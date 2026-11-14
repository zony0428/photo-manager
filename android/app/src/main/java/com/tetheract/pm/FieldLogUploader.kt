package com.tetheract.pm

import android.util.Log
import org.json.JSONObject
import java.net.URLEncoder
import java.security.MessageDigest
import java.util.Locale

/**
 * 端末内に保存された未送信の日付別フィールドログ（JSONL）を Wi-Fi 経由で PC 母艦へ送信するクラス。
 * 送信完了後はハッシュを記録し、設定に応じた送信済み古いログの自動削除を実行する。
 */
class FieldLogUploader(private val store: FieldLogStore) {

    companion object {
        private const val TAG = "FieldLogUploader"
    }

    /** pendingUploadDates を順に POST し、成功した日を markUploaded する。戻り値は送信日数 */
    fun uploadPending(
        serverUrl: String,
        token: String,
        post: (url: String, body: String) -> JSONObject
    ): Int {
        val cleanBaseUrl = serverUrl.trim().trimEnd('/')
        if (cleanBaseUrl.isEmpty()) return 0

        val pendingDates = store.pendingUploadDates()
        if (pendingDates.isEmpty()) {
            store.applyAutoDelete(System.currentTimeMillis())
            return 0
        }

        val deviceId = store.deviceId()
        val deviceName = store.deviceName()
        val encToken = URLEncoder.encode(token, "UTF-8")
        val endpointUrl = "$cleanBaseUrl/api/mobile/field-logs?t=$encToken"
        var uploadedDays = 0

        for (date in pendingDates) {
            val rawBytes = store.readDay(date) ?: continue
            if (rawBytes.isEmpty()) continue

            // 記録中の同時追記でハッシュ不一致が起きないよう、送信文字列のUTF-8バイト列からSHA-256を確定する
            val content = String(rawBytes, Charsets.UTF_8)
            val sha = sha256Hex(content.toByteArray(Charsets.UTF_8)) ?: store.sha256(date) ?: continue

            val bodyJson = JSONObject()
                .put("device_id", deviceId)
                .put("device_name", deviceName)
                .put("date", date)
                .put("sha256", sha)
                .put("content", content)
                .toString()

            try {
                val res = post(endpointUrl, bodyJson)
                if (res.optBoolean("ok", false)) {
                    val recordedSha = res.optString("sha256", sha).ifEmpty { sha }
                    store.markUploaded(date, recordedSha)
                    uploadedDays += 1
                } else {
                    Log.w(TAG, "フィールドログ送信失敗 ($date): ${res.optString("error", "unknown")}")
                }
            } catch (e: Exception) {
                Log.w(TAG, "フィールドログ通信エラー ($date)", e)
            }
        }

        store.applyAutoDelete(System.currentTimeMillis())
        return uploadedDays
    }

    private fun sha256Hex(bytes: ByteArray): String? {
        return try {
            val digest = MessageDigest.getInstance("SHA-256").digest(bytes)
            val sb = StringBuilder(digest.size * 2)
            for (b in digest) {
                sb.append(String.format(Locale.US, "%02x", b))
            }
            sb.toString()
        } catch (e: Exception) {
            Log.w(TAG, "SHA-256 算出失敗", e)
            null
        }
    }
}
