package com.tetheract.pm

import android.content.Context
import android.net.Uri
import android.os.Build
import android.util.Log
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.HttpURLConnection
import java.net.Inet4Address
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.Socket
import java.net.URL
import java.net.URLEncoder
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.Callable
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * ローカルWi-Fi（初回QRペアリング＋永続Cookie/トークン認証）経由でPC母艦とスマホ内専用ロッカーを高速双方向同期するマネージャ。
 * - 初回ペアリング時にPCの永続認証トークン（pm_lan_token Cookie相当）をスマホ内に保存する。
 * - PC側は起動時に自動でLAN待受を開始するため、2回目以降はPC側でQRコード画面を開かなくてもスマホ側の「Wi-Fi同期」1タップで即同期できる。
 * - ルーターのDHCP等でPCのローカルIP（192.168.x.y）が変化した場合も、同一サブネット内を自動探索して追従する。
 */
class WifiLockerSyncManager(
    private val context: Context,
    private val lockerDbManager: LockerDatabaseManager,
    private val usbOfflineUpdater: UsbOfflineUpdater? = null
) {

    companion object {
        private const val TAG = "WifiLockerSyncManager"
        private const val PREFS_NAME = "tetheract_wifi_prefs"
        private const val KEY_SERVER_URL = "wifi_server_url"
        private const val KEY_LAN_TOKEN = "wifi_lan_token"
        private const val KEY_LAST_SYNC_AT = "wifi_last_sync_at"
        private const val COOKIE_NAME = "pm_lan_token"
        private const val BUFFER_SIZE = 256 * 1024
        private val SQLITE_MAGIC = "SQLite format 3\u0000".toByteArray(Charsets.US_ASCII)
    }

    private val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    private val uiDownloadLock = Any()
    @Volatile private var backupBeforeSwitch: Pair<String, String>? = null
    @Volatile var isPcOnline: Boolean = false
    @Volatile var pcConnStatusJson: String = ""
    @Volatile var pcConnRevision: String = ""
    @Volatile var remoteUiRevision: String = ""
    @Volatile var remoteUiVersion: String = ""
    @Volatile var remoteUiMtime: Long = 0L
    @Volatile var remoteNativeRevision: String = ""
    @Volatile var remoteApkAvailable: Boolean = false

    private fun clearPcLinkState() {
        isPcOnline = false
        pcConnStatusJson = ""
        pcConnRevision = ""
        remoteUiRevision = ""
        remoteUiVersion = ""
        remoteUiMtime = 0L
        remoteNativeRevision = ""
        remoteApkAvailable = false
    }

    fun rollbackPendingSwitch() {
        val bak = backupBeforeSwitch ?: return
        backupBeforeSwitch = null
        prefs.edit().putString(KEY_SERVER_URL, bak.first).putString(KEY_LAN_TOKEN, bak.second).apply()
    }

    fun isWifiConfigured(): Boolean {
        return getConfiguredServerUrl().isNotEmpty()
    }

    fun getConfiguredServerUrl(): String {
        return prefs.getString(KEY_SERVER_URL, "")?.trim() ?: ""
    }

    fun getConfiguredToken(): String {
        return prefs.getString(KEY_LAN_TOKEN, "")?.trim() ?: ""
    }

    fun getLastWifiSyncAt(): String {
        return prefs.getString(KEY_LAST_SYNC_AT, "") ?: ""
    }

    /**
     * ディープリンク (tetheract://pair?server=...&token=...) または
     * QRコードURL (http://192.168.x.x:8088/m?t=...) を解析して永続ペアリング設定を保存する
     */
    fun savePairingFromInput(rawInput: String): JSONObject {
        val trimmed = rawInput.trim()
        if (trimmed.isEmpty()) {
            return JSONObject().put("ok", false).put("error", "URLが空です")
        }

        return try {
            val uri = Uri.parse(trimmed)
            var serverUrl = ""
            var token = ""

            if (uri.scheme.equals("tetheract", ignoreCase = true)) {
                serverUrl = (uri.getQueryParameter("server") ?: "").trim().trimEnd('/')
                token = (uri.getQueryParameter("token") ?: uri.getQueryParameter("t") ?: "").trim()
            } else if (uri.scheme.equals("http", ignoreCase = true) || uri.scheme.equals("https", ignoreCase = true)) {
                val host = uri.host ?: ""
                val port = if (uri.port > 0) ":${uri.port}" else ":8088"
                serverUrl = "${uri.scheme!!.lowercase(Locale.US)}://$host$port"
                token = (uri.getQueryParameter("t") ?: uri.getQueryParameter("token") ?: "").trim()
            } else if (trimmed.matches(Regex("^\\d+\\.\\d+\\.\\d+\\.\\d+(:\\d+)?.*$"))) {
                val parsed = Uri.parse("http://$trimmed")
                val host = parsed.host ?: ""
                val port = if (parsed.port > 0) ":${parsed.port}" else ":8088"
                serverUrl = "http://$host$port"
                token = (parsed.getQueryParameter("t") ?: parsed.getQueryParameter("token") ?: "").trim()
            }

            val serverUri = Uri.parse(serverUrl)
            val host = (serverUri.host ?: "").lowercase(Locale.US)
            if (host.isEmpty() || !isAllowedLocalLanHost(host)) {
                return JSONObject()
                    .put("ok", false)
                    .put("reason", "invalid_lan_host")
                    .put("error", "ローカルLAN内（192.168.x.x / 10.x.x.x / 172.16-31.x.x）のPCアドレスのみ指定できます")
            }

            val prevUrl = getConfiguredServerUrl()
            val prevHost = try { Uri.parse(prevUrl).host ?: "" } catch (_: Exception) { "" }
            val hasLocal = lockerDbManager.hasLockerDatabase() || lockerDbManager.getPendingChangeCount() > 0
            if (hasLocal && prevUrl.isNotEmpty() && !prevHost.equals(host, ignoreCase = true) && backupBeforeSwitch == null) {
                backupBeforeSwitch = Pair(prevUrl, getConfiguredToken())
            }
            val editor = prefs.edit().putString(KEY_SERVER_URL, serverUrl)
            if (token.isNotEmpty()) {
                editor.putString(KEY_LAN_TOKEN, token)
            }
            editor.apply()

            JSONObject()
                .put("ok", true)
                .put("serverUrl", serverUrl)
                .put("hasToken", getConfiguredToken().isNotEmpty())
        } catch (e: Exception) {
            Log.w(TAG, "ペアリングURL解析失敗: $trimmed", e)
            JSONObject()
                .put("ok", false)
                .put("error", e.message ?: "URLの解析に失敗しました")
        }
    }

    private fun isAllowedLocalLanHost(host: String): Boolean {
        if (host == "localhost" || host == "127.0.0.1" || host == "::1") return true
        val parts = host.split(".")
        if (parts.size == 4) {
            val octets = parts.map { it.toIntOrNull() ?: return false }
            if (octets.any { it < 0 || it > 255 }) return false
            if (octets[0] == 10) return true
            if (octets[0] == 192 && octets[1] == 168) return true
            if (octets[0] == 172 && octets[1] in 16..31) return true
            if (octets[0] == 127) return true
        }
        return false
    }

    /**
     * PC母艦とWi-Fi経由で双方向ロッカー同期を実行する。
     * - 未ペアリング時やDHCPによるIP変動時も自動で同一Wi-Fi内のPC母艦を検出し、
     *   PC画面の承認（またはQR画面開放）と連動してURL手入力なしでペアリング＆同期する。
     */
    fun syncWithPcOverWifi(
        forceFull: Boolean = false,
        allowLibrarySwitch: Boolean = false,
        onStatusProgress: ((String, String) -> Unit)? = null
    ): JSONObject {
        var serverUrl = getConfiguredServerUrl()
        var token = getConfiguredToken()

        return try {
            // 0. 接続先またはトークンが未設定の場合は、同一Wi-Fi内のPC母艦を自動探索＆ペアリング要求
            if (serverUrl.isEmpty() || token.isEmpty()) {
                onStatusProgress?.invoke(
                    "同一Wi-Fi内のPC母艦を自動探索中...",
                    "UDPブロードキャストとローカルサブネットからTETHERACTを探しています"
                )
                val disc = discoverPcOnLan(requestPair = true)
                if (!disc.optBoolean("found", false)) {
                    return JSONObject()
                        .put("ok", false)
                        .put("reason", "pc_not_found")
                        .put("error", "同一Wi-Fi上にPC母艦が見つかりませんでした。PC側でTETHERACTが起動しており、同じWi-Fiに接続されているか確認してください。")
                }
                serverUrl = disc.optString("serverUrl", serverUrl)
                token = getConfiguredToken()

                if (!disc.optBoolean("pairedMatch", false) && token.isEmpty()) {
                    val pcHost = disc.optString("hostname", serverUrl)
                    onStatusProgress?.invoke(
                        "PC母艦「$pcHost」を検出しました！",
                        "PC画面に表示された「許可する」をクリックしてください（またはPCでスマホ連携QR画面を開くと自動承認されます）"
                    )
                    var approved = false
                    for (attempt in 1..22) {
                        Thread.sleep(1200)
                        val poll = discoverPcOnLan(requestPair = false)
                        if (poll.optBoolean("pairedMatch", false) || getConfiguredToken().isNotEmpty()) {
                            serverUrl = poll.optString("serverUrl", serverUrl)
                            token = getConfiguredToken()
                            approved = true
                            break
                        }
                    }
                    if (!approved || token.isEmpty()) {
                        return JSONObject()
                            .put("ok", false)
                            .put("reason", "pair_timeout")
                            .put("error", "PC側でのペアリング承認が確認できませんでした。PC画面の「許可する」を押すか、スマホ連携(QR)画面を開いた状態で再度お試しください。")
                    }
                }
            }

            var encToken = URLEncoder.encode(token, "UTF-8")

            // 1. 接続確認 & ステータス取得（IP変動時は同一サブネット自動探索）
            var statusRes = try {
                httpGetJson("$serverUrl/api/mobile/locker-sync?mode=status&t=$encToken", token, connectTimeoutMs = 2500, readTimeoutMs = 8000)
            } catch (connErr: Exception) {
                val disc = discoverPcOnLan(requestPair = true)
                if (disc.optBoolean("found", false)) {
                    serverUrl = disc.optString("serverUrl", serverUrl)
                    token = getConfiguredToken()
                    encToken = URLEncoder.encode(token, "UTF-8")
                    httpGetJson("$serverUrl/api/mobile/locker-sync?mode=status&t=$encToken", token, connectTimeoutMs = 3500, readTimeoutMs = 8000)
                } else {
                    throw connErr
                }
            }

            if (!statusRes.optBoolean("ok", false) && statusRes.optString("reason") == "token_expired") { val disc = discoverPcOnLan(requestPair = true); if (disc.optBoolean("found", false) && getConfiguredToken().isNotEmpty()) { serverUrl = disc.optString("serverUrl", serverUrl); token = getConfiguredToken(); encToken = URLEncoder.encode(token, "UTF-8"); statusRes = httpGetJson("$serverUrl/api/mobile/locker-sync?mode=status&t=$encToken", token, connectTimeoutMs = 3500, readTimeoutMs = 8000) } }
            if (!statusRes.optBoolean("ok", false)) {
                return statusRes
            }
            val statusUiRev = statusRes.optString("ui_revision", "").trim()
            val statusUiVer = statusRes.optString("ui_version", "").trim()
            val statusUiMtime = statusRes.optLong("ui_mtime", 0L)
            val statusNativeRev = statusRes.optString("native_revision", "").trim()
            val statusApkAvail = statusRes.optBoolean("apk_available", false)
            if (statusUiRev.isNotEmpty()) {
                remoteUiRevision = statusUiRev
                remoteUiVersion = statusUiVer
                remoteUiMtime = statusUiMtime
            }
            if (statusNativeRev.isNotEmpty()) {
                remoteNativeRevision = statusNativeRev
                remoteApkAvailable = statusApkAvail
            }
            val remoteLibId = statusRes.optString("library_id", "").trim()
            val remoteOwnerId = statusRes.optString("owner_id", "").trim()
            val localLibId = lockerDbManager.readLocalLibraryId()
            val prevMeta = lockerDbManager.readLockerMeta()
            val hasLocalData = lockerDbManager.hasLockerDatabase() || lockerDbManager.getPendingChangeCount() > 0
            val isMismatch = (localLibId.isNotEmpty() && remoteLibId.isNotEmpty() && localLibId != remoteLibId) ||
                (localLibId.isEmpty() && backupBeforeSwitch != null)
            if (!allowLibrarySwitch && hasLocalData && isMismatch) {
                val curLabel = prevMeta.optString("usb_folder_name", "").ifEmpty { backupBeforeSwitch?.first ?: "現在のロッカー" }
                val newHost = Uri.parse(serverUrl).host ?: serverUrl
                return JSONObject().put("ok", false).put("reason", "library_mismatch").put("syncType", "wifi")
                    .put("currentSource", curLabel).put("targetSource", "Wi-Fi ($newHost)")
                    .put("pendingChangeCount", lockerDbManager.getPendingChangeCount())
            }
            backupBeforeSwitch = null
            var pcDbMtime = statusRes.optLong("db_mtime", 0L)
            var pcDbSize = statusRes.optLong("db_size", 0L)
            val hasExistingLocker = lockerDbManager.hasLockerDatabase() && !forceFull && !allowLibrarySwitch
            val prevMtime = prevMeta.optLong("source_db_mtime", -1L)
            val prevSize = prevMeta.optLong("source_db_size", -1L)
            val pcUnchangedBeforePush = hasExistingLocker && prevMtime > 0L && prevMtime == pcDbMtime && prevSize == pcDbSize

            // 2. スマホ側の未反映変更があれば先にPCへPOST反映
            var pushedCount = 0
            var skippedCount = 0
            val pendingCount = lockerDbManager.getPendingChangeCount()
            if (pendingCount > 0) {
                val (payload, sentRev) = lockerDbManager.buildMobileSyncSnapshot()
                val pushUrl = "$serverUrl/api/mobile/sync-import?t=$encToken"
                val pushRes = httpPostJson(pushUrl, token, payload, connectTimeoutMs = 5000, readTimeoutMs = 20000)
                if (!pushRes.optBoolean("ok", false) && pushRes.optString("status") != "ok") {
                    return JSONObject()
                        .put("ok", false)
                        .put("reason", "push_failed")
                        .put("error", pushRes.optString("error", "スマホ側の変更データの送信に失敗しました"))
                }
                lockerDbManager.clearPendingJournalUpTo(sentRev)
                pushedCount = pushRes.optInt("applied_count", pendingCount)
                skippedCount = pushRes.optInt("skipped_count", 0)
                if (pcUnchangedBeforePush) {
                    try {
                        val afterSt = httpGetJson("$serverUrl/api/mobile/locker-sync?mode=status&t=$encToken", token, connectTimeoutMs = 2000, readTimeoutMs = 4000)
                        if (afterSt.optBoolean("ok", false)) {
                            pcDbMtime = afterSt.optLong("db_mtime", pcDbMtime)
                            pcDbSize = afterSt.optLong("db_size", pcDbSize)
                        }
                    } catch (_: Exception) {}
                }
            }

            // 2b. 未送信のフィールドログがあればPCへPOST送信（写真変更0件時も実行）
            val uploadedLogDays = try {
                FieldLogUploader(FieldLogStore.get(context)).uploadPending(serverUrl, token) { url, body ->
                    httpPostJson(url, token, body, connectTimeoutMs = 5000, readTimeoutMs = 30000)
                }.also { if (it > 0) FieldLogService.notifyStatusChanged(context) }
            } catch (e: Exception) {
                Log.w(TAG, "フィールドログWi-Fi送信警告", e)
                0
            }

            // 3. PC側DBに変更がない場合は重い差分DBダウンロード・SQLite全件マージを0msでスキップ
            var syncMode = "wifi_delta"
            var usedDelta = false
            if (pcUnchangedBeforePush) {
                usedDelta = true
                syncMode = "wifi_noop"
            } else if (hasExistingLocker) {
                val wm = lockerDbManager.getLockerSyncWatermarks()
                val maxPhotoId = wm.optLong("max_photo_id", 0L)
                val maxThumbCreated = URLEncoder.encode(wm.optString("max_thumb_created_at", ""), "UTF-8")
                val deltaUrl = "$serverUrl/api/mobile/locker-sync?mode=delta&max_photo_id=$maxPhotoId&max_thumb_created_at=$maxThumbCreated&t=$encToken"
                val deltaTmp = File(lockerDbManager.lockerDir, "mobile_delta.wifi.tmp")
                try {
                    if (downloadFileFromHttp(deltaUrl, token, deltaTmp, readTimeoutMs = 30000) && validateSqliteHeader(deltaTmp)) {
                        if (lockerDbManager.applyDeltaDatabase(deltaTmp)) {
                            usedDelta = true
                            syncMode = "wifi_delta"
                        }
                    }
                } finally {
                    if (deltaTmp.exists()) deltaTmp.delete()
                }
            }

            var fullReapplied = 0
            if (!usedDelta) {
                val fullUrl = "$serverUrl/api/mobile/locker-sync?mode=full&t=$encToken"
                val fullTmp = File(lockerDbManager.lockerDir, "library.db.wifi.tmp")
                try {
                    if (!downloadFileFromHttp(fullUrl, token, fullTmp, readTimeoutMs = 180000) || !validateSqliteHeader(fullTmp)) {
                        return JSONObject()
                            .put("ok", false)
                            .put("reason", "download_failed")
                            .put("error", "PCからのデータベース取得に失敗しました。PCと同じWi-Fiに接続されているか確認してください。")
                    }
                    fullReapplied = lockerDbManager.replaceLibraryDatabaseFromTemp(fullTmp, BUFFER_SIZE)
                } finally {
                    if (fullTmp.exists()) fullTmp.delete()
                }
                syncMode = "wifi_full"
            }

            // wifi_delta は既に WAL 上のオープン済み DB へ適用済みのため、クローズ・WAL削除を行わずジャーナル再適用のみ実施する
            val reapplied = when (syncMode) {
                "wifi_noop" -> 0
                "wifi_delta" -> lockerDbManager.replayPendingJournal()
                else -> fullReapplied
            }
            val nowStr = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US).format(Date())
            val hostLabel = Uri.parse(serverUrl).host ?: serverUrl
            val newMeta = JSONObject()
                .put("library_id", remoteLibId.ifEmpty { localLibId })
                .put("owner_id", remoteOwnerId.ifEmpty { lockerDbManager.readLocalOwnerId() })
                .put("last_cached_at", nowStr)
                .put("source_db_mtime", pcDbMtime)
                .put("source_db_size", pcDbSize)
                .put("usb_folder_name", "Wi-Fi ($hostLabel)")
                .put("reapplied_journal_count", reapplied)
            lockerDbManager.writeLockerMeta(newMeta)
            prefs.edit().putString(KEY_LAST_SYNC_AT, nowStr).apply()
            isPcOnline = true
            refreshPcConnectionStatus(serverUrl, token)
            val effectiveUiRev = remoteUiRevision.ifEmpty { statusUiRev }
            val effectiveUiVer = remoteUiVersion.ifEmpty { statusUiVer }
            val effectiveUiMtime = if (remoteUiMtime > 0L) remoteUiMtime else statusUiMtime
            val uiApplied = syncAndApplyWifiUiBundleIfNeeded(
                serverUrl, token, effectiveUiRev, effectiveUiMtime, effectiveUiVer, triggerReload = false
            )
            val nativeUpdateRequired = isNativeApkUpdateAvailable()

            JSONObject()
                .put("ok", true)
                .put("updated", true)
                .put("syncMode", syncMode)
                .put("pushedCount", pushedCount)
                .put("skippedCount", skippedCount)
                .put("uploadedFieldLogDays", uploadedLogDays)
                .put("dbPhotoCount", lockerDbManager.getPhotoCount())
                .put("pendingChangeCount", lockerDbManager.getPendingChangeCount())
                .put("lastCachedAt", nowStr)
                .put("serverUrl", serverUrl)
                .put("uiBundleApplied", uiApplied)
                .put("uiVersion", effectiveUiVer)
                .put("nativeApkUpdateRequired", nativeUpdateRequired)
                .put("apkDownloadUrl", if (nativeUpdateRequired) getRemoteApkDownloadUrl() else "")
        } catch (e: Exception) {
            Log.e(TAG, "Wi-Fiロッカー同期エラー", e)
            clearPcLinkState()
            JSONObject()
                .put("ok", false)
                .put("reason", "network_error")
                .put("error", "PC（$serverUrl）へ接続できませんでした。PC側でTetheractが起動しており、同じWi-Fiに接続されているか確認してください。")
        }
    }

    /**
     * 同一Wi-Fi内のTetheract母艦PCをUDPブロードキャスト＋高速サブネットスキャンで自動検出し、
     * トークン照合またはペアリング要求を行う
     */
    fun discoverPcOnLan(requestPair: Boolean = false): JSONObject {
        val savedUrl = getConfiguredServerUrl()
        val token = getConfiguredToken()
        val devName = (Build.MODEL ?: "Android").trim()

        // 1. 保存済みURLがあれば最優先で疎通確認
        if (savedUrl.isNotEmpty()) {
            val probe = probeDiscoverEndpoint(savedUrl, token, requestPair, devName, timeoutMs = 900)
            if (probe != null) {
                isPcOnline = true
                if (probe.optBoolean("pairedMatch", false)) {
                    refreshPcConnectionStatus(probe.optString("serverUrl", "").ifEmpty { savedUrl }, getConfiguredToken())
                }
                return probe
            }
        }

        // 2. UDPブロードキャストによるミリ秒探索 (port 8088)
        val udpUrl = tryUdpBroadcastDiscovery(token, port = 8088)
        if (!udpUrl.isNullOrEmpty()) {
            val probe = probeDiscoverEndpoint(udpUrl, token, requestPair, devName, timeoutMs = 1200)
            if (probe != null) {
                isPcOnline = true
                if (probe.optBoolean("pairedMatch", false)) {
                    refreshPcConnectionStatus(probe.optString("serverUrl", "").ifEmpty { udpUrl }, getConfiguredToken())
                }
                return probe
            }
        }

        // 3. ルーターがUDPブロードキャストを遮断している場合の高速HTTPサブネット探索 (完了順即座返却・二重ソケット排除)
        return try {
            val port = 8088
            val prefixes = collectLocalSubnetPrefixes(savedUrl)
            if (prefixes.isEmpty()) {
                isPcOnline = false
                pcConnStatusJson = ""
                pcConnRevision = ""
                return JSONObject().put("ok", true).put("found", false)
            }
            val octets = ((2..35) + (100..140) + (36..99) + (141..254) + listOf(1)).distinct()
            for (prefix in prefixes) {
                val pool = Executors.newFixedThreadPool(16)
                try {
                    val completion = java.util.concurrent.ExecutorCompletionService<JSONObject?>(pool)
                    for (lastOctet in octets) {
                        val candidateIp = "$prefix.$lastOctet"
                        completion.submit {
                            probeDiscoverEndpoint("http://$candidateIp:$port", token, requestPair, devName, timeoutMs = 750)
                        }
                    }
                    val deadline = System.currentTimeMillis() + 6500L
                    var remaining = octets.size
                    while (remaining > 0 && System.currentTimeMillis() < deadline) {
                        val f = completion.poll(150, TimeUnit.MILLISECONDS) ?: continue
                        remaining--
                        val found = try { f.get() } catch (_: Exception) { null }
                        if (found != null && found.optBoolean("found", false)) {
                            isPcOnline = true
                            if (found.optBoolean("pairedMatch", false)) {
                                val resolvedUrl = found.optString("serverUrl", "").ifEmpty { getConfiguredServerUrl() }
                                if (resolvedUrl.isNotEmpty()) {
                                    refreshPcConnectionStatus(resolvedUrl, getConfiguredToken())
                                }
                            }
                            return found
                        }
                    }
                } finally {
                    pool.shutdownNow()
                }
            }
            isPcOnline = false
            pcConnStatusJson = ""
            pcConnRevision = ""
            JSONObject().put("ok", true).put("found", false)
        } catch (e: Exception) {
            Log.d(TAG, "LANサブネット自動探索スキップ: ${e.message}")
            isPcOnline = false
            pcConnStatusJson = ""
            pcConnRevision = ""
            JSONObject().put("ok", true).put("found", false)
        }
    }

    /**
     * Android 11+ の SELinux netlink 制限 (SIOCGIFFLAGS SocketException) を回避して
     * 現在の Wi-Fi ローカルサブネット (例: "192.168.1") を最優先順で取得する
     */
    private fun collectLocalSubnetPrefixes(savedUrl: String): List<String> {
        val rawPrefixes = linkedSetOf<String>()
        if (savedUrl.isNotEmpty()) {
            try {
                val oldHost = Uri.parse(savedUrl).host ?: ""
                if (oldHost.count { it == '.' } == 3) {
                    rawPrefixes.add(oldHost.substringBeforeLast('.'))
                }
            } catch (_: Exception) {}
        }
        // 1. プライベートLAN宛てのダミーUDPルーティング解決で Wi-Fi (wlan0) のIPを最優先取得
        for (probeTarget in arrayOf("192.168.1.1", "192.168.0.1", "192.168.1.10", "8.8.8.8", "10.0.0.1")) {
            try {
                DatagramSocket().use { s ->
                    s.connect(InetAddress.getByName(probeTarget), 80)
                    val localIp = s.localAddress?.hostAddress ?: ""
                    if (isAllowedLocalLanHost(localIp) && localIp.count { it == '.' } == 3) {
                        rawPrefixes.add(localIp.substringBeforeLast('.'))
                    }
                }
            } catch (_: Exception) {}
        }
        // 2. NetworkInterface 列挙 (Android 11+ で例外を投げる iface.isUp を呼ばず、インターフェース単位で try-catch)
        try {
            val ifaces = NetworkInterface.getNetworkInterfaces()
            while (ifaces != null && ifaces.hasMoreElements()) {
                try {
                    val iface = ifaces.nextElement() ?: continue
                    val addrs = iface.inetAddresses
                    while (addrs != null && addrs.hasMoreElements()) {
                        try {
                            val addr = addrs.nextElement()
                            if (addr is Inet4Address && !addr.isLoopbackAddress) {
                                val ip = addr.hostAddress ?: continue
                                if (isAllowedLocalLanHost(ip) && ip.count { it == '.' } == 3) {
                                    rawPrefixes.add(ip.substringBeforeLast('.'))
                                }
                            }
                        } catch (_: Exception) {}
                    }
                } catch (_: Exception) {}
            }
        } catch (_: Exception) {}
        rawPrefixes.add("192.168.1")
        rawPrefixes.add("192.168.0")
        return rawPrefixes.sortedBy { p ->
            when {
                p.startsWith("192.168.") -> 0
                p.startsWith("172.") -> 1
                else -> 2
            }
        }
    }

    private fun tryUdpBroadcastDiscovery(token: String, port: Int): String? {
        return try {
            DatagramSocket().use { sock ->
                sock.broadcast = true
                sock.soTimeout = 750
                val msg = "TETHERACT_DISCOVER_V1|$token".toByteArray(Charsets.UTF_8)
                val prefixes = collectLocalSubnetPrefixes(getConfiguredServerUrl())
                val bcastTargets = linkedSetOf("255.255.255.255")
                for (prefix in prefixes) {
                    bcastTargets.add("$prefix.255")
                }
                for (t in bcastTargets) {
                    try {
                        val pkt = DatagramPacket(msg, msg.size, InetAddress.getByName(t), port)
                        sock.send(pkt)
                    } catch (_: Exception) {}
                }
                // ルーターがブロードキャストを遮断している環境向けに主要ホストへユニキャストUDPパケットも即時送信
                val primaryPrefix = prefixes.firstOrNull() ?: "192.168.1"
                val priorityOctets = (2..35) + (100..130)
                for (oct in priorityOctets) {
                    try {
                        val pkt = DatagramPacket(msg, msg.size, InetAddress.getByName("$primaryPrefix.$oct"), port)
                        sock.send(pkt)
                    } catch (_: Exception) {}
                }
                val buf = ByteArray(1024)
                val recv = DatagramPacket(buf, buf.size)
                sock.receive(recv)
                val respStr = String(recv.data, 0, recv.length, Charsets.UTF_8)
                val json = JSONObject(respStr)
                if (json.optString("service") == "tetheract-pm") {
                    val pairedMatch = json.optBoolean("paired_match", false)
                    val remoteLibId = json.optString("library_id", "").trim()
                    val localLibId = lockerDbManager.readLocalLibraryId()
                    val hasBound = getConfiguredServerUrl().isNotEmpty() || token.isNotEmpty() || lockerDbManager.hasLockerDatabase()
                    if (hasBound && (!pairedMatch || (localLibId.isNotEmpty() && remoteLibId.isNotEmpty() && localLibId != remoteLibId))) {
                        return null
                    }
                    val senderIp = recv.address.hostAddress ?: return null
                    val respPort = json.optInt("port", port)
                    val newToken = json.optString("pair_token", "").trim()
                    val url = "http://$senderIp:$respPort"
                    if (pairedMatch) {
                        val ed = prefs.edit().putString(KEY_SERVER_URL, url)
                        if (newToken.length >= 16) ed.putString(KEY_LAN_TOKEN, newToken)
                        ed.apply()
                    }
                    return url
                }
            }
            null
        } catch (_: Exception) {
            null
        }
    }

    private fun probeDiscoverEndpoint(
        baseUrl: String,
        token: String,
        requestPair: Boolean,
        devName: String,
        timeoutMs: Int
    ): JSONObject? {
        return try {
            val encTok = URLEncoder.encode(token, "UTF-8")
            val encDev = URLEncoder.encode(devName, "UTF-8")
            val reqPairFlag = if (requestPair) 1 else 0
            val url = "$baseUrl/api/mobile/discover?t=$encTok&request_pair=$reqPairFlag&device=$encDev"
            val res = httpGetJson(url, token, connectTimeoutMs = timeoutMs, readTimeoutMs = 1500)
            if (res.optBoolean("ok", false) && res.optString("service") == "tetheract-pm") {
                val resolvedUrl = baseUrl.trimEnd('/')
                val pairToken = res.optString("pair_token", "").trim()
                val pairedMatch = res.optBoolean("paired_match", false) || pairToken.isNotEmpty()
                val remoteLibId = res.optString("library_id", "").trim()
                val localLibId = lockerDbManager.readLocalLibraryId()
                val sameLib = localLibId.isEmpty() || remoteLibId.isEmpty() || localLibId == remoteLibId
                val hasBound = getConfiguredServerUrl().isNotEmpty() || token.isNotEmpty() || lockerDbManager.hasLockerDatabase()
                if (!requestPair && hasBound && (!pairedMatch || !sameLib)) return null
                if ((pairedMatch && sameLib) || !hasBound) {
                    val ed = prefs.edit().putString(KEY_SERVER_URL, resolvedUrl)
                    if (pairToken.length >= 16) ed.putString(KEY_LAN_TOKEN, pairToken)
                    ed.apply()
                }
                JSONObject()
                    .put("ok", true)
                    .put("found", true)
                    .put("serverUrl", resolvedUrl)
                    .put("hostname", res.optString("hostname", ""))
                    .put("pairedMatch", pairedMatch)
                    .put("pairingPending", res.optBoolean("pairing_pending", false))
            } else {
                null
            }
        } catch (_: Exception) {
            null
        }
    }

    private fun attachAuthCookieAndSaveResponseCookie(conn: HttpURLConnection, token: String) {
        if (token.isNotEmpty()) {
            conn.setRequestProperty("Cookie", "$COOKIE_NAME=$token")
        }
    }

    private fun updateCookieFromResponse(conn: HttpURLConnection) {
        try {
            val cookies = conn.headerFields["Set-Cookie"] ?: conn.headerFields["set-cookie"] ?: return
            for (c in cookies) {
                val m = Regex("$COOKIE_NAME=([^;\\s]+)").find(c)
                if (m != null) {
                    val newTok = m.groupValues[1].trim()
                    if (newTok.length >= 16) {
                        prefs.edit().putString(KEY_LAN_TOKEN, newTok).apply()
                    }
                }
            }
        } catch (_: Exception) {}
    }

    private fun httpGetJson(urlStr: String, token: String, connectTimeoutMs: Int, readTimeoutMs: Int): JSONObject {
        val conn = (URL(urlStr).openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = connectTimeoutMs
            readTimeout = readTimeoutMs
            useCaches = false
            attachAuthCookieAndSaveResponseCookie(this, token)
        }
        return try {
            val code = conn.responseCode
            updateCookieFromResponse(conn)
            if (code == 401 || code == 403) {
                return JSONObject()
                    .put("ok", false)
                    .put("reason", "token_expired")
                    .put("httpStatus", code)
                    .put("error", "PC側でペアリング鍵がリセットされています。PCの「スマホ連携(QR)」のQRコードをもう一度読み取ってください。")
            }
            if (code == 423) {
                return JSONObject()
                    .put("ok", false)
                    .put("reason", "pc_locked")
                    .put("httpStatus", code)
                    .put("error", "PC側のTetheractがロックされています。PC側でロックを解除してください。")
            }
            if (code !in 200..299) {
                return JSONObject()
                    .put("ok", false)
                    .put("httpStatus", code)
                    .put("error", "PCサーバー応答エラー (HTTP $code)")
            }
            val body = conn.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
            JSONObject(body).put("ok", true)
        } finally {
            conn.disconnect()
        }
    }

    private fun httpPostJson(urlStr: String, token: String, jsonBody: String, connectTimeoutMs: Int, readTimeoutMs: Int): JSONObject {
        val conn = (URL(urlStr).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            connectTimeout = connectTimeoutMs
            readTimeout = readTimeoutMs
            doOutput = true
            useCaches = false
            setRequestProperty("Content-Type", "application/json; charset=utf-8")
            attachAuthCookieAndSaveResponseCookie(this, token)
        }
        return try {
            val bytes = jsonBody.toByteArray(Charsets.UTF_8)
            conn.outputStream.use { out ->
                out.write(bytes)
                out.flush()
            }
            val code = conn.responseCode
            updateCookieFromResponse(conn)
            if (code !in 200..299) {
                return JSONObject().put("ok", false).put("httpStatus", code).put("error", "HTTP $code")
            }
            val body = conn.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
            JSONObject(body).put("ok", true)
        } finally {
            conn.disconnect()
        }
    }

    private fun downloadFileFromHttp(urlStr: String, token: String, destFile: File, readTimeoutMs: Int): Boolean {
        val conn = (URL(urlStr).openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = 5000
            readTimeout = readTimeoutMs
            useCaches = false
            attachAuthCookieAndSaveResponseCookie(this, token)
        }
        return try {
            if (conn.responseCode !in 200..299) return false
            updateCookieFromResponse(conn)
            destFile.parentFile?.mkdirs()
            BufferedInputStream(conn.inputStream, BUFFER_SIZE).use { input ->
                FileOutputStream(destFile).use { output ->
                    val buf = ByteArray(BUFFER_SIZE)
                    var read: Int
                    while (input.read(buf).also { read = it } != -1) {
                        output.write(buf, 0, read)
                    }
                    output.flush()
                    output.fd.sync()
                }
            }
            destFile.exists() && destFile.length() > 100L
        } catch (e: Exception) {
            Log.w(TAG, "ファイルダウンロード失敗: $urlStr", e)
            false
        } finally {
            conn.disconnect()
        }
    }

    /**
     * 母艦から取得した ui_revision を現在UIと比較し、更新があれば tetheract_ui_bundle.zip を取得・展開する
     */
    fun syncAndApplyWifiUiBundleIfNeeded(
        serverUrl: String,
        token: String,
        remoteRev: String,
        remoteMtime: Long,
        remoteVer: String,
        triggerReload: Boolean = false
    ): Boolean {
        val updater = usbOfflineUpdater ?: return false
        val cleanRev = remoteRev.trim()
        val cleanUrl = serverUrl.trim().trimEnd('/')
        if (cleanUrl.isEmpty() || token.isEmpty() || !updater.needsWifiUiUpdate(cleanRev)) {
            return false
        }
        synchronized(uiDownloadLock) {
            if (!updater.needsWifiUiUpdate(cleanRev)) return false
            val tmpZip = File(context.cacheDir, "tetheract_ui_bundle.wifi.tmp")
            return try {
                val encTok = URLEncoder.encode(token, "UTF-8")
                val bundleUrl = "$cleanUrl/api/mobile/ui-bundle?t=$encTok"
                if (downloadFileFromHttp(bundleUrl, token, tmpZip, readTimeoutMs = 20000)) {
                    updater.applyUiBundleFromZipFile(
                        tmpZip,
                        cleanRev,
                        remoteMtime,
                        remoteVer,
                        triggerReload = triggerReload
                    )
                } else {
                    false
                }
            } catch (e: Exception) {
                Log.w(TAG, "Wi-Fi UIバンドル取得・適用失敗", e)
                false
            } finally {
                if (tmpZip.exists()) tmpZip.delete()
            }
        }
    }

    /**
     * キャッシュ済みの母艦 UI リビジョンに基づき、必要時のみ Wi-Fi 経由で UI バンドルを適用する
     */
    fun checkAndApplyRemoteUiUpdateIfNeeded(triggerReload: Boolean = false): JSONObject {
        val serverUrl = getConfiguredServerUrl().trimEnd('/')
        val token = getConfiguredToken()
        val rev = remoteUiRevision
        val ver = remoteUiVersion
        val mtime = remoteUiMtime
        if (serverUrl.isEmpty() || token.isEmpty() || rev.isEmpty()) {
            return JSONObject().put("ok", true).put("uiBundleApplied", false)
        }
        val applied = syncAndApplyWifiUiBundleIfNeeded(
            serverUrl, token, rev, mtime, ver, triggerReload = triggerReload
        )
        return JSONObject()
            .put("ok", true)
            .put("uiBundleApplied", applied)
            .put("uiRevision", rev)
            .put("uiVersion", ver)
    }

    /** 母艦のネイティブ変更により APK 本体の再インストールが必要かつ配信可能か判定する */
    fun isNativeApkUpdateAvailable(): Boolean {
        val updater = usbOfflineUpdater ?: return false
        return isPcOnline && remoteApkAvailable && updater.needsNativeApkUpdate(remoteNativeRevision)
    }

    /** 母艦から最新 Android APK をダウンロードするための認証付きURLを返す */
    fun getRemoteApkDownloadUrl(): String {
        val url = getConfiguredServerUrl().trimEnd('/')
        val tok = getConfiguredToken()
        if (url.isEmpty() || tok.isEmpty()) return ""
        return "$url/api/mobile/apk?t=${URLEncoder.encode(tok, "UTF-8")}"
    }

    /** 設定済みPC母艦のライブ接続状態（ドライブ/写真ごとのオンライン状態）を取得してキャッシュする */
    fun refreshPcConnectionStatus(
        serverUrl: String = getConfiguredServerUrl().trimEnd('/'),
        token: String = getConfiguredToken(),
    ): Boolean {
        val cleanUrl = serverUrl.trim().trimEnd('/')
        if (cleanUrl.isEmpty()) {
            clearPcLinkState()
            return false
        }
        var conn: HttpURLConnection? = null
        return try {
            val qTok = if (token.isNotEmpty()) "?t=${URLEncoder.encode(token, "UTF-8")}" else ""
            conn = (URL("$cleanUrl/api/mobile/connection-status$qTok").openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"; connectTimeout = 1000; readTimeout = 2000; useCaches = false
                attachAuthCookieAndSaveResponseCookie(this, token)
            }
            val code = conn.responseCode
            if (code in 200..299) {
                val body = conn.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
                val json = JSONObject(body)
                pcConnStatusJson = body
                pcConnRevision = json.optString("revision", "")
                remoteUiRevision = json.optString("ui_revision", "").trim()
                remoteUiVersion = json.optString("ui_version", "").trim()
                remoteUiMtime = json.optLong("ui_mtime", 0L)
                remoteNativeRevision = json.optString("native_revision", "").trim()
                remoteApkAvailable = json.optBoolean("apk_available", false)
                isPcOnline = true
                return true
            }
            if (code == 404) {
                // 旧バージョン母艦との後方互換: /api/version で疎通のみ判定
                conn.disconnect()
                conn = (URL("$cleanUrl/api/version$qTok").openConnection() as HttpURLConnection).apply {
                    requestMethod = "GET"; connectTimeout = 900; readTimeout = 1200; useCaches = false
                    attachAuthCookieAndSaveResponseCookie(this, token)
                }
                val ok = conn.responseCode in 200..299
                if (ok) {
                    isPcOnline = true
                } else {
                    clearPcLinkState()
                }
                return ok
            }
            clearPcLinkState()
            false
        } catch (_: Exception) {
            clearPcLinkState()
            false
        } finally {
            try { conn?.disconnect() } catch (_: Exception) {}
        }
    }

    /** 設定済みPC母艦への軽量疎通確認を行い、ライブ接続状況と isPcOnline をリアルタイム更新する */
    fun probePcLinkOnline(): Boolean = refreshPcConnectionStatus()

    /** ペアリング済みPCの /api/photo/{id}/view から実ファイルストリームを取得する */
    fun openLanFullPhotoStream(photoId: Long): Pair<String, java.io.InputStream>? {
        val serverUrl = getConfiguredServerUrl()
        val token = getConfiguredToken()
        if (serverUrl.isEmpty() || token.isEmpty() || photoId <= 0L) return null
        return try {
            val encToken = java.net.URLEncoder.encode(token, "UTF-8")
            val conn = (URL("$serverUrl/api/photo/$photoId/view?t=$encToken").openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"; connectTimeout = 1200; readTimeout = 8000; useCaches = true
                attachAuthCookieAndSaveResponseCookie(this, token)
            }
            if (conn.responseCode !in 200..299) {
                conn.disconnect()
                return null
            }
            isPcOnline = true
            if (conn.getHeaderField("X-Photo-Offline")?.equals("true", ignoreCase = true) == true) {
                conn.disconnect()
                return null
            }
            val mime = (conn.contentType ?: "image/jpeg").substringBefore(';').trim().ifEmpty { "image/jpeg" }
            Pair(mime, conn.inputStream)
        } catch (_: Exception) {
            isPcOnline = false
            null
        }
    }

    private fun validateSqliteHeader(file: File): Boolean {
        if (!file.exists() || file.length() < SQLITE_MAGIC.size) return false
        return try {
            val header = ByteArray(SQLITE_MAGIC.size)
            FileInputStream(file).use { fis ->
                val r = fis.read(header)
                r == SQLITE_MAGIC.size && header.contentEquals(SQLITE_MAGIC)
            }
        } catch (_: Exception) {
            false
        }
    }
}
