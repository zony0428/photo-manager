package com.tetheract.pm

import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.media.ExifInterface
import android.util.Base64
import android.util.Log
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream

/**
 * ライトボックス等から端末ギャラリーを汚さずに SNS 共有シートを起動するヘルパー。
 * cacheDir/share/ に一時画像を書き出し、GPSを含まない Exif を整えた上で FileProvider 経由で ACTION_SEND を発行する。
 */
class QuickShareHelper(private val context: Context) {

    companion object {
        private const val TAG = "QuickShareHelper"
        private const val SHARE_DIR_NAME = "share"
        private const val MAX_CACHE_FILES = 10
        private const val MAX_CACHE_AGE_MS = 3L * 60L * 60L * 1000L
    }

    /** DataURL 画像を一時ファイルとして書き出し、OS標準共有シートを開く */
    fun sharePhotoFromDataUrlJson(payloadJson: String): String {
        return try {
            val req = JSONObject(payloadJson)
            val dataUrl = req.optString("dataUrl", "").trim()
            val commaIdx = dataUrl.indexOf(',')
            val b64 = if (commaIdx >= 0) dataUrl.substring(commaIdx + 1) else dataUrl
            if (b64.isEmpty()) {
                return JSONObject().put("ok", false).put("error", "共有する画像データが空です").toString()
            }

            val isPng = dataUrl.startsWith("data:image/png", ignoreCase = true) ||
                req.optString("mimeType", "").equals("image/png", ignoreCase = true)
            val mimeType = if (isPng) "image/png" else "image/jpeg"
            val ext = if (isPng) "png" else "jpg"

            val rawName = req.optString("fileName", "tetheract_share.$ext").trim()
            val cleanBase = rawName
                .substringAfterLast('/')
                .substringAfterLast('\\')
                .substringBeforeLast('.')
                .replace(Regex("[^A-Za-z0-9._\\-\\u3040-\\u30FF\\u4E00-\\u9FFF]"), "_")
                .ifEmpty { "tetheract_share" }
                .take(80)
            val finalName = "${cleanBase}_${System.currentTimeMillis() % 100000}.$ext"

            val bytes = Base64.decode(b64, Base64.DEFAULT)
            if (bytes.isEmpty()) {
                return JSONObject().put("ok", false).put("error", "画像データのデコードに失敗しました").toString()
            }

            val shareDir = File(context.cacheDir, SHARE_DIR_NAME).apply { mkdirs() }
            cleanupOldCacheFiles(shareDir)

            val outFile = File(shareDir, finalName)
            FileOutputStream(outFile).use { fos ->
                fos.write(bytes)
                fos.flush()
            }

            // JPEG時は GPS を含めず撮影日時・カメラ機種のみ任意付与（Canvas生成JPEGのためGPSは元から非含有）
            if (!isPng) {
                applySafeNonGpsExif(
                    outFile = outFile,
                    dateTakenRaw = req.optString("dateTaken", "").trim(),
                    cameraModelRaw = req.optString("cameraModel", "").trim(),
                )
            }

            val authority = "${context.packageName}.fileprovider"
            val shareUri = FileProvider.getUriForFile(context, authority, outFile)

            val shareIntent = Intent(Intent.ACTION_SEND).apply {
                type = mimeType
                putExtra(Intent.EXTRA_STREAM, shareUri)
                clipData = ClipData.newRawUri(cleanBase, shareUri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            val chooser = Intent.createChooser(shareIntent, "SNSへ共有").apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            context.startActivity(chooser)

            JSONObject()
                .put("ok", true)
                .put("fileName", finalName)
                .put("fileSize", outFile.length())
                .toString()
        } catch (e: Exception) {
            Log.e(TAG, "SNSクイック共有エラー", e)
            JSONObject()
                .put("ok", false)
                .put("error", e.message ?: "共有画面を開けませんでした")
                .toString()
        }
    }

    private fun applySafeNonGpsExif(outFile: File, dateTakenRaw: String, cameraModelRaw: String) {
        val normDate = normalizeExifDateTime(dateTakenRaw)
        val cleanModel = if (cameraModelRaw.isNotEmpty() && cameraModelRaw != "不明" && cameraModelRaw != "RAW写真") {
            cameraModelRaw
        } else {
            ""
        }
        if (normDate.isEmpty() && cleanModel.isEmpty()) return
        try {
            val exif = ExifInterface(outFile.absolutePath)
            if (normDate.isNotEmpty()) {
                exif.setAttribute(ExifInterface.TAG_DATETIME_ORIGINAL, normDate)
                exif.setAttribute(ExifInterface.TAG_DATETIME_DIGITIZED, normDate)
                exif.setAttribute(ExifInterface.TAG_DATETIME, normDate)
            }
            if (cleanModel.isNotEmpty()) {
                exif.setAttribute(ExifInterface.TAG_MODEL, cleanModel)
            }
            exif.saveAttributes()
        } catch (e: Exception) {
            Log.w(TAG, "共有用一時ファイルのExif設定スキップ: ${e.message}")
        }
    }

    private fun normalizeExifDateTime(raw: String): String {
        val m = Regex("(\\d{4})[-:/](\\d{2})[-:/](\\d{2})[T\\s]+(\\d{2}):(\\d{2})(?::(\\d{2}))?").find(raw)
            ?: return ""
        val sec = m.groupValues[6].ifEmpty { "00" }
        return "${m.groupValues[1]}:${m.groupValues[2]}:${m.groupValues[3]} ${m.groupValues[4]}:${m.groupValues[5]}:$sec"
    }

    private fun cleanupOldCacheFiles(shareDir: File) {
        try {
            val files = shareDir.listFiles()?.filter { it.isFile }?.sortedByDescending { it.lastModified() } ?: return
            val now = System.currentTimeMillis()
            files.forEachIndexed { idx, f ->
                if (idx >= MAX_CACHE_FILES || (now - f.lastModified()) > MAX_CACHE_AGE_MS) {
                    f.delete()
                }
            }
        } catch (e: Exception) {
            Log.d(TAG, "共有キャッシュ掃除スキップ: ${e.message}")
        }
    }
}
