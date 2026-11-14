package com.tetheract.pm

import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.media.ExifInterface
import android.net.Uri
import android.os.Build
import android.provider.DocumentsContract
import android.provider.MediaStore
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.InputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap

/**
 * スマホ機内フォルダの写真をロッカー内 library.db（管理下）へ自動スキャン統合し、
 * 母艦DB（Loome外を含む全登録写真）との重複照合・EXIF抽出・原本ストリーム紐付けを担うエンジン。
 */
class PhoneCatalogEngine(
    private val context: Context,
    private val lockerDbManager: LockerDatabaseManager
) {

    companion object {
        private const val TAG = "PhoneCatalogEngine"
        const val PHONE_LOCAL_ID_BASE = 900_000_000L
        const val ANDROID_LOCAL_VSN = "ANDROID_LOCAL"
        private const val MAX_PRE_SYNC_EXIF_READS = 16
        private val DUP_SUFFIX_REGEX = Regex("(?:_\\d+|\\s*\\(\\d+\\))$")
        private val EXIF_DATE_PREFIX_REGEX = Regex("^(\\d{4}):(\\d{2}):(\\d{2})(.*)$")
        private val FILENAME_DATE_REGEX = Regex("(20\\d{2})[-_]?([01]\\d)[-_]?([0-3]\\d)(?:[-_T ]?([0-2]\\d)([0-5]\\d)([0-5]\\d))?")

        /** 連番サフィックス (_1, (1) 等) を除いた正規化小文字ファイル名を返す */
        fun normalizeDupFileName(fileName: String): String {
            val lower = fileName.trim().lowercase(Locale.US)
            val dotIdx = lower.lastIndexOf('.')
            if (dotIdx <= 0) return lower
            val stem = lower.substring(0, dotIdx)
            val ext = lower.substring(dotIdx)
            val cleanStem = DUP_SUFFIX_REGEX.replace(stem, "").trim().ifEmpty { stem }
            return "$cleanStem$ext"
        }
    }

    data class CatalogSyncOutcome(val changedRows: Int, val syncedCount: Int, val errorMessage: String? = null)

    private data class ExistingPhoneRow(
        val id: Long, val fileSize: Long, val rating: Int, val directoryPath: String,
        val dateTaken: String, val cameraModel: String, val width: Int, val height: Int
    )

    private data class FastMediaMeta(val dateTaken: String, val width: Int, val height: Int)

    private data class DbCurationRow(
        val rating: Int, val dateTaken: String, val cameraModel: String,
        val lat: Double?, val lon: Double?, val city: String
    )

    /** 母艦DB登録済み写真およびスマホ管理下写真の photo_id -> docKey マップ（オフライン時の原本直接表示用） */
    private val photoIdToDocKey = ConcurrentHashMap<Long, String>()

    fun resolveDocKeyForPhotoId(photoId: Long): String? {
        photoIdToDocKey[photoId]?.takeIf { it.isNotEmpty() }?.let { return it }
        val meta = lockerDbManager.getPhotoFileMeta(photoId) ?: return null
        val fp = meta.optString("file_path", "")
        if (fp.startsWith("phone://")) {
            val dk = fp.removePrefix("phone://").trim()
            if (dk.isNotEmpty()) { photoIdToDocKey[photoId] = dk; return dk }
        }
        val links = meta.optJSONArray("links") ?: return null
        for (i in 0 until links.length()) {
            val lfp = links.optJSONObject(i)?.optString("file_path", "") ?: ""
            if (lfp.startsWith("phone://")) {
                val dk = lfp.removePrefix("phone://").trim()
                if (dk.isNotEmpty()) { photoIdToDocKey[photoId] = dk; return dk }
            }
        }
        return null
    }

    /** 母艦と未同期の単体起動時でもスマホ内写真を管理下に入れられるよう、library.db の必須テーブル・カラムを保証する */
    fun ensureStandaloneSchemaIfNeeded(): Boolean {
        return try {
            val ok = lockerDbManager.withWritableDatabase(createIfMissing = true) { db ->
                db.execSQL(
                    """
                    CREATE TABLE IF NOT EXISTS photos (
                        id INTEGER PRIMARY KEY AUTOINCREMENT, file_path TEXT NOT NULL, file_name TEXT NOT NULL,
                        directory_path TEXT NOT NULL, file_size INTEGER NOT NULL DEFAULT 0, file_mtime REAL DEFAULT 0,
                        width INTEGER, height INTEGER, date_taken TEXT, original_date_taken TEXT, year_month TEXT,
                        camera_model TEXT, lens_model TEXT, focal_length REAL, f_number REAL, shutter_speed TEXT,
                        exposure_bias REAL DEFAULT 0.0, iso INTEGER, latitude REAL, longitude REAL,
                        country TEXT, state TEXT, city TEXT, rating INTEGER DEFAULT 0, is_favorite INTEGER DEFAULT 0,
                        is_raw INTEGER DEFAULT 0, paired_raw_path TEXT, volume_serial TEXT, is_unlinked INTEGER DEFAULT 0,
                        content_key TEXT, stack_id INTEGER, is_stack_primary INTEGER DEFAULT 1,
                        rotation INTEGER DEFAULT 0, brightness INTEGER DEFAULT 0, contrast INTEGER DEFAULT 0,
                        saturation INTEGER DEFAULT 0, fine_angle REAL DEFAULT 0.0,
                        crop_x REAL DEFAULT 0.0, crop_y REAL DEFAULT 0.0, crop_w REAL DEFAULT 1.0, crop_h REAL DEFAULT 1.0
                    )
                    """.trimIndent()
                )
                db.execSQL("CREATE TABLE IF NOT EXISTS thumbnails (photo_id INTEGER PRIMARY KEY, file_hash TEXT, data BLOB NOT NULL, width INTEGER DEFAULT 0, height INTEGER DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP)")
                db.execSQL("CREATE TABLE IF NOT EXISTS photo_tags (photo_id INTEGER NOT NULL, tag TEXT NOT NULL, source TEXT DEFAULT 'manual', confidence REAL DEFAULT 1.0, PRIMARY KEY (photo_id, tag)) WITHOUT ROWID")
                db.execSQL("CREATE TABLE IF NOT EXISTS photo_links (id INTEGER PRIMARY KEY AUTOINCREMENT, photo_id INTEGER NOT NULL, volume_serial TEXT NOT NULL DEFAULT '' COLLATE NOCASE, rel_path TEXT NOT NULL DEFAULT '' COLLATE NOCASE, rel_dir TEXT NOT NULL DEFAULT '' COLLATE NOCASE, file_path TEXT NOT NULL DEFAULT '' COLLATE NOCASE, directory_path TEXT NOT NULL DEFAULT '' COLLATE NOCASE, file_name TEXT NOT NULL DEFAULT '' COLLATE NOCASE, file_mtime REAL, paired_raw_path TEXT, is_primary INTEGER DEFAULT 0, UNIQUE(volume_serial, rel_path))")
                ensurePhotoLinksColumns(db)
                db.execSQL("CREATE INDEX IF NOT EXISTS idx_photos_mobile_sort ON photos(date_taken DESC, file_name ASC)")
                db.execSQL("CREATE INDEX IF NOT EXISTS idx_photos_stack_id ON photos(stack_id)")
                db.execSQL("CREATE INDEX IF NOT EXISTS idx_photos_file_path ON photos(file_path)")
                db.execSQL("CREATE INDEX IF NOT EXISTS idx_photos_dir_path ON photos(directory_path)")
                db.execSQL("CREATE INDEX IF NOT EXISTS idx_photos_vol_serial ON photos(volume_serial)")
                db.execSQL("CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
                db.execSQL("CREATE TABLE IF NOT EXISTS security_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
                true
            } ?: false
            if (ok) lockerDbManager.refreshSafeColumnCache()
            ok
        } catch (e: Exception) {
            Log.e(TAG, "スタンドアロン library.db 初期化失敗", e)
            false
        }
    }

    private fun ensurePhotoLinksColumns(db: SQLiteDatabase) {
        val cols = HashSet<String>()
        try {
            db.rawQuery("PRAGMA table_info(photo_links)", null).use { c -> while (c.moveToNext()) cols.add(c.getString(1) ?: "") }
            for ((col, def) in arrayOf("rel_dir" to "TEXT NOT NULL DEFAULT ''", "directory_path" to "TEXT NOT NULL DEFAULT ''", "file_mtime" to "REAL", "is_primary" to "INTEGER DEFAULT 0")) {
                if (col !in cols) try { db.execSQL("ALTER TABLE photo_links ADD COLUMN $col $def") } catch (_: Exception) {}
            }
            db.execSQL("CREATE INDEX IF NOT EXISTS idx_photo_links_photo_id ON photo_links(photo_id)")
            db.execSQL("CREATE INDEX IF NOT EXISTS idx_photo_links_vol_dir ON photo_links(volume_serial, directory_path)")
            db.execSQL("CREATE INDEX IF NOT EXISTS idx_photo_links_file_path ON photo_links(file_path)")
        } catch (_: Exception) {}
    }

    /** 母艦側で削除されたと判明した写真のローカル母艦レコード(id < 900000000)を除去する */
    fun purgeDeletedMotherRows(staleMotherIds: Set<Long>, stalePhonePaths: Set<String>): Int {
        if ((staleMotherIds.isEmpty() && stalePhonePaths.isEmpty()) || !lockerDbManager.hasLockerDatabase()) return 0
        var removed = 0
        try {
            lockerDbManager.withWritableDatabase(createIfMissing = false) { db ->
                val targetIds = HashSet<Long>(staleMotherIds.filter { it in 1 until PHONE_LOCAL_ID_BASE })
                for (fp in stalePhonePaths) {
                    db.rawQuery("SELECT photo_id FROM photo_links WHERE file_path = ? AND photo_id < $PHONE_LOCAL_ID_BASE", arrayOf(fp)).use { c ->
                        while (c.moveToNext()) targetIds.add(c.getLong(0))
                    }
                }
                for (pid in targetIds) {
                    photoIdToDocKey.remove(pid)
                    db.execSQL("DELETE FROM photo_links WHERE photo_id = ?", arrayOf(pid))
                    db.execSQL("DELETE FROM photos WHERE id = ? AND id < $PHONE_LOCAL_ID_BASE", arrayOf(pid))
                    removed++
                }
            }
        } catch (_: Exception) {}
        return removed
    }

    data class MotherShipLookup(
        val exactMatchToId: Map<String, Long>, val normMatchToId: Map<String, Long>,
        val dtCamSizeToId: Map<String, Long>, val dtSizeToId: Map<String, Long>,
        val motherSizes: Set<Long>, val uploadedHistorySet: Set<String>
    ) {
        fun findMatchingMotherPhotoId(fileName: String, fileSize: Long, dateTaken: String = "", cameraModel: String = ""): Long? {
            if (fileSize <= 0L) return null
            val dt = dateTaken.trim().replaceFirst(EXIF_DATE_PREFIX_REGEX, "$1-$2-$3$4")
            val cam = cameraModel.trim().lowercase(Locale.US)
            if (dt.isNotEmpty() && cam.isNotEmpty()) dtCamSizeToId["$dt|$cam|$fileSize"]?.let { return it }
            if (dt.isNotEmpty()) dtSizeToId["$dt|$fileSize"]?.let { return it }
            if (fileName.isNotEmpty()) {
                exactMatchToId["${fileName.lowercase(Locale.US)}|$fileSize"]?.let { return it }
                normMatchToId["${normalizeDupFileName(fileName)}|$fileSize"]?.let { return it }
            }
            return null
        }

        fun isStoredInMotherShip(fileName: String, fileSize: Long, dateTaken: String = "", cameraModel: String = ""): Boolean {
            if (findMatchingMotherPhotoId(fileName, fileSize, dateTaken, cameraModel) != null) return true
            return "${fileName.lowercase(Locale.US)}|$fileSize" in uploadedHistorySet || "${normalizeDupFileName(fileName)}|$fileSize" in uploadedHistorySet
        }
    }

    /** ロッカー内 library.db（photos & photo_links）および転送済み履歴から重複照合インデックスを構築する */
    fun loadMotherShipLookup(uploadedHistory: Set<String>): MotherShipLookup {
        val exactMap = HashMap<String, Long>(); val normMap = HashMap<String, Long>()
        val dtCamSizeMap = HashMap<String, Long>(); val dtSizeMap = HashMap<String, Long>()
        val motherSizes = HashSet<Long>()
        if (!lockerDbManager.hasLockerDatabase()) return MotherShipLookup(exactMap, normMap, dtCamSizeMap, dtSizeMap, motherSizes, uploadedHistory)

        try {
            lockerDbManager.withWritableDatabase(createIfMissing = false) { db ->
                db.rawQuery(
                    "SELECT id, LOWER(file_name), file_size, COALESCE(date_taken, ''), COALESCE(original_date_taken, ''), LOWER(COALESCE(camera_model, '')) " +
                        "FROM photos WHERE IFNULL(is_unlinked, 0) = 0 AND id < $PHONE_LOCAL_ID_BASE AND IFNULL(volume_serial, '') != '$ANDROID_LOCAL_VSN' AND file_size > 0",
                    null
                ).use { c ->
                    while (c.moveToNext()) {
                        val pid = c.getLong(0); val fn = c.getString(1) ?: ""; val sz = c.getLong(2)
                        val dt1 = (c.getString(3) ?: "").trim().replaceFirst(EXIF_DATE_PREFIX_REGEX, "$1-$2-$3$4")
                        val dt2 = (c.getString(4) ?: "").trim().replaceFirst(EXIF_DATE_PREFIX_REGEX, "$1-$2-$3$4")
                        val cam = (c.getString(5) ?: "").trim()
                        if (sz > 0L) {
                            motherSizes.add(sz)
                            for (dt in arrayOf(dt1, dt2)) if (dt.isNotEmpty()) {
                                dtSizeMap.putIfAbsent("$dt|$sz", pid)
                                if (cam.isNotEmpty()) dtCamSizeMap.putIfAbsent("$dt|$cam|$sz", pid)
                            }
                            if (fn.isNotEmpty()) { exactMap["$fn|$sz"] = pid; normMap.putIfAbsent("${normalizeDupFileName(fn)}|$sz", pid) }
                        }
                    }
                }
                try {
                    db.rawQuery(
                        "SELECT lk.photo_id, LOWER(lk.file_name), p.file_size FROM photo_links lk JOIN photos p ON p.id = lk.photo_id " +
                            "WHERE IFNULL(p.is_unlinked, 0) = 0 AND p.id < $PHONE_LOCAL_ID_BASE AND IFNULL(lk.volume_serial, '') != '$ANDROID_LOCAL_VSN' AND lk.file_name IS NOT NULL AND p.file_size > 0",
                        null
                    ).use { lc ->
                        while (lc.moveToNext()) {
                            val pid = lc.getLong(0); val fn = lc.getString(1) ?: continue; val sz = lc.getLong(2)
                            if (fn.isNotEmpty() && sz > 0L) { motherSizes.add(sz); exactMap.putIfAbsent("$fn|$sz", pid); normMap.putIfAbsent("${normalizeDupFileName(fn)}|$sz", pid) }
                        }
                    }
                } catch (_: Exception) {}
            }
        } catch (e: Exception) { Log.w(TAG, "母艦DB重複照合セット読込スキップ: ${e.message}") }
        return MotherShipLookup(exactMap, normMap, dtCamSizeMap, dtSizeMap, motherSizes, uploadedHistory)
    }

    fun syncScannedItemsToCatalog(
        rawItems: List<JSONObject>,
        lookup: MotherShipLookup,
        draftsObj: JSONObject,
        decodeDocKeyFn: (String) -> Pair<String, String>?,
        decodeThumbFn: (Uri) -> ByteArray?
    ): Int = syncScannedItemsToCatalogDetailed(rawItems, lookup, draftsObj, decodeDocKeyFn, decodeThumbFn).changedRows

    /**
     * スキャンされたスマホ内写真リストをロッカー内 library.db（管理下）へ高速一括同期する。
     * DBロック内ではファイルI/O・サムネイルデコード・行別SELECTを一切行わず、数千枚でも数百ミリ秒で完了させる。
     */
    fun syncScannedItemsToCatalogDetailed(
        rawItems: List<JSONObject>,
        lookup: MotherShipLookup,
        draftsObj: JSONObject,
        decodeDocKeyFn: (String) -> Pair<String, String>?,
        @Suppress("UNUSED_PARAMETER") decodeThumbFn: ((Uri) -> ByteArray?)? = null
    ): CatalogSyncOutcome {
        if (rawItems.isEmpty() && !lockerDbManager.hasLockerDatabase()) {
            return CatalogSyncOutcome(0, 0, null)
        }
        if (!ensureStandaloneSchemaIfNeeded()) {
            return CatalogSyncOutcome(0, 0, "library.db のスキーマ初期化に失敗しました")
        }

        // 1. DBロックの外側で MediaStore から撮影日時・縦横寸法を一括取得（1クエリのみ・ファイルストリームオープンなし）
        val mediaFastMap = if (rawItems.isNotEmpty()) loadMediaStoreFastMetaMap() else emptyMap()
        val preExifMap = HashMap<String, PhoneExifMeta>()
        var preExifCount = 0
        for (item in rawItems) {
            if (preExifCount >= MAX_PRE_SYNC_EXIF_READS) break
            val fileSize = item.optLong("fileSize", 0L)
            if (fileSize <= 0L || fileSize !in lookup.motherSizes) continue
            val fileName = item.optString("fileName", "")
            val docKey = item.optString("docKey", "")
            val fastMeta = mediaFastMap["${fileName.lowercase(Locale.US)}|$fileSize"]
            if (docKey.isNotEmpty() && fileName.isNotEmpty() && fastMeta == null && item.optString("dateTaken", "").isEmpty()) {
                preExifCount++
                preExifMap[docKey] = extractPhoneExifMeta(docKey, fileName, item.optLong("lastModifiedMs", 0L), decodeDocKeyFn)
            }
        }

        var changedRows = 0
        var syncedCount = 0
        var syncErr: String? = null

        try {
            lockerDbManager.withWritableDatabase(createIfMissing = true) { db ->
                ensurePhotoLinksColumns(db)
                val photoCols = HashSet<String>()
                db.rawQuery("PRAGMA table_info(photos)", null).use { c ->
                    while (c.moveToNext()) photoCols.add(c.getString(1) ?: "")
                }

                val existingPhoneRows = HashMap<String, ExistingPhoneRow>()
                var maxPhoneId = PHONE_LOCAL_ID_BASE
                db.rawQuery(
                    "SELECT id, file_path, COALESCE(file_size, 0), COALESCE(rating, 0), COALESCE(directory_path, ''), COALESCE(date_taken, ''), COALESCE(camera_model, ''), COALESCE(width, 0), COALESCE(height, 0) FROM photos WHERE id >= $PHONE_LOCAL_ID_BASE OR IFNULL(volume_serial, '') = '$ANDROID_LOCAL_VSN'",
                    null
                ).use { c ->
                    while (c.moveToNext()) {
                        val pid = c.getLong(0); val fp = c.getString(1) ?: continue
                        existingPhoneRows[fp] = ExistingPhoneRow(pid, c.getLong(2), c.getInt(3), c.getString(4) ?: "", c.getString(5) ?: "", c.getString(6) ?: "", c.getInt(7), c.getInt(8))
                        if (pid > maxPhoneId) maxPhoneId = pid
                    }
                }

                val existingPhoneLinks = HashMap<String, Pair<Long, String>>()
                try {
                    db.rawQuery(
                        "SELECT photo_id, file_path, COALESCE(directory_path, '') FROM photo_links WHERE volume_serial = ?",
                        arrayOf(ANDROID_LOCAL_VSN)
                    ).use { c ->
                        while (c.moveToNext()) {
                            val pid = c.getLong(0); val fp = c.getString(1) ?: continue; val dp = c.getString(2) ?: ""
                            existingPhoneLinks[fp] = pid to dp
                            if (fp.startsWith("phone://")) {
                                val dk = fp.removePrefix("phone://").trim()
                                if (dk.isNotEmpty()) photoIdToDocKey[pid] = dk
                            }
                        }
                    }
                } catch (_: Exception) {}

                // 2. 評価・メタデータ・タグを事前一括ロード（2000枚ループ内での個別SQL発行をゼロにする）
                val dbCurationMap = HashMap<Long, DbCurationRow>()
                db.rawQuery(
                    "SELECT id, COALESCE(rating, 0), COALESCE(date_taken, ''), COALESCE(camera_model, ''), latitude, longitude, COALESCE(city, '') FROM photos WHERE IFNULL(is_unlinked, 0) = 0",
                    null
                ).use { c ->
                    while (c.moveToNext()) {
                        val pid = c.getLong(0)
                        val lat = if (!c.isNull(4)) c.getDouble(4) else null
                        val lon = if (!c.isNull(5)) c.getDouble(5) else null
                        dbCurationMap[pid] = DbCurationRow(c.getInt(1), c.getString(2) ?: "", c.getString(3) ?: "", lat, lon, c.getString(6) ?: "")
                    }
                }
                val dbTagsMap = HashMap<Long, MutableList<String>>()
                db.rawQuery("SELECT photo_id, tag FROM photo_tags ORDER BY tag ASC", null).use { c ->
                    while (c.moveToNext()) {
                        val pid = c.getLong(0); val t = (c.getString(1) ?: "").trim()
                        if (t.isNotEmpty()) dbTagsMap.getOrPut(pid) { mutableListOf() }.add(t)
                    }
                }

                val seenPhonePaths = HashSet<String>()
                val fallbackFmt = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US)

                db.beginTransaction()
                try {
                    for (item in rawItems) {
                        val docKey = item.optString("docKey", "")
                        val fileName = item.optString("fileName", "")
                        val fileSize = item.optLong("fileSize", 0L)
                        val lastModMs = item.optLong("lastModifiedMs", 0L)
                        val rawFolder = item.optString("folderName", "Camera")
                        val cleanFolder = rawFolder.removePrefix("📱").trim().trim('/').ifEmpty { "Camera" }
                        val phoneDirPath = "📱 $cleanFolder"
                        if (docKey.isEmpty() || fileName.isEmpty() || fileSize <= 0L) continue

                        val phonePath = "phone://$docKey"
                        seenPhonePaths.add(phonePath)

                        val existing = existingPhoneRows[phonePath]
                        val fastMeta = mediaFastMap["${fileName.lowercase(Locale.US)}|$fileSize"]
                        val preExif = preExifMap[docKey]
                        val candDt = existing?.dateTaken?.ifEmpty { null }
                            ?: preExif?.dateTaken?.ifEmpty { null }
                            ?: fastMeta?.dateTaken?.ifEmpty { null }
                            ?: item.optString("dateTaken", "")
                        val candCam = existing?.cameraModel?.ifEmpty { null }
                            ?: preExif?.let { it.cameraModel.ifEmpty { it.cameraMake } }?.ifEmpty { null }
                            ?: item.optString("cameraModel", "")

                        val matchedMotherId = lookup.findMatchingMotherPhotoId(fileName, fileSize, candDt, candCam)
                        val isStored = matchedMotherId != null || lookup.isStoredInMotherShip(fileName, fileSize, candDt, candCam)
                        item.put("inMotherShip", isStored)

                        if (matchedMotherId != null && matchedMotherId > 0L) {
                            photoIdToDocKey[matchedMotherId] = docKey
                            item.put("photoId", matchedMotherId)
                            if (existing != null) {
                                migrateLocalCurationToMotherRow(db, existing.id, matchedMotherId)
                                db.execSQL("DELETE FROM thumbnails WHERE photo_id = ?", arrayOf(existing.id))
                                db.execSQL("DELETE FROM photo_tags WHERE photo_id = ?", arrayOf(existing.id))
                                db.execSQL("DELETE FROM photo_links WHERE photo_id = ? AND volume_serial = ?", arrayOf(existing.id, ANDROID_LOCAL_VSN))
                                db.execSQL("DELETE FROM photos WHERE id = ?", arrayOf(existing.id))
                                changedRows++
                            }
                            val prevLink = existingPhoneLinks[phonePath]
                            if (prevLink == null || prevLink.first != matchedMotherId || prevLink.second != phoneDirPath) {
                                upsertAndroidLocalPhotoLink(db, matchedMotherId, "$cleanFolder/$fileName", cleanFolder, phonePath, phoneDirPath, fileName, lastModMs / 1000.0)
                                changedRows++
                            }
                            applyCachedCurationToItem(matchedMotherId, item, draftsObj.optJSONObject(docKey), dbCurationMap[matchedMotherId], dbTagsMap[matchedMotherId])
                            syncedCount++
                            continue
                        }

                        val targetId: Long
                        if (existing != null) {
                            targetId = existing.id
                            val patchW = if (existing.width <= 0 && (fastMeta?.width ?: 0) > 0) fastMeta!!.width else 0
                            val patchH = if (existing.height <= 0 && (fastMeta?.height ?: 0) > 0) fastMeta!!.height else 0
                            if (existing.fileSize != fileSize || existing.directoryPath != phoneDirPath || patchW > 0) {
                                val cv = ContentValues().apply {
                                    put("file_size", fileSize); put("file_mtime", lastModMs / 1000.0); put("directory_path", phoneDirPath)
                                    if ("is_unlinked" in photoCols) put("is_unlinked", 0)
                                    if (patchW > 0 && "width" in photoCols) put("width", patchW)
                                    if (patchH > 0 && "height" in photoCols) put("height", patchH)
                                }
                                db.update("photos", cv, "id = ?", arrayOf(targetId.toString()))
                                changedRows++
                            }
                        } else {
                            maxPhoneId += 1L
                            targetId = maxPhoneId
                            val draft = draftsObj.optJSONObject(docKey)
                            val initRating = draft?.optInt("rating", 0) ?: item.optInt("rating", 0)
                            val exifMeta = preExif ?: buildFastOrFallbackMeta(fileName, lastModMs, fastMeta, fallbackFmt)
                            val isRaw = if (fileName.substringAfterLast('.', "").lowercase(Locale.US) in setOf("dng", "arw", "cr2", "cr3", "nef", "orf", "raf", "rw2", "pef")) 1 else 0
                            val camModel = exifMeta.cameraModel.ifEmpty { exifMeta.cameraMake }
                            val cKey = if (exifMeta.dateTaken.length >= 19) "dt:${exifMeta.dateTaken.take(19)}|sz:$fileSize|raw:$isRaw" else "${fileName.lowercase(Locale.US)}|$fileSize"
                            val cv = ContentValues().apply {
                                put("id", targetId); put("file_path", phonePath); put("file_name", fileName)
                                put("directory_path", phoneDirPath); put("file_size", fileSize)
                                if ("file_mtime" in photoCols) put("file_mtime", lastModMs / 1000.0)
                                if ("date_taken" in photoCols) put("date_taken", exifMeta.dateTaken)
                                if ("original_date_taken" in photoCols) put("original_date_taken", exifMeta.dateTaken)
                                if ("year_month" in photoCols) put("year_month", exifMeta.yearMonth)
                                if ("camera_make" in photoCols && exifMeta.cameraMake.isNotEmpty()) put("camera_make", exifMeta.cameraMake)
                                if ("camera_model" in photoCols && camModel.isNotEmpty()) put("camera_model", camModel)
                                if ("lens_model" in photoCols && exifMeta.lensModel.isNotEmpty()) put("lens_model", exifMeta.lensModel)
                                if ("focal_length" in photoCols && exifMeta.focalLength != null) put("focal_length", exifMeta.focalLength)
                                if ("f_number" in photoCols && exifMeta.fNumber != null) put("f_number", exifMeta.fNumber)
                                if ("shutter_speed" in photoCols && exifMeta.shutterSpeed.isNotEmpty()) put("shutter_speed", exifMeta.shutterSpeed)
                                if ("iso" in photoCols && exifMeta.iso != null) put("iso", exifMeta.iso)
                                if ("width" in photoCols && exifMeta.width > 0) put("width", exifMeta.width)
                                if ("height" in photoCols && exifMeta.height > 0) put("height", exifMeta.height)
                                if ("latitude" in photoCols && exifMeta.latitude != null) put("latitude", exifMeta.latitude)
                                if ("longitude" in photoCols && exifMeta.longitude != null) put("longitude", exifMeta.longitude)
                                if ("rating" in photoCols) put("rating", initRating)
                                if ("is_raw" in photoCols) put("is_raw", isRaw)
                                if ("is_stack_primary" in photoCols) put("is_stack_primary", 1)
                                if ("volume_serial" in photoCols) put("volume_serial", ANDROID_LOCAL_VSN)
                                if ("is_unlinked" in photoCols) put("is_unlinked", 0)
                                if ("content_key" in photoCols) put("content_key", cKey)
                            }
                            val rowId = db.insertWithOnConflict("photos", null, cv, SQLiteDatabase.CONFLICT_REPLACE)
                            if (rowId == -1L) {
                                Log.e(TAG, "photos 行挿入失敗: $fileName ($phoneDirPath)")
                                if (syncErr == null) syncErr = "photos テーブルへの行登録に失敗しました ($fileName)"
                                continue
                            }
                            val addedTagList = mutableListOf<String>()
                            val draftTags = draft?.optJSONArray("tags") ?: item.optJSONArray("tags")
                            if (draftTags != null) {
                                for (i in 0 until draftTags.length()) {
                                    val t = (draftTags.optString(i) ?: "").trim()
                                    for (anc in expandTagAncestors(t)) {
                                        db.execSQL("INSERT OR IGNORE INTO photo_tags (photo_id, tag, source, confidence) VALUES (?, ?, 'manual', 1.0)", arrayOf(targetId, anc))
                                        addedTagList.add(anc)
                                    }
                                }
                            }
                            dbCurationMap[targetId] = DbCurationRow(initRating, exifMeta.dateTaken, camModel, exifMeta.latitude, exifMeta.longitude, "")
                            if (addedTagList.isNotEmpty()) dbTagsMap[targetId] = addedTagList
                            changedRows++
                        }

                        val prevLink = existingPhoneLinks[phonePath]
                        if (prevLink == null || prevLink.first != targetId || prevLink.second != phoneDirPath) {
                            upsertAndroidLocalPhotoLink(db, targetId, "$cleanFolder/$fileName", cleanFolder, phonePath, phoneDirPath, fileName, lastModMs / 1000.0)
                        }

                        photoIdToDocKey[targetId] = docKey
                        item.put("photoId", targetId)
                        syncedCount++
                        applyCachedCurationToItem(targetId, item, draftsObj.optJSONObject(docKey), dbCurationMap[targetId], dbTagsMap[targetId])
                    }

                    // フォルダ解除またはスマホ上から削除された ANDROID_LOCAL 行・リンクをクリーンアップ
                    for ((fp, row) in existingPhoneRows) {
                        if (fp !in seenPhonePaths) {
                            val pid = row.id
                            photoIdToDocKey.remove(pid)
                            db.execSQL("DELETE FROM thumbnails WHERE photo_id = ?", arrayOf(pid))
                            db.execSQL("DELETE FROM photo_tags WHERE photo_id = ?", arrayOf(pid))
                            db.execSQL("DELETE FROM photo_links WHERE photo_id = ? AND volume_serial = ?", arrayOf(pid, ANDROID_LOCAL_VSN))
                            db.execSQL("DELETE FROM photos WHERE id = ?", arrayOf(pid))
                            changedRows++
                        }
                    }
                    for ((fp, _) in existingPhoneLinks) {
                        if (fp !in seenPhonePaths) {
                            db.execSQL("DELETE FROM photo_links WHERE volume_serial = ? AND file_path = ?", arrayOf(ANDROID_LOCAL_VSN, fp))
                            changedRows++
                        }
                    }
                    if ("paired_raw_path" in photoCols) pairPhoneLocalRawJpeg(db)

                    db.setTransactionSuccessful()
                } finally {
                    db.endTransaction()
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "スマホ内写真の管理下DB統合エラー", e)
            syncErr = e.message ?: "DB統合エラー"
        }
        return CatalogSyncOutcome(changedRows, syncedCount, syncErr)
    }

    private fun loadMediaStoreFastMetaMap(): Map<String, FastMediaMeta> {
        val map = HashMap<String, FastMediaMeta>(2048)
        val fmt = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US)
        try {
            val proj = arrayOf(
                MediaStore.Images.Media.DISPLAY_NAME,
                MediaStore.Images.Media.SIZE,
                MediaStore.Images.Media.DATE_TAKEN,
                MediaStore.Images.Media.DATE_MODIFIED,
                MediaStore.Images.Media.WIDTH,
                MediaStore.Images.Media.HEIGHT,
                MediaStore.Images.Media.ORIENTATION
            )
            context.contentResolver.query(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, proj, null, null, null)?.use { c ->
                while (c.moveToNext()) {
                    val name = (c.getString(0) ?: "").trim().lowercase(Locale.US)
                    val sz = c.getLong(1)
                    if (name.isEmpty() || sz <= 0L) continue
                    val dtMs = if (!c.isNull(2)) c.getLong(2) else 0L
                    val modSec = if (!c.isNull(3)) c.getLong(3) else 0L
                    val rawW = if (!c.isNull(4)) c.getInt(4) else 0
                    val rawH = if (!c.isNull(5)) c.getInt(5) else 0
                    val orient = if (!c.isNull(6)) c.getInt(6) else 0
                    val swap = orient == 90 || orient == 270
                    val w = if (swap) rawH else rawW
                    val h = if (swap) rawW else rawH
                    val effMs = if (dtMs > 946684800000L) dtMs else if (modSec > 946684800L) modSec * 1000L else 0L
                    val dtStr = if (effMs > 0L) fmt.format(Date(effMs)) else ""
                    map.putIfAbsent("$name|$sz", FastMediaMeta(dtStr, w, h))
                }
            }
        } catch (e: Exception) {
            Log.d(TAG, "MediaStore高速メタ取得スキップ: ${e.message}")
        }
        return map
    }

    private fun buildFastOrFallbackMeta(fileName: String, lastModMs: Long, fast: FastMediaMeta?, fmt: SimpleDateFormat): PhoneExifMeta {
        val dt = fast?.dateTaken?.takeIf { it.length >= 19 } ?: run {
            val m = FILENAME_DATE_REGEX.find(fileName)
            if (m != null) {
                "${m.groupValues[1]}-${m.groupValues[2]}-${m.groupValues[3]} ${m.groupValues[4].ifEmpty { "12" }}:${m.groupValues[5].ifEmpty { "00" }}:${m.groupValues[6].ifEmpty { "00" }}"
            } else fmt.format(Date(if (lastModMs > 0L) lastModMs else System.currentTimeMillis()))
        }
        return PhoneExifMeta(dt, dt.take(7), "", "", "", null, null, "", null, fast?.width ?: 0, fast?.height ?: 0, null, null)
    }

    private fun upsertAndroidLocalPhotoLink(
        db: SQLiteDatabase, photoId: Long, relPath: String, relDir: String,
        filePath: String, directoryPath: String, fileName: String, fileMtime: Double
    ) {
        try {
            db.execSQL("DELETE FROM photo_links WHERE volume_serial = ? AND (file_path = ? OR rel_path = ?)", arrayOf(ANDROID_LOCAL_VSN, filePath, relPath))
            db.execSQL(
                "INSERT OR REPLACE INTO photo_links (photo_id, volume_serial, rel_path, rel_dir, file_path, directory_path, file_name, file_mtime) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                arrayOf(photoId, ANDROID_LOCAL_VSN, relPath, relDir, filePath, directoryPath, fileName, fileMtime)
            )
        } catch (e: Exception) { Log.w(TAG, "photo_links 登録警告 ($fileName): ${e.message}") }
    }

    /** オンデマンド生成されたスマホ写真のサムネイルBLOB群をバッチで thumbnails テーブルへ保存する */
    fun saveThumbnailBlobsBatch(batch: Map<Long, ByteArray>) {
        if (batch.isEmpty()) return
        try {
            lockerDbManager.withWritableDatabase(createIfMissing = false) { db ->
                db.beginTransaction()
                try {
                    for ((photoId, thumbBytes) in batch) {
                        if (photoId < PHONE_LOCAL_ID_BASE || thumbBytes.isEmpty()) continue
                        val tcv = ContentValues().apply { put("photo_id", photoId); put("data", thumbBytes); put("width", 360); put("height", 360) }
                        db.insertWithOnConflict("thumbnails", null, tcv, SQLiteDatabase.CONFLICT_IGNORE)
                    }
                    db.setTransactionSuccessful()
                } finally {
                    db.endTransaction()
                }
            }
        } catch (_: Exception) {}
    }

    fun saveThumbnailBlobIfMissing(photoId: Long, thumbBytes: ByteArray) {
        if (photoId >= PHONE_LOCAL_ID_BASE && thumbBytes.isNotEmpty()) saveThumbnailBlobsBatch(mapOf(photoId to thumbBytes))
    }

    /** 指定したスマホ管理下フォルダ名（例: "Camera"）に属する登録済み写真枚数を返す */
    fun countCatalogPhotosForFolder(folderName: String): Int {
        if (!lockerDbManager.hasLockerDatabase()) return 0
        val clean = folderName.removePrefix("📱").trim().trim('/').ifEmpty { return 0 }
        val exactDir = "📱 $clean"; val subSlash = "$exactDir/%"; val subBack = "$exactDir\\%"
        return try {
            lockerDbManager.withWritableDatabase(createIfMissing = false) { db ->
                db.rawQuery(
                    "SELECT COUNT(*) FROM photos p WHERE IFNULL(p.is_unlinked, 0) = 0 " +
                        "AND NOT (COALESCE(p.is_raw, 0) = 1 AND p.paired_raw_path IS NOT NULL AND p.paired_raw_path != '') " +
                        "AND (p.directory_path = ? OR p.directory_path LIKE ? OR p.directory_path LIKE ? OR EXISTS (" +
                        "SELECT 1 FROM photo_links pl WHERE pl.photo_id = p.id AND (pl.directory_path = ? OR pl.directory_path LIKE ? OR pl.directory_path LIKE ?)))",
                    arrayOf(exactDir, subSlash, subBack, exactDir, subSlash, subBack)
                ).use { c -> if (c.moveToFirst()) c.getInt(0) else 0 }
            } ?: 0
        } catch (_: Exception) { 0 }
    }

    private fun expandTagAncestors(tagStr: String): List<String> {
        val parts = tagStr.split("/").map { it.trim() }.filter { it.isNotEmpty() }
        return parts.indices.map { i -> parts.subList(0, i + 1).joinToString("/") }
    }

    private fun migrateLocalCurationToMotherRow(db: SQLiteDatabase, localId: Long, motherId: Long) {
        try {
            var localRate = 0
            db.rawQuery("SELECT COALESCE(rating, 0) FROM photos WHERE id = ? LIMIT 1", arrayOf(localId.toString())).use { c ->
                if (c.moveToFirst()) localRate = c.getInt(0)
            }
            if (localRate != 0) {
                db.execSQL("UPDATE photos SET rating = ? WHERE id = ? AND COALESCE(rating, 0) = 0", arrayOf(localRate, motherId))
            }
            db.execSQL(
                "INSERT OR IGNORE INTO photo_tags (photo_id, tag, source, confidence) SELECT ?, tag, source, confidence FROM photo_tags WHERE photo_id = ?",
                arrayOf(motherId, localId)
            )
        } catch (_: Exception) {}
    }

    private fun applyCachedCurationToItem(
        @Suppress("UNUSED_PARAMETER") photoId: Long,
        item: JSONObject,
        draft: JSONObject?,
        cur: DbCurationRow?,
        dbTags: List<String>?
    ) {
        if (cur != null) {
            if (cur.dateTaken.isNotEmpty()) item.put("dateTaken", cur.dateTaken)
            if (cur.cameraModel.isNotEmpty()) item.put("cameraModel", cur.cameraModel)
            if (cur.lat != null && cur.lon != null) { item.put("latitude", cur.lat); item.put("longitude", cur.lon) }
            if (cur.city.isNotEmpty()) item.put("city", cur.city)
        }
        val dbRating = cur?.rating ?: 0
        item.put("rating", if (dbRating != 0) dbRating else (draft?.optInt("rating", 0) ?: 0))

        val tagSet = LinkedHashSet<String>()
        dbTags?.forEach { if (it.isNotEmpty()) tagSet.add(it) }
        val draftTags = draft?.optJSONArray("tags")
        if (draftTags != null) {
            for (i in 0 until draftTags.length()) { val t = (draftTags.optString(i) ?: "").trim(); if (t.isNotEmpty()) tagSet.add(t) }
        }
        val outTags = JSONArray(); tagSet.forEach { outTags.put(it) }
        item.put("tags", outTags)
    }

    /** Android 10+ のGPS黒塗り(Redaction)を回避し、MediaStore.setRequireOriginal 経由で原本ストリームを開く */
    fun openOriginalPhotoStream(docUri: Uri, fileName: String = "", fileSize: Long = 0L): InputStream? {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            if (fileName.isNotEmpty() && fileSize > 0L) {
                try {
                    context.contentResolver.query(
                        MediaStore.Images.Media.EXTERNAL_CONTENT_URI, arrayOf(MediaStore.Images.Media._ID),
                        "${MediaStore.Images.Media.DISPLAY_NAME} = ? AND ${MediaStore.Images.Media.SIZE} = ?",
                        arrayOf(fileName, fileSize.toString()), null
                    )?.use { c ->
                        if (c.moveToFirst()) {
                            val mUri = ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, c.getLong(0))
                            context.contentResolver.openInputStream(MediaStore.setRequireOriginal(mUri))?.let { return it }
                        }
                    }
                } catch (_: Exception) {}
            }
            try { context.contentResolver.openInputStream(MediaStore.setRequireOriginal(docUri))?.let { return it } } catch (_: Exception) {}
        }
        return try { context.contentResolver.openInputStream(docUri) } catch (_: Exception) { null }
    }

    /** 母艦から返却されたGPS座標・逆ジオコーディング地名をスマホ側 library.db の該当写真行へ即時反映する */
    fun applyMotherGeoToPhoneRow(docKey: String, geoObj: JSONObject) {
        if (docKey.isEmpty() || !lockerDbManager.hasLockerDatabase()) return
        val hasLatLon = !geoObj.isNull("latitude") && !geoObj.isNull("longitude")
        val lat = geoObj.optDouble("latitude", Double.NaN); val lon = geoObj.optDouble("longitude", Double.NaN)
        val country = geoObj.optString("country", "").trim(); val state = geoObj.optString("state", "").trim(); val city = geoObj.optString("city", "").trim()
        if ((!hasLatLon || lat.isNaN() || lon.isNaN()) && country.isEmpty() && state.isEmpty() && city.isEmpty()) return
        try {
            lockerDbManager.withWritableDatabase(createIfMissing = false) { db ->
                val cv = ContentValues().apply {
                    if (hasLatLon && !lat.isNaN() && !lon.isNaN()) { put("latitude", lat); put("longitude", lon) }
                    if (country.isNotEmpty()) put("country", country)
                    if (state.isNotEmpty()) put("state", state)
                    if (city.isNotEmpty()) put("city", city)
                }
                if (cv.size() > 0) db.update("photos", cv, "file_path = ? OR id IN (SELECT photo_id FROM photo_links WHERE file_path = ?)", arrayOf("phone://$docKey", "phone://$docKey"))
            }
        } catch (_: Exception) {}
    }

    /** 原本ストリームのEXIFから緯度・経度ペアを直接読み取る（転送直前の補完用） */
    fun readOriginalLatLon(docUri: Uri, fileName: String, fileSize: Long): Pair<Double, Double>? = try {
        openOriginalPhotoStream(docUri, fileName, fileSize)?.use { ins ->
            val ll = FloatArray(2)
            if (ExifInterface(ins).getLatLong(ll)) ll[0].toDouble() to ll[1].toDouble() else null
        }
    } catch (_: Exception) { null }

    private data class PhoneExifMeta(
        val dateTaken: String, val yearMonth: String, val cameraMake: String, val cameraModel: String,
        val lensModel: String, val focalLength: Double?, val fNumber: Double?, val shutterSpeed: String,
        val iso: Int?, val width: Int, val height: Int, val latitude: Double?, val longitude: Double?
    )

    private fun buildFallbackExifMeta(fileName: String, lastModMs: Long): PhoneExifMeta {
        val m = FILENAME_DATE_REGEX.find(fileName)
        val dt = if (m != null) {
            "${m.groupValues[1]}-${m.groupValues[2]}-${m.groupValues[3]} ${m.groupValues[4].ifEmpty { "12" }}:${m.groupValues[5].ifEmpty { "00" }}:${m.groupValues[6].ifEmpty { "00" }}"
        } else SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US).format(Date(if (lastModMs > 0L) lastModMs else System.currentTimeMillis()))
        return PhoneExifMeta(dt, dt.take(7), "", "", "", null, null, "", null, 0, 0, null, null)
    }

    private fun extractPhoneExifMeta(
        docKey: String, fileName: String, lastModMs: Long, decodeDocKeyFn: (String) -> Pair<String, String>?
    ): PhoneExifMeta {
        val base = buildFallbackExifMeta(fileName, lastModMs)
        var dateTaken = base.dateTaken
        var cameraMake = ""; var cameraModel = ""; var lensModel = ""; var shutterSpeed = ""
        var focalLength: Double? = null; var fNumber: Double? = null; var iso: Int? = null
        var width = 0; var height = 0; var lat: Double? = null; var lon: Double? = null

        val pair = decodeDocKeyFn(docKey)
        if (pair != null) {
            try {
                val docUri = DocumentsContract.buildDocumentUriUsingTree(Uri.parse(pair.first), pair.second)
                openOriginalPhotoStream(docUri, fileName, 0L)?.use { ins ->
                    val exif = ExifInterface(ins)
                    val rawDt = (exif.getAttribute(ExifInterface.TAG_DATETIME_ORIGINAL) ?: exif.getAttribute(ExifInterface.TAG_DATETIME) ?: "").trim()
                    val m = EXIF_DATE_PREFIX_REGEX.matchEntire(rawDt)
                    if (m != null) dateTaken = "${m.groupValues[1]}-${m.groupValues[2]}-${m.groupValues[3]}${m.groupValues[4]}"
                    cameraMake = (exif.getAttribute(ExifInterface.TAG_MAKE) ?: "").trim()
                    cameraModel = (exif.getAttribute(ExifInterface.TAG_MODEL) ?: "").trim()
                    lensModel = (exif.getAttribute("LensModel") ?: "").trim()
                    focalLength = exif.getAttributeDouble(ExifInterface.TAG_FOCAL_LENGTH, -1.0).takeIf { it > 0.0 }
                    fNumber = exif.getAttributeDouble(ExifInterface.TAG_F_NUMBER, -1.0).takeIf { it > 0.0 }
                    shutterSpeed = (exif.getAttribute(ExifInterface.TAG_EXPOSURE_TIME) ?: "").trim()
                    iso = (exif.getAttribute("PhotographicSensitivity") ?: exif.getAttribute(ExifInterface.TAG_ISO_SPEED_RATINGS))?.trim()?.toIntOrNull()?.takeIf { it > 0 }
                    width = exif.getAttributeInt(ExifInterface.TAG_IMAGE_WIDTH, 0)
                    height = exif.getAttributeInt(ExifInterface.TAG_IMAGE_LENGTH, 0)
                    val latLong = FloatArray(2)
                    if (exif.getLatLong(latLong)) { lat = latLong[0].toDouble(); lon = latLong[1].toDouble() }
                }
            } catch (_: Exception) {}
        }

        val ym = if (dateTaken.length >= 7) dateTaken.substring(0, 7) else base.yearMonth
        return PhoneExifMeta(dateTaken, ym, cameraMake, cameraModel, lensModel, focalLength, fNumber, shutterSpeed, iso, width, height, lat, lon)
    }

    private fun pairPhoneLocalRawJpeg(db: SQLiteDatabase) {
        data class RRow(val id: Long, val fp: String, val isRaw: Int, val curPair: String)
        val groups = HashMap<String, MutableList<RRow>>()
        db.rawQuery("SELECT id, directory_path, file_name, file_path, COALESCE(is_raw, 0), COALESCE(paired_raw_path, '') FROM photos WHERE id >= 900000000 AND IFNULL(is_unlinked, 0) = 0", null).use { c ->
            while (c.moveToNext()) {
                val stem = (c.getString(2) ?: "").substringBeforeLast('.').lowercase(Locale.US)
                if (stem.isNotEmpty()) groups.getOrPut("${c.getString(1) ?: ""}|$stem") { mutableListOf() }.add(RRow(c.getLong(0), c.getString(3) ?: "", c.getInt(4), c.getString(5) ?: ""))
            }
        }
        for (list in groups.values) {
            val jpg = list.firstOrNull { it.isRaw == 0 }; val raws = list.filter { it.isRaw == 1 }
            if (jpg != null && raws.isNotEmpty()) {
                if (jpg.curPair != raws[0].fp) db.execSQL("UPDATE photos SET paired_raw_path = ? WHERE id = ?", arrayOf(raws[0].fp, jpg.id))
                for (r in raws) if (r.curPair != jpg.fp) db.execSQL("UPDATE photos SET paired_raw_path = ? WHERE id = ?", arrayOf(jpg.fp, r.id))
            } else for (it in list) if (it.curPair.isNotEmpty()) db.execSQL("UPDATE photos SET paired_raw_path = NULL WHERE id = ?", arrayOf(it.id))
        }
    }
}
