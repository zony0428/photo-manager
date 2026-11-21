package com.tetheract.pm

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Base64
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.UUID

/**
 * ロッカー内 library.db の watermark_assets テーブルを管理するストア。
 * PC側と同一スキーマで透過PNGロゴを保存・配信し、初回のみデフォルトの TETHERACT ロゴを投入する。
 */
class WatermarkAssetStore(
    private val context: Context,
    private val lockerDbManager: LockerDatabaseManager,
) {

    companion object {
        private const val TAG = "WatermarkAssetStore"
        const val DEFAULT_WATERMARK_ID = "default_tetheract_logo"
        const val DEFAULT_WATERMARK_NAME = "TETHERACT"
        const val DEFAULT_WATERMARK_SEED_KEY = "default_watermark_seeded_v1"
        private const val DEFAULT_ASSET_PATH = "icons/tetheract-watermark-default.png"
        private const val MAX_WATERMARK_COUNT = 24
        private const val MAX_LONG_EDGE = 2048
        private const val WATERMARK_URL_PREFIX = "https://appassets.tetheract.local/watermark/"
    }

    data class MobileWatermarkBackupRow(
        val id: String,
        val name: String,
        val mimeType: String,
        val width: Int,
        val height: Int,
        val data: ByteArray,
        val origin: String,
        val createdAt: String,
    )

    fun ensureTableAndSeed(db: SQLiteDatabase) {
        db.execSQL(
            """
            CREATE TABLE IF NOT EXISTS watermark_assets (
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
        db.execSQL(
            """
            CREATE TABLE IF NOT EXISTS app_meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """.trimIndent()
        )
        var alreadySeeded = false
        db.rawQuery("SELECT value FROM app_meta WHERE key = ? LIMIT 1", arrayOf(DEFAULT_WATERMARK_SEED_KEY)).use { c ->
            if (c.moveToFirst() && (c.getString(0) ?: "") == "1") {
                alreadySeeded = true
            }
        }
        if (alreadySeeded) return

        try {
            val rawBytes = context.assets.open(DEFAULT_ASSET_PATH).use { it.readBytes() }
            val opts = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(rawBytes, 0, rawBytes.size, opts)
            val w = opts.outWidth.coerceAtLeast(1)
            val h = opts.outHeight.coerceAtLeast(1)
            val cv = ContentValues().apply {
                put("id", DEFAULT_WATERMARK_ID)
                put("name", DEFAULT_WATERMARK_NAME)
                put("mime_type", "image/png")
                put("width", w)
                put("height", h)
                put("data", rawBytes)
                put("origin", "default")
                put("created_at", lockerDbManager.formatLocalNow())
            }
            db.insertWithOnConflict("watermark_assets", null, cv, SQLiteDatabase.CONFLICT_IGNORE)
            val metaCv = ContentValues().apply {
                put("key", DEFAULT_WATERMARK_SEED_KEY)
                put("value", "1")
            }
            db.insertWithOnConflict("app_meta", null, metaCv, SQLiteDatabase.CONFLICT_REPLACE)
        } catch (e: Exception) {
            Log.w(TAG, "デフォルトウォーターマーク初期投入スキップ: ${e.message}")
        }
    }

    /** フルDB差し替え前にスマホ側で登録した origin='mobile' ロゴを退避する */
    fun readMobileLocalBackup(db: SQLiteDatabase): List<MobileWatermarkBackupRow> {
        val out = mutableListOf<MobileWatermarkBackupRow>()
        try {
            db.rawQuery("SELECT 1 FROM sqlite_master WHERE type='table' AND name='watermark_assets'", null).use { c ->
                if (!c.moveToFirst()) return out
            }
            db.rawQuery(
                "SELECT id, name, mime_type, width, height, data, origin, created_at FROM watermark_assets WHERE origin = 'mobile'",
                null
            ).use { c ->
                while (c.moveToNext()) {
                    val bytes = c.getBlob(5) ?: continue
                    out.add(
                        MobileWatermarkBackupRow(
                            id = c.getString(0) ?: continue,
                            name = c.getString(1) ?: "logo.png",
                            mimeType = c.getString(2) ?: "image/png",
                            width = c.getInt(3),
                            height = c.getInt(4),
                            data = bytes,
                            origin = c.getString(6) ?: "mobile",
                            createdAt = c.getString(7) ?: lockerDbManager.formatLocalNow(),
                        )
                    )
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "スマホ登録ロゴの退避スキップ: ${e.message}")
        }
        return out
    }

    /** フルDB差し替え後に退避しておいたスマホ登録ロゴを書き戻す */
    fun restoreMobileLocalBackup(db: SQLiteDatabase, rows: List<MobileWatermarkBackupRow>) {
        if (rows.isEmpty()) return
        try {
            ensureTableAndSeed(db)
            for (r in rows) {
                val cv = ContentValues().apply {
                    put("id", r.id)
                    put("name", r.name)
                    put("mime_type", r.mimeType)
                    put("width", r.width)
                    put("height", r.height)
                    put("data", r.data)
                    put("origin", r.origin)
                    put("created_at", r.createdAt)
                }
                db.insertWithOnConflict("watermark_assets", null, cv, SQLiteDatabase.CONFLICT_REPLACE)
            }
        } catch (e: Exception) {
            Log.w(TAG, "スマホ登録ロゴの復元スキップ: ${e.message}")
        }
    }

    fun listAssetsJson(): String {
        return try {
            val arr = lockerDbManager.withWritableDatabase(createIfMissing = true) { db ->
                ensureTableAndSeed(db)
                queryListArray(db)
            } ?: JSONArray()
            JSONObject().put("ok", true).put("watermarks", arr).toString()
        } catch (e: Exception) {
            Log.e(TAG, "ウォーターマーク一覧取得エラー", e)
            JSONObject().put("ok", false).put("watermarks", JSONArray()).put("error", e.message ?: "一覧取得に失敗しました").toString()
        }
    }

    fun getAssetBlob(assetId: String): Pair<String, ByteArray>? {
        val aid = assetId.trim()
        if (aid.isEmpty() || !aid.matches(Regex("^[A-Za-z0-9_-]{1,64}$"))) return null
        return lockerDbManager.withWritableDatabase(createIfMissing = false) { db ->
            try {
                db.rawQuery("SELECT mime_type, data FROM watermark_assets WHERE id = ? LIMIT 1", arrayOf(aid)).use { c ->
                    if (c.moveToFirst()) {
                        val mime = c.getString(0) ?: "image/png"
                        val bytes = c.getBlob(1) ?: return@use null
                        if (bytes.isNotEmpty()) Pair(mime, bytes) else null
                    } else {
                        null
                    }
                }
            } catch (e: Exception) {
                Log.w(TAG, "ウォーターマークBLOB取得エラー ($aid): ${e.message}")
                null
            }
        }
    }

    fun saveAssetJson(payloadJson: String): String {
        var decoded: Bitmap? = null
        var scaled: Bitmap? = null
        return try {
            val req = JSONObject(payloadJson)
            val dataUrl = req.optString("dataUrl", "").trim()
            val commaIdx = dataUrl.indexOf(',')
            val b64 = if (commaIdx >= 0) dataUrl.substring(commaIdx + 1) else dataUrl
            if (b64.isEmpty()) {
                return JSONObject().put("ok", false).put("error", "画像データが空です").toString()
            }
            val rawBytes = Base64.decode(b64, Base64.DEFAULT)
            if (rawBytes.size > 15 * 1024 * 1024) {
                return JSONObject().put("ok", false).put("error", "15MB以下の画像を選択してください").toString()
            }

            decoded = BitmapFactory.decodeByteArray(rawBytes, 0, rawBytes.size)
                ?: return JSONObject().put("ok", false).put("error", "画像を読み込めませんでした").toString()

            val srcW = decoded.width.coerceAtLeast(1)
            val srcH = decoded.height.coerceAtLeast(1)
            val longEdge = maxOf(srcW, srcH)
            val outBmp = if (longEdge > MAX_LONG_EDGE) {
                val sc = MAX_LONG_EDGE.toFloat() / longEdge.toFloat()
                val nw = (srcW * sc).toInt().coerceAtLeast(1)
                val nh = (srcH * sc).toInt().coerceAtLeast(1)
                scaled = Bitmap.createScaledBitmap(decoded, nw, nh, true)
                scaled
            } else {
                decoded
            }

            val baos = ByteArrayOutputStream()
            outBmp.compress(Bitmap.CompressFormat.PNG, 100, baos)
            val pngBytes = baos.toByteArray()
            val outW = outBmp.width
            val outH = outBmp.height

            val rawName = req.optString("name", "logo.png").trim()
                .substringAfterLast('/')
                .substringAfterLast('\\')
                .ifEmpty { "logo.png" }
            val aid = "mob_${UUID.randomUUID().toString().replace("-", "").take(16)}"
            val nowStr = lockerDbManager.formatLocalNow()

            val saveRes = lockerDbManager.withWritableDatabase(createIfMissing = true) { db ->
                ensureTableAndSeed(db)
                var curCnt = 0
                db.rawQuery("SELECT COUNT(*) FROM watermark_assets", null).use { c ->
                    if (c.moveToFirst()) curCnt = c.getInt(0)
                }
                if (curCnt >= MAX_WATERMARK_COUNT) {
                    return@withWritableDatabase JSONObject()
                        .put("ok", false)
                        .put("error", "登録できるロゴ画像は最大${MAX_WATERMARK_COUNT}枚までです")
                }
                val cv = ContentValues().apply {
                    put("id", aid)
                    put("name", rawName)
                    put("mime_type", "image/png")
                    put("width", outW)
                    put("height", outH)
                    put("data", pngBytes)
                    put("origin", "mobile")
                    put("created_at", nowStr)
                }
                db.insertWithOnConflict("watermark_assets", null, cv, SQLiteDatabase.CONFLICT_REPLACE)

                val assetObj = JSONObject()
                    .put("id", aid)
                    .put("name", rawName)
                    .put("mime_type", "image/png")
                    .put("width", outW)
                    .put("height", outH)
                    .put("byte_size", pngBytes.size)
                    .put("origin", "mobile")
                    .put("created_at", nowStr)
                    .put("image_url", "$WATERMARK_URL_PREFIX$aid")

                JSONObject()
                    .put("ok", true)
                    .put("asset", assetObj)
                    .put("watermarks", queryListArray(db))
            }
            (saveRes ?: JSONObject().put("ok", false).put("error", "DBを開けませんでした")).toString()
        } catch (e: Exception) {
            Log.e(TAG, "ウォーターマーク保存エラー", e)
            JSONObject().put("ok", false).put("error", e.message ?: "ロゴの保存に失敗しました").toString()
        } finally {
            try { if (scaled != null && scaled !== decoded && !scaled!!.isRecycled) scaled!!.recycle() } catch (_: Exception) {}
            try { if (decoded != null && !decoded!!.isRecycled) decoded!!.recycle() } catch (_: Exception) {}
        }
    }

    fun deleteAssetJson(assetId: String): String {
        val aid = assetId.trim()
        if (aid.isEmpty() || !aid.matches(Regex("^[A-Za-z0-9_-]{1,64}$"))) {
            return JSONObject().put("ok", false).put("error", "無効なIDです").toString()
        }
        return try {
            val res = lockerDbManager.withWritableDatabase(createIfMissing = true) { db ->
                ensureTableAndSeed(db)
                val rows = db.delete("watermark_assets", "id = ?", arrayOf(aid))
                if (aid == DEFAULT_WATERMARK_ID) {
                    val metaCv = ContentValues().apply {
                        put("key", DEFAULT_WATERMARK_SEED_KEY)
                        put("value", "1")
                    }
                    db.insertWithOnConflict("app_meta", null, metaCv, SQLiteDatabase.CONFLICT_REPLACE)
                }
                JSONObject()
                    .put("ok", rows > 0)
                    .put("deleted_id", aid)
                    .put("watermarks", queryListArray(db))
            }
            (res ?: JSONObject().put("ok", false).put("error", "DBを開けませんでした")).toString()
        } catch (e: Exception) {
            Log.e(TAG, "ウォーターマーク削除エラー", e)
            JSONObject().put("ok", false).put("error", e.message ?: "ロゴの削除に失敗しました").toString()
        }
    }

    private fun queryListArray(db: SQLiteDatabase): JSONArray {
        val arr = JSONArray()
        db.rawQuery(
            """
            SELECT id, name, mime_type, width, height, LENGTH(data) AS byte_size, origin, created_at
            FROM watermark_assets
            ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, created_at ASC, id ASC
            """.trimIndent(),
            arrayOf(DEFAULT_WATERMARK_ID)
        ).use { c ->
            while (c.moveToNext()) {
                val aid = c.getString(0) ?: continue
                arr.put(
                    JSONObject()
                        .put("id", aid)
                        .put("name", c.getString(1) ?: "logo.png")
                        .put("mime_type", c.getString(2) ?: "image/png")
                        .put("width", c.getInt(3))
                        .put("height", c.getInt(4))
                        .put("byte_size", c.getLong(5))
                        .put("origin", c.getString(6) ?: "pc")
                        .put("created_at", c.getString(7) ?: "")
                        .put("image_url", "$WATERMARK_URL_PREFIX$aid")
                )
            }
        }
        return arr
    }
}
