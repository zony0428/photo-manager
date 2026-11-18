package com.tetheract.pm

import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.location.Geocoder
import android.media.ExifInterface
import android.net.Uri
import android.os.Build
import android.provider.DocumentsContract
import android.provider.MediaStore
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.io.InputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.math.abs

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
        const val THMOD_LOCAL_SCHEME = "thmod_local"
        private const val MAX_PRE_SYNC_EXIF_READS = 64
        private val PAREN_DUP_SUFFIX_REGEX = Regex("\\s*\\(\\d+\\)$")
        private val NUM_DUP_SUFFIX_REGEX = Regex("^(.+)_([1-9]\\d?)$")
        private val CAMERA_BASE_NUM_REGEX = Regex("(?:[a-z]+\\d{3,}|_\\d{3,}|\\d{6,})$")
        private val EXIF_DATE_PREFIX_REGEX = Regex("^(\\d{4}):(\\d{2}):(\\d{2})(.*)$")
        private val EXIF_FLEX_DATE_REGEX = Regex("^(\\d{4})[-:/](\\d{2})[-:/](\\d{2})(?:[T ](\\d{2}):(\\d{2}):(\\d{2}))?")
        private val FILENAME_DATE_REGEX = Regex("(20\\d{2})[-_]?([01]\\d)[-_]?([0-3]\\d)(?:[-_T ]?([0-2]\\d)([0-5]\\d)([0-5]\\d))?")
        private val NON_ALNUM_REGEX = Regex("[^a-z0-9]+")
        private val INVALID_CAMERAS = setOf("", "不明", "raw写真", "unknown")

        /** カメラ本体番号(IMG_1234等)を保護しつつ、OSコピー枝番 (_1, (1) 等) のみを除いた正規化小文字ファイル名を返す */
        fun normalizeDupFileName(fileName: String): String {
            val lower = fileName.trim().lowercase(Locale.US)
            val dotIdx = lower.lastIndexOf('.')
            if (dotIdx <= 0) return lower
            val stem = lower.substring(0, dotIdx)
            val ext = lower.substring(dotIdx)
            var cleanStem = PAREN_DUP_SUFFIX_REGEX.replace(stem, "").trim()
            val m = NUM_DUP_SUFFIX_REGEX.matchEntire(cleanStem)
            if (m != null && CAMERA_BASE_NUM_REGEX.containsMatchIn(m.groupValues[1])) {
                cleanStem = m.groupValues[1]
            }
            return "${cleanStem.ifEmpty { stem }}$ext"
        }

        /** 先頭 thmod_ と拡張子・コピー枝番を除去した比較用正規化ステムを返す */
        fun normalizeCameraStem(fileName: String?): String {
            if (fileName.isNullOrBlank()) return ""
            val base = fileName.substringAfterLast('/').substringAfterLast('\\').trim()
            if (base.isEmpty()) return ""
            val dotIdx = base.lastIndexOf('.')
            var stem = (if (dotIdx > 0) base.substring(0, dotIdx) else base).trim().lowercase(Locale.US)
            if (stem.startsWith("thmod_")) stem = stem.removePrefix("thmod_").trim()
            stem = PAREN_DUP_SUFFIX_REGEX.replace(stem, "").trim()
            val m = NUM_DUP_SUFFIX_REGEX.matchEntire(stem)
            if (m != null && CAMERA_BASE_NUM_REGEX.containsMatchIn(m.groupValues[1])) {
                stem = m.groupValues[1]
            }
            return stem
        }

        private fun normalizeDateEpochSec(raw: String?): Long? {
            val s = (raw ?: "").trim()
            val m = EXIF_FLEX_DATE_REGEX.find(s) ?: return null
            val yyyy = m.groupValues[1].toIntOrNull() ?: return null
            val mm = m.groupValues[2].toIntOrNull() ?: return null
            val dd = m.groupValues[3].toIntOrNull() ?: return null
            val hh = m.groupValues[4].toIntOrNull() ?: 0
            val mi = m.groupValues[5].toIntOrNull() ?: 0
            val ss = m.groupValues[6].toIntOrNull() ?: 0
            if (yyyy !in 1970..2100 || mm !in 1..12 || dd !in 1..31) return null
            return try {
                val cal = java.util.Calendar.getInstance(java.util.TimeZone.getTimeZone("UTC"), Locale.US)
                cal.set(yyyy, mm - 1, dd, hh, mi, ss)
                cal.set(java.util.Calendar.MILLISECOND, 0)
                cal.timeInMillis / 1000L
            } catch (_: Exception) {
                null
            }
        }

        private fun cameraModelsCompatible(camA: String?, camB: String?): Boolean {
            val kA = NON_ALNUM_REGEX.replace((camA ?: "").trim().lowercase(Locale.US), "")
            val kB = NON_ALNUM_REGEX.replace((camB ?: "").trim().lowercase(Locale.US), "")
            if (kA.isEmpty() || kB.isEmpty()) return true
            if ((camA ?: "").trim().lowercase(Locale.US) in INVALID_CAMERAS || (camB ?: "").trim().lowercase(Locale.US) in INVALID_CAMERAS) {
                return true
            }
            return kA == kB || kA in kB || kB in kA
        }

        /** EXIF ExposureTime（小数・分数表記）をカメラ標準表記（例: 1/250, 0.5, 2）へ整形する */
        internal fun formatExposureTime(raw: String?): String {
            val s = (raw ?: "").trim()
            if (s.isEmpty()) return ""
            val sec: Double = if ('/' in s) {
                val parts = s.split('/', limit = 2)
                val num = parts.getOrNull(0)?.trim()?.toDoubleOrNull() ?: return s
                val den = parts.getOrNull(1)?.trim()?.toDoubleOrNull() ?: return s
                if (den <= 0.0 || num <= 0.0) return s
                if (abs(num - 1.0) < 1e-6 && den >= 2.0) return "1/${Math.round(den)}"
                num / den
            } else {
                s.toDoubleOrNull() ?: return s
            }
            if (sec <= 0.0) return ""
            if (sec < 0.45) {
                val inv = Math.round(1.0 / sec).coerceAtLeast(2L)
                return "1/$inv"
            }
            val rounded = Math.round(sec * 10.0) / 10.0
            return if (abs(rounded - Math.round(rounded)) < 1e-6) {
                Math.round(rounded).toString()
            } else {
                String.format(Locale.US, "%.1f", rounded)
            }
        }
    }

    val thmodExportsDir: File = File(lockerDbManager.lockerDir, "thmod_exports")

    /** treeUriStr ("thmod_local" または SAF tree URI) と docId から実アクセス可能な Uri を構築する */
    fun buildLocalOrDocumentUri(treeUriStr: String, docId: String): Uri? {
        if (treeUriStr == THMOD_LOCAL_SCHEME) {
            val safeName = File(docId).name
            if (safeName.isEmpty() || safeName == "." || safeName == "..") return null
            return Uri.fromFile(File(thmodExportsDir, safeName))
        }
        return try {
            DocumentsContract.buildDocumentUriUsingTree(Uri.parse(treeUriStr), docId)
        } catch (_: Exception) {
            null
        }
    }

    data class CatalogSyncOutcome(val changedRows: Int, val syncedCount: Int, val errorMessage: String? = null)

    private data class ExistingPhoneRow(
        val id: Long, val fileSize: Long, val rating: Int, val directoryPath: String,
        val dateTaken: String, val cameraModel: String, val width: Int, val height: Int,
        val hasLens: Boolean, val hasExposure: Boolean, val hasGps: Boolean
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
                        content_key TEXT, stack_id INTEGER, is_stack_primary INTEGER DEFAULT 1, stack_type TEXT,
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

        // 1. DBロックの外側で MediaStore と既存スマホ行情報を取得（並列読み取り・I/O分離）
        val mediaFastMap = if (rawItems.isNotEmpty()) loadMediaStoreFastMetaMap() else emptyMap()
        val knownExifStateByPath = HashMap<String, Boolean>()
        if (lockerDbManager.hasLockerDatabase() && rawItems.isNotEmpty()) {
            try {
                val arr = JSONArray(
                    lockerDbManager.rawQuerySafeJson(
                        "SELECT file_path, COALESCE(camera_model, '') AS cam, f_number, COALESCE(shutter_speed, '') AS ss, iso, focal_length FROM photos WHERE id >= $PHONE_LOCAL_ID_BASE OR IFNULL(volume_serial, '') = '$ANDROID_LOCAL_VSN'",
                        "[]"
                    )
                )
                for (i in 0 until arr.length()) {
                    val o = arr.optJSONObject(i) ?: continue
                    val fp = o.optString("file_path", "")
                    if (fp.isEmpty()) continue
                    val cam = o.optString("cam", "").trim()
                    val hasExp = !o.isNull("f_number") || o.optString("ss", "").trim().isNotEmpty() || !o.isNull("iso") || !o.isNull("focal_length")
                    knownExifStateByPath[fp] = cam.isNotEmpty() && hasExp
                }
            } catch (_: Exception) {}
        }

        val preExifMap = HashMap<String, PhoneExifMeta>()
        var preExifCount = 0
        for (pass in 0..1) {
            if (preExifCount >= MAX_PRE_SYNC_EXIF_READS) break
            for (item in rawItems) {
                if (preExifCount >= MAX_PRE_SYNC_EXIF_READS) break
                val fileSize = item.optLong("fileSize", 0L)
                if (fileSize <= 0L) continue
                val fileName = item.optString("fileName", "")
                val docKey = item.optString("docKey", "")
                if (docKey.isEmpty() || fileName.isEmpty() || docKey in preExifMap) continue
                val hasState = knownExifStateByPath["phone://$docKey"]
                val inMotherSizes = fileSize in lookup.motherSizes
                val isThmod = item.optBoolean("isThmod", false) || fileName.lowercase(Locale.US).startsWith("thmod_")
                val isPriority = hasState == null || inMotherSizes || isThmod
                val shouldRead = if (pass == 0) isPriority else (hasState == false)
                if (shouldRead) {
                    preExifCount++
                    preExifMap[docKey] = extractPhoneExifMeta(docKey, fileName, item.optLong("lastModifiedMs", 0L), decodeDocKeyFn, fileSize)
                }
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
                val hasLensCol = "lens_model" in photoCols
                val hasExpCols = "f_number" in photoCols && "shutter_speed" in photoCols && "iso" in photoCols
                val hasGpsCols = "latitude" in photoCols && "longitude" in photoCols
                val lensExpr = if (hasLensCol) "CASE WHEN COALESCE(lens_model, '') != '' THEN 1 ELSE 0 END" else "1"
                val expExpr = if (hasExpCols) "CASE WHEN f_number IS NOT NULL OR COALESCE(shutter_speed, '') != '' OR iso IS NOT NULL THEN 1 ELSE 0 END" else "1"
                val gpsExpr = if (hasGpsCols) "CASE WHEN latitude IS NOT NULL AND longitude IS NOT NULL THEN 1 ELSE 0 END" else "1"
                db.rawQuery(
                    "SELECT id, file_path, COALESCE(file_size, 0), COALESCE(rating, 0), COALESCE(directory_path, ''), COALESCE(date_taken, ''), COALESCE(camera_model, ''), COALESCE(width, 0), COALESCE(height, 0), $lensExpr, $expExpr, $gpsExpr FROM photos WHERE id >= $PHONE_LOCAL_ID_BASE OR IFNULL(volume_serial, '') = '$ANDROID_LOCAL_VSN'",
                    null
                ).use { c ->
                    while (c.moveToNext()) {
                        val pid = c.getLong(0); val fp = c.getString(1) ?: continue
                        existingPhoneRows[fp] = ExistingPhoneRow(
                            pid, c.getLong(2), c.getInt(3), c.getString(4) ?: "",
                            c.getString(5) ?: "", c.getString(6) ?: "", c.getInt(7), c.getInt(8),
                            c.getInt(9) == 1, c.getInt(10) == 1, c.getInt(11) == 1
                        )
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
                            val patchW = if (existing.width <= 0) {
                                if ((preExif?.width ?: 0) > 0) preExif!!.width
                                else if ((fastMeta?.width ?: 0) > 0) fastMeta!!.width else 0
                            } else 0
                            val patchH = if (existing.height <= 0) {
                                if ((preExif?.height ?: 0) > 0) preExif!!.height
                                else if ((fastMeta?.height ?: 0) > 0) fastMeta!!.height else 0
                            } else 0
                            val preCam = preExif?.let { it.cameraModel.ifEmpty { it.cameraMake } }?.trim() ?: ""
                            val patchCam = if (existing.cameraModel.isEmpty() && preCam.isNotEmpty()) preCam else ""
                            val patchDt = if (existing.cameraModel.isEmpty() && (preExif?.dateTaken?.length ?: 0) >= 19) preExif!!.dateTaken else ""
                            val patchLens = if (!existing.hasLens && !(preExif?.lensModel.isNullOrEmpty())) preExif!!.lensModel else ""
                            val needsExpPatch = !existing.hasExposure && preExif != null && (
                                preExif.fNumber != null || preExif.shutterSpeed.isNotEmpty() || preExif.iso != null || preExif.focalLength != null
                            )
                            val needsGpsPatch = !existing.hasGps && preExif?.latitude != null && preExif.longitude != null
                            if (existing.fileSize != fileSize || existing.directoryPath != phoneDirPath || patchW > 0 || patchCam.isNotEmpty() || patchDt.isNotEmpty() || patchLens.isNotEmpty() || needsExpPatch || needsGpsPatch) {
                                val cv = ContentValues().apply {
                                    put("file_size", fileSize); put("file_mtime", lastModMs / 1000.0); put("directory_path", phoneDirPath)
                                    if ("is_unlinked" in photoCols) put("is_unlinked", 0)
                                    if (patchW > 0 && "width" in photoCols) put("width", patchW)
                                    if (patchH > 0 && "height" in photoCols) put("height", patchH)
                                    if (patchCam.isNotEmpty() && "camera_model" in photoCols) put("camera_model", patchCam)
                                    if (patchDt.isNotEmpty() && "date_taken" in photoCols) {
                                        put("date_taken", patchDt)
                                        if ("original_date_taken" in photoCols) put("original_date_taken", patchDt)
                                        if ("year_month" in photoCols) put("year_month", patchDt.take(7))
                                    }
                                    if (patchLens.isNotEmpty() && "lens_model" in photoCols) put("lens_model", patchLens)
                                    if (needsExpPatch && preExif != null) {
                                        if (preExif.focalLength != null && "focal_length" in photoCols) put("focal_length", preExif.focalLength)
                                        if (preExif.fNumber != null && "f_number" in photoCols) put("f_number", preExif.fNumber)
                                        if (preExif.shutterSpeed.isNotEmpty() && "shutter_speed" in photoCols) put("shutter_speed", preExif.shutterSpeed)
                                        if (preExif.iso != null && "iso" in photoCols) put("iso", preExif.iso)
                                    }
                                    if (needsGpsPatch && preExif != null) {
                                        if ("latitude" in photoCols) put("latitude", preExif.latitude)
                                        if ("longitude" in photoCols) put("longitude", preExif.longitude)
                                    }
                                }
                                db.update("photos", cv, "id = ?", arrayOf(targetId.toString()))
                                if (patchCam.isNotEmpty() || patchDt.isNotEmpty() || needsGpsPatch) {
                                    dbCurationMap[targetId]?.let { cur ->
                                        dbCurationMap[targetId] = cur.copy(
                                            dateTaken = patchDt.ifEmpty { cur.dateTaken },
                                            cameraModel = patchCam.ifEmpty { cur.cameraModel },
                                            lat = if (needsGpsPatch) preExif?.latitude else cur.lat,
                                            lon = if (needsGpsPatch) preExif?.longitude else cur.lon
                                        )
                                    }
                                }
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
                    stackPhoneLocalThmodDerivatives(db, photoCols)

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

    /** Android 10+ のGPS黒塗り(Redaction)を回避し、MediaStore.setRequireOriginal 経由またはローカルfile://で原本ストリームを開く */
    fun openOriginalPhotoStream(docUri: Uri, fileName: String = "", fileSize: Long = 0L): InputStream? {
        if (docUri.scheme == "file") {
            val localPath = docUri.path ?: return null
            return try {
                val f = File(localPath)
                if (f.isFile) FileInputStream(f) else null
            } catch (_: Exception) {
                null
            }
        }
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

    /** 原本ストリームのEXIFから撮影日時(YYYY-MM-DD HH:MM:SS)とカメラ機種名を直接読み取る */
    fun extractExifDateAndCamera(docUri: Uri, fileName: String, lastModMs: Long): Pair<String, String> {
        var dateTaken = ""
        var cameraModel = ""
        try {
            openOriginalPhotoStream(docUri, fileName, 0L)?.use { ins ->
                val exif = ExifInterface(ins)
                val rawDt = (exif.getAttribute(ExifInterface.TAG_DATETIME_ORIGINAL)
                    ?: exif.getAttribute(ExifInterface.TAG_DATETIME) ?: "").trim()
                val m = EXIF_DATE_PREFIX_REGEX.matchEntire(rawDt)
                if (m != null) {
                    dateTaken = "${m.groupValues[1]}-${m.groupValues[2]}-${m.groupValues[3]}${m.groupValues[4]}"
                }
                val mk = (exif.getAttribute(ExifInterface.TAG_MAKE) ?: "").trim()
                val md = (exif.getAttribute(ExifInterface.TAG_MODEL) ?: "").trim()
                cameraModel = md.ifEmpty { mk }
            }
        } catch (_: Exception) {}
        if (dateTaken.isEmpty()) {
            dateTaken = buildFallbackExifMeta(fileName, lastModMs).dateTaken
        }
        return dateTaken to cameraModel
    }

    /** ロッカーDB上のスマホ写真(phone:// スキーム)に付けられた最新の評価・タグマップを一括ロードする */
    fun loadPhoneLocalCurations(): Map<String, Pair<Int, List<String>>> {
        val out = HashMap<String, Pair<Int, List<String>>>()
        if (!lockerDbManager.hasLockerDatabase()) return out
        try {
            val rowsJson = lockerDbManager.rawQuerySafeJson(
                "SELECT id, file_path, COALESCE(rating, 0) AS rating FROM photos WHERE file_path LIKE 'phone://%' AND IFNULL(is_unlinked, 0) = 0",
                "[]"
            )
            val tagsJson = lockerDbManager.rawQuerySafeJson(
                "SELECT pt.photo_id, pt.tag FROM photo_tags pt JOIN photos p ON p.id = pt.photo_id WHERE p.file_path LIKE 'phone://%' AND IFNULL(p.is_unlinked, 0) = 0 ORDER BY pt.tag ASC",
                "[]"
            )
            val tagsByPid = HashMap<Long, MutableList<String>>()
            val tArr = JSONArray(tagsJson)
            for (i in 0 until tArr.length()) {
                val o = tArr.optJSONObject(i) ?: continue
                val pid = o.optLong("photo_id", 0L)
                val tag = (o.optString("tag", "")).trim()
                if (pid > 0L && tag.isNotEmpty()) {
                    tagsByPid.getOrPut(pid) { mutableListOf() }.add(tag)
                }
            }
            val pArr = JSONArray(rowsJson)
            for (i in 0 until pArr.length()) {
                val o = pArr.optJSONObject(i) ?: continue
                val pid = o.optLong("id", 0L)
                val fp = o.optString("file_path", "")
                if (!fp.startsWith("phone://")) continue
                val dk = fp.removePrefix("phone://").trim()
                if (dk.isEmpty()) continue
                val rate = o.optInt("rating", 0)
                val tList = tagsByPid[pid] ?: emptyList()
                out[dk] = rate to tList
            }
        } catch (e: Exception) {
            Log.d(TAG, "ローカルキュレーション読込スキップ: ${e.message}")
        }
        return out
    }

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
        docKey: String,
        fileName: String,
        lastModMs: Long,
        decodeDocKeyFn: (String) -> Pair<String, String>?,
        fileSize: Long = 0L
    ): PhoneExifMeta {
        val base = buildFallbackExifMeta(fileName, lastModMs)
        var dateTaken = base.dateTaken
        var cameraMake = ""; var cameraModel = ""; var lensModel = ""; var shutterSpeed = ""
        var focalLength: Double? = null; var fNumber: Double? = null; var iso: Int? = null
        var width = 0; var height = 0; var lat: Double? = null; var lon: Double? = null

        val pair = decodeDocKeyFn(docKey)
        if (pair != null) {
            try {
                val docUri = buildLocalOrDocumentUri(pair.first, pair.second)
                if (docUri != null) {
                    openOriginalPhotoStream(docUri, fileName, fileSize)?.use { ins ->
                        val exif = ExifInterface(ins)
                        val rawDt = (exif.getAttribute(ExifInterface.TAG_DATETIME_ORIGINAL) ?: exif.getAttribute(ExifInterface.TAG_DATETIME) ?: "").trim()
                        val m = EXIF_DATE_PREFIX_REGEX.matchEntire(rawDt)
                        if (m != null) dateTaken = "${m.groupValues[1]}-${m.groupValues[2]}-${m.groupValues[3]}${m.groupValues[4]}"
                        cameraMake = (exif.getAttribute(ExifInterface.TAG_MAKE) ?: "").trim()
                        cameraModel = (exif.getAttribute(ExifInterface.TAG_MODEL) ?: "").trim()
                        if (cameraModel.isEmpty() && cameraMake.isNotEmpty()) cameraModel = cameraMake
                        val rawLens = (exif.getAttribute("LensModel")
                            ?: exif.getAttribute("LensSpecification")
                            ?: exif.getAttribute("LensMake")
                            ?: "").trim()
                        lensModel = if (rawLens != "----" && rawLens != "不明") rawLens else ""
                        focalLength = exif.getAttributeDouble(ExifInterface.TAG_FOCAL_LENGTH, -1.0).takeIf { it > 0.0 }
                            ?: exif.getAttributeDouble("FocalLengthIn35mmFilm", -1.0).takeIf { it > 0.0 }
                        val rawF = exif.getAttributeDouble(ExifInterface.TAG_F_NUMBER, -1.0).takeIf { it > 0.0 }
                        fNumber = rawF ?: exif.getAttributeDouble(ExifInterface.TAG_APERTURE_VALUE, -1.0).takeIf { it > 0.0 }?.let { apex ->
                            Math.round(Math.pow(2.0, apex / 2.0) * 100.0) / 100.0
                        }
                        shutterSpeed = formatExposureTime(exif.getAttribute(ExifInterface.TAG_EXPOSURE_TIME))
                        val rawIso = (exif.getAttribute("PhotographicSensitivity")
                            ?: exif.getAttribute(ExifInterface.TAG_ISO_SPEED_RATINGS)
                            ?: exif.getAttribute("ISOSpeed")
                            ?: exif.getAttribute("RecommendedExposureIndex")
                            ?: "").trim()
                        iso = rawIso.split(',', ' ').firstOrNull { it.isNotBlank() }?.trim()?.toIntOrNull()?.takeIf { it > 0 }
                        width = exif.getAttributeInt(ExifInterface.TAG_IMAGE_WIDTH, 0)
                        height = exif.getAttributeInt(ExifInterface.TAG_IMAGE_LENGTH, 0)
                        val latLong = FloatArray(2)
                        if (exif.getLatLong(latLong)) { lat = latLong[0].toDouble(); lon = latLong[1].toDouble() }
                    }
                }
            } catch (_: Exception) {}
        }

        val ym = if (dateTaken.length >= 7) dateTaken.substring(0, 7) else base.yearMonth
        return PhoneExifMeta(dateTaken, ym, cameraMake, cameraModel, lensModel, focalLength, fNumber, shutterSpeed, iso, width, height, lat, lon)
    }

    /** GPS座標から国・都道府県・市区町村を短時間タイムアウト付きで逆ジオコーディングする */
    @Suppress("DEPRECATION")
    private fun reverseGeocodeQuick(lat: Double, lon: Double): Triple<String, String, String>? {
        if (!Geocoder.isPresent()) return null
        if (abs(lat) < 0.0001 && abs(lon) < 0.0001) return null
        var result: Triple<String, String, String>? = null
        val latch = CountDownLatch(1)
        Thread({
            try {
                val geocoder = Geocoder(context, Locale.getDefault())
                val list = geocoder.getFromLocation(lat, lon, 1)
                val addr = list?.firstOrNull()
                if (addr != null) {
                    val country = (addr.countryName ?: "").trim()
                    val state = (addr.adminArea ?: "").trim()
                    val city = (addr.locality ?: addr.subAdminArea ?: addr.featureName ?: "").trim()
                    if (country.isNotEmpty() || state.isNotEmpty() || city.isNotEmpty()) {
                        result = Triple(country, state, city)
                    }
                }
            } catch (_: Exception) {
            } finally {
                latch.countDown()
            }
        }, "PhoneGeoQuick").apply { isDaemon = true; start() }
        try {
            latch.await(600, TimeUnit.MILLISECONDS)
        } catch (_: InterruptedException) {}
        return result
    }

    /** スマホ内写真(および紐付け写真)の未取得EXIF・露出設定・GPS地名を実ファイルからオンデマンド補完しDBへ保存する */
    fun ensurePhotoExifHydratedJson(photoId: Long, decodeDocKeyFn: (String) -> Pair<String, String>?): String {
        if (photoId <= 0L || !lockerDbManager.hasLockerDatabase()) {
            return JSONObject().put("ok", false).put("error", "invalid_photo_id").toString()
        }
        try {
            val arr = JSONArray(
                lockerDbManager.rawQuerySafeJson(
                    "SELECT id, file_path, file_name, COALESCE(file_size, 0) AS file_size, COALESCE(file_mtime, 0) AS file_mtime, " +
                        "COALESCE(date_taken, '') AS date_taken, COALESCE(camera_model, '') AS camera_model, COALESCE(lens_model, '') AS lens_model, " +
                        "focal_length, f_number, COALESCE(shutter_speed, '') AS shutter_speed, iso, COALESCE(width, 0) AS width, COALESCE(height, 0) AS height, " +
                        "latitude, longitude, COALESCE(country, '') AS country, COALESCE(state, '') AS state, COALESCE(city, '') AS city " +
                        "FROM photos WHERE id = ? LIMIT 1",
                    JSONArray().put(photoId.toString()).toString()
                )
            )
            val row = arr.optJSONObject(0)
                ?: return JSONObject().put("ok", false).put("error", "not_found").toString()

            val fileName = row.optString("file_name", "").trim()
            val fileSize = row.optLong("file_size", 0L)
            val lastModMs = (row.optDouble("file_mtime", 0.0) * 1000.0).toLong()
            var dateTaken = row.optString("date_taken", "").trim()
            var cameraModel = row.optString("camera_model", "").trim()
            var lensModel = row.optString("lens_model", "").trim()
            var focalLength: Double? = if (!row.isNull("focal_length")) row.optDouble("focal_length").takeIf { it > 0.0 } else null
            var fNumber: Double? = if (!row.isNull("f_number")) row.optDouble("f_number").takeIf { it > 0.0 } else null
            val rawShutter = row.optString("shutter_speed", "").trim()
            var shutterSpeed = formatExposureTime(rawShutter)
            var iso: Int? = if (!row.isNull("iso")) row.optInt("iso").takeIf { it > 0 } else null
            var width = row.optInt("width", 0)
            var height = row.optInt("height", 0)
            var lat: Double? = if (!row.isNull("latitude")) row.optDouble("latitude") else null
            var lon: Double? = if (!row.isNull("longitude")) row.optDouble("longitude") else null
            var country = row.optString("country", "").trim()
            var state = row.optString("state", "").trim()
            var city = row.optString("city", "").trim()

            val needsFileExif = cameraModel.isEmpty() || lensModel.isEmpty() ||
                (fNumber == null && shutterSpeed.isEmpty() && iso == null && focalLength == null) ||
                lat == null || lon == null || width <= 0 || height <= 0
            var changed = shutterSpeed.isNotEmpty() && shutterSpeed != rawShutter

            if (needsFileExif) {
                val docKey = resolveDocKeyForPhotoId(photoId)
                if (!docKey.isNullOrEmpty() && fileName.isNotEmpty()) {
                    val meta = extractPhoneExifMeta(docKey, fileName, lastModMs, decodeDocKeyFn, fileSize)
                    val effCam = meta.cameraModel.ifEmpty { meta.cameraMake }.trim()
                    if (cameraModel.isEmpty() && effCam.isNotEmpty()) { cameraModel = effCam; changed = true }
                    if (lensModel.isEmpty() && meta.lensModel.isNotEmpty()) { lensModel = meta.lensModel; changed = true }
                    if (focalLength == null && meta.focalLength != null) { focalLength = meta.focalLength; changed = true }
                    if (fNumber == null && meta.fNumber != null) { fNumber = meta.fNumber; changed = true }
                    if (shutterSpeed.isEmpty() && meta.shutterSpeed.isNotEmpty()) { shutterSpeed = meta.shutterSpeed; changed = true }
                    if (iso == null && meta.iso != null) { iso = meta.iso; changed = true }
                    if (width <= 0 && meta.width > 0) { width = meta.width; changed = true }
                    if (height <= 0 && meta.height > 0) { height = meta.height; changed = true }
                    if ((lat == null || lon == null) && meta.latitude != null && meta.longitude != null) {
                        lat = meta.latitude; lon = meta.longitude; changed = true
                    }
                    if (dateTaken.isEmpty() && meta.dateTaken.isNotEmpty()) {
                        dateTaken = meta.dateTaken; changed = true
                    } else if (cameraModel.isNotEmpty() && row.optString("camera_model", "").isEmpty() && meta.dateTaken.length >= 19) {
                        if (dateTaken != meta.dateTaken) { dateTaken = meta.dateTaken; changed = true }
                    }
                }
            }

            if (lat != null && lon != null && country.isEmpty() && state.isEmpty() && city.isEmpty()) {
                val geo = reverseGeocodeQuick(lat, lon)
                if (geo != null) {
                    country = geo.first; state = geo.second; city = geo.third
                    changed = true
                }
            }

            if (changed) {
                lockerDbManager.withWritableDatabase(createIfMissing = false) { db ->
                    val cols = HashSet<String>()
                    db.rawQuery("PRAGMA table_info(photos)", null).use { c ->
                        while (c.moveToNext()) cols.add(c.getString(1) ?: "")
                    }
                    val cv = ContentValues().apply {
                        if (cameraModel.isNotEmpty() && "camera_model" in cols) put("camera_model", cameraModel)
                        if (lensModel.isNotEmpty() && "lens_model" in cols) put("lens_model", lensModel)
                        if (focalLength != null && "focal_length" in cols) put("focal_length", focalLength)
                        if (fNumber != null && "f_number" in cols) put("f_number", fNumber)
                        if (shutterSpeed.isNotEmpty() && "shutter_speed" in cols) put("shutter_speed", shutterSpeed)
                        if (iso != null && "iso" in cols) put("iso", iso)
                        if (width > 0 && "width" in cols) put("width", width)
                        if (height > 0 && "height" in cols) put("height", height)
                        if (lat != null && lon != null && "latitude" in cols && "longitude" in cols) {
                            put("latitude", lat); put("longitude", lon)
                        }
                        if (dateTaken.isNotEmpty() && "date_taken" in cols) {
                            put("date_taken", dateTaken)
                            if ("original_date_taken" in cols) put("original_date_taken", dateTaken)
                            if ("year_month" in cols && dateTaken.length >= 7) put("year_month", dateTaken.take(7))
                        }
                        if (country.isNotEmpty() && "country" in cols) put("country", country)
                        if (state.isNotEmpty() && "state" in cols) put("state", state)
                        if (city.isNotEmpty() && "city" in cols) put("city", city)
                    }
                    if (cv.size() > 0) db.update("photos", cv, "id = ?", arrayOf(photoId.toString()))
                }
            }

            val outPhoto = JSONObject()
                .put("id", photoId)
                .put("date_taken", dateTaken)
                .put("camera_model", cameraModel)
                .put("lens_model", lensModel)
                .put("shutter_speed", shutterSpeed)
                .put("width", width)
                .put("height", height)
                .put("country", country)
                .put("state", state)
                .put("city", city)
            if (focalLength != null) outPhoto.put("focal_length", focalLength)
            if (fNumber != null) outPhoto.put("f_number", fNumber)
            if (iso != null) outPhoto.put("iso", iso)
            if (lat != null && lon != null) outPhoto.put("latitude", lat).put("longitude", lon)

            return JSONObject().put("ok", true).put("updated", changed).put("photo", outPhoto).toString()
        } catch (e: Exception) {
            Log.w(TAG, "EXIFオンデマンド補完警告 (id=$photoId): ${e.message}")
            return JSONObject().put("ok", false).put("error", e.message ?: "exif_hydrate_error").toString()
        }
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

    /** スマホ内 library.db 上で thmod_<stem> 派生画像を対応する元写真へスタック結合する（元写真を常に代表保護） */
    private fun stackPhoneLocalThmodDerivatives(db: SQLiteDatabase, photoCols: Set<String>) {
        if ("stack_id" !in photoCols || "is_stack_primary" !in photoCols) return
        val hasStackType = "stack_type" in photoCols
        val hasOrigDt = "original_date_taken" in photoCols
        val origDtSel = if (hasOrigDt) "COALESCE(original_date_taken, '')" else "''"
        val stackTypeSel = if (hasStackType) "COALESCE(stack_type, '')" else "''"
        val pairedSel = if ("paired_raw_path" in photoCols) "COALESCE(paired_raw_path, '')" else "''"

        data class StackRow(
            val id: Long,
            val fileName: String,
            val dateTaken: String,
            val cameraModel: String,
            val stackId: Long?,
            val isPrimary: Int,
            val stackType: String,
            val isRaw: Int,
            val pairedRaw: String
        )

        val thmodRows = ArrayList<StackRow>()
        val parentsByStem = HashMap<String, ArrayList<StackRow>>()

        try {
            db.rawQuery(
                "SELECT id, file_name, COALESCE(date_taken, ''), $origDtSel, COALESCE(camera_model, ''), stack_id, COALESCE(is_stack_primary, 1), $stackTypeSel, COALESCE(is_raw, 0), $pairedSel FROM photos WHERE IFNULL(is_unlinked, 0) = 0",
                null
            ).use { c ->
                while (c.moveToNext()) {
                    val fn = (c.getString(1) ?: "").trim()
                    if (fn.isEmpty()) continue
                    val dt = (c.getString(3) ?: "").trim().ifEmpty { (c.getString(2) ?: "").trim() }
                    val row = StackRow(
                        id = c.getLong(0),
                        fileName = fn,
                        dateTaken = dt,
                        cameraModel = (c.getString(4) ?: "").trim(),
                        stackId = if (c.isNull(5)) null else c.getLong(5),
                        isPrimary = c.getInt(6),
                        stackType = (c.getString(7) ?: "").trim(),
                        isRaw = c.getInt(8),
                        pairedRaw = (c.getString(9) ?: "").trim()
                    )
                    if (fn.lowercase(Locale.US).startsWith("thmod_")) {
                        thmodRows.add(row)
                    } else {
                        val stem = normalizeCameraStem(fn)
                        if (stem.isNotEmpty()) parentsByStem.getOrPut(stem) { ArrayList() }.add(row)
                    }
                }
            }
        } catch (e: Exception) {
            Log.d(TAG, "thmodスタック結合走査スキップ: ${e.message}")
            return
        }

        if (thmodRows.isEmpty() || parentsByStem.isEmpty()) return

        for (th in thmodRows) {
            val st = normalizeCameraStem(th.fileName)
            val cands = parentsByStem[st] ?: continue
            val thEpoch = normalizeDateEpochSec(th.dateTaken)
            val matched = ArrayList<StackRow>()

            if (thEpoch != null) {
                for (cand in cands) {
                    if (!cameraModelsCompatible(th.cameraModel, cand.cameraModel)) continue
                    val cEpoch = normalizeDateEpochSec(cand.dateTaken)
                    if (cEpoch != null && abs(thEpoch - cEpoch) <= 2L) matched.add(cand)
                }
            }
            if (matched.isEmpty()) {
                // EXIF消去等で日時比較できない場合でも、元写真候補が実質1コマ（同一秒または単一ペア）なら結合
                val distinctShots = cands.map { it.dateTaken.ifEmpty { it.id.toString() } }.toSet()
                if (distinctShots.size == 1) matched.addAll(cands)
            }
            if (matched.isEmpty()) continue

            matched.sortWith(
                compareBy<StackRow>(
                    { if (it.isRaw == 1 && it.pairedRaw.isNotEmpty()) 1 else 0 },
                    { it.isRaw },
                    { -it.isPrimary },
                    { it.id }
                )
            )
            val repParent = matched[0]
            val targetStackId = repParent.stackId ?: repParent.id
            val targetStackType = repParent.stackType.ifEmpty { "burst" }
            if (th.stackId == targetStackId) continue

            if (repParent.stackId == null) {
                for (mc in matched) {
                    val isPri = if (mc.id == repParent.id) 1 else 0
                    if (hasStackType) {
                        db.execSQL(
                            "UPDATE photos SET stack_id = ?, is_stack_primary = ?, stack_type = ? WHERE id = ?",
                            arrayOf(targetStackId, isPri, targetStackType, mc.id)
                        )
                    } else {
                        db.execSQL(
                            "UPDATE photos SET stack_id = ?, is_stack_primary = ? WHERE id = ?",
                            arrayOf(targetStackId, isPri, mc.id)
                        )
                    }
                }
            }
            if (hasStackType) {
                db.execSQL(
                    "UPDATE photos SET stack_id = ?, is_stack_primary = 0, stack_type = ? WHERE id = ?",
                    arrayOf(targetStackId, targetStackType, th.id)
                )
            } else {
                db.execSQL(
                    "UPDATE photos SET stack_id = ?, is_stack_primary = 0 WHERE id = ?",
                    arrayOf(targetStackId, th.id)
                )
            }
        }
    }
}
