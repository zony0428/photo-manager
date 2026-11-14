package com.tetheract.pm

import android.content.Context
import android.net.Uri
import android.net.wifi.WifiManager
import android.os.Build
import android.os.PowerManager
import android.os.SystemClock
import android.provider.DocumentsContract
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.util.Locale
import java.util.concurrent.atomic.AtomicBoolean

/**
 * スマホ内写真から母艦 Loome\case\YYYY-MM-DD への原本ストリーム転送実行クラス。
 * - WakeLock / WifiLock 保持による画面消灯時のOS通信遮断防止
 * - チャンク分割プリフライト照合と進捗通知スロットリング
 * - 一時通信エラー時の自動リトライ・IP再探索と、連続失敗時の安全な中断・部分成功記録
 */
class PhoneCaseTransferRunner(
    private val context: Context,
    private val catalogEngine: PhoneCatalogEngine,
    private val wifiSyncManager: WifiLockerSyncManager,
    private val decodeDocKey: (String) -> Pair<String, String>?
) {

    companion object {
        private const val TAG = "PhoneCaseTransferRunner"
        private const val COOKIE_NAME = "pm_lan_token"
        private const val PREFLIGHT_CHUNK_SIZE = 500
        private const val PROGRESS_MIN_INTERVAL_MS = 120L
        private const val MAX_UPLOAD_ATTEMPTS = 3
        private const val MAX_CONSECUTIVE_FAILURES = 5
        private const val MAX_LOCK_HOLD_MS = 60L * 60L * 1000L
    }

    private val transferRunning = AtomicBoolean(false)

    fun isTransferRunning(): Boolean = transferRunning.get()

    /**
     * 選択されたスマホ内写真群をプリフライト照合し、未収納分を母艦へストリーム転送する
     */
    fun executeTransferSync(
        payloadJson: String,
        drafts: JSONObject,
        uploadedHistory: Set<String>,
        onRecordUploadedKeys: (List<String>) -> Unit,
        onRescanAfterTransfer: () -> Unit,
        onProgress: (JSONObject) -> Unit
    ): JSONObject {
        if (!transferRunning.compareAndSet(false, true)) {
            return JSONObject().put("ok", false).put("error", "現在すでに母艦への収納転送を実行中です")
        }

        var wakeLock: PowerManager.WakeLock? = null
        var wifiLock: WifiManager.WifiLock? = null

        try {
            val locks = acquireTransferLocks()
            wakeLock = locks.first
            wifiLock = locks.second

            val req = JSONObject(payloadJson)
            val itemsArr = req.optJSONArray("items") ?: JSONArray()
            val commonTagsArr = req.optJSONArray("commonTags") ?: JSONArray()
            val hasCommonRating = req.has("commonRating") && !req.isNull("commonRating")
            val commonRating = if (hasCommonRating) req.optInt("commonRating", 0) else null

            val commonTags = mutableListOf<String>()
            for (i in 0 until commonTagsArr.length()) {
                val t = (commonTagsArr.optString(i) ?: "").trim()
                if (t.isNotEmpty()) commonTags.add(t)
            }

            var serverUrl = wifiSyncManager.getConfiguredServerUrl().trimEnd('/')
            var token = wifiSyncManager.getConfiguredToken()
            if (serverUrl.isEmpty()) {
                val disc = wifiSyncManager.discoverPcOnLan(requestPair = false)
                if (disc.optBoolean("ok", false) && disc.optBoolean("pairedMatch", false)) {
                    serverUrl = disc.optString("serverUrl", "").trimEnd('/')
                    token = wifiSyncManager.getConfiguredToken().ifEmpty { token }
                }
            }
            if (serverUrl.isEmpty()) {
                return JSONObject().put("ok", false).put("error", "母艦PCとのWi-Fi接続先が設定されていません。先にWi-Fi同期・ペアリングを行ってください。")
            }

            val motherSizes = catalogEngine.loadMotherShipLookup(uploadedHistory).motherSizes
            val candidates = mutableListOf<JSONObject>()
            val preflightItems = mutableListOf<JSONObject>()
            var lastProgEmitMs = 0L

            fun emitProgress(cur: Int, tot: Int, fileName: String, imp: Int, skp: Int, err: Int = 0, force: Boolean = false) {
                val now = SystemClock.elapsedRealtime()
                if (!force && now - lastProgEmitMs < PROGRESS_MIN_INTERVAL_MS) return
                lastProgEmitMs = now
                onProgress(
                    JSONObject()
                        .put("current", cur).put("total", tot).put("fileName", fileName)
                        .put("importedCount", imp).put("skippedCount", skp).put("errorCount", err)
                )
            }

            val rawTotal = itemsArr.length()
            for (i in 0 until rawTotal) {
                val it = itemsArr.optJSONObject(i) ?: continue
                val docKey = it.optString("docKey", "").trim()
                val fileName = it.optString("fileName", "").trim()
                val fileSize = it.optLong("fileSize", 0L)
                val lastMod = it.optLong("lastModifiedMs", 0L)
                val dateTaken = it.optString("dateTaken", "").trim()
                val cameraModel = it.optString("cameraModel", "").trim()
                if (docKey.isEmpty() || fileName.isEmpty() || fileSize <= 0L) continue

                val draft = drafts.optJSONObject(docKey)
                val draftRating = draft?.optInt("rating", 0) ?: 0
                val rawItemRating = if (!it.isNull("rating")) it.optInt("rating", 0) else 0
                val itemRating = if (commonRating != null && commonRating != 0) {
                    commonRating
                } else if (rawItemRating != 0) {
                    rawItemRating
                } else {
                    draftRating
                }

                val mergedTags = linkedSetOf<String>()
                val rawItTags = it.optJSONArray("tags")
                val itTags = if (rawItTags != null && rawItTags.length() > 0) rawItTags else (draft?.optJSONArray("tags") ?: rawItTags)
                if (itTags != null) {
                    for (j in 0 until itTags.length()) {
                        val t = (itTags.optString(j) ?: "").trim()
                        if (t.isNotEmpty()) mergedTags.add(t)
                    }
                }
                mergedTags.addAll(commonTags)
                val tagsJsonArr = JSONArray()
                mergedTags.forEach { t -> tagsJsonArr.put(t) }

                val cand = JSONObject()
                    .put("docKey", docKey).put("fileName", fileName).put("fileSize", fileSize)
                    .put("lastModifiedMs", lastMod).put("dateTaken", dateTaken).put("cameraModel", cameraModel)
                    .put("rating", itemRating).put("tags", tagsJsonArr)
                val pfItem = JSONObject()
                    .put("client_id", docKey).put("file_name", fileName).put("file_size", fileSize)
                    .put("last_modified_ms", lastMod).put("date_taken", dateTaken).put("camera_model", cameraModel)
                    .put("rating", itemRating).put("tags", tagsJsonArr)

                var lat = if (!it.isNull("latitude")) it.optDouble("latitude", Double.NaN) else Double.NaN
                var lon = if (!it.isNull("longitude")) it.optDouble("longitude", Double.NaN) else Double.NaN
                // 母艦側に同一サイズの既存写真がある候補のみプリフライト前にGPSを確認し、新規写真は送信直前に確認する
                if ((lat.isNaN() || lon.isNaN()) && fileSize in motherSizes) {
                    emitProgress(0, rawTotal, "母艦DBと照合準備中 (${i + 1}/$rawTotal)...", 0, 0)
                    decodeDocKey(docKey)?.let { (tUri, dId) ->
                        val dUri = try { DocumentsContract.buildDocumentUriUsingTree(Uri.parse(tUri), dId) } catch (_: Exception) { null }
                        if (dUri != null) catalogEngine.readOriginalLatLon(dUri, fileName, fileSize)?.let { (la, lo) -> lat = la; lon = lo }
                    }
                }
                if (!lat.isNaN() && !lon.isNaN()) {
                    cand.put("latitude", lat).put("longitude", lon)
                    pfItem.put("latitude", lat).put("longitude", lon)
                }
                candidates.add(cand)
                preflightItems.add(pfItem)
            }

            if (candidates.isEmpty()) {
                return JSONObject().put("ok", false).put("error", "転送対象の写真がありません")
            }

            val total = candidates.size
            emitProgress(0, total, "母艦DBと重複照合中...", 0, 0, force = true)

            val skipSet = HashSet<String>()
            var appliedToExisting = 0

            for (chunk in preflightItems.chunked(PREFLIGHT_CHUNK_SIZE)) {
                val chunkArr = JSONArray().apply { chunk.forEach { put(it) } }
                val pfBody = JSONObject().put("items", chunkArr).toString()
                val preflightRes = try {
                    val encTok = URLEncoder.encode(token, "UTF-8")
                    postJson("$serverUrl/api/mobile/case-preflight?t=$encTok", token, pfBody, connectTimeoutMs = 10000, readTimeoutMs = 60000)
                } catch (connErr: Exception) {
                    val disc = wifiSyncManager.discoverPcOnLan(requestPair = false)
                    if (disc.optBoolean("found", false) && disc.optString("serverUrl").isNotEmpty()) {
                        serverUrl = disc.optString("serverUrl").trimEnd('/')
                        val newTok = wifiSyncManager.getConfiguredToken().trim()
                        if (newTok.isNotEmpty()) token = newTok
                        val encTok = URLEncoder.encode(token, "UTF-8")
                        try {
                            postJson("$serverUrl/api/mobile/case-preflight?t=$encTok", token, pfBody, connectTimeoutMs = 10000, readTimeoutMs = 60000)
                        } catch (retryErr: Exception) {
                            wifiSyncManager.isPcOnline = false
                            return JSONObject().put("ok", false).put("error", "母艦PCへの接続に失敗しました (${retryErr.message ?: "通信エラー"})。PCが起動しているか確認してください。")
                        }
                    } else {
                        wifiSyncManager.isPcOnline = false
                        return JSONObject().put("ok", false).put("error", "母艦PCへの接続に失敗しました (${connErr.message ?: "通信エラー"})。PCが起動しているか確認してください。")
                    }
                }

                wifiSyncManager.isPcOnline = true
                if (!preflightRes.optBoolean("ok", false)) {
                    return JSONObject().put("ok", false).put("error", preflightRes.optString("detail", preflightRes.optString("error", "プリフライト照合に失敗しました")))
                }
                preflightRes.optJSONArray("skipped_client_ids")?.let { arr ->
                    for (i in 0 until arr.length()) skipSet.add(arr.optString(i, ""))
                }
                preflightRes.optJSONObject("existing_geo_map")?.let { gmap ->
                    val keys = gmap.keys()
                    while (keys.hasNext()) {
                        val k = keys.next()
                        gmap.optJSONObject(k)?.let { catalogEngine.applyMotherGeoToPhoneRow(k, it) }
                    }
                }
                appliedToExisting += preflightRes.optInt("applied_to_existing", 0)
            }

            val newlyUploadedKeys = mutableListOf<String>()
            val succeededDocKeys = JSONArray()
            var importedCount = 0
            var skippedCount = 0
            var errorCount = 0
            var consecutiveFailures = 0
            var aborted = false
            var lastErrorMsg = ""

            for ((idx, cand) in candidates.withIndex()) {
                val docKey = cand.optString("docKey")
                val fileName = cand.optString("fileName")
                val fileSize = cand.optLong("fileSize", 0L)
                val matchKey = "${fileName.lowercase(Locale.US)}|$fileSize"
                val normKey = "${PhoneCatalogEngine.normalizeDupFileName(fileName)}|$fileSize"
                val isSkip = docKey in skipSet

                emitProgress(idx + 1, total, fileName, importedCount, skippedCount, errorCount, force = idx == 0 || idx == total - 1 || !isSkip)

                if (isSkip) {
                    skippedCount += 1
                    newlyUploadedKeys.add(matchKey)
                    newlyUploadedKeys.add(normKey)
                    succeededDocKeys.put(docKey)
                    continue
                }

                val (upRes, updatedEndpoint) = uploadSinglePhotoWithRetry(serverUrl, token, cand)
                if (updatedEndpoint != null) {
                    serverUrl = updatedEndpoint.first
                    token = updatedEndpoint.second
                }

                if (upRes.optBoolean("ok", false)) {
                    consecutiveFailures = 0
                    if (upRes.optString("status") == "skipped_duplicate") skippedCount += 1 else importedCount += 1
                    catalogEngine.applyMotherGeoToPhoneRow(docKey, upRes)
                    newlyUploadedKeys.add(matchKey)
                    newlyUploadedKeys.add(normKey)
                    succeededDocKeys.put(docKey)
                } else {
                    errorCount += 1
                    consecutiveFailures += 1
                    lastErrorMsg = upRes.optString("error", "通信エラー")
                    Log.w(TAG, "写真アップロード失敗 (${idx + 1}/$total $fileName): $lastErrorMsg")
                    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                        aborted = true
                        wifiSyncManager.isPcOnline = false
                        Log.e(TAG, "連続アップロード失敗上限($MAX_CONSECUTIVE_FAILURES)に達したため転送を安全中断します: $lastErrorMsg")
                        break
                    }
                }
            }

            emitProgress(
                minOf(total, importedCount + skippedCount + errorCount),
                total,
                if (aborted) "通信中断 — 収納済み分を記録中..." else "カタログ状態を更新中...",
                importedCount,
                skippedCount,
                errorCount,
                force = true
            )

            if (newlyUploadedKeys.isNotEmpty()) {
                onRecordUploadedKeys(newlyUploadedKeys)
                onRescanAfterTransfer()
            }

            val remainingCount = maxOf(0, total - importedCount - skippedCount)
            val allSucceeded = !aborted && errorCount == 0
            val resObj = JSONObject()
                .put("ok", allSucceeded)
                .put("partial", !allSucceeded && (importedCount > 0 || skippedCount > 0))
                .put("aborted", aborted)
                .put("totalCount", total)
                .put("importedCount", importedCount)
                .put("skippedCount", skippedCount)
                .put("errorCount", errorCount)
                .put("remainingCount", remainingCount)
                .put("appliedToExisting", appliedToExisting)
                .put("succeededDocKeys", succeededDocKeys)
            if (!allSucceeded) {
                val reason = if (lastErrorMsg.isNotEmpty()) lastErrorMsg else "通信が途切れました"
                resObj.put("error", reason)
            }
            return resObj
        } finally {
            releaseTransferLocks(wakeLock, wifiLock)
            transferRunning.set(false)
        }
    }

    /**
     * 母艦PCとWi-Fi通信可能な場合はチャンク分割プリフライトでライブ照合し、母艦側で削除された写真を未収納へ戻す
     */
    fun reconcileWithMotherShipLive(
        allRawItems: List<JSONObject>,
        draftsObj: JSONObject,
        uploadedHistorySupplier: () -> Set<String>,
        onRemoveUploadedKeys: (Set<String>) -> Unit,
        decodeThumbFn: (Uri) -> ByteArray?
    ): Boolean {
        if (allRawItems.isEmpty() || transferRunning.get()) return false
        val serverUrl = wifiSyncManager.getConfiguredServerUrl().trim().trimEnd('/')
        val token = wifiSyncManager.getConfiguredToken().trim()
        if (serverUrl.isEmpty()) return false

        return try {
            val encTok = URLEncoder.encode(token, "UTF-8")
            val skipSet = HashSet<String>()
            val existKeys = HashSet<String>()

            for (chunk in allRawItems.chunked(PREFLIGHT_CHUNK_SIZE)) {
                val pfArr = JSONArray()
                for (it in chunk) {
                    pfArr.put(
                        JSONObject()
                            .put("client_id", it.optString("docKey"))
                            .put("file_name", it.optString("fileName"))
                            .put("file_size", it.optLong("fileSize", 0L))
                            .put("last_modified_ms", it.optLong("lastModifiedMs", 0L))
                            .put("date_taken", it.optString("dateTaken"))
                            .put("camera_model", it.optString("cameraModel"))
                    )
                }
                val res = postJson("$serverUrl/api/mobile/case-preflight?t=$encTok", token, JSONObject().put("items", pfArr).toString(), 2000, 12000)
                if (!res.optBoolean("ok", false)) return false
                wifiSyncManager.isPcOnline = true
                res.optJSONArray("skipped_client_ids")?.let { arr ->
                    for (i in 0 until arr.length()) skipSet.add(arr.optString(i, ""))
                }
                res.optJSONObject("existing_photo_map")?.let { emap ->
                    val ks = emap.keys()
                    while (ks.hasNext()) existKeys.add(ks.next())
                }
                res.optJSONObject("existing_geo_map")?.let { gmap ->
                    val ks = gmap.keys()
                    while (ks.hasNext()) {
                        val k = ks.next()
                        gmap.optJSONObject(k)?.let { catalogEngine.applyMotherGeoToPhoneRow(k, it) }
                    }
                }
            }

            val removedKeys = HashSet<String>()
            val staleMotherIds = HashSet<Long>()
            val stalePaths = HashSet<String>()
            for (it in allRawItems) {
                val dk = it.optString("docKey")
                val fn = it.optString("fileName")
                val sz = it.optLong("fileSize", 0L)
                if (dk in skipSet || dk in existKeys) {
                    it.put("inMotherShip", true)
                } else {
                    if (it.optBoolean("inMotherShip", false)) {
                        val pid = it.optLong("photoId", 0L)
                        if (pid in 1 until PhoneCatalogEngine.PHONE_LOCAL_ID_BASE) staleMotherIds.add(pid)
                        stalePaths.add("phone://$dk")
                        removedKeys.add("${fn.lowercase(Locale.US)}|$sz")
                        removedKeys.add("${PhoneCatalogEngine.normalizeDupFileName(fn)}|$sz")
                    }
                    it.put("inMotherShip", false)
                }
            }
            if (removedKeys.isNotEmpty()) onRemoveUploadedKeys(removedKeys)
            val purged = catalogEngine.purgeDeletedMotherRows(staleMotherIds, stalePaths)
            if (purged > 0) {
                val freshLookup = catalogEngine.loadMotherShipLookup(uploadedHistorySupplier())
                catalogEngine.syncScannedItemsToCatalogDetailed(allRawItems, freshLookup, draftsObj, decodeDocKey, decodeThumbFn)
            }
            purged > 0 || removedKeys.isNotEmpty()
        } catch (e: Exception) {
            Log.d(TAG, "母艦ライブ照合スキップ: ${e.message}")
            false
        }
    }

    private fun uploadSinglePhotoWithRetry(
        initialServerUrl: String,
        initialToken: String,
        cand: JSONObject
    ): Pair<JSONObject, Pair<String, String>?> {
        var curUrl = initialServerUrl
        var curTok = initialToken
        var updatedPair: Pair<String, String>? = null
        var lastRes = JSONObject().put("ok", false).put("error", "Upload failed")

        val docKey = cand.optString("docKey")
        val (treeUriStr, docId) = decodeDocKey(docKey)
            ?: return JSONObject().put("ok", false).put("error", "Invalid docKey") to null
        val docUri = DocumentsContract.buildDocumentUriUsingTree(Uri.parse(treeUriStr), docId)
        val fileName = cand.optString("fileName")
        val fileSize = cand.optLong("fileSize", 0L)

        // 送信直前に未取得のGPS座標があれば補完する
        if (cand.isNull("latitude") || cand.isNull("longitude")) {
            catalogEngine.readOriginalLatLon(docUri, fileName, fileSize)?.let { (la, lo) ->
                cand.put("latitude", la).put("longitude", lo)
            }
        }

        val backoffMs = longArrayOf(700L, 1600L, 3000L)
        for (attempt in 1..MAX_UPLOAD_ATTEMPTS) {
            lastRes = uploadSinglePhotoOnce(curUrl, curTok, docUri, cand)
            if (lastRes.optBoolean("ok", false)) {
                return lastRes to updatedPair
            }
            val httpCode = lastRes.optInt("httpCode", 0)
            if (httpCode in listOf(400, 401, 403, 413, 423)) {
                // リトライしても回復しないクライアント/認証/ロックエラーは即時返却
                return lastRes to updatedPair
            }
            if (attempt < MAX_UPLOAD_ATTEMPTS) {
                try {
                    Thread.sleep(backoffMs[minOf(attempt - 1, backoffMs.lastIndex)])
                } catch (_: InterruptedException) {
                    return lastRes to updatedPair
                }
                if (attempt == 2 && httpCode == 0) {
                    val disc = wifiSyncManager.discoverPcOnLan(requestPair = false)
                    if (disc.optBoolean("found", false)) {
                        val newUrl = disc.optString("serverUrl", "").trimEnd('/')
                        val newTok = wifiSyncManager.getConfiguredToken().trim().ifEmpty { curTok }
                        if (newUrl.isNotEmpty() && (newUrl != curUrl || newTok != curTok)) {
                            curUrl = newUrl
                            curTok = newTok
                            updatedPair = curUrl to curTok
                        }
                    }
                }
            }
        }
        return lastRes to updatedPair
    }

    private fun uploadSinglePhotoOnce(serverUrl: String, token: String, docUri: Uri, cand: JSONObject): JSONObject {
        val fileName = cand.optString("fileName")
        val fileSize = cand.optLong("fileSize", 0L)
        val lastMod = cand.optLong("lastModifiedMs", 0L)
        val rating = cand.optInt("rating", 0)
        val tagsStr = (cand.optJSONArray("tags") ?: JSONArray()).toString()
        val geoQuery = if (!cand.isNull("latitude") && !cand.isNull("longitude")) {
            "&lat=${cand.optDouble("latitude")}&lon=${cand.optDouble("longitude")}"
        } else ""

        val qName = URLEncoder.encode(fileName, "UTF-8")
        val qTags = URLEncoder.encode(tagsStr, "UTF-8")
        val qTok = URLEncoder.encode(token, "UTF-8")
        val uploadUrl = "$serverUrl/api/mobile/case-upload?t=$qTok&file_name=$qName&last_modified_ms=$lastMod&rating=$rating&tags_json=$qTags$geoQuery"

        var conn: HttpURLConnection? = null
        return try {
            val inputStream = catalogEngine.openOriginalPhotoStream(docUri, fileName, fileSize)
                ?: return JSONObject().put("ok", false).put("httpCode", 400).put("error", "ファイルを開けませんでした ($fileName)")

            inputStream.use { ins ->
                conn = (URL(uploadUrl).openConnection() as HttpURLConnection).apply {
                    requestMethod = "POST"
                    connectTimeout = 15000
                    readTimeout = 120000
                    doOutput = true
                    setChunkedStreamingMode(64 * 1024)
                    setRequestProperty("Content-Type", "application/octet-stream")
                    setRequestProperty("Connection", "close")
                    if (token.isNotEmpty()) setRequestProperty("Cookie", "$COOKIE_NAME=$token")
                }
                conn!!.outputStream.use { outs ->
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        val n = ins.read(buf)
                        if (n <= 0) break
                        outs.write(buf, 0, n)
                    }
                    outs.flush()
                }
                val code = conn!!.responseCode
                val respTxt = (if (code in 200..299) conn!!.inputStream else conn!!.errorStream)
                    ?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: "{}"
                if (code in 200..299) {
                    try {
                        JSONObject(respTxt)
                    } catch (_: Exception) {
                        JSONObject().put("ok", false).put("httpCode", code).put("error", "サーバー応答の解析に失敗しました (HTTP $code)")
                    }
                } else {
                    JSONObject().put("ok", false).put("httpCode", code).put("error", "HTTP $code: $respTxt")
                }
            }
        } catch (e: Exception) {
            JSONObject().put("ok", false).put("httpCode", 0).put("error", e.message ?: "Upload network error")
        } finally {
            try { conn?.disconnect() } catch (_: Exception) {}
        }
    }

    private fun postJson(urlStr: String, token: String, bodyJson: String, connectTimeoutMs: Int, readTimeoutMs: Int): JSONObject {
        var conn: HttpURLConnection? = null
        try {
            val bytes = bodyJson.toByteArray(Charsets.UTF_8)
            conn = (URL(urlStr).openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = connectTimeoutMs
                readTimeout = readTimeoutMs
                doOutput = true
                setFixedLengthStreamingMode(bytes.size)
                setRequestProperty("Content-Type", "application/json; charset=utf-8")
                setRequestProperty("Connection", "close")
                if (token.isNotEmpty()) setRequestProperty("Cookie", "$COOKIE_NAME=$token")
            }
            conn.outputStream.use { it.write(bytes) }
            val code = conn.responseCode
            val txt = try {
                (if (code in 200..299) conn.inputStream else conn.errorStream)
                    ?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: ""
            } catch (_: Exception) {
                ""
            }
            val parsed = if (txt.isNotBlank()) {
                try { JSONObject(txt) } catch (_: Exception) { null }
            } else {
                null
            }
            if (code in 200..299) {
                return parsed ?: JSONObject()
                    .put("ok", false)
                    .put("httpCode", code)
                    .put("error", "サーバー応答の解析に失敗しました (HTTP $code)")
            }
            val detail = parsed?.optString("detail", "")?.takeIf { it.isNotEmpty() }
                ?: parsed?.optString("error", "")?.takeIf { it.isNotEmpty() }
                ?: txt.trim().take(160).ifEmpty { "サーバーエラー" }
            val errMsg = when (code) {
                401, 403 -> "母艦PCとのペアリング認証が無効です (HTTP $code: $detail)"
                423 -> "母艦PCのアプリがロックされています ($detail)"
                else -> "母艦サーバーエラー (HTTP $code: $detail)"
            }
            return JSONObject()
                .put("ok", false)
                .put("httpCode", code)
                .put("error", errMsg)
                .put("detail", errMsg)
        } finally {
            try { conn?.disconnect() } catch (_: Exception) {}
        }
    }

    @Suppress("DEPRECATION")
    private fun acquireTransferLocks(): Pair<PowerManager.WakeLock?, WifiManager.WifiLock?> {
        var wl: PowerManager.WakeLock? = null
        var wfl: WifiManager.WifiLock? = null
        try {
            val pm = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
            wl = pm?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Tetheract:CaseTransferWakeLock")?.apply {
                setReferenceCounted(false)
                acquire(MAX_LOCK_HOLD_MS)
            }
        } catch (e: Exception) {
            Log.w(TAG, "WakeLock取得スキップ: ${e.message}")
        }
        try {
            val wm = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
            val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                WifiManager.WIFI_MODE_FULL_LOW_LATENCY
            } else {
                WifiManager.WIFI_MODE_FULL_HIGH_PERF
            }
            wfl = wm?.createWifiLock(mode, "Tetheract:CaseTransferWifiLock")?.apply {
                setReferenceCounted(false)
                acquire()
            }
        } catch (e: Exception) {
            Log.w(TAG, "WifiLock取得スキップ: ${e.message}")
        }
        return wl to wfl
    }

    private fun releaseTransferLocks(wakeLock: PowerManager.WakeLock?, wifiLock: WifiManager.WifiLock?) {
        try {
            if (wakeLock?.isHeld == true) wakeLock.release()
        } catch (e: Exception) {
            Log.w(TAG, "WakeLock解放警告: ${e.message}")
        }
        try {
            if (wifiLock?.isHeld == true) wifiLock.release()
        } catch (e: Exception) {
            Log.w(TAG, "WifiLock解放警告: ${e.message}")
        }
    }
}
