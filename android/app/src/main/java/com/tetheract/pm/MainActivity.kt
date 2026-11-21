package com.tetheract.pm

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.usb.UsbManager
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.service.quicksettings.TileService
import android.text.InputType
import android.util.Log
import android.view.ViewGroup
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.window.OnBackInvokedCallback
import android.window.OnBackInvokedDispatcher
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.FileInputStream
import java.util.concurrent.Executors

/**
 * Tetheract Photo Manager Android ネイティブシェルのメインアクティビティ。
 * - WebView コンテナ上にフロントエンド資産を表示
 * - shouldInterceptRequest により SQLite の WebP サムネイル BLOB と SAF 実画像をゼロコピーストリーム供給
 * - QRコード（tetheract://pair）によるローカルWi-Fiロッカー同期およびUSB自動差分同期を実行
 */
class MainActivity : Activity() {

    companion object {
        private const val TAG = "MainActivity"
        private const val REQ_CODE_OPEN_USB_TREE = 1001
        private const val REQ_CODE_FILE_CHOOSER = 1002
        private const val REQ_CODE_FIELD_LOG_PERMS = 1003
        private const val REQ_CODE_OPEN_PHONE_FOLDER_TREE = 1004
        private const val REQ_CODE_MEDIA_LOCATION_PERMS = 1005
        private const val APP_HOST = "appassets.tetheract.local"
        private const val START_URL = "https://appassets.tetheract.local/app/mobile.html"
    }

    private lateinit var webView: WebView
    private lateinit var lockerDbManager: LockerDatabaseManager
    private lateinit var safUsbManager: SafUsbManager
    private lateinit var wifiSyncManager: WifiLockerSyncManager
    private lateinit var usbOfflineUpdater: UsbOfflineUpdater
    private lateinit var phoneCaseManager: PhoneCaseManager
    private lateinit var nativeBridge: TetheractNativeBridge

    private var filePathCallback: ValueCallback<Array<Uri>>? = null
    private val bgExecutor = Executors.newSingleThreadExecutor()
    private val wifiSyncInProgress = java.util.concurrent.atomic.AtomicBoolean(false)
    private val keepScreenOnCount = java.util.concurrent.atomic.AtomicInteger(0)
    private var lastBackDispatchMs: Long = 0L
    private var lastRootBackPressMs: Long = 0L
    private var backInvokedCallback: OnBackInvokedCallback? = null
    private var usbAttachReceiver: BroadcastReceiver? = null
    private val usbAutoSyncRunning = java.util.concurrent.atomic.AtomicBoolean(false)

    @Volatile private var webPageLoaded: Boolean = false
    @Volatile private var pendingOpenFieldLog: Boolean = false
    @Volatile private var isActivityResumed: Boolean = false
    @Volatile private var lastNotifiedPcOnline: Boolean? = null
    @Volatile private var lastNotifiedUsbConn: Boolean? = null
    @Volatile private var lastNotifiedPcConnRev: String = ""
    @Volatile private var lastNotifiedUsbVsn: String = ""
    @Volatile private var suppressAutoScanUntilMs: Long = 0L
    @Volatile private var pendingPostReloadToast: String? = null
    private val wifiUiUpdateInProgress = java.util.concurrent.atomic.AtomicBoolean(false)
    @Volatile private var lastFailedWifiUiRevision: String = ""
    @Volatile private var lastNotifiedNativeRevision: String = ""
    private val linkWatchExecutor = Executors.newSingleThreadScheduledExecutor()

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (resources.configuration.smallestScreenWidthDp < 600) {
            requestedOrientation = android.content.pm.ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
        }

        try {
            lockerDbManager = LockerDatabaseManager(applicationContext)
            safUsbManager = SafUsbManager(applicationContext, lockerDbManager)
            usbOfflineUpdater = UsbOfflineUpdater(applicationContext, safUsbManager) {
                runOnUiThread { if (::webView.isInitialized) { webPageLoaded = false; webView.reload() } }
            }
            wifiSyncManager = WifiLockerSyncManager(applicationContext, lockerDbManager, usbOfflineUpdater)
            phoneCaseManager = PhoneCaseManager(applicationContext, lockerDbManager, wifiSyncManager)
            nativeBridge = TetheractNativeBridge(
                context = applicationContext,
                lockerDbManager = lockerDbManager,
                safUsbManager = safUsbManager,
                wifiSyncManager = wifiSyncManager,
                usbOfflineUpdater = usbOfflineUpdater,
                phoneCaseManager = phoneCaseManager,
                onLaunchUsbFolderPicker = { launchSafUsbFolderPicker(REQ_CODE_OPEN_USB_TREE) },
                onTriggerWifiSyncAsync = { forceFull, delayMs -> runWifiSyncInBackground(forceFull, initialDelayMs = delayMs) },
                onStartFieldLogFromUi = { startOrRequestFieldLogFromUi() },
                onTriggerUsbSyncAsync = { bgExecutor.execute { handleConnectedUsbAutoSync() } },
                onLaunchPhoneFolderPicker = { launchSafUsbFolderPicker(REQ_CODE_OPEN_PHONE_FOLDER_TREE) },
                onLaunchCamera = { launchExternalCameraApp() },
                onEvalJs = { js -> runOnUiThread { if (::webView.isInitialized) webView.evaluateJavascript(js, null) } },
                onKeepScreenOn = { keep -> updateKeepScreenOn(keep) }
            )
            FieldLogService.setStatusListener { statusJson -> notifyWebViewFieldLogChanged(statusJson) }
            if (isOpenFieldLogIntent(intent)) pendingOpenFieldLog = true

            webView = WebView(this).apply {
                layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
                fitsSystemWindows = true
                setBackgroundColor(Color.parseColor("#16181b"))
                settings.apply {
                    javaScriptEnabled = true
                    domStorageEnabled = true
                    databaseEnabled = true
                    allowFileAccess = false
                    allowContentAccess = true
                    mediaPlaybackRequiresUserGesture = false
                    cacheMode = WebSettings.LOAD_DEFAULT
                    mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
                }
                webChromeClient = object : WebChromeClient() {
                    override fun onJsAlert(
                        view: WebView?,
                        url: String?,
                        message: String?,
                        result: android.webkit.JsResult?
                    ): Boolean {
                        val safeMsg = message ?: ""
                        Log.w(TAG, "WebView onJsAlert フォールバック通知: $safeMsg")
                        result?.confirm()
                        if (safeMsg.isNotEmpty() && view != null) {
                            val esc = JSONObject.quote(safeMsg)
                            view.post {
                                view.evaluateJavascript(
                                    "(function(m){var t=document.getElementById('mToast');if(t){t.textContent=m;t.style.display='block';setTimeout(function(){t.style.display='none';},4000);}})(${esc});",
                                    null
                                )
                            }
                        }
                        return true
                    }

                    override fun onShowFileChooser(
                        webView: WebView?,
                        filePathCallback: ValueCallback<Array<Uri>>?,
                        fileChooserParams: FileChooserParams?
                    ): Boolean {
                        this@MainActivity.filePathCallback?.onReceiveValue(null)
                        this@MainActivity.filePathCallback = filePathCallback
                        return try {
                            val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                                addCategory(Intent.CATEGORY_OPENABLE)
                                type = "*/*"
                            }
                            startActivityForResult(intent, REQ_CODE_FILE_CHOOSER)
                            true
                        } catch (e: Exception) {
                            this@MainActivity.filePathCallback = null
                            false
                        }
                    }
                }
                webViewClient = createInterceptingWebViewClient()
                setDownloadListener { url, _, _, _, _ ->
                    if (!url.isNullOrBlank() && (url.startsWith("http://", ignoreCase = true) || url.startsWith("https://", ignoreCase = true))) {
                        try {
                            val dlIntent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).apply {
                                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                            }
                            startActivity(dlIntent)
                        } catch (e: Exception) {
                            Log.w(TAG, "WebView ダウンロード起動失敗: $url", e)
                        }
                    }
                }
                addJavascriptInterface(nativeBridge, "TetheractNative")
            }

            setContentView(webView)
            registerGestureBackHandler()
            registerUsbAttachReceiver()
            startLinkStateWatcher()
            ensureMediaLocationPermissionIfNeeded()
            webPageLoaded = false
            webView.loadUrl(START_URL)

            val handledDeepLink = handleIncomingPairingIntent(intent)
            if (!handledDeepLink) {
                bgExecutor.execute {
                    try {
                        if (safUsbManager.isUsbConnected()) handleConnectedUsbAutoSync()
                        autoScanLinkedPhoneFoldersIfNeeded(forceNotify = !lockerDbManager.hasLockerDatabase())
                        val disc = wifiSyncManager.discoverPcOnLan(requestPair = false)
                        notifyWebViewPcDiscovered(disc)
                        notifyWebViewLinkStateChanged(force = true)
                        triggerWifiUiAutoUpdateIfNeeded()
                    } catch (e: Exception) {
                        Log.w(TAG, "起動時自動チェック警告", e)
                    }
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "MainActivity 初期化エラー", e)
        }
    }

    override fun onResume() {
        super.onResume()
        isActivityResumed = true
        bgExecutor.execute {
            try {
                if (::wifiSyncManager.isInitialized) wifiSyncManager.probePcLinkOnline()
                notifyWebViewLinkStateChanged(force = true)
                triggerWifiUiAutoUpdateIfNeeded()
                autoScanLinkedPhoneFoldersIfNeeded(forceNotify = false)
            } catch (e: Exception) {
                Log.w(TAG, "onResume 自動チェック警告", e)
            }
        }
    }

    override fun onPause() {
        isActivityResumed = false
        super.onPause()
    }

    private fun updateKeepScreenOn(keep: Boolean) {
        if (keep) {
            keepScreenOnCount.incrementAndGet()
        } else {
            while (true) {
                val cur = keepScreenOnCount.get()
                val next = if (cur > 0) cur - 1 else 0
                if (keepScreenOnCount.compareAndSet(cur, next)) break
            }
        }
        runOnUiThread {
            if (isFinishing || isDestroyed) return@runOnUiThread
            if (keepScreenOnCount.get() > 0) {
                window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            } else {
                window.clearFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            }
        }
    }

    private fun startLinkStateWatcher() {
        linkWatchExecutor.scheduleWithFixedDelay({
            try {
                if (!isActivityResumed || wifiSyncInProgress.get() || (::phoneCaseManager.isInitialized && phoneCaseManager.isTransferRunning())) return@scheduleWithFixedDelay
                if (::wifiSyncManager.isInitialized) wifiSyncManager.probePcLinkOnline()
                notifyWebViewLinkStateChanged(force = false)
                triggerWifiUiAutoUpdateIfNeeded()
            } catch (_: Exception) {}
        }, 6L, 6L, java.util.concurrent.TimeUnit.SECONDS)
    }

    private fun triggerWifiUiAutoUpdateIfNeeded() {
        if (!::wifiSyncManager.isInitialized || !::usbOfflineUpdater.isInitialized) return
        if (wifiSyncInProgress.get() || (::phoneCaseManager.isInitialized && phoneCaseManager.isTransferRunning())) return
        val rev = wifiSyncManager.remoteUiRevision
        if (wifiSyncManager.isPcOnline && !wifiSyncManager.isNativeApkUpdateAvailable() && rev.isNotEmpty() && rev != lastFailedWifiUiRevision && usbOfflineUpdater.needsWifiUiUpdate(rev)) {
            if (wifiUiUpdateInProgress.compareAndSet(false, true)) {
                try {
                    val res = wifiSyncManager.checkAndApplyRemoteUiUpdateIfNeeded(triggerReload = false)
                    if (res.optBoolean("uiBundleApplied", false)) {
                        lastFailedWifiUiRevision = ""
                        val ver = res.optString("uiVersion", "").let { if (it.isNotEmpty()) " (v$it)" else "" }
                        pendingPostReloadToast = "✓ 母艦とリンクし、最新UI$ver へ自動アップデートしました"
                        runOnUiThread {
                            if (!isFinishing && !isDestroyed && ::webView.isInitialized) {
                                webPageLoaded = false
                                webView.reload()
                            }
                        }
                        return
                    } else {
                        lastFailedWifiUiRevision = rev
                    }
                } catch (e: Exception) {
                    lastFailedWifiUiRevision = rev
                    Log.w(TAG, "Wi-Fiリンク自動UIアップデート警告", e)
                } finally {
                    wifiUiUpdateInProgress.set(false)
                }
            }
        }
        notifyNativeApkUpdateIfNeeded()
    }

    private fun notifyNativeApkUpdateIfNeeded() {
        if (!::wifiSyncManager.isInitialized || !wifiSyncManager.isNativeApkUpdateAvailable()) return
        val rev = wifiSyncManager.remoteNativeRevision
        if (rev.isEmpty() || rev == lastNotifiedNativeRevision) return
        runOnUiThread {
            if (!isFinishing && !isDestroyed && ::webView.isInitialized && webPageLoaded) {
                lastNotifiedNativeRevision = rev
                val payload = JSONObject()
                    .put("nativeRevision", rev)
                    .put("uiVersion", wifiSyncManager.remoteUiVersion)
                    .put("apkDownloadUrl", wifiSyncManager.getRemoteApkDownloadUrl())
                    .toString()
                webView.evaluateJavascript(
                    "if(window.__onTetheractNativeApkUpdateRequired){window.__onTetheractNativeApkUpdateRequired($payload);}",
                    null
                )
            }
        }
    }

    private fun notifyWebViewLinkStateChanged(force: Boolean = false) {
        val pcOn = if (::wifiSyncManager.isInitialized) wifiSyncManager.isPcOnline else false
        val usbConn = if (::safUsbManager.isInitialized) safUsbManager.isUsbConnected() else false
        val pcConnRev = if (::wifiSyncManager.isInitialized) wifiSyncManager.pcConnRevision else ""
        val usbVsn = if (::safUsbManager.isInitialized) safUsbManager.getMountedUsbVsnCached() else ""
        if (!force && lastNotifiedPcOnline == pcOn && lastNotifiedUsbConn == usbConn && lastNotifiedPcConnRev == pcConnRev && lastNotifiedUsbVsn == usbVsn) return
        lastNotifiedPcOnline = pcOn
        lastNotifiedUsbConn = usbConn
        lastNotifiedPcConnRev = pcConnRev
        lastNotifiedUsbVsn = usbVsn
        val safeRev = pcConnRev.replace(Regex("[^a-zA-Z0-9_-]"), "")
        val safeVsn = usbVsn.replace(Regex("[^a-zA-Z0-9_-]"), "")
        runOnUiThread {
            if (::webView.isInitialized && webPageLoaded) {
                webView.evaluateJavascript("if(window.__onTetheractLinkStateChanged){window.__onTetheractLinkStateChanged({pcOnline:$pcOn,usbConnected:$usbConn,pcConnRevision:'$safeRev',usbVsn:'$safeVsn'});}", null)
            }
        }
    }

    private fun autoScanLinkedPhoneFoldersIfNeeded(forceNotify: Boolean = false) {
        if (!::phoneCaseManager.isInitialized || !phoneCaseManager.hasLinkedFolders() || phoneCaseManager.isTransferRunning()) return
        if (android.os.SystemClock.elapsedRealtime() < suppressAutoScanUntilMs) return
        val res = JSONObject(phoneCaseManager.scanFolderPhotosJson("all", includeItems = false, allowLiveReconcile = false, minFreshMs = 15_000L))
        if (forceNotify || res.optBoolean("catalogChanged", false)) {
            runOnUiThread { if (::webView.isInitialized) webView.evaluateJavascript("if(window.__onTetheractPhoneCatalogSynced){window.__onTetheractPhoneCatalogSynced();}", null) }
        }
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (isOpenFieldLogIntent(intent)) {
            if (webPageLoaded && ::webView.isInitialized) dispatchOpenFieldLogToWebView() else pendingOpenFieldLog = true
        }
        handleIncomingPairingIntent(intent)
    }

    private fun isOpenFieldLogIntent(incoming: Intent?): Boolean {
        val action = incoming?.action ?: return false
        return action == FieldLogService.ACTION_OPEN_FIELD_LOG || action == TileService.ACTION_QS_TILE_PREFERENCES
    }

    private fun dispatchOpenFieldLogToWebView() {
        runOnUiThread { if (::webView.isInitialized) webView.evaluateJavascript("if(window.__onTetheractOpenFieldLog){window.__onTetheractOpenFieldLog();}", null) }
    }

    private fun notifyWebViewFieldLogChanged(statusJson: JSONObject) {
        val jsonEscaped = JSONObject.quote(statusJson.toString())
        runOnUiThread { if (::webView.isInitialized) webView.evaluateJavascript("if(window.__onTetheractFieldLogChanged){window.__onTetheractFieldLogChanged(JSON.parse($jsonEscaped));}", null) }
    }

    private fun ensureMediaLocationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return
        val needed = mutableListOf<String>()
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_MEDIA_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            needed.add(Manifest.permission.ACCESS_MEDIA_LOCATION)
        }
        val storagePerm = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) Manifest.permission.READ_MEDIA_IMAGES else Manifest.permission.READ_EXTERNAL_STORAGE
        if (ContextCompat.checkSelfPermission(this, storagePerm) != PackageManager.PERMISSION_GRANTED) {
            needed.add(storagePerm)
        }
        if (needed.isNotEmpty()) {
            runOnUiThread { try { requestPermissions(needed.toTypedArray(), REQ_CODE_MEDIA_LOCATION_PERMS) } catch (_: Exception) {} }
        }
    }

    private fun startOrRequestFieldLogFromUi(): JSONObject {
        val hasFineLocation = ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
        if (hasFineLocation) {
            FieldLogService.clearInterruptedFlag(applicationContext)
            val serviceIntent = Intent(applicationContext, FieldLogService::class.java).apply { action = FieldLogService.ACTION_START }
            ContextCompat.startForegroundService(applicationContext, serviceIntent)
            return JSONObject().put("ok", true).put("status", "started")
        }

        val permissionsToRequest = mutableListOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                permissionsToRequest.add(Manifest.permission.POST_NOTIFICATIONS)
            }
        }
        runOnUiThread {
            try { requestPermissions(permissionsToRequest.toTypedArray(), REQ_CODE_FIELD_LOG_PERMS) } catch (e: Exception) { Log.e(TAG, "権限要求エラー", e) }
        }
        return JSONObject().put("ok", true).put("status", "permission_requested")
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQ_CODE_MEDIA_LOCATION_PERMS) {
            bgExecutor.execute { try { autoScanLinkedPhoneFoldersIfNeeded(forceNotify = true) } catch (_: Exception) {} }
            return
        }
        if (requestCode != REQ_CODE_FIELD_LOG_PERMS) return
        val hasFineLocation = ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
        if (hasFineLocation) {
            FieldLogService.clearInterruptedFlag(this)
            val serviceIntent = Intent(this, FieldLogService::class.java).apply { action = FieldLogService.ACTION_START }
            try { ContextCompat.startForegroundService(this, serviceIntent) } catch (e: Exception) { Log.e(TAG, "FieldLogService起動失敗", e) }
        }
        FieldLogService.notifyStatusChanged(this)
    }

    /**
     * QRコードページからの tetheract://pair?server=...&token=... ディープリンクを受け取り、
     * 接続先を保存して即座にWi-Fi双方向ロッカー同期を実行する
     */
    private fun handleIncomingPairingIntent(incoming: Intent?): Boolean {
        val data = incoming?.data ?: return false
        if (!data.scheme.equals("tetheract", ignoreCase = true)) return false
        val pairRes = wifiSyncManager.savePairingFromInput(data.toString())
        if (pairRes.optBoolean("ok", false)) {
            runWifiSyncInBackground(forceFull = false, initialDelayMs = 450L)
            return true
        }
        return false
    }

    private fun runWifiSyncInBackground(forceFull: Boolean, initialDelayMs: Long = 0L, allowLibrarySwitch: Boolean = false) {
        if (!wifiSyncInProgress.compareAndSet(false, true)) return
        bgExecutor.execute {
            try {
                if (initialDelayMs > 0L) Thread.sleep(initialDelayMs)
                if (::phoneCaseManager.isInitialized && phoneCaseManager.isTransferRunning()) return@execute
                notifyWebViewWifiSyncProgress(wifiSyncManager.getConfiguredServerUrl(), "", "")
                val syncRes = wifiSyncManager.syncWithPcOverWifi(
                    forceFull = forceFull,
                    allowLibrarySwitch = allowLibrarySwitch,
                    onStatusProgress = { title, sub -> notifyWebViewWifiSyncProgress(wifiSyncManager.getConfiguredServerUrl(), title, sub) }
                )
                if (syncRes.optString("reason") == "library_mismatch") {
                    notifyWebViewUsbSyncCompleted(JSONObject().put("ok", false).put("cancelled", true))
                    promptLibrarySwitchConfirmation(syncRes)
                    return@execute
                }
                if (syncRes.optBoolean("ok", false)) {
                    autoScanLinkedPhoneFoldersIfNeeded(forceNotify = false)
                    syncRes.put("dbPhotoCount", lockerDbManager.getPhotoCount())
                }
                notifyWebViewLinkStateChanged(force = true)
                if (syncRes.optBoolean("uiBundleApplied", false)) {
                    lastFailedWifiUiRevision = ""
                    val ver = syncRes.optString("uiVersion", "").let { if (it.isNotEmpty()) " (v$it)" else "" }
                    pendingPostReloadToast = "✓ 母艦と同期し、最新UI$ver へアップデートしました"
                    runOnUiThread {
                        if (!isFinishing && !isDestroyed && ::webView.isInitialized) {
                            webPageLoaded = false
                            webView.reload()
                        }
                    }
                } else {
                    notifyWebViewUsbSyncCompleted(syncRes)
                    notifyNativeApkUpdateIfNeeded()
                }
            } catch (e: Exception) {
                Log.e(TAG, "Wi-Fiバックグラウンド同期エラー", e)
                notifyWebViewLinkStateChanged(force = true)
                notifyWebViewUsbSyncCompleted(
                    JSONObject().put("ok", false).put("syncMode", "wifi_error").put("error", e.message ?: "Wi-Fi同期中にエラーが発生しました")
                )
            } finally {
                wifiSyncInProgress.set(false)
            }
        }
    }

    private fun notifyWebViewWifiSyncProgress(serverUrl: String, customTitle: String = "", customSub: String = "") {
        val escUrl = JSONObject.quote(serverUrl)
        val escTitle = JSONObject.quote(customTitle)
        val escSub = JSONObject.quote(customSub)
        runOnUiThread {
            if (::webView.isInitialized) {
                webView.evaluateJavascript("if(window.__onTetheractWifiSyncStarted){window.__onTetheractWifiSyncStarted($escUrl,$escTitle,$escSub);}", null)
            }
        }
    }

    private fun notifyWebViewPcDiscovered(discJson: JSONObject) {
        val payload = discJson.toString()
        runOnUiThread {
            if (::webView.isInitialized) {
                webView.evaluateJavascript("if(window.__onTetheractPcDiscovered){window.__onTetheractPcDiscovered($payload);}", null)
            }
        }
    }

    /**
     * WebView のリクエストをインターセプトし、サムネイル・原本（スマホ内/USB/Wi-Fi）・静的アセットをストリーム返却する
     */
    private fun createInterceptingWebViewClient(): WebViewClient {
        return object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest?): WebResourceResponse? {
                val url = request?.url ?: return null
                if (!url.host.equals(APP_HOST, ignoreCase = true)) return super.shouldInterceptRequest(view, request)
                val path = url.path ?: "/"
                return when {
                    path.startsWith("/thumb/") -> serveThumbnailBlob(path.removePrefix("/thumb/"))
                    path.startsWith("/watermark/") -> serveWatermarkBlob(path.removePrefix("/watermark/"))
                    path.startsWith("/usb_photo/") -> serveUsbFullPhoto(path.removePrefix("/usb_photo/"), url.getQueryParameter("only_hd") == "1")
                    path.startsWith("/phone_photo/") -> servePhonePhoto(path.removePrefix("/phone_photo/"), url.getQueryParameter("thumb") == "1")
                    path.startsWith("/app/") -> serveAppAsset(path.removePrefix("/app/"))
                    else -> serveAppAsset(path.trimStart('/'))
                }
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                if (url != null && url.contains(APP_HOST, ignoreCase = true)) {
                    webPageLoaded = true
                    notifyWebViewLinkStateChanged(force = true)
                    if (pendingOpenFieldLog) {
                        pendingOpenFieldLog = false
                        dispatchOpenFieldLogToWebView()
                    }
                    val toastMsg = pendingPostReloadToast
                    if (!toastMsg.isNullOrEmpty()) {
                        pendingPostReloadToast = null
                        val escMsg = JSONObject.quote(toastMsg)
                        view?.postDelayed({
                            if (!isFinishing && !isDestroyed && ::webView.isInitialized) {
                                webView.evaluateJavascript(
                                    "if(window.__showTetheractToast){window.__showTetheractToast($escMsg,4500);}",
                                    null
                                )
                            }
                        }, 500L)
                        view?.postDelayed({
                            if (!isFinishing && !isDestroyed && ::webView.isInitialized) {
                                notifyNativeApkUpdateIfNeeded()
                            }
                        }, 5200L)
                    } else {
                        view?.postDelayed({
                            if (!isFinishing && !isDestroyed && ::webView.isInitialized) {
                                notifyNativeApkUpdateIfNeeded()
                            }
                        }, 600L)
                    }
                }
            }
        }
    }

    private fun serveWatermarkBlob(idSegment: String): WebResourceResponse {
        val assetId = idSegment.substringBefore('?').substringBefore('/').trim()
        val hit = lockerDbManager.watermarkStore.getAssetBlob(assetId)
        if (hit != null) {
            return WebResourceResponse(
                hit.first, null, 200, "OK",
                mapOf("Access-Control-Allow-Origin" to "*", "Cache-Control" to "public, max-age=86400"),
                ByteArrayInputStream(hit.second)
            )
        }
        return WebResourceResponse(
            "text/plain", "utf-8", 404, "Not Found",
            mapOf("Access-Control-Allow-Origin" to "*"),
            ByteArrayInputStream(ByteArray(0))
        )
    }

    private fun serveThumbnailBlob(idSegment: String): WebResourceResponse {
        val photoId = idSegment.substringBefore('?').trim().toLongOrNull()
        if (photoId != null && photoId > 0L) {
            val blob = lockerDbManager.getThumbnailBlob(photoId)
            if (blob != null && blob.isNotEmpty()) {
                val isJpeg = blob.size >= 3 && blob[0] == 0xFF.toByte() && blob[1] == 0xD8.toByte()
                val mime = if (isJpeg) "image/jpeg" else "image/webp"
                return WebResourceResponse(
                    mime, null, 200, "OK",
                    mapOf("Access-Control-Allow-Origin" to "*", "Cache-Control" to "public, max-age=31536000, immutable"),
                    ByteArrayInputStream(blob)
                )
            }
            if (::phoneCaseManager.isInitialized) {
                val phoneThumb = phoneCaseManager.openPhonePhotoByPhotoId(photoId, isThumb = true)
                if (phoneThumb != null) {
                    return WebResourceResponse(
                        phoneThumb.first, null, 200, "OK",
                        mapOf("Access-Control-Allow-Origin" to "*", "Cache-Control" to "private, max-age=3600"),
                        phoneThumb.second
                    )
                }
            }
        }
        return WebResourceResponse("text/plain", "UTF-8", 404, "Not Found", emptyMap(), ByteArrayInputStream(ByteArray(0)))
    }

    private fun serveUsbFullPhoto(idSegment: String, onlyHd: Boolean = false): WebResourceResponse {
        val photoId = idSegment.substringBefore('?').trim().toLongOrNull()
        if (photoId != null && photoId > 0L) {
            if (::phoneCaseManager.isInitialized) {
                val phonePair = phoneCaseManager.openPhonePhotoByPhotoId(photoId, isThumb = false)
                if (phonePair != null) {
                    if (::nativeBridge.isInitialized) nativeBridge.recordPhotoSource(photoId, "phone")
                    return WebResourceResponse(
                        phonePair.first, null, 200, "OK",
                        mapOf("Access-Control-Allow-Origin" to "*", "Cache-Control" to "private, max-age=300", "X-Tetheract-Source" to "phone"),
                        phonePair.second
                    )
                }
            }
            val usbStreamPair = safUsbManager.openUsbPhotoStream(photoId)
            if (usbStreamPair != null) {
                if (::nativeBridge.isInitialized) nativeBridge.recordPhotoSource(photoId, "usb")
                return WebResourceResponse(
                    usbStreamPair.first, null, 200, "OK",
                    mapOf("Access-Control-Allow-Origin" to "*", "Cache-Control" to "private, max-age=300", "X-Tetheract-Source" to "usb"),
                    usbStreamPair.second
                )
            }
            val lanStreamPair = wifiSyncManager.openLanFullPhotoStream(photoId)
            notifyWebViewLinkStateChanged(force = false)
            if (lanStreamPair != null) {
                if (::nativeBridge.isInitialized) nativeBridge.recordPhotoSource(photoId, "wifi")
                return WebResourceResponse(
                    lanStreamPair.first, null, 200, "OK",
                    mapOf("Access-Control-Allow-Origin" to "*", "Cache-Control" to "private, max-age=300", "X-Tetheract-Source" to "wifi"),
                    lanStreamPair.second
                )
            }
            if (!onlyHd) return serveThumbnailBlob(idSegment)
        }
        return WebResourceResponse("text/plain", "UTF-8", 404, "Not Found", mapOf("Access-Control-Allow-Origin" to "*"), ByteArrayInputStream(ByteArray(0)))
    }

    private fun serveAppAsset(relPath: String): WebResourceResponse {
        val cleanPath = relPath.substringBefore('?').trimStart('/').ifEmpty { "mobile.html" }
        val mimeType = guessAssetMimeType(cleanPath)
        val encoding = if (isTextMimeType(mimeType)) "UTF-8" else null
        val headers = mapOf("Access-Control-Allow-Origin" to "*", "Cache-Control" to "no-cache")

        val hotFile = usbOfflineUpdater.resolveHotUpdatedAsset(cleanPath)
        if (hotFile != null) {
            return try {
                WebResourceResponse(mimeType, encoding, 200, "OK", headers, FileInputStream(hotFile))
            } catch (e: Exception) {
                Log.w(TAG, "ホットアップデートファイル読込失敗: $cleanPath", e)
                WebResourceResponse("text/plain", "UTF-8", 500, "Error", headers, ByteArrayInputStream(ByteArray(0)))
            }
        }

        return try {
            WebResourceResponse(mimeType, encoding, 200, "OK", headers, assets.open(cleanPath))
        } catch (e: Exception) {
            WebResourceResponse("text/plain", "UTF-8", 404, "Not Found", headers, ByteArrayInputStream(ByteArray(0)))
        }
    }

    private fun servePhonePhoto(docKeySegment: String, isThumb: Boolean): WebResourceResponse {
        val docKey = docKeySegment.substringBefore('?').trim()
        val pair = if (docKey.isNotEmpty() && ::phoneCaseManager.isInitialized) phoneCaseManager.openPhonePhotoStream(docKey, isThumb) else null
        if (pair != null) {
            return WebResourceResponse(pair.first, null, 200, "OK", mapOf("Access-Control-Allow-Origin" to "*", "Cache-Control" to "private, max-age=600"), pair.second)
        }
        return WebResourceResponse("text/plain", "UTF-8", 404, "Not Found", mapOf("Access-Control-Allow-Origin" to "*"), ByteArrayInputStream(ByteArray(0)))
    }

    private fun launchSafUsbFolderPicker(reqCode: Int = REQ_CODE_OPEN_USB_TREE) {
        runOnUiThread {
            try {
                val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION or Intent.FLAG_GRANT_PREFIX_URI_PERMISSION)
                }
                startActivityForResult(intent, reqCode)
            } catch (e: Exception) {
                Log.e(TAG, "SAF ピッカー起動失敗", e)
                if (reqCode == REQ_CODE_OPEN_USB_TREE) {
                    notifyWebViewUsbSyncCompleted(JSONObject().put("ok", false).put("error", e.message ?: "Picker launch failed"))
                }
            }
        }
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQ_CODE_FILE_CHOOSER) {
            val results = if (resultCode == RESULT_OK && data?.data != null) arrayOf(data.data!!) else null
            filePathCallback?.onReceiveValue(results)
            filePathCallback = null
            return
        }
        if (requestCode == REQ_CODE_OPEN_PHONE_FOLDER_TREE) {
            val treeUri: Uri? = if (resultCode == RESULT_OK) data?.data else null
            if (treeUri != null) {
                suppressAutoScanUntilMs = android.os.SystemClock.elapsedRealtime() + 15_000L
                runOnUiThread { if (::webView.isInitialized) webView.evaluateJavascript("if(window.__onTetheractPhoneFolderScanStarted){window.__onTetheractPhoneFolderScanStarted();}", null) }
            }
            bgExecutor.execute {
                val res = if (treeUri != null) phoneCaseManager.onPhoneFolderTreeSelected(treeUri) else JSONObject().put("ok", false).put("cancelled", true)
                val esc = JSONObject.quote(res.toString())
                runOnUiThread { if (::webView.isInitialized) webView.evaluateJavascript("if(window.__onTetheractPhoneFolderPicked){window.__onTetheractPhoneFolderPicked(JSON.parse($esc));}", null) }
            }
            return
        }
        if (requestCode == REQ_CODE_OPEN_USB_TREE) {
            val treeUri: Uri? = if (resultCode == RESULT_OK) data?.data else null
            if (treeUri == null) {
                notifyWebViewUsbSyncCompleted(JSONObject().put("ok", false).put("cancelled", true))
                return
            }
            bgExecutor.execute {
                val mountRes = safUsbManager.onUsbTreeSelected(treeUri)
                usbOfflineUpdater.checkAndTriggerUpdate(autoApplyUi = true, triggerApkInstall = false)
                handleLoomeMountResult(mountRes)
            }
        }
    }

    private fun promptLibrarySwitchConfirmation(mismatchRes: JSONObject) {
        val curSrc = mismatchRes.optString("currentSource", "現在のロッカー")
        val tgtSrc = mismatchRes.optString("targetSource", "新しい接続先")
        val pendingCnt = mismatchRes.optInt("pendingChangeCount", 0)
        val pendingNote = if (pendingCnt > 0) "\n・未送信の評価・タグ変更: ${pendingCnt}件（破棄されます）" else ""
        val msg = "スマホ内の現在のカタログとは別のTetheractライブラリです。\n\n" +
            "・現在: $curSrc\n・切替先: $tgtSrc$pendingNote\n\n" +
            "このまま同期すると、スマホ内の現在のロッカーデータと未送信の変更はすべて破棄され、切替先のカタログに置き換わります。\n" +
            "すべて破棄して切り替えますか？\n（※元のPC本体側の写真やデータは消えません）"
        runOnUiThread {
            if (isFinishing || isDestroyed) return@runOnUiThread
            AlertDialog.Builder(this)
                .setTitle("別のライブラリへの切り替え確認")
                .setMessage(msg)
                .setNegativeButton("キャンセル") { _, _ -> wifiSyncManager.rollbackPendingSwitch() }
                .setOnCancelListener { wifiSyncManager.rollbackPendingSwitch() }
                .setPositiveButton("すべて破棄して切り替える") { _, _ ->
                    bgExecutor.execute {
                        lockerDbManager.resetLockerAndJournalForSwitch()
                        FieldLogStore.get(applicationContext).resetUploadStateForSwitch()
                        runOnUiThread { runWifiSyncInBackground(forceFull = true, allowLibrarySwitch = true) }
                    }
                }
                .show()
        }
    }

    private fun notifyWebViewUsbSyncCompleted(result: JSONObject) {
        val jsonEscaped = JSONObject.quote(result.toString())
        runOnUiThread {
            if (::webView.isInitialized) {
                webView.evaluateJavascript(
                    "(function(d){if(typeof window.__dispatchTetheractUsbSyncCompleted==='function'){window.__dispatchTetheractUsbSyncCompleted(d);}else{window.dispatchEvent(new CustomEvent('tetheract:usb-sync-completed',{detail:d}));}})(JSON.parse($jsonEscaped));",
                    null
                )
            }
        }
    }

    private fun registerUsbAttachReceiver() {
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(ctx: Context?, intent: Intent?) {
                when (intent?.action) {
                    UsbManager.ACTION_USB_DEVICE_ATTACHED -> handleUsbDeviceAttached()
                    UsbManager.ACTION_USB_DEVICE_DETACHED -> {
                        safUsbManager.onUsbDetached()
                        notifyWebViewLinkStateChanged(force = true)
                        notifyWebViewUsbSyncCompleted(JSONObject().put("ok", true).put("usbDetached", true).put("syncMode", "loome_detached"))
                    }
                }
            }
        }
        usbAttachReceiver = receiver
        val filter = IntentFilter().apply {
            addAction(UsbManager.ACTION_USB_DEVICE_ATTACHED)
            addAction(UsbManager.ACTION_USB_DEVICE_DETACHED)
        }
        ContextCompat.registerReceiver(this, receiver, filter, ContextCompat.RECEIVER_EXPORTED)
    }

    private fun handleUsbDeviceAttached() {
        if (!usbAutoSyncRunning.compareAndSet(false, true)) return
        bgExecutor.execute {
            try {
                for (waitMs in longArrayOf(1600L, 2400L)) {
                    Thread.sleep(waitMs)
                    if (safUsbManager.isUsbConnected()) {
                        handleConnectedUsbAutoSync()
                        return@execute
                    }
                }
                if (safUsbManager.getSavedUsbTreeUri() == null) {
                    runOnUiThread {
                        if (isFinishing || isDestroyed) return@runOnUiThread
                        AlertDialog.Builder(this)
                            .setTitle("USBストレージを検出")
                            .setMessage("USB内の Loome（または Tetheract）フォルダの読み取りを許可すると、以降はUSBを挿すだけで原本データを直接表示できます。今すぐフォルダを選択しますか？")
                            .setNegativeButton("あとで", null)
                            .setPositiveButton("フォルダを選択") { _, _ -> launchSafUsbFolderPicker() }
                            .show()
                    }
                }
            } catch (e: Exception) {
                Log.w(TAG, "USB接続自動検知エラー", e)
            } finally {
                usbAutoSyncRunning.set(false)
            }
        }
    }

    private fun handleConnectedUsbAutoSync() {
        val res = safUsbManager.mountConnectedLoome()
        usbOfflineUpdater.checkAndTriggerUpdate(autoApplyUi = true, triggerApkInstall = false)
        autoScanLinkedPhoneFoldersIfNeeded(forceNotify = false)
        notifyWebViewLinkStateChanged(force = true)
        handleLoomeMountResult(res)
    }

    private fun handleLoomeMountResult(res: JSONObject) {
        val reason = res.optString("reason")
        if (reason == "ethical_foreign_owner") {
            notifyWebViewUsbSyncCompleted(JSONObject().put("ok", false).put("cancelled", true))
            showEthicalBlockDialog(res.optString("error"))
        } else if (res.optBoolean("needsPassword", false)) {
            notifyWebViewUsbSyncCompleted(JSONObject().put("ok", false).put("cancelled", true))
            promptLoomePasswordDialog(res)
        } else if (reason != "usb_not_connected") {
            notifyWebViewUsbSyncCompleted(res)
        }
    }

    private fun promptLoomePasswordDialog(mountRes: JSONObject, errorNotice: String = "") {
        runOnUiThread {
            if (isFinishing || isDestroyed) return@runOnUiThread
            val input = EditText(this).apply {
                inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
                hint = "パスワードまたはリカバリーコード"
            }
            val baseMsg = "この Loome はパスワードで保護されています。原本データを閲覧するにはパスワードを入力してください（鍵はメモリ上のみに展開され、USBを抜くと自動消去されます）。"
            val fullMsg = if (errorNotice.isNotEmpty()) "$baseMsg\n\n⚠ $errorNotice" else baseMsg
            AlertDialog.Builder(this)
                .setTitle("🔒 鍵付きLoomeの解錠")
                .setMessage(fullMsg)
                .setView(input)
                .setNegativeButton("キャンセル", null)
                .setPositiveButton("解錠する") { _, _ ->
                    val pw = input.text?.toString()?.trim().orEmpty()
                    if (pw.isEmpty()) {
                        promptLoomePasswordDialog(mountRes, "パスワードまたはリカバリーコードを入力してください")
                        return@setPositiveButton
                    }
                    bgExecutor.execute {
                        val uRes = safUsbManager.unlockLoomeWithPassword(pw)
                        if (uRes.optBoolean("ok", false)) {
                            notifyWebViewUsbSyncCompleted(uRes)
                            runOnUiThread {
                                if (::webView.isInitialized) {
                                    webView.evaluateJavascript(
                                        "document.querySelectorAll('img[src*=\"/usb_photo/\"],img[src*=\"/thumb/\"]').forEach(function(i){var s=i.getAttribute('src');if(s){i.setAttribute('src',s.split('&t=')[0]+(s.indexOf('?')>=0?'&':'?')+'t='+Date.now());}});",
                                        null
                                    )
                                }
                            }
                        } else {
                            val err = uRes.optString("error", "パスワードまたはリカバリーコードが正しくありません")
                            promptLoomePasswordDialog(mountRes, err)
                        }
                    }
                }
                .show()
        }
    }

    private fun showEthicalBlockDialog(message: String) {
        runOnUiThread {
            if (isFinishing || isDestroyed) return@runOnUiThread
            AlertDialog.Builder(this)
                .setTitle("エシカル保護（アクセス拒否）")
                .setMessage(message.ifEmpty { "別のオーナーのメディアが検出されたため、アクセスと書き込みをブロックしました。" })
                .setPositiveButton("OK", null)
                .show()
        }
    }

    /**
     * 端末の標準カメラアプリを通常撮影モード（フル機能）で起動する
     */
    private fun launchExternalCameraApp(): Boolean {
        val actions = listOf(
            android.provider.MediaStore.INTENT_ACTION_STILL_IMAGE_CAMERA,
            android.provider.MediaStore.ACTION_IMAGE_CAPTURE
        )
        for (action in actions) {
            try {
                startActivity(Intent(action))
                return true
            } catch (e: Exception) {
                Log.w(TAG, "カメラ起動試行スキップ ($action): ${e.message}")
            }
        }
        return false
    }

    private fun registerGestureBackHandler() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val cb = OnBackInvokedCallback { handleBackNavigation() }
            backInvokedCallback = cb
            onBackInvokedDispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, cb)
        }
    }

    private fun handleBackNavigation() {
        val now = System.currentTimeMillis()
        if (now - lastBackDispatchMs < 100L) return
        lastBackDispatchMs = now
        if (!::webView.isInitialized) { finish(); return }
        webView.evaluateJavascript("(function(){ return window.__handleAndroidBack ? window.__handleAndroidBack() : 'root'; })()") { rawResult ->
            val res = rawResult?.trim()?.trim('"') ?: "root"
            if (res == "handled") { lastRootBackPressMs = 0L; return@evaluateJavascript }
            if (webView.canGoBack()) { webView.goBack(); return@evaluateJavascript }
            val pressNow = System.currentTimeMillis()
            if (pressNow - lastRootBackPressMs < 2000L) {
                finish()
            } else {
                lastRootBackPressMs = pressNow
                webView.evaluateJavascript("if(window.__showAndroidExitHint){window.__showAndroidExitHint();}", null)
            }
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() = handleBackNavigation()

    override fun onDestroy() {
        usbAttachReceiver?.let { try { unregisterReceiver(it) } catch (_: Exception) {} }
        usbAttachReceiver = null
        FieldLogService.setStatusListener(null)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            backInvokedCallback?.let { try { onBackInvokedDispatcher.unregisterOnBackInvokedCallback(it) } catch (_: Exception) {} }
        }
        linkWatchExecutor.shutdownNow()
        bgExecutor.shutdownNow()
        if (::lockerDbManager.isInitialized) lockerDbManager.closeLibraryDatabase()
        super.onDestroy()
    }

    private fun isTextMimeType(m: String): Boolean =
        m.startsWith("text/") || m == "application/javascript" || m == "application/json" || m == "image/svg+xml"

    private fun guessAssetMimeType(path: String): String = when {
        path.endsWith(".html", true) -> "text/html"
        path.endsWith(".css", true) -> "text/css"
        path.endsWith(".js", true) -> "application/javascript"
        path.endsWith(".json", true) -> "application/json"
        path.endsWith(".svg", true) -> "image/svg+xml"
        path.endsWith(".webp", true) -> "image/webp"
        path.endsWith(".png", true) -> "image/png"
        path.endsWith(".jpg", true) || path.endsWith(".jpeg", true) -> "image/jpeg"
        path.endsWith(".woff2", true) -> "font/woff2"
        path.endsWith(".wasm", true) -> "application/wasm"
        path.endsWith(".ico", true) -> "image/x-icon"
        else -> "application/octet-stream"
    }
}
