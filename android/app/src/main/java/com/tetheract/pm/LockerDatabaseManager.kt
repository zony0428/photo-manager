package com.tetheract.pm

import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.locks.ReentrantReadWriteLock

/**
 * スマホ内専用ロッカーの library.db と独立ジャーナル pending_journal.db を管理するクラス。
 * v1.7.0+ の _v170_guard 仮想生成列・トリガーを含むスキーマにも安全に対応する。
 */
class LockerDatabaseManager(private val context: Context) {

    companion object {
        private const val TAG = "LockerDatabaseManager"
        private const val NOT_PAIRED_RAW = "NOT (COALESCE(is_raw, 0) = 1 AND paired_raw_path IS NOT NULL AND paired_raw_path != '')"
        private const val NOT_PAIRED_RAW_P = "NOT (COALESCE(p.is_raw, 0) = 1 AND p.paired_raw_path IS NOT NULL AND p.paired_raw_path != '')"
        private val COLOR_TAGS = arrayOf(
            "赤", "青", "緑", "黄色", "黒", "白",
            "銀・シルバー", "金・ゴールド", "茶色", "紫", "オレンジ", "ピンク"
        )
        private val WRITE_SQL_REGEX = Regex(
            "\\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|ATTACH|DETACH|VACUUM|REINDEX)\\b|\\bREPLACE\\s+INTO\\b",
            RegexOption.IGNORE_CASE
        )
        private val READONLY_PRAGMA_REGEX = Regex(
            "^PRAGMA\\s+(\\w+\\.)?(table_info|table_xinfo|index_list|index_info)\\s*\\(",
            RegexOption.IGNORE_CASE
        )
    }

    val lockerDir: File = File(context.filesDir, "locker").apply { mkdirs() }
    val libraryDbFile: File = File(lockerDir, "library.db")
    val journalDbFile: File = File(lockerDir, "pending_journal.db")
    private val metaFile: File = File(lockerDir, "locker_meta.json")

    private val dbRwLock = ReentrantReadWriteLock()
    private val journalLock = Any()
    private val metaLock = Any()
    private val journal = PendingJournalStore(journalDbFile, journalLock) { formatLocalNow() }
    val watermarkStore = WatermarkAssetStore(context.applicationContext, this)
    @Volatile
    private var libraryDb: SQLiteDatabase? = null
    @Volatile
    private var safePhotoColumnExpr: String? = null

    private inline fun <T> withReadLock(block: () -> T): T {
        val rl = dbRwLock.readLock()
        rl.lock()
        return try {
            block()
        } finally {
            rl.unlock()
        }
    }

    private inline fun <T> withWriteLock(block: () -> T): T {
        check(dbRwLock.isWriteLockedByCurrentThread || dbRwLock.readHoldCount == 0) {
            "同一スレッド上での readLock から writeLock への昇格は禁止されています"
        }
        val wl = dbRwLock.writeLock()
        wl.lock()
        return try {
            block()
        } finally {
            wl.unlock()
        }
    }

    /** 共有読み取りロック下で開いている library.db を並列参照する（未オープン時はロック獲得前に安全初期化する） */
    private inline fun <T> withReadableDatabase(block: (SQLiteDatabase) -> T): T? {
        if (!dbRwLock.isWriteLockedByCurrentThread && dbRwLock.readHoldCount == 0) {
            val fast = libraryDb
            if (fast == null || !fast.isOpen) {
                ensureLibraryDbOpen(createIfMissing = false) ?: return null
            }
        }
        return withReadLock {
            val db = libraryDb?.takeIf { it.isOpen } ?: return@withReadLock null
            block(db)
        }
    }

    private fun execPragmaSafe(db: SQLiteDatabase, pragmaSql: String) {
        try { db.rawQuery(pragmaSql, null).use { it.moveToFirst() } } catch (e: Exception) { Log.d(TAG, "PRAGMA skip ($pragmaSql): ${e.message}") }
    }

    fun formatLocalNow(): String = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US).format(Date())

    fun hasLockerDatabase(): Boolean =
        libraryDbFile.exists() && (libraryDbFile.length() >= 4096L || File(lockerDir, "library.db-wal").length() > 0L)

    internal fun <T> withWritableDatabase(createIfMissing: Boolean = false, block: (SQLiteDatabase) -> T): T? = withWriteLock {
        val db = ensureLibraryDbOpen(createIfMissing) ?: return@withWriteLock null
        block(db)
    }

    internal fun refreshSafeColumnCache() = withWriteLock {
        libraryDb?.takeIf { it.isOpen }?.let { safePhotoColumnExpr = buildSafePhotoSelectColumns(it) }
    }

    fun readLockerMeta(): JSONObject = synchronized(metaLock) {
        if (!metaFile.exists()) JSONObject() else try {
            JSONObject(metaFile.readText(Charsets.UTF_8))
        } catch (e: Exception) {
            Log.w(TAG, "ロッカーメタデータ読込失敗", e); JSONObject()
        }
    }

    fun writeLockerMeta(meta: JSONObject) = synchronized(metaLock) {
        try { metaFile.writeText(meta.toString(2), Charsets.UTF_8) } catch (e: Exception) { Log.w(TAG, "ロッカーメタデータ保存失敗", e) }
    }

    /** 現在ロッカーに格納されている library.db の固有識別子 (library_id) を返す */
    fun readLocalLibraryId(): String {
        val fromMeta = readLockerMeta().optString("library_id", "").trim()
        if (fromMeta.isNotEmpty()) return fromMeta
        return withReadableDatabase { db ->
            try {
                db.rawQuery("SELECT value FROM app_meta WHERE key = 'library_id' LIMIT 1", null).use { c ->
                    if (c.moveToFirst()) (c.getString(0) ?: "").trim() else ""
                }
            } catch (_: Exception) { "" }
        } ?: ""
    }

    /** 現在ロッカーに格納されているライブラリの owner_id (エシカル保護識別子) を返す */
    fun readLocalOwnerId(): String {
        val fromMeta = readLockerMeta().optString("owner_id", "").trim()
        if (fromMeta.isNotEmpty()) return fromMeta
        return withReadableDatabase { db ->
            try {
                db.rawQuery("SELECT value FROM security_meta WHERE key = 'owner_id' LIMIT 1", null).use { c ->
                    if (c.moveToFirst()) (c.getString(0) ?: "").trim() else ""
                }
            } catch (_: Exception) { "" }
        } ?: ""
    }

    /** 一時SQLiteファイルから owner_id を読み取る */
    fun extractSqliteOwnerId(sqliteFile: File, isDelta: Boolean): String {
        if (!sqliteFile.exists() || sqliteFile.length() < 100L) return ""
        val tbl = if (isDelta) "delta_meta" else "security_meta"
        return try {
            SQLiteDatabase.openDatabase(sqliteFile.absolutePath, null, SQLiteDatabase.OPEN_READONLY).use { tmpDb ->
                tmpDb.rawQuery("SELECT value FROM $tbl WHERE key = 'owner_id' LIMIT 1", null).use { c ->
                    if (c.moveToFirst()) (c.getString(0) ?: "").trim() else ""
                }
            }
        } catch (_: Exception) { "" }
    }

    /** 一時SQLiteファイル (library.db または mobile_delta.db) から library_id を読み取る */
    fun extractSqliteLibraryId(sqliteFile: File, isDelta: Boolean): String {
        if (!sqliteFile.exists() || sqliteFile.length() < 100L) return ""
        val tbl = if (isDelta) "delta_meta" else "app_meta"
        return try {
            SQLiteDatabase.openDatabase(sqliteFile.absolutePath, null, SQLiteDatabase.OPEN_READONLY).use { tmpDb ->
                tmpDb.rawQuery("SELECT value FROM $tbl WHERE key = 'library_id' LIMIT 1", null).use { c ->
                    if (c.moveToFirst()) (c.getString(0) ?: "").trim() else ""
                }
            }
        } catch (_: Exception) { "" }
    }

    /** 別サーバー／別USBライブラリへの切り替え承認時に、現ロッカーと未送信ジャーナルを全破棄する */
    fun resetLockerAndJournalForSwitch() = withWriteLock {
        clearPendingJournal()
        closeLibraryDatabase()
        libraryDbFile.delete()
        File(lockerDir, "library.db-wal").delete()
        File(lockerDir, "library.db-shm").delete()
        synchronized(metaLock) { metaFile.delete() }
    }

    fun closeLibraryDatabase() = withWriteLock {
        try {
            libraryDb?.close()
        } catch (e: Exception) {
            Log.w(TAG, "library.db クローズ警告", e)
        } finally {
            libraryDb = null
            safePhotoColumnExpr = null
        }
    }

    /** 新しい library.db 本体ファイルがロッカーへ配置された直後に初期化・ジャーナル再適用を行う */
    fun onNewDatabaseCopied(): Int = withWriteLock {
        closeLibraryDatabase()
        File(lockerDir, "library.db-wal").delete()
        File(lockerDir, "library.db-shm").delete()
        ensureLibraryDbOpen()
        replayPendingJournal()
    }

    /** 一時ダウンロードした完全版 library.db を排他 writeLock 下で原子的に差し替え、オープンとジャーナル再適用まで行う */
    fun replaceLibraryDatabaseFromTemp(srcTmpFile: File, bufferSize: Int = 65536): Int = withWriteLock {
        val mobileWatermarkBackup = try {
            ensureLibraryDbOpen(createIfMissing = false)?.let { watermarkStore.readMobileLocalBackup(it) } ?: emptyList()
        } catch (_: Exception) {
            emptyList()
        }
        closeLibraryDatabase()
        File(lockerDir, "library.db-wal").delete()
        File(lockerDir, "library.db-shm").delete()
        if (libraryDbFile.exists() && !libraryDbFile.delete()) {
            FileInputStream(srcTmpFile).use { input ->
                FileOutputStream(libraryDbFile).use { output ->
                    input.copyTo(output, bufferSize)
                    output.fd.sync()
                }
            }
            srcTmpFile.delete()
        } else if (!srcTmpFile.renameTo(libraryDbFile)) {
            FileInputStream(srcTmpFile).use { input ->
                FileOutputStream(libraryDbFile).use { output ->
                    input.copyTo(output, bufferSize)
                    output.fd.sync()
                }
            }
            srcTmpFile.delete()
        }
        val reopenedDb = ensureLibraryDbOpen()
        if (reopenedDb != null && mobileWatermarkBackup.isNotEmpty()) {
            watermarkStore.restoreMobileLocalBackup(reopenedDb, mobileWatermarkBackup)
        }
        replayPendingJournal()
    }

    /** ロッカー内 library.db を WAL + NORMAL 同期 + メモリキャッシュ有効で開く */
    private fun ensureLibraryDbOpen(createIfMissing: Boolean = false): SQLiteDatabase? {
        val fast = libraryDb
        if (fast != null && fast.isOpen) return fast
        return withWriteLock {
            val current = libraryDb
            if (current != null && current.isOpen) return@withWriteLock current
            if (!hasLockerDatabase() && !createIfMissing) return@withWriteLock null

            try {
                libraryDbFile.parentFile?.mkdirs()
                val flags = SQLiteDatabase.OPEN_READWRITE or SQLiteDatabase.CREATE_IF_NECESSARY or SQLiteDatabase.ENABLE_WRITE_AHEAD_LOGGING
                var db = SQLiteDatabase.openDatabase(libraryDbFile.absolutePath, null, flags)
                if (prepareV170GuardCompatibility(db)) {
                    db.close()
                    db = SQLiteDatabase.openDatabase(libraryDbFile.absolutePath, null, flags)
                }
                execPragmaSafe(db, "PRAGMA synchronous = NORMAL")
                execPragmaSafe(db, "PRAGMA temp_store = MEMORY")
                execPragmaSafe(db, "PRAGMA cache_size = -32000")
                try {
                    db.execSQL("CREATE INDEX IF NOT EXISTS idx_photos_mobile_sort ON photos(date_taken DESC, file_name ASC)")
                    db.execSQL("CREATE INDEX IF NOT EXISTS idx_photos_stack_id ON photos(stack_id)")
                    db.execSQL("CREATE INDEX IF NOT EXISTS idx_photos_file_path ON photos(file_path)")
                    db.execSQL("CREATE INDEX IF NOT EXISTS idx_photos_dir_path ON photos(directory_path)")
                    db.execSQL("CREATE INDEX IF NOT EXISTS idx_photos_vol_serial ON photos(volume_serial)")
                } catch (_: Exception) {}
                safePhotoColumnExpr = buildSafePhotoSelectColumns(db)
                libraryDb = db
                db
            } catch (e: Exception) {
                Log.e(TAG, "library.db オープン失敗", e)
                null
            }
        }
    }

    /** Android SQLiteDatabase 用にロッカー内コピー上の _v170_guard トリガーと仮想生成列関数参照を無害化する */
    private fun prepareV170GuardCompatibility(db: SQLiteDatabase): Boolean {
        var schemaModified = false
        try {
            val triggerNames = mutableListOf<String>()
            db.rawQuery(
                "SELECT name FROM sqlite_master WHERE type = 'trigger' AND (name LIKE 'trg_v170_guard_%' OR sql LIKE '%tetheract_v170_guard%')",
                null
            ).use { c -> while (c.moveToNext()) triggerNames.add(c.getString(0)) }
            for (trg in triggerNames) db.execSQL("DROP TRIGGER IF EXISTS \"${trg.replace("\"", "")}\"")

            var hasGuardExpr = false
            db.rawQuery("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND sql LIKE '%tetheract_v170_guard%'", null)
                .use { c -> if (c.moveToFirst() && c.getInt(0) > 0) hasGuardExpr = true }
            if (hasGuardExpr) {
                execPragmaSafe(db, "PRAGMA writable_schema = ON")
                db.execSQL("UPDATE sqlite_master SET sql = REPLACE(sql, 'tetheract_v170_guard()', '1') WHERE type = 'table' AND sql LIKE '%tetheract_v170_guard%'")
                execPragmaSafe(db, "PRAGMA writable_schema = OFF")
                execPragmaSafe(db, "PRAGMA writable_schema = RESET")
                schemaModified = true
            }
            ensurePhotoLinksTable(db)
        } catch (e: Exception) {
            Log.w(TAG, "_v170_guard 互換処理スキップ", e)
        }
        return schemaModified
    }

    private fun ensurePhotoLinksTable(db: SQLiteDatabase) {
        try {
            db.execSQL(
                "CREATE TABLE IF NOT EXISTS photo_links (id INTEGER PRIMARY KEY AUTOINCREMENT, photo_id INTEGER NOT NULL, " +
                    "volume_serial TEXT NOT NULL DEFAULT '' COLLATE NOCASE, rel_path TEXT NOT NULL DEFAULT '' COLLATE NOCASE, " +
                    "rel_dir TEXT NOT NULL DEFAULT '' COLLATE NOCASE, file_path TEXT NOT NULL DEFAULT '' COLLATE NOCASE, " +
                    "directory_path TEXT NOT NULL DEFAULT '' COLLATE NOCASE, file_name TEXT NOT NULL DEFAULT '' COLLATE NOCASE, " +
                    "file_mtime REAL, paired_raw_path TEXT, is_primary INTEGER DEFAULT 0, UNIQUE(volume_serial, rel_path))"
            )
            val cols = HashSet<String>()
            db.rawQuery("PRAGMA table_info(photo_links)", null).use { c -> while (c.moveToNext()) cols.add(c.getString(1) ?: "") }
            for ((col, def) in arrayOf("rel_dir" to "TEXT NOT NULL DEFAULT ''", "directory_path" to "TEXT NOT NULL DEFAULT ''", "file_mtime" to "REAL", "is_primary" to "INTEGER DEFAULT 0")) {
                if (col !in cols) try { db.execSQL("ALTER TABLE photo_links ADD COLUMN $col $def") } catch (_: Exception) {}
            }
            db.execSQL("CREATE INDEX IF NOT EXISTS idx_photo_links_photo_id ON photo_links(photo_id)")
            db.execSQL("CREATE INDEX IF NOT EXISTS idx_photo_links_vol_dir ON photo_links(volume_serial, directory_path)")
            db.execSQL("CREATE INDEX IF NOT EXISTS idx_photo_links_file_path ON photo_links(file_path)")
        } catch (_: Exception) {}
    }

    private fun buildSafePhotoSelectColumns(db: SQLiteDatabase): String {
        val cols = mutableListOf<String>()
        try {
            db.rawQuery("PRAGMA table_info(photos)", null).use { c ->
                val nameIdx = c.getColumnIndex("name")
                while (c.moveToNext()) {
                    val col = if (nameIdx >= 0) c.getString(nameIdx) else ""
                    if (col.isNotEmpty() && col != "_v170_guard") cols.add("p.\"$col\"")
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "photos カラム一覧取得失敗", e)
        }
        return if (cols.isNotEmpty()) cols.joinToString(", ") else "p.id, p.file_path, p.file_name, p.rating"
    }

    fun getPhotoCount(): Int {
        return withReadableDatabase { db ->
            try {
                db.rawQuery("SELECT COUNT(*) FROM photos WHERE IFNULL(is_unlinked, 0) = 0 AND $NOT_PAIRED_RAW", null).use { c -> if (c.moveToFirst()) c.getInt(0) else 0 }
            } catch (_: Exception) { 0 }
        } ?: 0
    }

    /** thumbnails テーブルから WebP サムネイル BLOB を並列 readLock で取得し、暗号化時はロック外で復号して返す */
    fun getThumbnailBlob(photoId: Long): ByteArray? {
        val blob = withReadableDatabase { db ->
            try {
                db.rawQuery(
                    "SELECT data FROM thumbnails WHERE photo_id = ? LIMIT 1",
                    arrayOf(photoId.toString())
                ).use { c ->
                    if (c.moveToFirst() && !c.isNull(0)) c.getBlob(0) else null
                }
            } catch (e: Exception) {
                Log.w(TAG, "サムネイルBLOB取得失敗: photoId=$photoId", e)
                null
            }
        } ?: return null
        return LoomeVaultCrypto.decryptThumbnailIfNeeded(blob, photoId)
    }

    /** 指定写真のファイル所在メタデータと photo_links 一覧を取得する */
    fun getPhotoFileMeta(photoId: Long): JSONObject? {
        return withReadableDatabase { db ->
            try {
                val meta = db.rawQuery(
                    "SELECT id, file_path, file_name, directory_path, volume_serial, is_raw, paired_raw_path FROM photos WHERE id = ? LIMIT 1",
                    arrayOf(photoId.toString())
                ).use { c ->
                    if (c.moveToFirst()) cursorRowToJson(c) else null
                } ?: return@withReadableDatabase null
                val links = try {
                    rawQueryToJsonArray(
                        db,
                        "SELECT volume_serial, rel_path, file_path, file_name FROM photo_links WHERE photo_id = ?",
                        arrayOf(photoId.toString())
                    )
                } catch (_: Exception) { JSONArray() }
                meta.put("links", links)
            } catch (e: Exception) {
                null
            }
        }
    }

    /** ロッカーDB内の security_meta / delta_meta から解錠用シール相当の JSONObject を構築して返す */
    fun readSecuritySealFromDb(): JSONObject? {
        return withReadableDatabase { db ->
            val map = HashMap<String, String>()
            for (tbl in arrayOf("security_meta", "delta_meta")) {
                try {
                    db.rawQuery("SELECT key, value FROM $tbl", null).use { c ->
                        while (c.moveToNext()) {
                            val k = c.getString(0) ?: continue
                            if (map[k].isNullOrEmpty()) map[k] = c.getString(1) ?: ""
                        }
                    }
                } catch (_: Exception) {}
            }
            val pwSalt = map["pw_salt"]?.trim() ?: ""
            val pwWrap = (map["wrapped_owner_bundle"] ?: map["dek_wrapped_pw"] ?: "").trim()
            val recSalt = map["recovery_salt"]?.trim() ?: ""
            val recWrap = map["dek_wrapped_recovery"]?.trim() ?: ""
            if (pwWrap.isEmpty() && recWrap.isEmpty()) return@withReadableDatabase null
            JSONObject().put("owner_id", map["owner_id"]?.trim() ?: "")
                .put("security_level", (map["security_level"] ?: "0").toIntOrNull() ?: 0)
                .put("pw_protected", pwSalt.isNotEmpty() && pwWrap.isNotEmpty())
                .put("pw_salt", pwSalt).put("wrapped_owner_bundle", pwWrap).put("dek_wrapped_pw", pwWrap)
                .put("recovery_salt", recSalt).put("dek_wrapped_recovery", recWrap)
        }
    }

    /** WHERE / ORDER 条件で写真を検索し、タグとスタック情報を統合した JSON を返す */
    fun queryPhotosJson(
        whereSql: String,
        paramsJson: String,
        orderSql: String,
        limit: Int,
        offset: Int
    ): String {
        return withReadableDatabase { db ->
            val selectCols = safePhotoColumnExpr ?: buildSafePhotoSelectColumns(db)
            val cleanWhere = whereSql.trim().ifEmpty { "IFNULL(p.is_unlinked, 0) = 0 AND $NOT_PAIRED_RAW_P" }
            val cleanOrder = orderSql.trim().ifEmpty { "p.date_taken DESC, p.file_name ASC" }
            val safeLimit = if (limit in 1..5000) limit else 500
            val safeOffset = if (offset >= 0) offset else 0

            val bindArgs = mutableListOf<String>()
            try {
                val arr = JSONArray(paramsJson.ifEmpty { "[]" })
                for (i in 0 until arr.length()) bindArgs.add(arr.optString(i, ""))
            } catch (e: Exception) {
                Log.w(TAG, "クエリパラメータ解析警告", e)
            }
            bindArgs.add(safeLimit.toString())
            bindArgs.add(safeOffset.toString())

            val sql = "SELECT $selectCols FROM photos p WHERE $cleanWhere ORDER BY $cleanOrder LIMIT ? OFFSET ?"
            val photosArray = JSONArray()
            val photoIds = mutableListOf<Long>()
            val photoMap = LinkedHashMap<Long, JSONObject>()

            try {
                db.rawQuery(sql, bindArgs.toTypedArray()).use { c ->
                    while (c.moveToNext()) {
                        val obj = cursorRowToJson(c)
                        val pid = obj.optLong("id", 0L)
                        if (pid > 0L) {
                            obj.put("tags", JSONArray()).put("stack_count", 1)
                            photoIds.add(pid)
                            photoMap[pid] = obj
                        }
                    }
                }

                for (chunk in photoIds.chunked(500)) {
                    val ph = chunk.joinToString(",") { "?" }
                    val args = chunk.map { it.toString() }.toTypedArray()
                    db.rawQuery(
                        "SELECT photo_id, tag FROM photo_tags WHERE photo_id IN ($ph) ORDER BY tag ASC",
                        args
                    ).use { tc ->
                        while (tc.moveToNext()) {
                            val pid = tc.getLong(0)
                            val tag = tc.getString(1) ?: continue
                            photoMap[pid]?.optJSONArray("tags")?.put(tag)
                        }
                    }
                }
                for (obj in photoMap.values) photosArray.put(obj)
            } catch (e: Exception) {
                Log.e(TAG, "queryPhotosJson 実行エラー", e)
            }

            JSONObject().put("photos", photosArray).toString()
        } ?: JSONObject().put("photos", JSONArray()).toString()
    }

    /** タグ・年月・機材・場所・フォルダのフィルタツリー集計を一括取得して返す */
    fun getFilterTreesJson(): String {
        val result = JSONObject().put("tags", JSONArray()).put("untaggedCount", 0).put("timeline", JSONArray())
            .put("cameras", JSONArray()).put("lenses", JSONArray()).put("locations", JSONArray())
            .put("noLocationCount", 0).put("folders", JSONArray()).put("binders", JSONArray())

        withReadableDatabase { db ->
            try {
                result.put(
                    "tags",
                    rawQueryToJsonArray(
                        db,
                        "SELECT pt.tag, COUNT(DISTINCT pt.photo_id) AS count, SUM(CASE WHEN pt.source = 'ai' THEN 1 ELSE 0 END) AS ai_count, " +
                            "SUM(CASE WHEN pt.source = 'manual' OR pt.source IS NULL THEN 1 ELSE 0 END) AS manual_count, " +
                            "CASE WHEN SUM(CASE WHEN pt.source = 'manual' OR pt.source IS NULL THEN 1 ELSE 0 END) > 0 AND SUM(CASE WHEN pt.source = 'ai' THEN 1 ELSE 0 END) > 0 THEN 'both' " +
                            "WHEN SUM(CASE WHEN pt.source = 'ai' THEN 1 ELSE 0 END) > 0 THEN 'ai' ELSE 'manual' END AS source " +
                            "FROM photo_tags pt INNER JOIN photos p ON p.id = pt.photo_id WHERE IFNULL(p.is_unlinked, 0) = 0 AND $NOT_PAIRED_RAW_P GROUP BY pt.tag ORDER BY pt.tag ASC"
                    )
                )
                val cPh = COLOR_TAGS.joinToString(",") { "?" }
                db.rawQuery(
                    "SELECT COUNT(*) FROM photos p WHERE IFNULL(p.is_unlinked, 0) = 0 AND $NOT_PAIRED_RAW_P AND NOT EXISTS (" +
                        "SELECT 1 FROM photo_tags pt WHERE pt.photo_id = p.id AND IFNULL(pt.source, 'manual') != 'ai' AND pt.tag NOT IN ($cPh))",
                    COLOR_TAGS
                ).use { c -> if (c.moveToFirst()) result.put("untaggedCount", c.getInt(0)) }
                result.put("timeline", rawQueryToJsonArray(db, "SELECT year_month, COUNT(*) AS count FROM photos WHERE IFNULL(is_unlinked, 0) = 0 AND $NOT_PAIRED_RAW AND year_month IS NOT NULL AND year_month != '' GROUP BY year_month ORDER BY year_month DESC"))
                result.put("cameras", rawQueryToJsonArray(db, "SELECT camera_model, COUNT(*) AS count FROM photos WHERE IFNULL(is_unlinked, 0) = 0 AND $NOT_PAIRED_RAW AND camera_model IS NOT NULL AND camera_model != '' GROUP BY camera_model ORDER BY count DESC"))
                result.put("lenses", rawQueryToJsonArray(db, "SELECT lens_model, COUNT(*) AS count FROM photos WHERE IFNULL(is_unlinked, 0) = 0 AND $NOT_PAIRED_RAW AND lens_model IS NOT NULL AND lens_model != '' GROUP BY lens_model ORDER BY count DESC"))
                result.put("locations", rawQueryToJsonArray(db, "SELECT country, state, city, COUNT(*) AS count FROM photos WHERE IFNULL(is_unlinked, 0) = 0 AND $NOT_PAIRED_RAW AND country IS NOT NULL AND country != '' GROUP BY country, state, city ORDER BY country ASC, state ASC, city ASC"))
                result.put(
                    "folders",
                    rawQueryToJsonArray(
                        db,
                        "SELECT directory_path, COUNT(DISTINCT id) AS count FROM (" +
                            "SELECT id, directory_path FROM photos WHERE IFNULL(is_unlinked, 0) = 0 AND $NOT_PAIRED_RAW AND directory_path IS NOT NULL AND directory_path != '' " +
                            "UNION ALL " +
                            "SELECT pl.photo_id AS id, pl.directory_path FROM photo_links pl INNER JOIN photos p ON p.id = pl.photo_id " +
                            "WHERE IFNULL(p.is_unlinked, 0) = 0 AND $NOT_PAIRED_RAW_P AND pl.volume_serial = 'ANDROID_LOCAL' AND pl.directory_path IS NOT NULL AND pl.directory_path != ''" +
                            ") GROUP BY directory_path ORDER BY directory_path ASC"
                    )
                )
            } catch (e: Exception) {
                Log.e(TAG, "フィルタ集計エラー", e)
            }
        }
        return result.toString()
    }

    /** 評価・タグ・非破壊調整をロッカーDBへ即時反映し、同時に pending_journal.db へ永続記録する */
    fun savePhotoChangeJson(payloadJson: String): String = withWriteLock {
        try {
            val payload = JSONObject(payloadJson)
            val photoId = payload.optLong("photo_id", 0L)
            if (photoId <= 0L) return@withWriteLock JSONObject().put("ok", false).put("error", "Invalid photo_id").toString()
            val db = ensureLibraryDbOpen()
            if (db != null) applyChangeToLibraryDb(db, photoId, payload)
            recordChangeToJournalDb(db, photoId, payload)
            JSONObject().put("ok", true).put("photo_id", photoId).put("pendingChangeCount", getPendingChangeCount()).toString()
        } catch (e: Exception) {
            Log.e(TAG, "変更保存エラー", e)
            JSONObject().put("ok", false).put("error", e.message ?: "Save failed").toString()
        }
    }

    /** 複数写真の評価・タグ・非破壊調整を1回のJNI呼び出し＋単一SQLiteトランザクションで一括保存する */
    fun savePhotoChangesBatchJson(payloadJson: String): String = withWriteLock {
        try {
            val root = JSONObject(payloadJson)
            val rawItems = root.optJSONArray("items")
            val rawIds = root.optJSONArray("photo_ids")
            val batchEntries = mutableListOf<Pair<Long, JSONObject>>()

            val sharedKeys = arrayOf(
                "rating", "is_favorite", "rotation", "brightness", "contrast", "saturation",
                "fine_angle", "crop_x", "crop_y", "crop_w", "crop_h", "set_stack_primary",
                "add_tags", "remove_tags", "add_tag_keys", "remove_tag_keys"
            )

            if (rawItems != null && rawItems.length() > 0) {
                for (i in 0 until rawItems.length()) {
                    val itemObj = rawItems.optJSONObject(i) ?: continue
                    val pid = itemObj.optLong("photo_id", itemObj.optLong("id", 0L))
                    if (pid <= 0L) continue
                    val merged = JSONObject(itemObj.toString())
                    merged.put("photo_id", pid)
                    for (k in sharedKeys) {
                        if (!merged.has(k) && root.has(k) && !root.isNull(k)) {
                            merged.put(k, root.get(k))
                        }
                    }
                    batchEntries.add(pid to merged)
                }
            } else if (rawIds != null && rawIds.length() > 0) {
                for (i in 0 until rawIds.length()) {
                    val pid = rawIds.optLong(i, 0L)
                    if (pid <= 0L) continue
                    val merged = JSONObject().put("photo_id", pid)
                    for (k in sharedKeys) {
                        if (root.has(k) && !root.isNull(k)) merged.put(k, root.get(k))
                    }
                    batchEntries.add(pid to merged)
                }
            }

            if (batchEntries.isEmpty()) {
                return@withWriteLock JSONObject()
                    .put("ok", true)
                    .put("updatedCount", 0)
                    .put("pendingChangeCount", getPendingChangeCount())
                    .toString()
            }

            val db = ensureLibraryDbOpen()
            val preloadedIdentities = HashMap<Long, JournalPhotoIdentity>()
            if (db != null) {
                val needMetaIds = batchEntries.mapNotNull { (pid, obj) ->
                    val missing = obj.optString("content_key", "").isEmpty() ||
                        obj.optString("file_name", "").isEmpty() ||
                        obj.optString("date_taken", "").isEmpty() ||
                        obj.optLong("file_size", 0L) <= 0L
                    if (missing) pid else null
                }.distinct()

                for (chunk in needMetaIds.chunked(500)) {
                    val ph = chunk.joinToString(",") { "?" }
                    val args = chunk.map { it.toString() }.toTypedArray()
                    db.rawQuery(
                        "SELECT id, content_key, file_path, file_name, file_size, date_taken, COALESCE(camera_model, '') FROM photos WHERE id IN ($ph)",
                        args
                    ).use { c ->
                        while (c.moveToNext()) {
                            val pid = c.getLong(0)
                            preloadedIdentities[pid] = JournalPhotoIdentity(
                                contentKey = c.getString(1) ?: "",
                                filePath = c.getString(2) ?: "",
                                fileName = c.getString(3) ?: "",
                                fileSize = c.getLong(4),
                                dateTaken = c.getString(5) ?: "",
                                cameraModel = c.getString(6) ?: ""
                            )
                        }
                    }
                }

                db.beginTransaction()
                try {
                    for ((pid, merged) in batchEntries) {
                        applyChangeOperationsInTx(db, pid, merged)
                    }
                    db.setTransactionSuccessful()
                } finally {
                    db.endTransaction()
                }
            }

            for ((pid, merged) in batchEntries) {
                val fallback = preloadedIdentities[pid]
                val identity = JournalPhotoIdentity(
                    contentKey = merged.optString("content_key", "").trim().ifEmpty { fallback?.contentKey ?: "" },
                    filePath = merged.optString("file_path", "").trim().ifEmpty { fallback?.filePath ?: "" },
                    fileName = merged.optString("file_name", "").trim().ifEmpty { fallback?.fileName ?: "" },
                    fileSize = merged.optLong("file_size", 0L).let { if (it > 0L) it else (fallback?.fileSize ?: 0L) },
                    dateTaken = merged.optString("date_taken", "").trim().ifEmpty { fallback?.dateTaken ?: "" },
                    cameraModel = merged.optString("camera_model", "").trim().ifEmpty { fallback?.cameraModel ?: "" }
                )
                journal.record(pid, identity, merged)
            }

            JSONObject()
                .put("ok", true)
                .put("updatedCount", batchEntries.size)
                .put("pendingChangeCount", getPendingChangeCount())
                .toString()
        } catch (e: Exception) {
            Log.e(TAG, "一括変更保存エラー", e)
            JSONObject().put("ok", false).put("error", e.message ?: "Batch save failed").toString()
        }
    }

    private fun applyChangeToLibraryDb(db: SQLiteDatabase, photoId: Long, payload: JSONObject) {
        db.beginTransaction()
        try {
            applyChangeOperationsInTx(db, photoId, payload)
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
    }

    private fun applyChangeOperationsInTx(db: SQLiteDatabase, photoId: Long, payload: JSONObject) {
        val updateValues = ContentValues()
        if (payload.has("rating") && !payload.isNull("rating")) {
            updateValues.put("rating", payload.optInt("rating", 0))
        }
        if (payload.has("is_favorite") && !payload.isNull("is_favorite")) {
            updateValues.put("is_favorite", payload.optInt("is_favorite", 0))
        }
        for (intCol in arrayOf("rotation", "brightness", "contrast", "saturation")) {
            if (payload.has(intCol) && !payload.isNull(intCol)) {
                updateValues.put(intCol, payload.optInt(intCol, 0))
            }
        }
        for (realCol in arrayOf("fine_angle", "crop_x", "crop_y", "crop_w", "crop_h")) {
            if (payload.has(realCol) && !payload.isNull(realCol)) {
                updateValues.put(realCol, payload.optDouble(realCol, 0.0))
            }
        }
        if (updateValues.size() > 0) {
            db.update("photos", updateValues, "id = ?", arrayOf(photoId.toString()))
        }
        if (payload.optBoolean("set_stack_primary", false)) {
            var oldStackId = 0L
            db.rawQuery("SELECT COALESCE(stack_id, 0) FROM photos WHERE id = ? LIMIT 1", arrayOf(photoId.toString())).use { sc ->
                if (sc.moveToFirst()) oldStackId = sc.getLong(0)
            }
            if (oldStackId > 0L) {
                db.execSQL(
                    "UPDATE photos SET stack_id = ?, is_stack_primary = CASE WHEN id = ? THEN 1 ELSE 0 END WHERE stack_id = ?",
                    arrayOf(photoId, photoId, oldStackId)
                )
            }
        }

        val removeTags = payload.optJSONArray("remove_tags")
        if (removeTags != null) {
            for (i in 0 until removeTags.length()) {
                val tag = removeTags.optString(i, "").trim()
                if (tag.isNotEmpty()) {
                    db.execSQL(
                        "DELETE FROM photo_tags WHERE photo_id = ? AND (tag = ? OR tag LIKE ?)",
                        arrayOf(photoId, tag, "$tag/%")
                    )
                    for (anc in expandTagAncestors(tag).dropLast(1).asReversed()) {
                        db.execSQL(
                            "DELETE FROM photo_tags WHERE photo_id = ? AND tag = ? AND NOT EXISTS (SELECT 1 FROM photo_tags pt2 WHERE pt2.photo_id = ? AND pt2.tag LIKE ?)",
                            arrayOf(photoId, anc, photoId, "$anc/%")
                        )
                    }
                }
            }
        }

        val addTags = payload.optJSONArray("add_tags")
        if (addTags != null) {
            for (i in 0 until addTags.length()) {
                val rawTag = addTags.optString(i, "").trim()
                for (anc in expandTagAncestors(rawTag)) {
                    db.execSQL(
                        "INSERT OR IGNORE INTO photo_tags (photo_id, tag, source, confidence) VALUES (?, ?, 'manual', 1.0)",
                        arrayOf(photoId, anc)
                    )
                }
            }
        }
    }

    /** ペイロードに欠けている識別情報をロッカーDBから補ってジャーナルへ記録する（単体運用時のスマホローカル写真も対象） */
    private fun recordChangeToJournalDb(libDb: SQLiteDatabase?, photoId: Long, payload: JSONObject) {
        var contentKey = payload.optString("content_key", "").trim()
        var filePath = payload.optString("file_path", "").trim()
        var fileName = payload.optString("file_name", "").trim()
        var fileSize = payload.optLong("file_size", 0L)
        var dateTaken = payload.optString("date_taken", "").trim()
        var cameraModel = payload.optString("camera_model", "").trim()

        if (libDb != null && (contentKey.isEmpty() || fileName.isEmpty() || dateTaken.isEmpty() || fileSize <= 0L || cameraModel.isEmpty())) {
            libDb.rawQuery(
                "SELECT content_key, file_path, file_name, file_size, date_taken, COALESCE(camera_model, '') FROM photos WHERE id = ? LIMIT 1",
                arrayOf(photoId.toString())
            ).use { c ->
                if (c.moveToFirst()) {
                    if (contentKey.isEmpty()) contentKey = c.getString(0) ?: ""
                    if (filePath.isEmpty()) filePath = c.getString(1) ?: ""
                    if (fileName.isEmpty()) fileName = c.getString(2) ?: ""
                    if (fileSize <= 0L) fileSize = c.getLong(3)
                    if (dateTaken.isEmpty()) dateTaken = c.getString(4) ?: ""
                    if (cameraModel.isEmpty()) cameraModel = c.getString(5) ?: ""
                }
            }
        }
        journal.record(photoId, JournalPhotoIdentity(contentKey, filePath, fileName, fileSize, dateTaken, cameraModel), payload)
    }

    /** USBやWi-Fiで新しい library.db をロッカーに反映した際、未同期ジャーナルを content_key / 撮影日時+サイズ優先で再適用する */
    fun replayPendingJournal(): Int = withWriteLock {
        val libDb = ensureLibraryDbOpen() ?: return@withWriteLock 0
        val patches = journal.readReplayPatches()
        if (patches.isEmpty()) return@withWriteLock 0
        var replayed = 0
        libDb.beginTransaction()
        try {
            for ((entry, replayPatch) in patches) {
                val targetId = resolveTargetPhotoIdForReplay(libDb, entry) ?: continue
                applyChangeOperationsInTx(libDb, targetId, replayPatch)
                replayed++
            }
            libDb.setTransactionSuccessful()
        } finally {
            libDb.endTransaction()
        }
        replayed
    }

    private fun resolveTargetPhotoIdForReplay(libDb: SQLiteDatabase, entry: JSONObject): Long? {
        val cKey = entry.optString("content_key", "").trim()
        if (cKey.isNotEmpty()) {
            libDb.rawQuery("SELECT id FROM photos WHERE content_key = ? AND IFNULL(is_unlinked, 0) = 0 LIMIT 1", arrayOf(cKey)).use { c ->
                if (c.moveToFirst()) return c.getLong(0)
            }
        }
        val dTaken = entry.optString("date_taken", "").trim()
        val fSize = entry.optLong("file_size", 0L)
        if (dTaken.isNotEmpty() && fSize > 0L) {
            libDb.rawQuery(
                "SELECT id FROM photos WHERE (date_taken = ? OR original_date_taken = ?) AND file_size = ? AND IFNULL(is_unlinked, 0) = 0 ORDER BY id ASC LIMIT 1",
                arrayOf(dTaken, dTaken, fSize.toString())
            ).use { c -> if (c.moveToFirst()) return c.getLong(0) }
        }
        val fPath = entry.optString("file_path", "").trim()
        if (fPath.isNotEmpty()) {
            libDb.rawQuery("SELECT id FROM photos WHERE file_path = ? LIMIT 1", arrayOf(fPath)).use { c -> if (c.moveToFirst()) return c.getLong(0) }
        }
        val fName = entry.optString("file_name", "").trim()
        if (fName.isNotEmpty() && dTaken.isNotEmpty()) {
            libDb.rawQuery("SELECT id FROM photos WHERE file_name = ? AND date_taken = ? LIMIT 1", arrayOf(fName, dTaken)).use { c ->
                if (c.moveToFirst()) return c.getLong(0)
            }
        }
        val pid = entry.optLong("photo_id", 0L)
        return if (pid in 1L until PhoneCatalogEngine.PHONE_LOCAL_ID_BASE) pid else null
    }

    fun getPendingChangeCount(): Int = journal.count()

    fun buildMobileSyncJsonPayload(): String = buildMobileSyncSnapshot().first

    /**
     * 未同期ジャーナルの送信用JSONと、その時点の最大 rev を同時に取得する。
     * 送信成功後は clearPendingJournalUpTo(rev) で送信済み分だけを消す。
     */
    fun buildMobileSyncSnapshot(): Pair<String, Long> = journal.buildSnapshot()

    fun clearPendingJournal() = journal.clearAll()

    /** 送信済み（rev が指定値以下）のジャーナルだけを削除し、送信中に追加・更新された変更は残す */
    fun clearPendingJournalUpTo(maxRev: Long) = journal.clearUpTo(maxRev)

    fun getLockerSyncWatermarks(): JSONObject {
        return withReadableDatabase { db ->
            var maxPhotoId = 0L
            var maxThumbCreated = ""
            var motherCount = 0
            db.rawQuery("SELECT COUNT(*), COALESCE(MAX(id), 0) FROM photos WHERE id < 900000000 AND IFNULL(is_unlinked, 0) = 0", null).use { c ->
                if (c.moveToFirst()) { motherCount = c.getInt(0); maxPhotoId = c.getLong(1) }
            }
            db.rawQuery("SELECT COALESCE(MAX(created_at), '') FROM thumbnails WHERE photo_id < 900000000", null).use { c -> if (c.moveToFirst()) maxThumbCreated = c.getString(0) ?: "" }
            JSONObject().put("schema", "tetheract-locker-state-v1").put("photo_count", motherCount)
                .put("max_photo_id", maxPhotoId).put("max_thumb_created_at", maxThumbCreated).put("updated_at", formatLocalNow())
        } ?: JSONObject()
    }

    /** PC側が生成した軽量差分パック (mobile_delta.db) をロッカーDBへ高速マージ（追加・更新・削除）する */
    fun applyDeltaDatabase(deltaFile: File): Boolean = withWriteLock {
        val db = ensureLibraryDbOpen() ?: return@withWriteLock false
        var attached = false
        try {
            var lockerMaxThumbId = 0L
            db.rawQuery("SELECT COALESCE(MAX(photo_id), 0) FROM thumbnails WHERE photo_id < 900000000", null).use { c -> if (c.moveToFirst()) lockerMaxThumbId = c.getLong(0) }
            db.execSQL("ATTACH DATABASE '${deltaFile.absolutePath.replace("'", "''")}' AS delta")
            attached = true
            var deltaLibId = ""
            db.rawQuery("SELECT value FROM delta.delta_meta WHERE key = 'library_id' LIMIT 1", null).use { c ->
                if (c.moveToFirst()) deltaLibId = (c.getString(0) ?: "").trim()
            }
            val localLibId = readLocalLibraryId()
            if (localLibId.isNotEmpty() && deltaLibId.isNotEmpty() && localLibId != deltaLibId) return@withWriteLock false
            var coveredFromId = Long.MAX_VALUE
            db.rawQuery("SELECT value FROM delta.delta_meta WHERE key = 'covered_from_photo_id' LIMIT 1", null).use { c ->
                if (c.moveToFirst()) coveredFromId = c.getString(0)?.toLongOrNull() ?: Long.MAX_VALUE
            }
            if (lockerMaxThumbId < coveredFromId) return@withWriteLock false
            val cols = mutableListOf<String>()
            db.rawQuery("PRAGMA delta.table_info(photos)", null).use { c ->
                while (c.moveToNext()) {
                    val name = c.getString(1) ?: ""
                    if (name.isNotEmpty() && name != "_v170_guard") cols.add(name)
                }
            }
            if (cols.isEmpty()) return@withWriteLock false
            val colList = cols.joinToString(", ")
            execPragmaSafe(db, "PRAGMA foreign_keys = OFF")
            db.beginTransaction()
            try {
                db.execSQL("DROP TRIGGER IF EXISTS main.trg_photos_after_delete")
                db.execSQL("DELETE FROM main.thumbnails WHERE photo_id < 900000000 AND photo_id NOT IN (SELECT id FROM delta.photos)")
                db.execSQL("DELETE FROM main.photos WHERE id < 900000000 AND id NOT IN (SELECT id FROM delta.photos)")
                db.execSQL("INSERT OR REPLACE INTO main.photos ($colList) SELECT $colList FROM delta.photos")
                db.execSQL("DELETE FROM main.photo_tags WHERE photo_id < 900000000")
                db.execSQL("INSERT OR REPLACE INTO main.photo_tags (photo_id, tag, source, confidence) SELECT photo_id, tag, source, confidence FROM delta.photo_tags")
                for (optTable in arrayOf("tag_definitions", "filter_presets", "photo_links", "security_meta")) {
                    db.rawQuery("SELECT 1 FROM delta.sqlite_master WHERE type='table' AND name='$optTable'", null).use { tc ->
                        if (tc.moveToFirst()) {
                            db.rawQuery("SELECT 1 FROM main.sqlite_master WHERE type='table' AND name='$optTable'", null).use { mc ->
                                if (mc.moveToFirst()) {
                                    if (optTable == "photo_links") {
                                        db.execSQL("DELETE FROM main.photo_links WHERE IFNULL(volume_serial, '') != 'ANDROID_LOCAL'")
                                    } else {
                                        db.execSQL("DELETE FROM main.$optTable")
                                    }
                                    db.execSQL("INSERT OR REPLACE INTO main.$optTable SELECT * FROM delta.$optTable")
                                }
                            }
                        }
                    }
                }
                db.rawQuery("SELECT 1 FROM delta.sqlite_master WHERE type='table' AND name='watermark_assets'", null).use { tc ->
                    if (tc.moveToFirst()) {
                        db.execSQL(
                            """
                            CREATE TABLE IF NOT EXISTS main.watermark_assets (
                                id TEXT PRIMARY KEY,
                                name TEXT NOT NULL,
                                mime_type TEXT NOT NULL,
                                width INTEGER NOT NULL,
                                height INTEGER NOT NULL,
                                data BLOB NOT NULL,
                                origin TEXT NOT NULL DEFAULT 'pc',
                                created_at TEXT DEFAULT CURRENT_TIMESTAMP
                            )
                            """.trimIndent()
                        )
                        db.execSQL("DELETE FROM main.watermark_assets WHERE IFNULL(origin, 'pc') != 'mobile'")
                        db.execSQL("INSERT OR REPLACE INTO main.watermark_assets SELECT * FROM delta.watermark_assets")
                        db.execSQL("INSERT OR REPLACE INTO main.app_meta (key, value) VALUES ('${WatermarkAssetStore.DEFAULT_WATERMARK_SEED_KEY}', '1')")
                    }
                }
                db.execSQL("INSERT OR REPLACE INTO main.thumbnails (photo_id, data, width, height, created_at) SELECT photo_id, data, width, height, created_at FROM delta.thumbnails")
                db.setTransactionSuccessful()
            } finally {
                db.endTransaction()
            }
            safePhotoColumnExpr = buildSafePhotoSelectColumns(db)
            true
        } catch (e: Exception) {
            Log.w(TAG, "差分DB適用フォールバック: ${e.message}")
            false
        } finally {
            if (attached) try { db.execSQL("DETACH DATABASE delta") } catch (_: Exception) {}
        }
    }

    /** WebView 側から SELECT クエリを並列 readLock で実行し、高速StringBuilderでJSON配列を返す */
    fun rawQuerySafeJson(sql: String, paramsJson: String): String {
        if (!isReadOnlySql(sql)) {
            Log.w(TAG, "rawQuerySafeJson: 読み取り専用でないSQLを拒否しました")
            return "[]"
        }
        return withReadableDatabase { db ->
            try {
                val argsList = mutableListOf<String>()
                if (paramsJson.isNotEmpty() && paramsJson != "[]") {
                    val arr = JSONArray(paramsJson)
                    for (i in 0 until arr.length()) argsList.add(arr.optString(i, ""))
                }
                val safeSql = if (sql.contains("SELECT p.*", ignoreCase = true) || sql.contains("SELECT *", ignoreCase = true)) {
                    val cols = safePhotoColumnExpr ?: buildSafePhotoSelectColumns(db)
                    sql.replace(Regex("SELECT\\s+p\\.\\*", RegexOption.IGNORE_CASE), "SELECT $cols")
                        .replace(Regex("SELECT\\s+\\*\\s+FROM\\s+photos", RegexOption.IGNORE_CASE), "SELECT ${cols.replace("p.", "")} FROM photos")
                } else sql
                db.rawQuery(safeSql, argsList.toTypedArray()).use { c ->
                    val colCount = c.columnCount
                    val quotedKeys = Array(colCount) { i -> JSONObject.quote(c.getColumnName(i) ?: "") + ":" }
                    val sb = java.lang.StringBuilder(4096)
                    sb.append('[')
                    var firstRow = true
                    while (c.moveToNext()) {
                        if (!firstRow) sb.append(',') else firstRow = false
                        sb.append('{')
                        var firstCol = true
                        for (i in 0 until colCount) {
                            val t = c.getType(i)
                            if (t == Cursor.FIELD_TYPE_BLOB) continue
                            if (!firstCol) sb.append(',') else firstCol = false
                            sb.append(quotedKeys[i])
                            when (t) { Cursor.FIELD_TYPE_NULL -> sb.append("null"); Cursor.FIELD_TYPE_INTEGER -> sb.append(c.getLong(i)); Cursor.FIELD_TYPE_FLOAT -> sb.append(c.getDouble(i)); Cursor.FIELD_TYPE_STRING -> sb.append(JSONObject.quote(c.getString(i) ?: "")) }
                        }
                        sb.append('}')
                    }
                    sb.append(']').toString()
                }
            } catch (e: Exception) {
                Log.w(TAG, "rawQuerySafeJson エラー: ${e.message}")
                "[]"
            }
        } ?: "[]"
    }

    /** WebView から渡された SQL が読み取り専用文（SELECT / WITH ... SELECT / 構造参照 PRAGMA）かを判定する */
    private fun isReadOnlySql(sql: String): Boolean {
        val body = sql.trim()
        if (READONLY_PRAGMA_REGEX.containsMatchIn(body)) return true
        val head = body.take(6).uppercase(Locale.US)
        if (!head.startsWith("SELECT") && !head.startsWith("WITH")) return false
        return !WRITE_SQL_REGEX.containsMatchIn(body)
    }

    private fun expandTagAncestors(tagStr: String): List<String> {
        val parts = tagStr.split("/").map { it.trim() }.filter { it.isNotEmpty() }
        return parts.indices.map { i -> parts.subList(0, i + 1).joinToString("/") }
    }

    private fun rawQueryToJsonArray(db: SQLiteDatabase, sql: String, args: Array<String>? = null): JSONArray {
        val arr = JSONArray()
        db.rawQuery(sql, args).use { c -> while (c.moveToNext()) arr.put(cursorRowToJson(c)) }
        return arr
    }

}

/** カーソルの現在行を JSONObject へ変換する（BLOB 列は除外） */
internal fun cursorRowToJson(c: Cursor): JSONObject {
    val obj = JSONObject()
    for (i in 0 until c.columnCount) {
        val name = c.getColumnName(i) ?: continue
        when (c.getType(i)) {
            Cursor.FIELD_TYPE_NULL -> obj.put(name, JSONObject.NULL)
            Cursor.FIELD_TYPE_INTEGER -> obj.put(name, c.getLong(i))
            Cursor.FIELD_TYPE_FLOAT -> obj.put(name, c.getDouble(i))
            Cursor.FIELD_TYPE_STRING -> obj.put(name, c.getString(i))
            Cursor.FIELD_TYPE_BLOB -> {}
        }
    }
    return obj
}
