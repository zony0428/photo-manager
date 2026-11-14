package com.tetheract.pm

import android.content.ContentValues
import android.database.sqlite.SQLiteDatabase
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/** ジャーナルに記録する写真の識別情報（PC側で同一写真を照合するためのキー群） */
data class JournalPhotoIdentity(
    val contentKey: String,
    val filePath: String,
    val fileName: String,
    val fileSize: Long,
    val dateTaken: String
)

/**
 * 未同期変更ジャーナル pending_journal.db の記録・統合・送信用スナップショット生成を担うクラス。
 * 排他は LockerDatabaseManager と同じロックオブジェクトを共有して行う。
 */
class PendingJournalStore(
    private val journalDbFile: File,
    private val lock: Any,
    private val nowProvider: () -> String
) {

    companion object {
        private const val TAG = "PendingJournalStore"
        private val INT_ADJUST_COLUMNS = arrayOf("rotation", "brightness", "contrast", "saturation")
        private val REAL_ADJUST_COLUMNS = arrayOf("fine_angle", "crop_x", "crop_y", "crop_w", "crop_h")
    }

    @Volatile
    private var journalDb: SQLiteDatabase? = null

    private fun ensureOpen(): SQLiteDatabase {
        synchronized(lock) {
            val current = journalDb
            if (current != null && current.isOpen) return current
            val db = SQLiteDatabase.openOrCreateDatabase(journalDbFile, null)
            try {
                db.enableWriteAheadLogging()
            } catch (e: Exception) {
                Log.d(TAG, "WAL skip: ${e.message}")
            }
            try {
                db.rawQuery("PRAGMA synchronous = NORMAL", null).use { it.moveToFirst() }
            } catch (e: Exception) {
                Log.d(TAG, "PRAGMA skip: ${e.message}")
            }
            db.execSQL(
                "CREATE TABLE IF NOT EXISTS pending_changes (" +
                    "journal_key TEXT PRIMARY KEY, photo_id INTEGER, content_key TEXT, " +
                    "file_path TEXT, file_name TEXT, file_size INTEGER DEFAULT 0, date_taken TEXT, " +
                    "rating INTEGER, is_favorite INTEGER, add_tags_json TEXT DEFAULT '[]', " +
                    "remove_tags_json TEXT DEFAULT '[]', adjustments_json TEXT DEFAULT '{}', updated_at TEXT)"
            )
            migrateColumns(db)
            journalDb = db
            return db
        }
    }

    /** 既存の pending_journal.db に後から追加した列（rev・タグキー）を補う */
    private fun migrateColumns(db: SQLiteDatabase) {
        val existing = mutableSetOf<String>()
        db.rawQuery("PRAGMA table_info(pending_changes)", null).use { c ->
            while (c.moveToNext()) existing.add(c.getString(1) ?: "")
        }
        val required = linkedMapOf(
            "rev" to "INTEGER DEFAULT 0",
            "add_tag_keys_json" to "TEXT DEFAULT '{}'",
            "remove_tag_keys_json" to "TEXT DEFAULT '{}'"
        )
        for ((col, def) in required) {
            if (col !in existing) {
                db.execSQL("ALTER TABLE pending_changes ADD COLUMN $col $def")
            }
        }
    }

    /** 写真1枚分の変更を既存エントリへ統合し、新しい rev を振って記録する */
    fun record(photoId: Long, identity: JournalPhotoIdentity, payload: JSONObject) = synchronized(lock) {
        val jDb = ensureOpen()
        val journalKey = identity.contentKey.ifEmpty { "pid:$photoId:${identity.fileName}" }
        val addSet = linkedSetOf<String>()
        val removeSet = linkedSetOf<String>()
        var addKeys = JSONObject()
        var removeKeys = JSONObject()
        var mergedRating: Int? = if (payload.has("rating") && !payload.isNull("rating")) payload.optInt("rating") else null
        var mergedFavorite: Int? = if (payload.has("is_favorite") && !payload.isNull("is_favorite")) payload.optInt("is_favorite") else null
        var adjObj = JSONObject()

        jDb.rawQuery(
            "SELECT rating, add_tags_json, remove_tags_json, adjustments_json, is_favorite, add_tag_keys_json, remove_tag_keys_json " +
                "FROM pending_changes WHERE journal_key = ? LIMIT 1",
            arrayOf(journalKey)
        ).use { c ->
            if (c.moveToFirst()) {
                if (mergedRating == null && !c.isNull(0)) mergedRating = c.getInt(0)
                val oldAdd = JSONArray(c.getString(1) ?: "[]")
                for (i in 0 until oldAdd.length()) addSet.add(oldAdd.optString(i))
                val oldRem = JSONArray(c.getString(2) ?: "[]")
                for (i in 0 until oldRem.length()) removeSet.add(oldRem.optString(i))
                adjObj = parseJsonObjectOrEmpty(c.getString(3))
                if (mergedFavorite == null && !c.isNull(4)) mergedFavorite = c.getInt(4)
                addKeys = parseJsonObjectOrEmpty(c.getString(5))
                removeKeys = parseJsonObjectOrEmpty(c.getString(6))
            }
        }
        for (intCol in INT_ADJUST_COLUMNS) {
            if (payload.has(intCol) && !payload.isNull(intCol)) adjObj.put(intCol, payload.optInt(intCol, 0))
        }
        for (realCol in REAL_ADJUST_COLUMNS) {
            if (payload.has(realCol) && !payload.isNull(realCol)) adjObj.put(realCol, payload.optDouble(realCol, 0.0))
        }
        if (payload.has("set_stack_primary") && !payload.isNull("set_stack_primary")) {
            adjObj.put("set_stack_primary", payload.optBoolean("set_stack_primary", false))
        }

        payload.optJSONArray("add_tags")?.let { arr ->
            for (i in 0 until arr.length()) {
                val t = arr.optString(i, "").trim()
                if (t.isNotEmpty()) { removeSet.remove(t); addSet.add(t); removeKeysByTagName(removeKeys, t) }
            }
        }
        payload.optJSONArray("remove_tags")?.let { arr ->
            for (i in 0 until arr.length()) {
                val t = arr.optString(i, "").trim()
                if (t.isNotEmpty()) { addSet.remove(t); removeSet.add(t); removeKeysByTagName(addKeys, t) }
            }
        }
        payload.optJSONObject("add_tag_keys")?.let { obj ->
            obj.keys().forEach { k -> removeKeys.remove(k); addKeys.put(k, obj.optString(k, "")) }
        }
        payload.optJSONObject("remove_tag_keys")?.let { obj ->
            obj.keys().forEach { k -> addKeys.remove(k); removeKeys.put(k, obj.optString(k, "")) }
        }

        var nextRev = 1L
        jDb.rawQuery("SELECT COALESCE(MAX(rev), 0) + 1 FROM pending_changes", null).use { c ->
            if (c.moveToFirst()) nextRev = c.getLong(0)
        }

        val cv = ContentValues().apply {
            put("journal_key", journalKey); put("photo_id", photoId); put("content_key", identity.contentKey)
            put("file_path", identity.filePath); put("file_name", identity.fileName)
            put("file_size", identity.fileSize); put("date_taken", identity.dateTaken)
            if (mergedRating != null) put("rating", mergedRating) else putNull("rating")
            if (mergedFavorite != null) put("is_favorite", mergedFavorite) else putNull("is_favorite")
            put("add_tags_json", JSONArray(addSet.toList()).toString())
            put("remove_tags_json", JSONArray(removeSet.toList()).toString())
            put("add_tag_keys_json", addKeys.toString())
            put("remove_tag_keys_json", removeKeys.toString())
            put("adjustments_json", adjObj.toString())
            put("rev", nextRev)
            put("updated_at", nowProvider())
        }
        jDb.insertWithOnConflict("pending_changes", null, cv, SQLiteDatabase.CONFLICT_REPLACE)
    }

    /** 再適用（リプレイ）用に全エントリを返す。adjustments_json はトップレベルへ展開済み */
    fun readReplayPatches(): List<Pair<JSONObject, JSONObject>> = synchronized(lock) {
        val result = mutableListOf<Pair<JSONObject, JSONObject>>()
        ensureOpen().rawQuery("SELECT * FROM pending_changes", null).use { c ->
            while (c.moveToNext()) {
                val entry = cursorRowToJson(c)
                val patch = JSONObject().apply {
                    if (entry.has("rating") && !entry.isNull("rating")) put("rating", entry.optInt("rating"))
                    if (entry.has("is_favorite") && !entry.isNull("is_favorite")) put("is_favorite", entry.optInt("is_favorite"))
                    put("add_tags", JSONArray(entry.optString("add_tags_json", "[]")))
                    put("remove_tags", JSONArray(entry.optString("remove_tags_json", "[]")))
                    val adj = parseJsonObjectOrEmpty(entry.optString("adjustments_json", "{}"))
                    adj.keys().forEach { k -> put(k, adj.get(k)) }
                }
                result.add(Pair(entry, patch))
            }
        }
        result
    }

    fun count(): Int = try {
        ensureOpen().rawQuery("SELECT COUNT(*) FROM pending_changes", null).use { c -> if (c.moveToFirst()) c.getInt(0) else 0 }
    } catch (e: Exception) {
        Log.w(TAG, "未同期件数の取得失敗: ${e.message}")
        0
    }

    /**
     * 送信用 JSON と、その時点の最大 rev を同時に取得する。
     * 送信成功後は clearUpTo(rev) で送信済み分だけを消す。
     */
    fun buildSnapshot(): Pair<String, Long> = synchronized(lock) {
        val changesArr = JSONArray()
        var maxRev = 0L
        ensureOpen().rawQuery("SELECT * FROM pending_changes ORDER BY updated_at ASC", null).use { c ->
            while (c.moveToNext()) {
                val row = cursorRowToJson(c)
                maxRev = maxOf(maxRev, row.optLong("rev", 0L))
                val item = JSONObject()
                    .put("photo_id", row.optLong("photo_id"))
                    .put("content_key", row.optString("content_key", ""))
                    .put("file_path", row.optString("file_path", ""))
                    .put("file_name", row.optString("file_name", ""))
                    .put("file_size", row.optLong("file_size", 0L))
                    .put("date_taken", row.optString("date_taken", ""))
                    .put("add_tags", JSONArray(row.optString("add_tags_json", "[]")))
                    .put("remove_tags", JSONArray(row.optString("remove_tags_json", "[]")))
                if (row.has("rating") && !row.isNull("rating")) item.put("rating", row.optInt("rating"))
                if (row.has("is_favorite") && !row.isNull("is_favorite")) item.put("is_favorite", row.optInt("is_favorite"))
                val addKeys = parseJsonObjectOrEmpty(row.optString("add_tag_keys_json", "{}"))
                if (addKeys.length() > 0) item.put("add_tag_keys", addKeys)
                val removeKeys = parseJsonObjectOrEmpty(row.optString("remove_tag_keys_json", "{}"))
                if (removeKeys.length() > 0) item.put("remove_tag_keys", removeKeys)
                val adj = parseJsonObjectOrEmpty(row.optString("adjustments_json", "{}"))
                adj.keys().forEach { k -> item.put(k, adj.get(k)) }
                changesArr.put(item)
            }
        }
        val payload = JSONObject().put("format", "photo-manager-mobile-sync-v1").put("exported_at", nowProvider())
            .put("source_db", "library.db").put("journal_rev", maxRev).put("changes", changesArr).toString(2) + "\n"
        Pair(payload, maxRev)
    }

    fun clearAll() = synchronized(lock) { ensureOpen().execSQL("DELETE FROM pending_changes") }

    /** 送信済み（rev が指定値以下）のエントリだけを削除し、送信中に追加・更新された変更は残す */
    fun clearUpTo(maxRev: Long) = synchronized(lock) {
        ensureOpen().execSQL("DELETE FROM pending_changes WHERE COALESCE(rev, 0) <= ?", arrayOf<Any>(maxRev))
    }

    /** タグキー辞書 {tag_key: タグ名} から、指定タグ名を値に持つエントリを取り除く */
    private fun removeKeysByTagName(keyMap: JSONObject, tagName: String) {
        val targets = mutableListOf<String>()
        keyMap.keys().forEach { k -> if (keyMap.optString(k, "") == tagName) targets.add(k) }
        targets.forEach { keyMap.remove(it) }
    }

    private fun parseJsonObjectOrEmpty(raw: String?): JSONObject {
        if (raw.isNullOrBlank() || raw == "null") return JSONObject()
        return try {
            JSONObject(raw)
        } catch (e: Exception) {
            Log.w(TAG, "ジャーナル内JSONの解析に失敗したため空として扱います: ${e.message}")
            JSONObject()
        }
    }
}
