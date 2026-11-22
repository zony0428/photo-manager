package com.tetheract.pm

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.util.Log
import androidx.documentfile.provider.DocumentFile
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream

/**
 * USB 接続時に母艦側の cache/mobile_delta.db または cache/library.db を
 * 完全読み取り専用（Read-Only）でアプリ専用一時領域へ読み込み、ロッカーDBへ自動差分反映するマネージャ。
 * 安全のため USB 側へは 1 バイトも書き込まず、片方向（母艦 → モバイル）ダウンリンクのみを行う。
 */
class UsbDownlinkSyncManager(
    private val context: Context,
    private val lockerDbManager: LockerDatabaseManager,
    private val safUsbManager: SafUsbManager
) {

    companion object {
        private const val TAG = "UsbDownlinkSyncManager"
        private const val BUFFER_SIZE = 65536
        private val SQLITE_MAGIC = "SQLite format 3\u0000".toByteArray(Charsets.US_ASCII)
    }

    private val syncLock = Any()

    /** 接続中 USB 内の cache/ からカタログ差分（または完全版DB）を Read-Only で自動取込する */
    fun syncCatalogFromConnectedUsb(
        mountRes: JSONObject,
        allowLibrarySwitch: Boolean = false,
        onProgress: (title: String, sub: String) -> Unit = { _, _ -> }
    ): JSONObject = synchronized(syncLock) {
        val baseRes = JSONObject(mountRes.toString())
        if (!baseRes.optBoolean("ok", false) || baseRes.optBoolean("needsPassword", false)) {
            return baseRes
        }

        val rootDoc = safUsbManager.getConnectedUsbRootDocument() ?: return baseRes
        val folderLabel = rootDoc.name ?: baseRes.optString("usbFolderName", "Loome USB")
        val cacheDir = safUsbManager.findCacheDirectory(rootDoc)
        if (cacheDir == null) {
            val rootName = (rootDoc.name ?: "").trim()
            val skipReason = if (rootName.equals("Loome", ignoreCase = true) || rootName.equals("storage", ignoreCase = true)) {
                "cache_not_accessible"
            } else {
                "no_cache_db"
            }
            return baseRes.put("catalogSkipReason", skipReason)
        }

        val deltaDoc = cacheDir.findFile("mobile_delta.db")?.takeIf { it.isFile && it.canRead() }
        val fullDoc = cacheDir.findFile("library.db")?.takeIf { it.isFile && it.canRead() }
        val walDoc = cacheDir.findFile("library.db-wal")?.takeIf { it.isFile && it.canRead() }
        if (deltaDoc == null && fullDoc == null) {
            return baseRes.put("catalogSkipReason", "no_cache_db")
        }

        val usbSig = buildUsbSignature(deltaDoc, fullDoc, walDoc)
        val prevMeta = lockerDbManager.readLockerMeta()
        val hasExistingLocker = lockerDbManager.hasLockerDatabase()
        if (!allowLibrarySwitch && hasExistingLocker && prevMeta.optString("usb_last_downlink_sig", "") == usbSig) {
            return baseRes
                .put("ok", true)
                .put("updated", false)
                .put("usbConnected", true)
                .put("loomeMounted", true)
                .put("downlinkOnly", true)
                .put("syncMode", "usb_downlink_noop")
                .put("addedCount", 0)
                .put("removedCount", 0)
                .put("reappliedCount", 0)
                .put("dbPhotoCount", lockerDbManager.getPhotoCount())
                .put("pendingChangeCount", lockerDbManager.getPendingChangeCount())
                .put("usbFolderName", folderLabel)
        }

        val beforeMotherCount = lockerDbManager.getMotherPhotoCount()
        val tmpDir = File(context.cacheDir, "usb_downlink").apply {
            deleteRecursively()
            mkdirs()
        }

        try {
            var applied = false
            var syncMode = ""
            var reapplied = 0
            var resolvedLibId = ""
            var resolvedOwnerId = ""
            val hasLocalData = hasExistingLocker || lockerDbManager.getPendingChangeCount() > 0

            // Tier 1: 高速軽量パック (cache/mobile_delta.db) を優先適用（library.db より古い場合は Tier 2 へ自動フォールバック）
            val walLen = walDoc?.length() ?: 0L
            val latestFullMtime = maxOf(fullDoc?.lastModified() ?: 0L, if (walLen > 0L) walDoc?.lastModified() ?: 0L else 0L)
            val deltaFresh = deltaDoc != null && deltaDoc.length() >= 4096L &&
                (latestFullMtime <= 0L || deltaDoc.lastModified() + 2000L >= latestFullMtime)

            if (hasExistingLocker && !allowLibrarySwitch && deltaFresh) {
                val tmpDelta = File(tmpDir, "mobile_delta_usb.tmp.db")
                if (copyDocumentReadOnly(deltaDoc!!, tmpDelta) && validateSqliteHeader(tmpDelta)) {
                    val localOwner = lockerDbManager.readLocalOwnerId()
                    val remoteOwner = lockerDbManager.extractSqliteOwnerId(tmpDelta, isDelta = true)
                    if (localOwner.isNotEmpty() && remoteOwner.isNotEmpty() && localOwner != remoteOwner) {
                        return ethicalBlockResult()
                    }
                    val localLibId = lockerDbManager.readLocalLibraryId()
                    val remoteLibId = lockerDbManager.extractSqliteLibraryId(tmpDelta, isDelta = true)
                    if (hasLocalData && localLibId.isNotEmpty() && remoteLibId.isNotEmpty() && localLibId != remoteLibId) {
                        return buildLibraryMismatchResult(prevMeta, folderLabel)
                    }
                    if (lockerDbManager.applyDeltaDatabase(tmpDelta)) {
                        reapplied = lockerDbManager.replayPendingJournal()
                        syncMode = "usb_downlink_delta"
                        resolvedLibId = remoteLibId
                        resolvedOwnerId = remoteOwner
                        applied = true
                    }
                }
            }

            // Tier 2: 初回取込またはデルタ適用不可時の cache/library.db (+ -wal) 読み取り専用取り込み
            if (!applied) {
                if (fullDoc == null || fullDoc.length() < 4096L) {
                    return baseRes.put("catalogSkipReason", "no_cache_db")
                }
                onProgress(
                    "母艦USBからカタログを自動取込中（読み取り専用）...",
                    "安全のため母艦 → モバイルのダウンリンク専用です。USBへは書き込みません"
                )
                val tmpFull = File(tmpDir, "library_usb.tmp.db")
                if (!copyDocumentReadOnly(fullDoc, tmpFull) || !validateSqliteHeader(tmpFull)) {
                    return baseRes.put("catalogSkipReason", "invalid_db_header")
                }
                if (walDoc != null && walDoc.length() > 0L) {
                    val tmpWal = File(tmpDir, "library_usb.tmp.db-wal")
                    if (copyDocumentReadOnly(walDoc, tmpWal)) {
                        checkpointTempWalToSingleDb(tmpFull, tmpWal)
                    }
                }
                lockerDbManager.prepareTempDatabaseForAndroidRead(tmpFull)

                val localOwner = lockerDbManager.readLocalOwnerId()
                val remoteOwner = lockerDbManager.extractSqliteOwnerId(tmpFull, isDelta = false)
                if (localOwner.isNotEmpty() && remoteOwner.isNotEmpty() && localOwner != remoteOwner) {
                    return ethicalBlockResult()
                }

                val localLibId = lockerDbManager.readLocalLibraryId()
                val remoteLibId = lockerDbManager.extractSqliteLibraryId(tmpFull, isDelta = false)
                if (!allowLibrarySwitch && hasLocalData && localLibId.isNotEmpty() && remoteLibId.isNotEmpty() && localLibId != remoteLibId) {
                    return buildLibraryMismatchResult(prevMeta, folderLabel)
                }

                if (!hasExistingLocker || allowLibrarySwitch) {
                    reapplied = lockerDbManager.replaceLibraryDatabaseFromTemp(tmpFull, BUFFER_SIZE)
                    syncMode = "usb_downlink_full"
                } else if (lockerDbManager.applyFullLibraryDiffFromTemp(tmpFull)) {
                    reapplied = lockerDbManager.replayPendingJournal()
                    syncMode = "usb_downlink_diff"
                } else {
                    reapplied = lockerDbManager.replaceLibraryDatabaseFromTemp(tmpFull, BUFFER_SIZE)
                    syncMode = "usb_downlink_full"
                }
                resolvedLibId = remoteLibId
                resolvedOwnerId = remoteOwner
            }

            val nowStr = lockerDbManager.formatLocalNow()
            val updatedMeta = JSONObject(prevMeta.toString())
                .put("library_id", resolvedLibId.ifEmpty { lockerDbManager.readLocalLibraryId() })
                .put("owner_id", resolvedOwnerId.ifEmpty { lockerDbManager.readLocalOwnerId() })
                .put("last_cached_at", nowStr)
                .put("usb_folder_name", folderLabel)
                .put("usb_last_downlink_sig", usbSig)
                .put("usb_last_downlink_at", nowStr)
                .put("reapplied_journal_count", reapplied)
            lockerDbManager.writeLockerMeta(updatedMeta)

            val afterMotherCount = lockerDbManager.getMotherPhotoCount()
            val addedCount = maxOf(0, afterMotherCount - beforeMotherCount)
            val removedCount = maxOf(0, beforeMotherCount - afterMotherCount)

            baseRes
                .put("ok", true)
                .put("updated", true)
                .put("usbConnected", true)
                .put("loomeMounted", true)
                .put("downlinkOnly", true)
                .put("syncMode", syncMode)
                .put("addedCount", addedCount)
                .put("removedCount", removedCount)
                .put("reappliedCount", reapplied)
                .put("dbPhotoCount", lockerDbManager.getPhotoCount())
                .put("pendingChangeCount", lockerDbManager.getPendingChangeCount())
                .put("usbFolderName", folderLabel)
        } catch (e: Exception) {
            Log.w(TAG, "USB自動差分ダウンリンク警告（Loomeマウントは継続）", e)
            baseRes.put("catalogSkipReason", "downlink_error")
        } finally {
            tmpDir.deleteRecursively()
        }
    }

    private fun buildUsbSignature(
        deltaDoc: DocumentFile?,
        fullDoc: DocumentFile?,
        walDoc: DocumentFile?
    ): String {
        val dPart = "d:${deltaDoc?.lastModified() ?: 0L}:${deltaDoc?.length() ?: 0L}"
        val fPart = "f:${fullDoc?.lastModified() ?: 0L}:${fullDoc?.length() ?: 0L}"
        val wPart = "w:${walDoc?.lastModified() ?: 0L}:${walDoc?.length() ?: 0L}"
        return "$dPart|$fPart|$wPart"
    }

    private fun copyDocumentReadOnly(doc: DocumentFile, dest: File): Boolean {
        return try {
            val input = context.contentResolver.openInputStream(doc.uri) ?: return false
            input.use { stream ->
                FileOutputStream(dest).use { output ->
                    stream.copyTo(output, BUFFER_SIZE)
                    output.fd.sync()
                }
            }
            dest.exists() && dest.length() > 0L
        } catch (e: Exception) {
            Log.w(TAG, "USBファイルRead-Onlyコピー失敗 (${doc.name}): ${e.message}")
            false
        }
    }

    private fun validateSqliteHeader(file: File): Boolean {
        if (!file.exists() || file.length() < 4096L) return false
        return try {
            val header = ByteArray(16)
            FileInputStream(file).use { input ->
                val read = input.read(header)
                read == 16 && header.contentEquals(SQLITE_MAGIC)
            }
        } catch (_: Exception) {
            false
        }
    }

    private fun checkpointTempWalToSingleDb(tmpFull: File, tmpWal: File) {
        var walDb: SQLiteDatabase? = null
        try {
            walDb = SQLiteDatabase.openDatabase(
                tmpFull.absolutePath,
                null,
                SQLiteDatabase.OPEN_READWRITE or SQLiteDatabase.ENABLE_WRITE_AHEAD_LOGGING
            )
            walDb.rawQuery("PRAGMA wal_checkpoint(TRUNCATE)", null).use { it.moveToFirst() }
            walDb.rawQuery("PRAGMA journal_mode = DELETE", null).use { it.moveToFirst() }
        } catch (e: Exception) {
            Log.w(TAG, "一時WALチェックポイント警告（ベースDBで続行）: ${e.message}")
        } finally {
            try { walDb?.close() } catch (_: Exception) {}
            tmpWal.delete()
            File(tmpFull.parentFile, "${tmpFull.name}-shm").delete()
        }
    }

    private fun ethicalBlockResult(): JSONObject = JSONObject()
        .put("ok", false)
        .put("usbConnected", true)
        .put("reason", "ethical_foreign_owner")
        .put("error", "別のオーナーのライブラリが検出されたため、エシカル保護により自動取込をブロックしました")

    private fun buildLibraryMismatchResult(prevMeta: JSONObject, folderLabel: String): JSONObject {
        val curLabel = prevMeta.optString("usb_folder_name", "").ifEmpty { "現在のロッカー" }
        return JSONObject()
            .put("ok", false)
            .put("reason", "library_mismatch")
            .put("syncType", "usb")
            .put("currentSource", curLabel)
            .put("targetSource", "USB ($folderLabel)")
            .put("pendingChangeCount", lockerDbManager.getPendingChangeCount())
    }
}
