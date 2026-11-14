package com.tetheract.pm

import android.content.Context
import android.util.Log
import androidx.documentfile.provider.DocumentFile
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.File
import java.io.FileOutputStream
import java.util.zip.ZipInputStream

/**
 * オフライン USB UIバンドル・アップデート機構を管理するクラス。
 * USB内の android/tetheract_ui_bundle.zip (または Tetheract_Mobile.html) を検知し、
 * context.filesDir/ui_bundle/ へホットアップデート展開して WebView を即時リロードする。
 * （※Google Play プロテクトの誤検知を防ぐため、アプリ内からの他APK起動コードは持たないクリーン設計）
 */
class UsbOfflineUpdater(
    private val context: Context,
    private val safUsbManager: SafUsbManager,
    private val onReloadWebViewRequested: (() -> Unit)? = null
) {

    companion object {
        private const val TAG = "UsbOfflineUpdater"
        private const val BUFFER_SIZE = 32 * 1024
    }

    val uiBundleRootDir: File = File(context.filesDir, "ui_bundle").apply { mkdirs() }
    val uiBundleCurrentDir: File = File(uiBundleRootDir, "current").apply { mkdirs() }
    private val uiBundleMetaFile: File = File(uiBundleRootDir, "ui_bundle_meta.json")

    init {
        try {
            val pkgInfo = context.packageManager.getPackageInfo(context.packageName, 0)
            val pkgTime = pkgInfo.lastUpdateTime
            @Suppress("DEPRECATION")
            val pkgVer = if (android.os.Build.VERSION.SDK_INT >= 28) pkgInfo.longVersionCode else pkgInfo.versionCode.toLong()
            val legacyHotDir = File(context.filesDir, "hot_web_assets")
            if (legacyHotDir.exists()) legacyHotDir.deleteRecursively()

            val meta = readBundleMeta()
            val prevApkTime = meta.optLong("apk_update_time", 0L)
            val prevApkVer = meta.optLong("apk_version_code", 0L)
            val bundleMtime = meta.optLong("ui_mtime", 0L)
            if (pkgTime > prevApkTime || pkgVer > prevApkVer || (bundleMtime in 1L..pkgTime)) {
                if (uiBundleCurrentDir.exists()) uiBundleCurrentDir.deleteRecursively()
                uiBundleCurrentDir.mkdirs()
                writeBundleMeta(
                    JSONObject()
                        .put("apk_update_time", pkgTime)
                        .put("apk_version_code", pkgVer)
                )
            }
        } catch (_: Exception) {}
    }

    /**
     * ホットアップデート済みの UI ファイルが filesDir/ui_bundle/current/ 内に存在すれば返す
     */
    fun resolveHotUpdatedAsset(relativePath: String): File? {
        val cleanRel = relativePath.trimStart('/').replace('\\', '/')
        if (cleanRel.isEmpty() || cleanRel.contains("..")) return null
        val target = File(uiBundleCurrentDir, cleanRel)
        val canonicalBase = uiBundleCurrentDir.canonicalPath
        val canonicalTarget = target.canonicalPath
        if (!canonicalTarget.startsWith(canonicalBase)) return null
        return if (target.exists() && target.isFile) target else null
    }

    /**
     * USB内の UIバンドルの有無と更新状態をチェックする（APK自身より古いUSBバンドルは適用しない）
     */
    fun checkAvailableUsbUpdates(): JSONObject? {
        val rootDoc = safUsbManager.getConnectedUsbRootDocument() ?: return null
        val androidDir = rootDoc.findFile("android")?.takeIf { it.isDirectory }
        val uiBundleDoc = findUiBundleDocument(rootDoc, androidDir) ?: return null

        val meta = readBundleMeta()
        val pkgTime = try { context.packageManager.getPackageInfo(context.packageName, 0).lastUpdateTime } catch (_: Exception) { 0L }
        val mtime = uiBundleDoc.lastModified()
        if (mtime in 1L..pkgTime) return null

        val hasNewUiBundle = mtime != meta.optLong("ui_mtime", -1L) ||
            uiBundleDoc.length() != meta.optLong("ui_size", -1L)

        if (!hasNewUiBundle) {
            return null
        }

        return JSONObject()
            .put("hasUiBundleUpdate", true)
            .put("uiBundleName", uiBundleDoc.name ?: "")
            .put("apkUpdate", JSONObject.NULL)
    }

    /**
     * UIホットアップデートの適用を行う（APKより新しいバンドルのみ適用する）
     */
    fun checkAndTriggerUpdate(autoApplyUi: Boolean = true, triggerApkInstall: Boolean = false): JSONObject {
        val rootDoc = safUsbManager.getConnectedUsbRootDocument()
            ?: return JSONObject()
                .put("ok", false)
                .put("usbConnected", false)
                .put("reason", "usb_not_connected")

        val androidDir = rootDoc.findFile("android")?.takeIf { it.isDirectory }
        var uiApplied = false

        if (autoApplyUi) {
            val uiDoc = findUiBundleDocument(rootDoc, androidDir)
            if (uiDoc != null) {
                val meta = readBundleMeta()
                val pkgTime = try { context.packageManager.getPackageInfo(context.packageName, 0).lastUpdateTime } catch (_: Exception) { 0L }
                val mtime = uiDoc.lastModified()
                val size = uiDoc.length()
                val isNewerThanApk = mtime <= 0L || mtime > pkgTime
                if (isNewerThanApk && (mtime != meta.optLong("ui_mtime", -1L) || size != meta.optLong("ui_size", -1L))) {
                    uiApplied = applyUiBundleFromDocument(uiDoc, mtime, size)
                    if (uiApplied) {
                        onReloadWebViewRequested?.invoke()
                    }
                }
            }
        }

        return JSONObject()
            .put("ok", true)
            .put("usbConnected", true)
            .put("uiBundleApplied", uiApplied)
            .put("apkAvailable", false)
            .put("apkVersionName", "")
            .put("apkInstallerLaunched", false)
    }

    private fun findUiBundleDocument(rootDoc: DocumentFile, androidDir: DocumentFile?): DocumentFile? {
        androidDir?.findFile("tetheract_ui_bundle.zip")?.takeIf { it.isFile && it.length() > 0 }?.let { return it }
        rootDoc.findFile("tetheract_ui_bundle.zip")?.takeIf { it.isFile && it.length() > 0 }?.let { return it }
        androidDir?.findFile("Tetheract_Mobile.html")?.takeIf { it.isFile && it.length() > 0 }?.let { return it }
        rootDoc.findFile("Tetheract_Mobile.html")?.takeIf { it.isFile && it.length() > 0 }?.let { return it }
        return null
    }

    /**
     * USB内の tetheract_ui_bundle.zip または Tetheract_Mobile.html を内部ロッカーへ展開する
     */
    private fun applyUiBundleFromDocument(uiDoc: DocumentFile, mtime: Long, size: Long): Boolean {
        val stagingDir = File(uiBundleRootDir, "staging")
        return try {
            if (stagingDir.exists()) stagingDir.deleteRecursively()
            stagingDir.mkdirs()

            val name = (uiDoc.name ?: "").lowercase()
            val input = context.contentResolver.openInputStream(uiDoc.uri) ?: return false

            if (name.endsWith(".zip")) {
                val canonicalStaging = stagingDir.canonicalPath
                ZipInputStream(BufferedInputStream(input, BUFFER_SIZE)).use { zis ->
                    var entry = zis.nextEntry
                    while (entry != null) {
                        val entryName = entry.name.replace('\\', '/').trimStart('/')
                        if (entryName.isNotEmpty() && !entryName.contains("..")) {
                            val outFile = File(stagingDir, entryName)
                            if (!outFile.canonicalPath.startsWith(canonicalStaging)) {
                                throw SecurityException("Zip Slip 検出: $entryName")
                            }
                            if (entry.isDirectory) {
                                outFile.mkdirs()
                            } else {
                                outFile.parentFile?.mkdirs()
                                BufferedOutputStream(FileOutputStream(outFile), BUFFER_SIZE).use { bos ->
                                    val buf = ByteArray(BUFFER_SIZE)
                                    var len: Int
                                    while (zis.read(buf).also { len = it } != -1) {
                                        bos.write(buf, 0, len)
                                    }
                                    bos.flush()
                                }
                            }
                        }
                        zis.closeEntry()
                        entry = zis.nextEntry
                    }
                }
            } else {
                val outFile = File(stagingDir, "mobile.html")
                BufferedInputStream(input, BUFFER_SIZE).use { bis ->
                    BufferedOutputStream(FileOutputStream(outFile), BUFFER_SIZE).use { bos ->
                        val buf = ByteArray(BUFFER_SIZE)
                        var len: Int
                        while (bis.read(buf).also { len = it } != -1) {
                            bos.write(buf, 0, len)
                        }
                        bos.flush()
                    }
                }
            }

            if (uiBundleCurrentDir.exists()) uiBundleCurrentDir.deleteRecursively()
            if (!stagingDir.renameTo(uiBundleCurrentDir)) {
                stagingDir.copyRecursively(uiBundleCurrentDir, overwrite = true)
                stagingDir.deleteRecursively()
            }

            val pkgInfo = try { context.packageManager.getPackageInfo(context.packageName, 0) } catch (_: Exception) { null }
            val pkgTime = pkgInfo?.lastUpdateTime ?: 0L
            @Suppress("DEPRECATION")
            val pkgVer = if (pkgInfo != null) {
                if (android.os.Build.VERSION.SDK_INT >= 28) pkgInfo.longVersionCode else pkgInfo.versionCode.toLong()
            } else 0L

            writeBundleMeta(
                JSONObject()
                    .put("apk_update_time", pkgTime)
                    .put("apk_version_code", pkgVer)
                    .put("ui_mtime", mtime)
                    .put("ui_size", size)
                    .put("ui_name", uiDoc.name ?: "")
            )
            true
        } catch (e: Exception) {
            Log.e(TAG, "UIバンドル展開エラー", e)
            stagingDir.deleteRecursively()
            false
        }
    }

    private fun readBundleMeta(): JSONObject {
        if (!uiBundleMetaFile.exists()) return JSONObject()
        return try {
            JSONObject(uiBundleMetaFile.readText(Charsets.UTF_8))
        } catch (e: Exception) {
            JSONObject()
        }
    }

    private fun writeBundleMeta(meta: JSONObject) {
        try {
            uiBundleMetaFile.writeText(meta.toString(2), Charsets.UTF_8)
        } catch (e: Exception) {
            Log.w(TAG, "UIバンドルメタ保存失敗", e)
        }
    }

    fun getAppVersionLabel(): String = try {
        context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: ""
    } catch (_: Exception) { "" }
}
