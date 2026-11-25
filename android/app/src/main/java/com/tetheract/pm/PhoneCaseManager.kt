package com.tetheract.pm

import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Point
import android.graphics.PointF
import android.media.ExifInterface
import android.media.FaceDetector
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.SystemClock
import android.provider.DocumentsContract
import android.provider.MediaStore
import android.util.Base64
import android.util.Log
import android.util.LruCache
import androidx.documentfile.provider.DocumentFile
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileInputStream
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
        private const val KEY_SENT_SIGNALS_JSON = "sent_working_signals_json"
        private const val DRAFTS_FILENAME = "phone_case_drafts.json"
        private const val MAX_UPLOADED_HISTORY_KEYS = 50000
        const val FOLDER_MODE_CASE = "case"
        const val FOLDER_MODE_WORKING = "working"
        const val THMOD_VIRTUAL_FOLDER_ID = "pf_thmod_local"
        const val THMOD_VIRTUAL_FOLDER_NAME = "ArtFramer (速報出力)"
        private val INVALID_FILENAME_CHARS_REGEX = Regex("[\\\\/*?:\"<>|\\x00-\\x1f]")
        private val EXIF_WRITE_DATE_REGEX = Regex("^(\\d{4})[-:/](\\d{2})[-:/](\\d{2})(?:[T ](\\d{2}):(\\d{2}):(\\d{2}))?")

        private val IMAGE_EXTENSIONS = setOf(
            ".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif", ".avif",
            ".dng", ".arw", ".cr2", ".cr3", ".nef", ".orf", ".raf", ".rw2", ".pef"
        )

        fun normalizeFolderMode(raw: String?): String {
            return if ((raw ?: "").trim().lowercase(Locale.US) == FOLDER_MODE_WORKING) {
                FOLDER_MODE_WORKING
            } else {
                FOLDER_MODE_CASE
            }
        }

        fun isThmodFileName(fileName: String?): Boolean {
            val base = (fileName ?: "").substringAfterLast('/').substringAfterLast('\\').trim().lowercase(Locale.US)
            return base.startsWith("thmod_")
        }

        fun guessInitialFolderMode(folderName: String): String {
            val low = folderName.trim().lowercase(Locale.US)
            val workingHints = listOf(
                "creator", "snapbridge", "canon", "cameraconnect", "nikon",
                "imaging edge", "imagingedge", "image sync", "imagesync",
                "lumix", "fujifilm", "xapp", "oi.share", "oishare", "omsystem",
                "work", "working", "select"
            )
            return if (workingHints.any { low.contains(it) }) FOLDER_MODE_WORKING else FOLDER_MODE_CASE
        }

        fun computeSignalSignature(rating: Int, tagsArr: JSONArray?): String {
            val tags = ArrayList<String>()
            if (tagsArr != null) {
                for (i in 0 until tagsArr.length()) {
                    val t = (tagsArr.optString(i) ?: "").trim()
                    if (t.isNotEmpty()) tags.add(t)
                }
            }
            tags.sort()
            return "$rating|${tags.joinToString("\u0001")}"
        }
    }

    private val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    private val lock = Any()
    private val scanLock = Any()
    private val draftsFile = File(lockerDbManager.lockerDir, DRAFTS_FILENAME)
    val catalogEngine = PhoneCatalogEngine(context, lockerDbManager)
    private val thmodExportsDir: File = catalogEngine.thmodExportsDir
    private val transferRunner = PhoneCaseTransferRunner(context, catalogEngine, wifiSyncManager, ::decodeDocKey)
    @Volatile private var lastScanCompletedMs: Long = 0L
    @Volatile private var lastScannedAllItems: List<JSONObject>? = null
    private val thumbDecodeSem = Semaphore(3)
    private val pendingThumbs = ConcurrentHashMap<Long, ByteArray>()
    private val thumbFlushScheduled = AtomicBoolean(false)

    fun isTransferRunning(): Boolean = transferRunner.isTransferRunning()

    /** treeUriStr と docId から実アクセス可能な URI（SAF またはローカル thmod_exports）を組み立てる */
    fun buildDocumentOrLocalUri(treeUriStr: String, docId: String): Uri? =
        catalogEngine.buildLocalOrDocumentUri(treeUriStr, docId)

    /** 指定写真IDの未取得EXIF・露出設定・GPS地名を実ファイルからオンデマンド補完して返す */
    fun ensurePhotoExifJson(photoId: Long): String =
        catalogEngine.ensurePhotoExifHydratedJson(photoId, ::decodeDocKey)

    private fun listLocalThmodFiles(): List<File> {
        if (!thmodExportsDir.isDirectory) return emptyList()
        return (thmodExportsDir.listFiles() ?: return emptyList())
            .filter { f ->
                if (!f.isFile || f.name.startsWith(".")) return@filter false
                val dotIdx = f.name.lastIndexOf('.')
                val ext = if (dotIdx >= 0) f.name.substring(dotIdx).lowercase(Locale.US) else ""
                ext in IMAGE_EXTENSIONS && f.length() > 0L
            }
            .sortedByDescending { it.lastModified() }
    }

    private val thumbCache = object : LruCache<String, ByteArray>(16 * 1024 * 1024) {
        override fun sizeOf(key: String, value: ByteArray): Int = value.size
    }

    fun hasLinkedFolders(): Boolean = synchronized(lock) {
        val arr = buildFoldersStatusArray()
        for (i in 0 until arr.length()) {
            if (arr.optJSONObject(i)?.optBoolean("canRead", false) == true) return true
        }
        listLocalThmodFiles().isNotEmpty()
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
                    arr.put(
                        JSONObject()
                            .put("id", tid)
                            .put("name", folderName)
                            .put("uri", uriStr)
                            .put("mode", guessInitialFolderMode(folderName))
                            .put("addedAt", System.currentTimeMillis())
                            .put("photoCount", 0)
                    )
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

    /** リンク済みスマホ内フォルダの役割モード (case / working) を変更し、件数を再集計して返す */
    fun setFolderModeJson(folderId: String, mode: String): String {
        val cleanId = folderId.trim()
        val normMode = normalizeFolderMode(mode)
        var found = false
        synchronized(lock) {
            val arr = readFoldersArray()
            for (i in 0 until arr.length()) {
                val item = arr.optJSONObject(i) ?: continue
                if (item.optString("id") == cleanId) {
                    item.put("mode", normMode)
                    found = true
                    break
                }
            }
            if (found) {
                saveFoldersArray(arr)
                lastScanCompletedMs = 0L
                lastScannedAllItems = null
            }
        }
        if (!found) {
            return JSONObject().put("ok", false).put("error", "対象フォルダが見つかりませんでした").toString()
        }
        val scanRes = JSONObject(scanFolderPhotosJson("all", includeItems = false, allowLiveReconcile = false, minFreshMs = 0L))
        return JSONObject()
            .put("ok", scanRes.optBoolean("ok", true))
            .put("folderId", cleanId)
            .put("mode", normMode)
            .put("folders", scanRes.optJSONArray("folders") ?: synchronized(lock) { buildFoldersStatusArray() })
            .put("unstoredCount", scanRes.optInt("unstoredCount", 0))
            .toString()
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
                if (fObj.optString("id") == THMOD_VIRTUAL_FOLDER_ID || fObj.optString("uri") == PhoneCatalogEngine.THMOD_LOCAL_SCHEME) continue
                val fId = fObj.optString("id")
                val fName = fObj.optString("name", "Camera")
                val fMode = normalizeFolderMode(fObj.optString("mode", FOLDER_MODE_CASE))
                val treeUri = Uri.parse(fObj.optString("uri"))
                val rootDocId = DocumentsContract.getTreeDocumentId(treeUri)
                collectPhotosInDocumentDir(
                    treeUri, rootDocId, fId, fName, fMode, 0, 4,
                    lookup, draftsObj, dateFmt, seenDocKeys, allRawItems
                )
            }

            collectLocalThmodExports(lookup, draftsObj, dateFmt, seenDocKeys, allRawItems)

            allRawItems.sortByDescending { it.optLong("lastModifiedMs", 0L) }

            val outcome = catalogEngine.syncScannedItemsToCatalogDetailed(
                allRawItems, lookup, draftsObj, ::decodeDocKey
            )
            val liveReconciled = if (allowLiveReconcile && wifiSyncManager.isPcOnline) {
                reconcileWithMotherShipLive(allRawItems, draftsObj)
            } else false
            applyWorkingFolderSignalStatus(allRawItems)
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
            val isPending = item.optBoolean("pendingUplink", !item.optBoolean("inMotherShip", false))
            if (isPending) unstoredCount += 1
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
        treeUri: Uri, parentDocId: String, folderId: String, folderName: String, folderMode: String,
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

                    val isThmod = isThmodFileName(name)
                    outList.add(
                        JSONObject()
                            .put("docKey", docKey).put("folderId", folderId).put("folderName", folderName)
                            .put("folderMode", folderMode).put("isThmod", isThmod)
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
                treeUri, subDocId, folderId, subLabel, folderMode, depth + 1, maxDepth,
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
        val docUri = buildDocumentOrLocalUri(treeUriStr, docId) ?: return null

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
            if (docUri.scheme == "file") {
                val f = File(docUri.path ?: return null)
                if (!f.isFile) return null
                val lower = f.name.lowercase(Locale.US)
                val mime = if (lower.endsWith(".png")) "image/png" else "image/jpeg"
                return mime to FileInputStream(f)
            }
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
        if (docUri.scheme == "file") {
            val path = docUri.path ?: return null
            return try {
                val boundsOpt = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeFile(path, boundsOpt)
                val w = boundsOpt.outWidth; val h = boundsOpt.outHeight
                if (w <= 0 || h <= 0) return null
                var sample = 1; while (maxOf(w, h) / sample > 480) sample *= 2
                val bmp = BitmapFactory.decodeFile(path, BitmapFactory.Options().apply { inSampleSize = sample }) ?: return null
                val out = ByteArrayOutputStream()
                try {
                    bmp.compress(Bitmap.CompressFormat.JPEG, 82, out)
                } finally {
                    if (!bmp.isRecycled) bmp.recycle()
                }
                out.toByteArray()
            } catch (_: Exception) { null }
        }

        try {
            DocumentsContract.getDocumentThumbnail(context.contentResolver, docUri, Point(360, 360), null)?.let { docThumb ->
                val out = ByteArrayOutputStream()
                try {
                    docThumb.compress(Bitmap.CompressFormat.JPEG, 82, out)
                } finally {
                    if (!docThumb.isRecycled) docThumb.recycle()
                }
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
            try {
                bmp.compress(Bitmap.CompressFormat.JPEG, 80, out)
            } finally {
                if (!bmp.isRecycled) bmp.recycle()
            }
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
            onRecordSentSignals = ::recordSentSignals,
            onRescanAfterTransfer = {
                lastScanCompletedMs = 0L
                scanFolderPhotosJson("all", includeItems = false, allowLiveReconcile = false, minFreshMs = 0L)
            },
            onProgress = onProgress
        )
    }

    private fun readSentSignalsMap(): Map<String, String> = synchronized(lock) {
        val out = LinkedHashMap<String, String>()
        try {
            val obj = JSONObject(prefs.getString(KEY_SENT_SIGNALS_JSON, "{}") ?: "{}")
            val ks = obj.keys()
            while (ks.hasNext()) {
                val k = ks.next()
                out[k] = obj.optString(k, "")
            }
        } catch (_: Exception) {}
        out
    }

    private fun recordSentSignals(updates: Map<String, String>) = synchronized(lock) {
        if (updates.isEmpty()) return@synchronized
        val current = LinkedHashMap<String, String>(readSentSignalsMap())
        current.putAll(updates)
        val entries = current.entries.toList()
        val trimmed = if (entries.size > MAX_UPLOADED_HISTORY_KEYS) {
            entries.takeLast(MAX_UPLOADED_HISTORY_KEYS)
        } else {
            entries
        }
        val outObj = JSONObject()
        for ((k, v) in trimmed) {
            outObj.put(k, v)
        }
        prefs.edit().putString(KEY_SENT_SIGNALS_JSON, outObj.toString()).apply()
    }

    private fun applyWorkingFolderSignalStatus(allRawItems: List<JSONObject>) {
        val sentSignals = readSentSignalsMap()
        for (it in allRawItems) {
            val dk = it.optString("docKey", "")
            val fn = it.optString("fileName", "")
            val fMode = normalizeFolderMode(it.optString("folderMode", FOLDER_MODE_CASE))
            val isThmod = isThmodFileName(fn)
            val inMother = it.optBoolean("inMotherShip", false)
            if (fMode == FOLDER_MODE_WORKING && !isThmod) {
                val rating = it.optInt("rating", 0)
                val tagsArr = it.optJSONArray("tags")
                val hasCur = (rating != 0) || (tagsArr != null && tagsArr.length() > 0)
                val sig = computeSignalSignature(rating, tagsArr)
                val needsSignal = hasCur && !inMother && (sentSignals[dk] != sig)
                val synced = hasCur && (inMother || sentSignals[dk] == sig)
                it.put("needsSignalUplink", needsSignal)
                it.put("signalSynced", synced)
                it.put("pendingUplink", needsSignal)
            } else {
                it.put("needsSignalUplink", false)
                it.put("signalSynced", false)
                it.put("pendingUplink", !inMother)
            }
        }
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
            val isPending = item.optBoolean("pendingUplink", !item.optBoolean("inMotherShip", false))
            val unstoredInc = if (isPending) 1 else 0
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
            val folderMode = normalizeFolderMode(item.optString("mode", guessInitialFolderMode(folderName)))
            val canRead = uriStr in persistedSet
            val photoCount = maxOf(0, item.optInt("photoCount", 0))
            out.put(
                JSONObject()
                    .put("id", item.optString("id"))
                    .put("name", folderName)
                    .put("uri", uriStr)
                    .put("mode", folderMode)
                    .put("canRead", canRead)
                    .put("photoCount", photoCount)
                    .put("count", photoCount)
                    .put("unstoredCount", item.optInt("unstoredCount", 0))
            )
        }
        val thmodFiles = listLocalThmodFiles()
        if (thmodFiles.isNotEmpty()) {
            val cachedThmodItems = lastScannedAllItems?.filter { it.optString("folderId") == THMOD_VIRTUAL_FOLDER_ID }.orEmpty()
            val totalThmod = if (cachedThmodItems.isNotEmpty()) cachedThmodItems.size else thmodFiles.size
            val unstoredThmod = if (cachedThmodItems.isNotEmpty()) {
                cachedThmodItems.count { it.optBoolean("pendingUplink", !it.optBoolean("inMotherShip", false)) }
            } else {
                totalThmod
            }
            out.put(
                JSONObject()
                    .put("id", THMOD_VIRTUAL_FOLDER_ID)
                    .put("name", THMOD_VIRTUAL_FOLDER_NAME)
                    .put("uri", PhoneCatalogEngine.THMOD_LOCAL_SCHEME)
                    .put("mode", FOLDER_MODE_CASE)
                    .put("canRead", true)
                    .put("isVirtual", true)
                    .put("photoCount", totalThmod)
                    .put("count", totalThmod)
                    .put("unstoredCount", unstoredThmod)
            )
        }
        return out
    }

    private fun collectLocalThmodExports(
        lookup: PhoneCatalogEngine.MotherShipLookup,
        draftsObj: JSONObject,
        dateFmt: SimpleDateFormat,
        seenDocKeys: MutableSet<String>,
        outList: MutableList<JSONObject>
    ) {
        val localFiles = listLocalThmodFiles()
        if (localFiles.isEmpty()) return

        val existingKeys = HashSet<String>(outList.size + 16)
        for (it in outList) {
            val fn = it.optString("fileName", "").lowercase(Locale.US)
            val sz = it.optLong("fileSize", 0L)
            if (fn.isNotEmpty() && sz > 0L) existingKeys.add("$fn|$sz")
        }

        for (file in localFiles) {
            val name = file.name
            val size = file.length()
            if (size <= 0L) continue
            if ("${name.lowercase(Locale.US)}|$size" in existingKeys) continue

            val docKey = encodeDocKey(PhoneCatalogEngine.THMOD_LOCAL_SCHEME, name)
            if (!seenDocKeys.add(docKey)) continue

            val lastMod = file.lastModified()
            val inMotherShip = lookup.isStoredInMotherShip(name, size)
            val draft = draftsObj.optJSONObject(docKey)
            val rating = draft?.optInt("rating", 0) ?: 0
            val tagsArr = draft?.optJSONArray("tags") ?: JSONArray()
            val dateStr = if (lastMod > 0L) dateFmt.format(Date(lastMod)) else ""
            val lowerName = name.lowercase(Locale.US)
            val mime = if (lowerName.endsWith(".png")) "image/png" else "image/jpeg"

            outList.add(
                JSONObject()
                    .put("docKey", docKey)
                    .put("folderId", THMOD_VIRTUAL_FOLDER_ID)
                    .put("folderName", THMOD_VIRTUAL_FOLDER_NAME)
                    .put("folderMode", FOLDER_MODE_CASE)
                    .put("isThmod", isThmodFileName(name))
                    .put("fileName", name)
                    .put("fileSize", size)
                    .put("lastModifiedMs", lastMod)
                    .put("dateStr", dateStr)
                    .put("mimeType", mime)
                    .put("inMotherShip", inMotherShip)
                    .put("rating", rating)
                    .put("tags", tagsArr)
            )
        }
    }

    /**
     * モバイル版 Art Framer で生成した仕上がり画像（thmod_*.jpg 等）をロッカー専用フォルダへ保存し、
     * 安全な最小限EXIF（撮影日時・カメラ機種）のみ付与したうえで公開ギャラリー・母艦収納キューへ登録する。
     */
    fun saveArtFramerOutputJson(payloadJson: String): String {
        return try {
            val req = JSONObject(payloadJson)
            val rawName = req.optString("fileName", "thmod_export.jpg")
            val sanitizedBase = INVALID_FILENAME_CHARS_REGEX.replace(File(rawName.replace('\\', '/')).name.trim(), "_").trim('.', ' ')
            val cleanName = if (sanitizedBase.isNotEmpty() && sanitizedBase != "." && sanitizedBase != "..") sanitizedBase else "thmod_export_${System.currentTimeMillis()}.jpg"
            val lowerName = cleanName.lowercase(Locale.US)
            val isPng = lowerName.endsWith(".png")
            val isJpeg = lowerName.endsWith(".jpg") || lowerName.endsWith(".jpeg")
            val finalName = if (isPng || isJpeg) cleanName else "$cleanName.jpg"
            val mimeType = if (isPng) "image/png" else "image/jpeg"

            val dataUrl = req.optString("dataUrl", "")
            val b64Start = dataUrl.indexOf("base64,")
            val b64Payload = if (b64Start >= 0) dataUrl.substring(b64Start + 7) else dataUrl
            if (b64Payload.isBlank()) {
                return JSONObject().put("ok", false).put("error", "画像データが空です").toString()
            }
            val imgBytes = Base64.decode(b64Payload, Base64.DEFAULT)
            if (imgBytes.isEmpty()) {
                return JSONObject().put("ok", false).put("error", "画像データのデコードに失敗しました").toString()
            }

            if (!thmodExportsDir.exists()) thmodExportsDir.mkdirs()
            val outFile = File(thmodExportsDir, finalName)
            val docKey = encodeDocKey(PhoneCatalogEngine.THMOD_LOCAL_SCHEME, finalName)

            if (outFile.exists()) {
                val oldSize = outFile.length()
                if (oldSize > 0L) {
                    removeUploadedMatchKeys(
                        setOf(
                            "${finalName.lowercase(Locale.US)}|$oldSize",
                            "${PhoneCatalogEngine.normalizeDupFileName(finalName)}|$oldSize"
                        )
                    )
                }
            }
            outFile.writeBytes(imgBytes)

            val stripAllExif = req.optBoolean("stripAllExif", false)
            val rawDateTaken = req.optString("dateTaken", "").trim()
            val rawCameraModel = req.optString("cameraModel", "").trim()
            val dtMatch = EXIF_WRITE_DATE_REGEX.find(rawDateTaken)
            var exifEpochMs: Long? = null

            if (dtMatch != null) {
                val yyyy = dtMatch.groupValues[1]
                val mm = dtMatch.groupValues[2]
                val dd = dtMatch.groupValues[3]
                val hh = dtMatch.groupValues[4].ifEmpty { "12" }
                val mi = dtMatch.groupValues[5].ifEmpty { "00" }
                val ss = dtMatch.groupValues[6].ifEmpty { "00" }
                exifEpochMs = try {
                    SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US).parse("$yyyy-$mm-$dd $hh:$mi:$ss")?.time
                } catch (_: Exception) {
                    null
                }
                if (!stripAllExif && !isPng) {
                    try {
                        val exif = ExifInterface(outFile.absolutePath)
                        val exifDt = "$yyyy:$mm:$dd $hh:$mi:$ss"
                        exif.setAttribute(ExifInterface.TAG_DATETIME_ORIGINAL, exifDt)
                        exif.setAttribute(ExifInterface.TAG_DATETIME_DIGITIZED, exifDt)
                        exif.setAttribute(ExifInterface.TAG_DATETIME, exifDt)
                        if (rawCameraModel.isNotEmpty() && rawCameraModel != "不明" && rawCameraModel != "RAW写真") {
                            exif.setAttribute(ExifInterface.TAG_MODEL, rawCameraModel)
                        }
                        exif.saveAttributes()
                    } catch (exErr: Exception) {
                        Log.w(TAG, "Art Framer 出力EXIF書き込み警告 ($finalName): ${exErr.message}")
                    }
                }
            } else if (!stripAllExif && !isPng && rawCameraModel.isNotEmpty() && rawCameraModel != "不明" && rawCameraModel != "RAW写真") {
                try {
                    val exif = ExifInterface(outFile.absolutePath)
                    exif.setAttribute(ExifInterface.TAG_MODEL, rawCameraModel)
                    exif.saveAttributes()
                } catch (exErr: Exception) {
                    Log.w(TAG, "Art Framer 機種名EXIF書き込み警告 ($finalName): ${exErr.message}")
                }
            }

            if (exifEpochMs != null && exifEpochMs > 0L) {
                try {
                    outFile.setLastModified(exifEpochMs)
                } catch (_: Exception) {}
            }

            // 親写真のレーティング・タグを引き継ぎ、古いサムネキャッシュを破棄する
            thumbCache.remove(docKey)
            try {
                lockerDbManager.withWritableDatabase(createIfMissing = false) { db ->
                    db.execSQL(
                        "DELETE FROM thumbnails WHERE photo_id IN (SELECT id FROM photos WHERE file_path = ?)",
                        arrayOf("phone://$docKey")
                    )
                }
            } catch (_: Exception) {}

            val hasRating = req.has("rating") && !req.isNull("rating")
            val rating = if (hasRating) req.optInt("rating", 0) else 0
            val tagsArr = req.optJSONArray("tags") ?: JSONArray()
            synchronized(lock) {
                val drafts = readDraftsObject()
                val curDraft = JSONObject()
                if (hasRating && rating != 0) curDraft.put("rating", rating)
                val cleanTags = JSONArray()
                val seenTag = HashSet<String>()
                for (i in 0 until tagsArr.length()) {
                    val t = (tagsArr.optString(i) ?: "").trim()
                    if (t.isNotEmpty() && seenTag.add(t)) cleanTags.put(t)
                }
                curDraft.put("tags", cleanTags)
                drafts.put(docKey, curDraft)
                writeDraftsObject(drafts)
                lastScanCompletedMs = 0L
                lastScannedAllItems = null
            }

            // 公開ギャラリー (Pictures/Tetheract) への書き出しと共有シート起動
            val mediaUri = exportBytesToPublicGallery(finalName, mimeType, outFile, exifEpochMs)
            val shareImmediate = req.optBoolean("shareImmediate", false)
            var shareStarted = false
            var shareError = ""
            if (shareImmediate) {
                if (mediaUri != null) {
                    try {
                        val shareIntent = Intent(Intent.ACTION_SEND).apply {
                            type = mimeType
                            putExtra(Intent.EXTRA_STREAM, mediaUri)
                            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                        }
                        val chooser = Intent.createChooser(shareIntent, "仕上がりを共有").apply {
                            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
                        }
                        context.startActivity(chooser)
                        shareStarted = true
                    } catch (shErr: Exception) {
                        Log.w(TAG, "共有シート起動失敗: ${shErr.message}")
                        shareError = shErr.message ?: "共有画面を開けませんでした"
                    }
                } else {
                    shareError = "共有用URIを作成できませんでした（保存自体は完了しています）"
                }
            }

            // ロッカー DB と未収納カウントを即時更新する
            val scanRes = JSONObject(scanFolderPhotosJson("all", includeItems = false, allowLiveReconcile = false, minFreshMs = 0L))

            JSONObject()
                .put("ok", true)
                .put("fileName", finalName)
                .put("docKey", docKey)
                .put("fileSize", outFile.length())
                .put("mediaStoreSaved", mediaUri != null)
                .put("shareStarted", shareStarted)
                .put("shareError", shareError)
                .put("unstoredCount", scanRes.optInt("unstoredCount", 0))
                .put("catalogChanged", scanRes.optBoolean("catalogChanged", true))
                .put("folders", scanRes.optJSONArray("folders") ?: JSONArray())
                .toString()
        } catch (e: Exception) {
            Log.e(TAG, "Art Framer 出力保存エラー", e)
            JSONObject().put("ok", false).put("error", e.message ?: "出力の保存に失敗しました").toString()
        }
    }

    private fun exportBytesToPublicGallery(
        fileName: String,
        mimeType: String,
        sourceFile: File,
        exifEpochMs: Long?
    ): Uri? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return null
        return try {
            val resolver = context.contentResolver
            val values = ContentValues().apply {
                put(MediaStore.Images.Media.DISPLAY_NAME, fileName)
                put(MediaStore.Images.Media.MIME_TYPE, mimeType)
                put(MediaStore.Images.Media.RELATIVE_PATH, "${Environment.DIRECTORY_PICTURES}/Tetheract")
                put(MediaStore.Images.Media.IS_PENDING, 1)
                if (exifEpochMs != null && exifEpochMs > 0L) {
                    put(MediaStore.Images.Media.DATE_TAKEN, exifEpochMs)
                }
            }
            val itemUri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values) ?: return null
            try {
                resolver.openOutputStream(itemUri)?.use { out ->
                    FileInputStream(sourceFile).use { ins -> ins.copyTo(out) }
                    out.flush()
                } ?: throw IllegalStateException("MediaStore 出力ストリームを開けませんでした")
                val doneValues = ContentValues().apply { put(MediaStore.Images.Media.IS_PENDING, 0) }
                resolver.update(itemUri, doneValues, null, null)
                itemUri
            } catch (writeErr: Exception) {
                try { resolver.delete(itemUri, null, null) } catch (_: Exception) {}
                throw writeErr
            }
        } catch (e: Exception) {
            Log.w(TAG, "MediaStore 公開ギャラリー保存スキップ ($fileName): ${e.message}")
            null
        }
    }

    /** 縮小画像 DataURL から YuNet (顔) ＋ LPD-YuNet (ナンバー4頂点候補) をオンデバイス推論する */
    fun detectFacesFromDataUrlJson(dataUrl: String): String {
        var srcBmp: Bitmap? = null
        try {
            val raw = dataUrl.trim()
            val commaIdx = raw.indexOf(',')
            val b64 = if (commaIdx >= 0) raw.substring(commaIdx + 1) else raw
            if (b64.isEmpty()) {
                return JSONObject().put("ok", true).put("faces", JSONArray()).put("plates", JSONArray()).toString()
            }
            val bytes = Base64.decode(b64, Base64.DEFAULT)
            val opts = BitmapFactory.Options().apply {
                inPreferredConfig = Bitmap.Config.ARGB_8888
            }
            val imgBmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts)
                ?: return JSONObject()
                    .put("ok", false)
                    .put("error", "bitmap_decode_failed")
                    .put("faces", JSONArray())
                    .put("plates", JSONArray())
                    .toString()
            srcBmp = imgBmp

            val imgW = imgBmp.width
            val imgH = imgBmp.height
            if (imgW < 24 || imgH < 24) {
                return JSONObject().put("ok", true).put("faces", JSONArray()).put("plates", JSONArray()).toString()
            }

            val onnxPlates = try {
                OnnxPrivacyEngine.detectPlatesLpdYuNet(context, imgBmp, confThresh = 0.50f) ?: emptyList()
            } catch (e: Exception) {
                Log.w(TAG, "LPD-YuNet 推論警告: ${e.message}")
                emptyList()
            }

            val onnxFaces = try {
                OnnxPrivacyEngine.detectFacesYuNet(context, imgBmp, scoreThresh = 0.58f)
            } catch (e: Exception) {
                Log.w(TAG, "YuNet 顔推論警告: ${e.message}")
                null
            }

            if (onnxFaces != null) {
                return OnnxPrivacyEngine.encodeDetectionsJson(onnxFaces, onnxPlates, "onnx_yunet").toString()
            }

            // ONNX モデル未配置時のフォールバック (厳格閾値 + 肌トーン検証で標識誤検出を抑止)
            val longEdge = kotlin.math.max(imgW, imgH).toFloat()
            val allBoxes = ArrayList<OnnxPrivacyEngine.FaceCandidate>()

            fun scanTileFallback(rx: Int, ry: Int, rw: Int, rh: Int, minConf: Float) {
                val evenW = rw and 1.inv()
                if (evenW < 24 || rh < 24) return
                var cropped: Bitmap? = null
                var rgb565: Bitmap? = null
                try {
                    val useWhole = (rx == 0 && ry == 0 && evenW == imgW && rh == imgH)
                    val targetBase: Bitmap = if (useWhole) {
                        imgBmp
                    } else {
                        val c = Bitmap.createBitmap(imgBmp, rx, ry, evenW, rh)
                        cropped = c
                        c
                    }
                    rgb565 = targetBase.copy(Bitmap.Config.RGB_565, false) ?: return
                    val maxFaces = 12
                    val detector = FaceDetector(rgb565.width, rgb565.height, maxFaces)
                    val detected = arrayOfNulls<FaceDetector.Face>(maxFaces)
                    val count = detector.findFaces(rgb565, detected)
                    val mid = PointF()
                    for (i in 0 until count) {
                        val f = detected[i] ?: continue
                        val conf = f.confidence()
                        if (conf < minConf) continue
                        f.getMidPoint(mid)
                        val eyeDist = f.eyesDistance()
                        if (eyeDist < 4.0f) continue
                        val cx = rx + mid.x
                        val cy = ry + mid.y + eyeDist * 0.34f
                        val radiusPx = eyeDist * 1.48f
                        if (!OnnxPrivacyEngine.hasPlausibleSkinTone(imgBmp, cx, cy, radiusPx)) continue
                        allBoxes.add(
                            OnnxPrivacyEngine.FaceCandidate(
                                x = (cx / imgW.toFloat()).coerceIn(0f, 1f),
                                y = (cy / imgH.toFloat()).coerceIn(0f, 1f),
                                r = (radiusPx / longEdge).coerceIn(0.018f, 0.35f),
                                score = conf
                            )
                        )
                    }
                } catch (e: Exception) {
                    Log.d(TAG, "フォールバック顔検出警告: ${e.message}")
                } finally {
                    if (rgb565 != null && !rgb565.isRecycled) rgb565.recycle()
                    if (cropped != null && !cropped.isRecycled) cropped.recycle()
                }
            }

            scanTileFallback(0, 0, imgW, imgH, 0.58f)
            return OnnxPrivacyEngine.encodeDetectionsJson(allBoxes, onnxPlates, "fallback_facedetector").toString()
        } catch (e: Exception) {
            Log.w(TAG, "オンデバイス顔検出警告: ${e.message}")
            return JSONObject()
                .put("ok", false)
                .put("error", e.message ?: "face_detect_error")
                .put("faces", JSONArray())
                .put("plates", JSONArray())
                .toString()
        } finally {
            if (srcBmp != null && !srcBmp.isRecycled) srcBmp.recycle()
        }
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
