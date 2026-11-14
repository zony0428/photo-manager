package com.tetheract.pm

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Point
import android.net.Uri
import android.os.SystemClock
import android.provider.DocumentsContract
import android.util.Base64
import android.util.Log
import android.util.LruCache
import androidx.documentfile.provider.DocumentFile
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Semaphore
import java.util.concurrent.atomic.AtomicBoolean

/**
 * スマホ内画像フォルダ（Camera / Pictures 等）の SAF 永続リンク管理、
 * 自動スキャンによるロッカー library.db（管理下）への統合、母艦DB（Loome外を含む）との重複照合、
 * および母艦 Loome\case\YYYY-MM-DD への手動ストリーム転送を担うクラス。
 */
class PhoneCaseManager(
    private val context: Context,
    private val lockerDbManager: LockerDatabaseManager,
    private val wifiSyncManager: WifiLockerSyncManager
) {

    companion object {
        private const val TAG = "PhoneCaseManager"
        private const val PREFS_NAME = "tetheract_phone_case_prefs"
        private const val KEY_FOLDERS_JSON = "linked_folders_json"
        private const val KEY_UPLOADED_SET_JSON = "uploaded_name_size_json"
        private const val DRAFTS_FILENAME = "phone_case_drafts.json"
        private const val MAX_UPLOADED_HISTORY_KEYS = 50000

        private val IMAGE_EXTENSIONS = setOf(
            ".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif", ".avif",
            ".dng", ".arw", ".cr2", ".cr3", ".nef", ".orf", ".raf", ".rw2", ".pef"
        )
    }

    private val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    private val lock = Any()
    private val scanLock = Any()
    private val draftsFile = File(lockerDbManager.lockerDir, DRAFTS_FILENAME)
    val catalogEngine = PhoneCatalogEngine(context, lockerDbManager)
    private val transferRunner = PhoneCaseTransferRunner(context, catalogEngine, wifiSyncManager, ::decodeDocKey)
    @Volatile private var lastScanCompletedMs: Long = 0L
    @Volatile private var lastScannedAllItems: List<JSONObject>? = null
    private val thumbDecodeSem = Semaphore(3)
    private val pendingThumbs = ConcurrentHashMap<Long, ByteArray>()
    private val thumbFlushScheduled = AtomicBoolean(false)

    fun isTransferRunning(): Boolean = transferRunner.isTransferRunning()

    private val thumbCache = object : LruCache<String, ByteArray>(16 * 1024 * 1024) {
        override fun sizeOf(key: String, value: ByteArray): Int = value.size
    }

    fun hasLinkedFolders(): Boolean = synchronized(lock) {
        val arr = buildFoldersStatusArray()
        for (i in 0 until arr.length()) {
            if (arr.optJSONObject(i)?.optBoolean("canRead", false) == true) return true
        }
        false
    }

    /** photo_id からスマホ機内写真の実ファイルストリームを解決して開く（オフライン時の原本表示・オンデマンドサムネイル生成用） */
    fun openPhonePhotoByPhotoId(photoId: Long, isThumb: Boolean = false): Pair<String, InputStream>? {
        val docKey = catalogEngine.resolveDocKeyForPhotoId(photoId) ?: return null
        return openPhonePhotoStream(docKey, isThumb, photoId)
    }

    /** ACTION_OPEN_DOCUMENT_TREE で選択されたスマホ内画像フォルダを永続リンク登録し、即座に管理下DBへスキャン統合する */
    fun onPhoneFolderTreeSelected(treeUri: Uri): JSONObject {
        return try {
            try {
                context.contentResolver.takePersistableUriPermission(treeUri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
            } catch (_: Exception) {
                context.contentResolver.takePersistableUriPermission(
                    treeUri,
                    Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                )
            }

            val doc = DocumentFile.fromTreeUri(context, treeUri)
            val fallbackName = try {
                DocumentsContract.getTreeDocumentId(treeUri).substringAfterLast('/').substringAfterLast(':').trim()
            } catch (_: Exception) { "" }
            val folderName = (doc?.name ?: "").trim().ifEmpty { fallbackName.ifEmpty { "スマホ内フォルダ" } }
            val uriStr = treeUri.toString()

            val targetId = synchronized(lock) {
                val arr = readFoldersArray()
                var tid = ""
                for (i in 0 until arr.length()) {
                    val item = arr.optJSONObject(i) ?: continue
                    if (item.optString("uri") == uriStr) {
                        tid = item.optString("id")
                        item.put("name", folderName)
                        break
                    }
                }
                if (tid.isEmpty()) {
                    tid = "pf_" + UUID.randomUUID().toString().replace("-", "").take(10)
                    arr.put(JSONObject().put("id", tid).put("name", folderName).put("uri", uriStr).put("addedAt", System.currentTimeMillis()).put("photoCount", 0))
                }
                saveFoldersArray(arr)
                tid
            }

            lastScanCompletedMs = 0L
            val scanRes = JSONObject(scanFolderPhotosJson("all", includeItems = false, allowLiveReconcile = false, minFreshMs = 0L))
            val scanOk = scanRes.optBoolean("ok", true)
            val scanErr = scanRes.optString("scanError", scanRes.optString("error", ""))
            val foldersArr = synchronized(lock) { buildFoldersStatusArray() }
            var folderPhotoCount = scanRes.optInt("scannedCount", scanRes.optInt("totalCount", 0))
            for (i in 0 until foldersArr.length()) {
                val f = foldersArr.optJSONObject(i) ?: continue
                if (f.optString("id") == targetId) { folderPhotoCount = f.optInt("photoCount", folderPhotoCount); break }
            }

            JSONObject().put("ok", scanOk).put("folderId", targetId).put("folderName", folderName)
                .put("folders", foldersArr)
                .put("scannedCount", folderPhotoCount)
                .put("totalCount", scanRes.optInt("totalCount", 0)).put("unstoredCount", scanRes.optInt("unstoredCount", 0))
                .put("catalogChanged", scanRes.optBoolean("catalogChanged", true)).put("scanError", scanErr)
        } catch (e: Exception) {
            Log.e(TAG, "スマホ内フォルダ永続権限取得エラー", e)
            JSONObject().put("ok", false).put("error", e.message ?: "フォルダのリンクに失敗しました").put("scanError", e.message ?: "フォルダのリンクに失敗しました")
        }
    }

    /** リンク済みスマホ内フォルダ一覧を返す */
    fun listFoldersJson(): String = synchronized(lock) {
        return try {
            JSONObject().put("ok", true).put("folders", buildFoldersStatusArray()).toString()
        } catch (e: Exception) {
            JSONObject().put("ok", false).put("folders", JSONArray()).put("error", e.message ?: "").toString()
        }
    }

    /** 指定したスマホ内フォルダのリンクを解除する（DBからのローカル行整理は非同期スキャンで行う） */
    fun removeFolderJson(folderId: String): String {
        val foldersArr = synchronized(lock) {
            val cleanId = folderId.trim()
            val arr = readFoldersArray()
            val nextArr = JSONArray()
            for (i in 0 until arr.length()) {
                val item = arr.optJSONObject(i) ?: continue
                if (item.optString("id") != cleanId) nextArr.put(item)
            }
            saveFoldersArray(nextArr)
            lastScanCompletedMs = 0L
            lastScannedAllItems = null
            buildFoldersStatusArray()
        }
        return JSONObject().put("ok", true).put("folders", foldersArr).put("catalogChanged", true).toString()
    }

    /**
     * リンク済みの全スマホ内フォルダを走査してロッカー内 library.db（管理下）へ統合し、
     * 母艦DBとの重複照合結果付きで一覧を返す。
     */
    fun scanFolderPhotosJson(
        folderId: String,
        includeItems: Boolean = true,
        allowLiveReconcile: Boolean = false,
        minFreshMs: Long = 0L
    ): String = synchronized(scanLock) {
        return try {
            val nowElapsed = SystemClock.elapsedRealtime()
            val cachedAll = lastScannedAllItems
            if (minFreshMs > 0L && cachedAll != null && (nowElapsed - lastScanCompletedMs) in 0 until minFreshMs) {
                return@synchronized buildScanResultJson(
                    folderId = folderId, allItems = cachedAll, includeItems = includeItems,
                    syncedCount = cachedAll.size, changedRows = 0, liveReconciled = false, scanError = ""
                )
            }

            val folders = synchronized(lock) { buildFoldersStatusArray() }
            val readableFolders = mutableListOf<JSONObject>()
            for (i in 0 until folders.length()) {
                val f = folders.optJSONObject(i) ?: continue
                if (f.optBoolean("canRead", false)) readableFolders.add(f)
            }

            val uploadedHistory = readUploadedHistorySet()
            val lookup = catalogEngine.loadMotherShipLookup(uploadedHistory)
            val draftsObj = synchronized(lock) { readDraftsObject() }
            val dateFmt = SimpleDateFormat("yyyy-MM-dd", Locale.US)

            val allRawItems = mutableListOf<JSONObject>()
            val seenDocKeys = HashSet<String>()

            for (fObj in readableFolders) {
                val fId = fObj.optString("id")
                val fName = fObj.optString("name", "Camera")
                val treeUri = Uri.parse(fObj.optString("uri"))
                val rootDocId = DocumentsContract.getTreeDocumentId(treeUri)
                collectPhotosInDocumentDir(
                    treeUri, rootDocId, fId, fName, 0, 4,
                    lookup, draftsObj, dateFmt, seenDocKeys, allRawItems
                )
            }

            allRawItems.sortByDescending { it.optLong("lastModifiedMs", 0L) }

            val outcome = catalogEngine.syncScannedItemsToCatalogDetailed(
                allRawItems, lookup, draftsObj, ::decodeDocKey
            )
            val liveReconciled = if (allowLiveReconcile && wifiSyncManager.isPcOnline) {
                reconcileWithMotherShipLive(allRawItems, draftsObj)
            } else false
            updateFolderScanCounts(allRawItems)
            lastScannedAllItems = allRawItems
            lastScanCompletedMs = SystemClock.elapsedRealtime()

            buildScanResultJson(
                folderId = folderId, allItems = allRawItems, includeItems = includeItems,
                syncedCount = outcome.syncedCount, changedRows = outcome.changedRows,
                liveReconciled = liveReconciled, scanError = outcome.errorMessage ?: ""
            )
        } catch (e: Exception) {
            Log.e(TAG, "スマホ内フォルダ走査エラー", e)
            JSONObject()
                .put("ok", false).put("error", e.message ?: "フォルダのスキャンに失敗しました")
                .put("scanError", e.message ?: "フォルダのスキャンに失敗しました")
                .put("scannedCount", 0).put("catalogChanged", false).put("items", JSONArray())
                .toString()
        }
    }

    private fun buildScanResultJson(
        folderId: String, allItems: List<JSONObject>, includeItems: Boolean,
        syncedCount: Int, changedRows: Int, liveReconciled: Boolean, scanError: String
    ): String {
        val filteredItems = if (folderId.isEmpty() || folderId == "all") allItems else allItems.filter { it.optString("folderId") == folderId }
        val itemsArr = JSONArray()
        var unstoredCount = 0
        for (item in filteredItems) {
            if (!item.optBoolean("inMotherShip", false)) unstoredCount += 1
            if (includeItems) itemsArr.put(item)
        }
        return JSONObject()
            .put("ok", scanError.isEmpty())
            .put("folderId", folderId.ifEmpty { "all" })
            .put("scannedCount", syncedCount)
            .put("totalCount", filteredItems.size)
            .put("unstoredCount", unstoredCount)
            .put("catalogChanged", changedRows > 0 || liveReconciled)
            .put("scanError", scanError)
            .put("folders", synchronized(lock) { buildFoldersStatusArray() })
            .put("items", itemsArr)
            .toString()
    }

    private fun collectPhotosInDocumentDir(
        treeUri: Uri, parentDocId: String, folderId: String, folderName: String,
        depth: Int, maxDepth: Int, lookup: PhoneCatalogEngine.MotherShipLookup,
        draftsObj: JSONObject, dateFmt: SimpleDateFormat,
        seenDocKeys: MutableSet<String>, outList: MutableList<JSONObject>
    ) {
        val childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, parentDocId)
        val projection = arrayOf(
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE,
            DocumentsContract.Document.COLUMN_SIZE,
            DocumentsContract.Document.COLUMN_LAST_MODIFIED
        )
        val subDirs = mutableListOf<Pair<String, String>>()

        try {
            context.contentResolver.query(childrenUri, projection, null, null, null)?.use { c ->
                val idxId = c.getColumnIndex(DocumentsContract.Document.COLUMN_DOCUMENT_ID)
                val idxName = c.getColumnIndex(DocumentsContract.Document.COLUMN_DISPLAY_NAME)
                val idxMime = c.getColumnIndex(DocumentsContract.Document.COLUMN_MIME_TYPE)
                val idxSize = c.getColumnIndex(DocumentsContract.Document.COLUMN_SIZE)
                val idxMod = c.getColumnIndex(DocumentsContract.Document.COLUMN_LAST_MODIFIED)

                while (c.moveToNext()) {
                    val docId = if (idxId >= 0) (c.getString(idxId) ?: "") else ""
                    if (docId.isEmpty()) continue
                    val rawName = if (idxName >= 0) (c.getString(idxName) ?: "").trim() else ""
                    val name = rawName.ifEmpty { docId.substringAfterLast('/').substringAfterLast(':').trim() }
                    if (name.isEmpty() || name.startsWith(".")) continue

                    val mime = if (idxMime >= 0) (c.getString(idxMime) ?: "").trim() else ""
                    if (mime == DocumentsContract.Document.MIME_TYPE_DIR) {
                        val lowerDir = name.lowercase(Locale.US)
                        if (depth < maxDepth && lowerDir !in setOf("thumbnails", ".thumbnails", "android", "cache", ".trash", ".trashed")) {
                            subDirs.add(docId to "$folderName/$name")
                        }
                        continue
                    }

                    val dotIdx = name.lastIndexOf('.')
                    val ext = if (dotIdx >= 0) name.substring(dotIdx).lowercase(Locale.US) else ""
                    val isSupportedImage = ext in IMAGE_EXTENSIONS || (ext.isEmpty() && mime.startsWith("image/", ignoreCase = true))
                    if (!isSupportedImage) continue

                    val rawSize = if (idxSize >= 0 && !c.isNull(idxSize)) c.getLong(idxSize) else 0L
                    val size = if (rawSize > 0L) rawSize else if (idxSize >= 0 && c.isNull(idxSize)) 1L else 0L
                    if (size <= 0L) continue
                    val lastMod = if (idxMod >= 0 && !c.isNull(idxMod)) c.getLong(idxMod) else 0L

                    val docKey = encodeDocKey(treeUri.toString(), docId)
                    if (!seenDocKeys.add(docKey)) continue

                    val inMotherShip = lookup.isStoredInMotherShip(name, size)
                    val draft = draftsObj.optJSONObject(docKey)
                    val rating = draft?.optInt("rating", 0) ?: 0
                    val tagsArr = draft?.optJSONArray("tags") ?: JSONArray()
                    val dateStr = if (lastMod > 0L) dateFmt.format(Date(lastMod)) else ""

                    outList.add(
                        JSONObject()
                            .put("docKey", docKey).put("folderId", folderId).put("folderName", folderName)
                            .put("fileName", name).put("fileSize", size).put("lastModifiedMs", lastMod)
                            .put("dateStr", dateStr).put("mimeType", mime.ifEmpty { "image/jpeg" })
                            .put("inMotherShip", inMotherShip).put("rating", rating).put("tags", tagsArr)
                    )
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "ディレクトリ走査スキップ ($folderName): ${e.message}")
        }

        for ((subDocId, subLabel) in subDirs) {
            collectPhotosInDocumentDir(
                treeUri, subDocId, folderId, subLabel, depth + 1, maxDepth,
                lookup, draftsObj, dateFmt, seenDocKeys, outList
            )
        }
    }

    /** スマホ内写真の転送前ドラフト（評価・タグ）を保存し、管理下 library.db へも同時反映する */
    fun saveDraftChangesJson(payloadJson: String): String {
        return try {
            val req = JSONObject(payloadJson)
            val keysArr = req.optJSONArray("docKeys") ?: JSONArray()
            val hasRating = req.has("rating") && !req.isNull("rating")
            val newRating = if (hasRating) req.optInt("rating", 0) else 0
            val addTagsArr = req.optJSONArray("addTags") ?: JSONArray()
            val removeTagsArr = req.optJSONArray("removeTags") ?: JSONArray()

            val addTags = mutableListOf<String>()
            for (i in 0 until addTagsArr.length()) {
                val t = (addTagsArr.optString(i) ?: "").trim()
                if (t.isNotEmpty()) addTags.add(t)
            }
            val removeSet = mutableSetOf<String>()
            for (i in 0 until removeTagsArr.length()) {
                val t = (removeTagsArr.optString(i) ?: "").trim()
                if (t.isNotEmpty()) removeSet.add(t)
            }

            val updatedKeys = mutableListOf<String>()
            synchronized(lock) {
                val drafts = readDraftsObject()
                for (i in 0 until keysArr.length()) {
                    val dk = (keysArr.optString(i) ?: "").trim()
                    if (dk.isEmpty()) continue
                    val cur = drafts.optJSONObject(dk) ?: JSONObject()
                    if (hasRating) cur.put("rating", newRating)
                    val curTags = mutableSetOf<String>()
                    val existingTagsArr = cur.optJSONArray("tags")
                    if (existingTagsArr != null) {
                        for (j in 0 until existingTagsArr.length()) {
                            val et = (existingTagsArr.optString(j) ?: "").trim()
                            if (et.isNotEmpty()) curTags.add(et)
                        }
                    }
                    curTags.removeAll(removeSet)
                    curTags.addAll(addTags)
                    val nextTagsArr = JSONArray()
                    curTags.forEach { nextTagsArr.put(it) }
                    cur.put("tags", nextTagsArr)
                    drafts.put(dk, cur)
                    updatedKeys.add(dk)
                }
                writeDraftsObject(drafts)
                lastScanCompletedMs = 0L
            }

            if (updatedKeys.size <= 12) {
                for (dk in updatedKeys) applyDraftToCatalogRowIfPresent(dk, hasRating, newRating, addTagsArr, removeTagsArr)
            } else {
                Thread({
                    for (dk in updatedKeys) applyDraftToCatalogRowIfPresent(dk, hasRating, newRating, addTagsArr, removeTagsArr)
                }, "PhoneDraftCatalogApply").apply { isDaemon = true; start() }
            }

            JSONObject().put("ok", true).put("updatedCount", updatedKeys.size).toString()
        } catch (e: Exception) {
            Log.e(TAG, "ドラフト保存エラー", e)
            JSONObject().put("ok", false).put("error", e.message ?: "Draft save failed").toString()
        }
    }

    private fun applyDraftToCatalogRowIfPresent(docKey: String, hasRating: Boolean, rating: Int, addTagsArr: JSONArray, removeTagsArr: JSONArray) {
        try {
            val filePath = "phone://$docKey"
            val args = JSONArray().put(filePath).put(filePath).toString()
            val sql = "SELECT id FROM photos WHERE file_path = ? UNION SELECT photo_id AS id FROM photo_links WHERE file_path = ? LIMIT 1"
            val rows = JSONArray(lockerDbManager.rawQuerySafeJson(sql, args))
            val pid = if (rows.length() > 0) (rows.optJSONObject(0)?.optLong("id", 0L) ?: 0L) else 0L
            if (pid > 0L) {
                val patch = JSONObject().put("photo_id", pid)
                if (hasRating) patch.put("rating", rating)
                if (addTagsArr.length() > 0) patch.put("add_tags", addTagsArr)
                if (removeTagsArr.length() > 0) patch.put("remove_tags", removeTagsArr)
                lockerDbManager.savePhotoChangeJson(patch.toString())
            }
        } catch (_: Exception) {}
    }

    /** WebView (/phone_photo/{docKey} または /thumb/{photoId} フォールバック) 向けに画像ストリームを供給する */
    fun openPhonePhotoStream(docKey: String, isThumb: Boolean, photoIdForSave: Long = 0L): Pair<String, InputStream>? {
        val (treeUriStr, docId) = decodeDocKey(docKey) ?: return null
        val docUri = try { DocumentsContract.buildDocumentUriUsingTree(Uri.parse(treeUriStr), docId) } catch (_: Exception) { return null }

        if (isThumb) {
            thumbCache.get(docKey)?.takeIf { it.isNotEmpty() }?.let { return "image/jpeg" to ByteArrayInputStream(it) }
            val decoded = try {
                thumbDecodeSem.acquire()
                try {
                    thumbCache.get(docKey)?.takeIf { it.isNotEmpty() }
                        ?: decodeThumbnailBytes(docUri)?.takeIf { it.isNotEmpty() }?.also { thumbCache.put(docKey, it) }
                } finally {
                    thumbDecodeSem.release()
                }
            } catch (_: InterruptedException) {
                Thread.currentThread().interrupt()
                null
            }
            if (decoded != null) {
                enqueueThumbnailForSave(photoIdForSave, decoded)
                return "image/jpeg" to ByteArrayInputStream(decoded)
            }
        }

        return try {
            val stream = context.contentResolver.openInputStream(docUri) ?: return null
            if (SafUsbManager.isRawFileName(docId)) {
                val rawJpeg = stream.use { SafUsbManager.extractEmbeddedJpegFromRawStream(it) } ?: return null
                return "image/jpeg" to ByteArrayInputStream(rawJpeg)
            }
            (context.contentResolver.getType(docUri) ?: "image/jpeg") to stream
        } catch (e: Exception) {
            Log.w(TAG, "スマホ内写真ストリームオープン失敗", e)
            null
        }
    }

    private fun enqueueThumbnailForSave(photoId: Long, thumbBytes: ByteArray) {
        if (photoId < PhoneCatalogEngine.PHONE_LOCAL_ID_BASE || thumbBytes.isEmpty()) return
        if (pendingThumbs.size < 512) pendingThumbs.putIfAbsent(photoId, thumbBytes)
        if (thumbFlushScheduled.compareAndSet(false, true)) {
            Thread({
                try {
                    Thread.sleep(350L)
                    while (pendingThumbs.isNotEmpty()) {
                        val batch = HashMap<Long, ByteArray>()
                        val it = pendingThumbs.entries.iterator()
                        while (it.hasNext() && batch.size < 64) {
                            val e = it.next()
                            batch[e.key] = e.value
                            it.remove()
                        }
                        if (batch.isNotEmpty()) catalogEngine.saveThumbnailBlobsBatch(batch)
                    }
                } catch (_: Exception) {
                } finally {
                    thumbFlushScheduled.set(false)
                }
            }, "PhoneThumbBlobFlush").apply { isDaemon = true; start() }
        }
    }

    internal fun decodeThumbnailBytes(docUri: Uri): ByteArray? {
        try {
            DocumentsContract.getDocumentThumbnail(context.contentResolver, docUri, Point(360, 360), null)?.let { docThumb ->
                val out = ByteArrayOutputStream()
                docThumb.compress(Bitmap.CompressFormat.JPEG, 82, out); docThumb.recycle()
                return out.toByteArray()
            }
        } catch (_: Exception) {}

        return try {
            val boundsOpt = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            context.contentResolver.openInputStream(docUri)?.use { BitmapFactory.decodeStream(it, null, boundsOpt) }
            val w = boundsOpt.outWidth; val h = boundsOpt.outHeight
            if (w <= 0 || h <= 0) return SafUsbManager.decodeRawPreviewThumbnailBytes(context.contentResolver, docUri)
            var sample = 1; while (maxOf(w, h) / sample > 480) sample *= 2
            val bmp = context.contentResolver.openInputStream(docUri)?.use { BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply { inSampleSize = sample }) } ?: return null
            val out = ByteArrayOutputStream()
            bmp.compress(Bitmap.CompressFormat.JPEG, 80, out); bmp.recycle()
            out.toByteArray()
        } catch (_: Exception) { null }
    }

    /**
     * 選択されたスマホ内写真群をプリフライト重複照合（Loome外を含む母艦DB全画像と照合）した上で、
     * 未登録写真のみ母艦の \Loome\case\YYYY-MM-DD へ原本ストリーム転送する。
     */
    fun transferToMotherShipSync(
        payloadJson: String,
        onProgress: (JSONObject) -> Unit
    ): JSONObject {
        val drafts = synchronized(lock) { readDraftsObject() }
        val uploadedHistory = readUploadedHistorySet()
        return transferRunner.executeTransferSync(
            payloadJson = payloadJson,
            drafts = drafts,
            uploadedHistory = uploadedHistory,
            onRecordUploadedKeys = ::recordUploadedMatchKeys,
            onRescanAfterTransfer = {
                lastScanCompletedMs = 0L
                scanFolderPhotosJson("all", includeItems = false, allowLiveReconcile = false, minFreshMs = 0L)
            },
            onProgress = onProgress
        )
    }

    /** 母艦PCとWi-Fi通信可能な場合は /api/mobile/case-preflight でライブ照合し、母艦側で削除された写真を「未収納」へ戻す */
    private fun reconcileWithMotherShipLive(allRawItems: List<JSONObject>, draftsObj: JSONObject): Boolean {
        return transferRunner.reconcileWithMotherShipLive(
            allRawItems = allRawItems,
            draftsObj = draftsObj,
            uploadedHistorySupplier = ::readUploadedHistorySet,
            onRemoveUploadedKeys = ::removeUploadedMatchKeys,
            decodeThumbFn = ::decodeThumbnailBytes
        )
    }

    private fun readUploadedHistorySet(): Set<String> = synchronized(lock) {
        val set = LinkedHashSet<String>()
        try {
            val arr = JSONArray(prefs.getString(KEY_UPLOADED_SET_JSON, "[]") ?: "[]")
            for (i in 0 until arr.length()) arr.optString(i, "").takeIf { it.isNotEmpty() }?.let { set.add(it) }
        } catch (_: Exception) {}
        set
    }

    private fun recordUploadedMatchKeys(keys: List<String>) = synchronized(lock) {
        val current = LinkedHashSet<String>(readUploadedHistorySet()).apply { addAll(keys) }
        val trimmed = if (current.size > MAX_UPLOADED_HISTORY_KEYS) current.toList().takeLast(MAX_UPLOADED_HISTORY_KEYS) else current.toList()
        val outArr = JSONArray().apply { trimmed.forEach { put(it) } }
        prefs.edit().putString(KEY_UPLOADED_SET_JSON, outArr.toString()).apply()
    }

    private fun removeUploadedMatchKeys(keys: Set<String>) = synchronized(lock) {
        val current = LinkedHashSet<String>(readUploadedHistorySet()).apply { removeAll(keys) }
        val trimmed = if (current.size > MAX_UPLOADED_HISTORY_KEYS) current.toList().takeLast(MAX_UPLOADED_HISTORY_KEYS) else current.toList()
        val outArr = JSONArray().apply { trimmed.forEach { put(it) } }
        prefs.edit().putString(KEY_UPLOADED_SET_JSON, outArr.toString()).apply()
    }

    private fun updateFolderScanCounts(allRawItems: List<JSONObject>) = synchronized(lock) {
        val countsByFolder = HashMap<String, Pair<Int, Int>>()
        for (item in allRawItems) {
            val fid = item.optString("folderId", "")
            if (fid.isEmpty()) continue
            val prev = countsByFolder[fid] ?: (0 to 0)
            val unstoredInc = if (!item.optBoolean("inMotherShip", false)) 1 else 0
            countsByFolder[fid] = (prev.first + 1) to (prev.second + unstoredInc)
        }
        val arr = readFoldersArray()
        for (i in 0 until arr.length()) {
            val item = arr.optJSONObject(i) ?: continue
            val fid = item.optString("id", "")
            val pair = countsByFolder[fid]
            if (pair != null) {
                item.put("photoCount", pair.first).put("unstoredCount", pair.second)
            } else {
                item.put("photoCount", 0).put("unstoredCount", 0)
            }
        }
        saveFoldersArray(arr)
    }

    private fun buildFoldersStatusArray(): JSONArray {
        val arr = readFoldersArray()
        val persistedSet = try {
            context.contentResolver.persistedUriPermissions.filter { it.isReadPermission }.map { it.uri.toString() }.toSet()
        } catch (_: Exception) { emptySet() }

        val out = JSONArray()
        for (i in 0 until arr.length()) {
            val item = arr.optJSONObject(i) ?: continue
            val uriStr = item.optString("uri", "")
            if (uriStr.isEmpty()) continue
            val folderName = item.optString("name", "Camera")
            val canRead = uriStr in persistedSet
            val photoCount = maxOf(0, item.optInt("photoCount", 0))
            out.put(
                JSONObject()
                    .put("id", item.optString("id"))
                    .put("name", folderName)
                    .put("uri", uriStr)
                    .put("canRead", canRead)
                    .put("photoCount", photoCount)
                    .put("count", photoCount)
                    .put("unstoredCount", item.optInt("unstoredCount", 0))
            )
        }
        return out
    }

    private fun readFoldersArray(): JSONArray = try {
        JSONArray(prefs.getString(KEY_FOLDERS_JSON, "[]") ?: "[]")
    } catch (_: Exception) { JSONArray() }

    private fun saveFoldersArray(arr: JSONArray) = prefs.edit().putString(KEY_FOLDERS_JSON, arr.toString()).apply()

    private fun readDraftsObject(): JSONObject = if (!draftsFile.exists()) JSONObject() else try {
        JSONObject(draftsFile.readText(Charsets.UTF_8))
    } catch (_: Exception) { JSONObject() }

    private fun writeDraftsObject(obj: JSONObject) {
        try { draftsFile.writeText(obj.toString(), Charsets.UTF_8) } catch (e: Exception) { Log.w(TAG, "ドラフト保存警告", e) }
    }

    internal fun encodeDocKey(treeUriStr: String, docId: String): String =
        Base64.encodeToString("$treeUriStr\n$docId".toByteArray(Charsets.UTF_8), Base64.URL_SAFE or Base64.NO_WRAP)

    internal fun decodeDocKey(docKey: String): Pair<String, String>? = try {
        val decoded = String(Base64.decode(docKey.substringBefore('?').trim(), Base64.URL_SAFE or Base64.NO_WRAP), Charsets.UTF_8)
        val idx = decoded.indexOf('\n')
        if (idx <= 0) null else decoded.substring(0, idx) to decoded.substring(idx + 1)
    } catch (_: Exception) { null }
}
