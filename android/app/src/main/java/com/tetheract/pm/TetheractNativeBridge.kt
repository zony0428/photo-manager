package com.tetheract.pm

import android.content.Context
import android.content.Intent
import android.util.Log
import android.webkit.JavascriptInterface
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject

/**
 * WebView 内の JavaScript (window.TetheractNative) へ公開されるネイティブブリッジクラス。
 * LockerDatabaseManager, SafUsbManager, WifiLockerSyncManager, UsbOfflineUpdater および
 * フィールドログ機能（FieldLogStore / FieldLogService）の各機能を橋渡しする。
 */
class TetheractNativeBridge(
    context: Context,
    private val lockerDbManager: LockerDatabaseManager,
    private val safUsbManager: SafUsbManager,
    private val wifiSyncManager: WifiLockerSyncManager,
    private val usbOfflineUpdater: UsbOfflineUpdater,
    private val phoneCaseManager: PhoneCaseManager,
    private val onLaunchUsbFolderPicker: () -> Unit,
    private val onTriggerWifiSyncAsync: (Boolean, Long) -> Unit,
    private val onStartFieldLogFromUi: () -> JSONObject,
    private val onTriggerUsbSyncAsync: () -> Unit = {},
    private val onLaunchPhoneFolderPicker: () -> Unit = {},
    private val onLaunchCamera: () -> Boolean = { false },
    private val onEvalJs: (String) -> Unit = {},
    private val onKeepScreenOn: (Boolean) -> Unit = {}
) {

    companion object {
        private const val TAG = "TetheractNativeBridge"
        private const val STATUS_REFRESH_MIN_INTERVAL_MS = 4_000L
    }

    private val appContext: Context = context.applicationContext
    private val quickShareHelper: QuickShareHelper = QuickShareHelper(appContext)
    private val lastPhotoSourceMap = java.util.concurrent.ConcurrentHashMap<Long, String>()
    private val statusRefreshExecutor = java.util.concurrent.Executors.newSingleThreadExecutor { r ->
        Thread(r, "TetheractUsbStatusRefresh").apply { isDaemon = true }
    }
    private val statusRefreshRunning = java.util.concurrent.atomic.AtomicBoolean(false)
    @Volatile private var lastStatusRefreshMs: Long = 0L
    @Volatile private var cachedAvailableUpdateJson: String? = null

    fun recordPhotoSource(photoId: Long, source: String) {
        if (lastPhotoSourceMap.size > 1000) lastPhotoSourceMap.clear()
        lastPhotoSourceMap[photoId] = source
    }

    private fun scheduleUsbStatusRefreshIfNeeded(force: Boolean = false) {
        if (safUsbManager.getSavedUsbTreeUri() == null) {
            cachedAvailableUpdateJson = null
            return
        }
        val nowMs = android.os.SystemClock.elapsedRealtime()
        if (!force && lastStatusRefreshMs > 0L && nowMs - lastStatusRefreshMs < STATUS_REFRESH_MIN_INTERVAL_MS) {
            return
        }
        if (!statusRefreshRunning.compareAndSet(false, true)) return
        statusRefreshExecutor.execute {
            try {
                val prevConn = safUsbManager.isUsbConnectedCached()
                val nowConn = safUsbManager.refreshUsbConnectionState()
                cachedAvailableUpdateJson = if (nowConn) {
                    usbOfflineUpdater.checkAvailableUsbUpdates()?.toString()
                } else {
                    null
                }
                lastStatusRefreshMs = android.os.SystemClock.elapsedRealtime()
                if (prevConn != nowConn) {
                    val pcOn = wifiSyncManager.isPcOnline
                    onEvalJs.invoke("if(window.__onTetheractLinkStateChanged){window.__onTetheractLinkStateChanged({pcOnline:$pcOn,usbConnected:$nowConn});}")
                }
            } catch (e: Exception) {
                Log.w(TAG, "USB状態非同期リフレッシュ警告", e)
            } finally {
                statusRefreshRunning.set(false)
            }
        }
    }

    @JavascriptInterface
    fun getLastPhotoSource(photoId: Long): String {
        return lastPhotoSourceMap[photoId] ?: ""
    }

    /**
     * スマホ内専用ロッカー・USB接続状態・Wi-Fi設定状態・未同期件数・利用可能アップデートの概要JSONを返す。
     * SAF DocumentFile 走査はバックグラウンドで非同期更新し、呼び出しスレッドを一切ブロックしない。
     */
    @JavascriptInterface
    fun getLockerStatusJson(): String {
        return try {
            scheduleUsbStatusRefreshIfNeeded(force = false)
            val meta = lockerDbManager.readLockerMeta()
            val updateRaw = cachedAvailableUpdateJson
            val updateObj: Any = if (!updateRaw.isNullOrEmpty()) JSONObject(updateRaw) else JSONObject.NULL
            JSONObject()
                .put("mode", "android_native")
                .put("appVersion", usbOfflineUpdater.getAppVersionLabel())
                .put("hasLockerDb", lockerDbManager.hasLockerDatabase())
                .put("usbConnected", safUsbManager.isUsbConnectedCached())
                .put("usbFolderName", safUsbManager.getUsbFolderDisplayNameCached())
                .put("usbVsn", safUsbManager.getMountedUsbVsnCached())
                .put("pcOnline", wifiSyncManager.isPcOnline)
                .put("pcConnRevision", wifiSyncManager.pcConnRevision)
                .put("wifiConfigured", wifiSyncManager.isWifiConfigured())
                .put("wifiServerUrl", wifiSyncManager.getConfiguredServerUrl())
                .put("lastWifiSyncAt", wifiSyncManager.getLastWifiSyncAt())
                .put("dbPhotoCount", lockerDbManager.getPhotoCount())
                .put("lastCachedAt", meta.optString("last_cached_at", ""))
                .put("pendingChangeCount", lockerDbManager.getPendingChangeCount())
                .put("availableUpdate", updateObj)
                .put("nativeApkUpdateRequired", wifiSyncManager.isNativeApkUpdateAvailable())
                .put("apkDownloadUrl", wifiSyncManager.getRemoteApkDownloadUrl())
                .toString()
        } catch (e: Exception) {
            Log.e(TAG, "getLockerStatusJson エラー", e)
            JSONObject()
                .put("mode", "android_native")
                .put("hasLockerDb", false)
                .put("usbConnected", false)
                .put("error", e.message ?: "Status check error")
                .toString()
        }
    }

    /** キャッシュ済みのPC母艦ライブ接続スナップショットJSONを返す */
    @JavascriptInterface
    fun getPcConnectionStatusJson(): String = wifiSyncManager.pcConnStatusJson

    /**
     * PC母艦が配信する最新 Android APK (/api/mobile/apk) を端末の標準ブラウザでダウンロード開始する
     */
    @JavascriptInterface
    fun openPcApkDownloadInBrowserJson(): String {
        val apkUrl = wifiSyncManager.getRemoteApkDownloadUrl()
        if (apkUrl.isEmpty()) {
            return JSONObject()
                .put("ok", false)
                .put("error", "PC母艦の接続設定が見つかりません")
                .toString()
        }
        return try {
            val intent = Intent(Intent.ACTION_VIEW, android.net.Uri.parse(apkUrl)).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            appContext.startActivity(intent)
            JSONObject()
                .put("ok", true)
                .put("url", apkUrl)
                .toString()
        } catch (e: Exception) {
            Log.e(TAG, "APKブラウザダウンロード起動エラー", e)
            JSONObject()
                .put("ok", false)
                .put("error", e.message ?: "ブラウザの起動に失敗しました")
                .toString()
        }
    }

    /**
     * PCのQRコードURL (http://192.168.x.x:8088/m?t=...) またはディープリンクを保存する
     */
    @JavascriptInterface
    fun saveWifiPairingJson(urlOrQrInput: String): String {
        return wifiSyncManager.savePairingFromInput(urlOrQrInput).toString()
    }

    /**
     * バックグラウンドスレッドでPC母艦とのWi-Fi双方向ロッカー同期を開始する
     * （完了時に tetheract:usb-sync-completed イベントが発火する）
     */
    @JavascriptInterface
    fun triggerWifiSyncAsyncJson(forceFull: Boolean): String {
        return try {
            onTriggerWifiSyncAsync.invoke(forceFull, 0L)
            JSONObject()
                .put("ok", true)
                .put("status", "wifi_sync_started")
                .put("serverUrl", wifiSyncManager.getConfiguredServerUrl())
                .toString()
        } catch (e: Exception) {
            Log.e(TAG, "triggerWifiSyncAsyncJson エラー", e)
            JSONObject()
                .put("ok", false)
                .put("error", e.message ?: "Failed to start Wi-Fi sync")
                .toString()
        }
    }

    @JavascriptInterface
    fun discoverPcOnLanJson(): String {
        return wifiSyncManager.discoverPcOnLan(requestPair = false).toString()
    }

    /**
     * 未接続時は SAF フォルダ選択ピッカーを起動し、接続済み時は Loome USB の読み取り専用マウントを実行する
     */
    @JavascriptInterface
    fun triggerUsbSyncAsyncJson(): String {
        return try {
            if (safUsbManager.getSavedUsbTreeUri() == null || !safUsbManager.isUsbConnectedCached()) {
                onLaunchUsbFolderPicker.invoke()
                JSONObject().put("ok", true).put("status", "picker_launched").toString()
            } else {
                onTriggerUsbSyncAsync.invoke()
                JSONObject().put("ok", true).put("status", "usb_sync_started").toString()
            }
        } catch (e: Exception) {
            Log.e(TAG, "triggerUsbSyncAsyncJson エラー", e)
            JSONObject().put("ok", false).put("error", e.message ?: "USB sync failed").toString()
        }
    }

    @JavascriptInterface
    fun selectUsbFolderAndSync(): String {
        return try {
            onLaunchUsbFolderPicker.invoke()
            JSONObject()
                .put("ok", true)
                .put("status", "picker_launched")
                .toString()
        } catch (e: Exception) {
            Log.e(TAG, "selectUsbFolderAndSync エラー", e)
            JSONObject()
                .put("ok", false)
                .put("error", e.message ?: "Failed to launch SAF folder picker")
                .toString()
        }
    }

    /**
     * 接続中の Loome USB を読み取り専用でマウント確認する
     */
    @JavascriptInterface
    fun refreshLockerFromUsbJson(): String {
        return try {
            safUsbManager.mountConnectedLoome().toString()
        } catch (e: Exception) {
            Log.e(TAG, "refreshLockerFromUsbJson エラー", e)
            JSONObject()
                .put("ok", false)
                .put("updated", false)
                .put("error", e.message ?: "Refresh failed")
                .toString()
        }
    }

    /**
     * 鍵付き Loome をパスワードまたはリカバリーコードでメモリ解錠する
     */
    @JavascriptInterface
    fun unlockLoomeWithPasswordJson(password: String): String {
        return try {
            safUsbManager.unlockLoomeWithPassword(password).toString()
        } catch (e: Exception) {
            Log.e(TAG, "unlockLoomeWithPasswordJson エラー", e)
            JSONObject()
                .put("ok", false)
                .put("error", e.message ?: "Unlock failed")
                .toString()
        }
    }

    /**
     * ロッカー内の library.db に対して WHERE / ORDER クエリを実行し、写真一覧JSONを返す
     */
    @JavascriptInterface
    fun queryPhotosJson(
        whereSql: String,
        paramsJson: String,
        orderSql: String,
        limit: Int,
        offset: Int
    ): String {
        return lockerDbManager.queryPhotosJson(whereSql, paramsJson, orderSql, limit, offset)
    }

    /**
     * タグ・年月・機材・場所・フォルダのフィルタ集計ツリーJSONを返す
     */
    @JavascriptInterface
    fun getFilterTreesJson(): String {
        return lockerDbManager.getFilterTreesJson()
    }

    /**
     * 写真の評価・タグ・非破壊調整変更をロッカー内 library.db と pending_journal.db へ同時保存する
     */
    @JavascriptInterface
    fun savePhotoChangeJson(payloadJson: String): String {
        return lockerDbManager.savePhotoChangeJson(payloadJson)
    }

    /**
     * 複数写真の評価・タグ・非破壊調整変更を単一SQLiteトランザクションで一括保存する
     */
    @JavascriptInterface
    fun savePhotoChangesBatchJson(payloadJson: String): String {
        return lockerDbManager.savePhotoChangesBatchJson(payloadJson)
    }

    /**
     * USB への書き出しは行わず、Wi-Fi 同期を案内する（USB は原本閲覧専用）
     */
    @JavascriptInterface
    fun exportSyncJsonToUsb(): String {
        return JSONObject()
            .put("ok", false)
            .put("error", "選別データの同期はWi-Fi同期をご利用ください（USBは原本閲覧専用です）")
            .toString()
    }

    /**
     * 未同期ジャーナルの件数だけを返す（USB 上の更新ファイル探索を伴う getLockerStatusJson より軽量）
     */
    @JavascriptInterface
    fun getPendingChangeCount(): Int {
        return lockerDbManager.getPendingChangeCount()
    }

    /**
     * 現在記録されている未同期ジャーナルのJSON文字列を取得する（Wi-FiサーバーPOST用。journal_rev を含む）
     */
    @JavascriptInterface
    fun getPendingChangesJson(): String {
        return lockerDbManager.buildMobileSyncJsonPayload()
    }

    /**
     * PCサーバー同期完了後に、送信時点の journal_rev 以下のジャーナルだけをクリアする
     */
    @JavascriptInterface
    fun clearPendingChangesUpToJson(journalRev: Long): String {
        return try {
            lockerDbManager.clearPendingJournalUpTo(journalRev)
            JSONObject().put("ok", true).put("pendingChangeCount", lockerDbManager.getPendingChangeCount()).toString()
        } catch (e: Exception) {
            Log.e(TAG, "clearPendingChangesUpToJson エラー", e)
            JSONObject().put("ok", false).put("error", e.message ?: "Clear failed").toString()
        }
    }

    /**
     * 未同期ジャーナルをすべて破棄する（ユーザーによる変更履歴リセット用）
     */
    @JavascriptInterface
    fun clearPendingChangesJson(): String {
        return try {
            lockerDbManager.clearPendingJournal()
            JSONObject().put("ok", true).put("pendingChangeCount", 0).toString()
        } catch (e: Exception) {
            Log.e(TAG, "clearPendingChangesJson エラー", e)
            JSONObject().put("ok", false).put("error", e.message ?: "Clear failed").toString()
        }
    }

    /**
     * USB内の UI バンドル (Stage 1) および Tetheract_Android.apk (Stage 2) を確認・実行する
     */
    @JavascriptInterface
    fun checkAndTriggerUsbUpdateJson(optionsJson: String): String {
        return try {
            val opts = if (optionsJson.isNotEmpty()) JSONObject(optionsJson) else JSONObject()
            val autoApplyUi = opts.optBoolean("autoApplyUi", true)
            val triggerApkInstall = opts.optBoolean("triggerApkInstall", false)
            usbOfflineUpdater.checkAndTriggerUpdate(autoApplyUi, triggerApkInstall).toString()
        } catch (e: Exception) {
            Log.e(TAG, "checkAndTriggerUsbUpdateJson エラー", e)
            JSONObject()
                .put("ok", false)
                .put("error", e.message ?: "Update check failed")
                .toString()
        }
    }

    /**
     * 読み取り専用 SQL（SELECT 等）だけを実行する。書き込みは savePhotoChangeJson に一本化している
     */
    @JavascriptInterface
    fun rawQueryJson(sql: String, paramsJson: String): String {
        return lockerDbManager.rawQuerySafeJson(sql, paramsJson)
    }

    /**
     * フィールドログの現在の記録状態・設定・権限・中断フラグを返す
     */
    @JavascriptInterface
    fun fieldLogGetStatusJson(): String {
        return try {
            FieldLogService.buildStatusJson(appContext).toString()
        } catch (e: Exception) {
            Log.e(TAG, "fieldLogGetStatusJson エラー", e)
            JSONObject()
                .put("recording", false)
                .put("startedAt", 0L)
                .put("todayPoints", 0)
                .put("interrupted", false)
                .put("error", e.message ?: "Status error")
                .toString()
        }
    }

    /**
     * アプリ前面から GPS フィールドログの記録を開始する（権限未保持時は権限要求を発火する）
     */
    @JavascriptInterface
    fun fieldLogStartJson(): String {
        return try {
            onStartFieldLogFromUi.invoke().toString()
        } catch (e: Exception) {
            Log.e(TAG, "fieldLogStartJson エラー", e)
            JSONObject()
                .put("ok", false)
                .put("error", e.message ?: "Failed to start field log")
                .toString()
        }
    }

    /**
     * 記録中の GPS フィールドログを停止する
     */
    @JavascriptInterface
    fun fieldLogStopJson(): String {
        return try {
            if (FieldLogService.isRecording(appContext)) {
                val stopIntent = Intent(appContext, FieldLogService::class.java).apply {
                    action = FieldLogService.ACTION_STOP
                }
                appContext.startService(stopIntent)
            } else {
                FieldLogService.notifyStatusChanged(appContext)
            }
            JSONObject().put("ok", true).toString()
        } catch (e: Exception) {
            Log.e(TAG, "fieldLogStopJson エラー", e)
            JSONObject()
                .put("ok", false)
                .put("error", e.message ?: "Failed to stop field log")
                .toString()
        }
    }

    /**
     * 端末内に保存されている日別フィールドログ一覧を新しい日付順で返す
     */
    @JavascriptInterface
    fun fieldLogListDaysJson(): String {
        return try {
            val days = FieldLogStore.get(appContext).listDays()
            val arr = JSONArray()
            for (day in days) {
                arr.put(
                    JSONObject()
                        .put("date", day.date)
                        .put("points", day.points)
                        .put("firstT", day.firstT)
                        .put("lastT", day.lastT)
                        .put("distanceM", day.distanceM)
                        .put("bytes", day.bytes)
                        .put("uploaded", day.uploaded)
                )
            }
            JSONObject().put("days", arr).toString()
        } catch (e: Exception) {
            Log.e(TAG, "fieldLogListDaysJson エラー", e)
            JSONObject().put("days", JSONArray()).put("error", e.message ?: "List failed").toString()
        }
    }

    /**
     * 指定した日付配列のフィールドログを削除し、削除日数を返す
     */
    @JavascriptInterface
    fun fieldLogDeleteDaysJson(datesJson: String): String {
        return try {
            val arr = if (datesJson.isNotBlank()) JSONArray(datesJson) else JSONArray()
            val dates = mutableListOf<String>()
            for (i in 0 until arr.length()) {
                val date = arr.optString(i, "").trim()
                if (date.isNotEmpty()) {
                    dates.add(date)
                }
            }
            val deleted = FieldLogStore.get(appContext).deleteDays(dates)
            FieldLogService.notifyStatusChanged(appContext)
            JSONObject()
                .put("ok", true)
                .put("deleted", deleted)
                .toString()
        } catch (e: Exception) {
            Log.e(TAG, "fieldLogDeleteDaysJson エラー", e)
            JSONObject()
                .put("ok", false)
                .put("deleted", 0)
                .put("error", e.message ?: "Delete failed")
                .toString()
        }
    }

    /**
     * 端末内のすべてのフィールドログを削除し、削除日数を返す
     */
    @JavascriptInterface
    fun fieldLogDeleteAllJson(): String {
        return try {
            val deleted = FieldLogStore.get(appContext).deleteAll()
            FieldLogService.notifyStatusChanged(appContext)
            JSONObject()
                .put("ok", true)
                .put("deleted", deleted)
                .toString()
        } catch (e: Exception) {
            Log.e(TAG, "fieldLogDeleteAllJson エラー", e)
            JSONObject()
                .put("ok", false)
                .put("deleted", 0)
                .put("error", e.message ?: "Delete all failed")
                .toString()
        }
    }

    /**
     * フィールドログの記録設定を保存し、記録中の場合は購読間隔をライブ反映する
     */
    @JavascriptInterface
    fun fieldLogSaveSettingsJson(json: String): String {
        return try {
            val store = FieldLogStore.get(appContext)
            val current = store.loadSettings()
            val obj = if (json.isNotBlank()) JSONObject(json) else JSONObject()
            val requested = FieldLogSettings(
                intervalSec = obj.optInt("intervalSec", current.intervalSec),
                autoStopHours = obj.optInt("autoStopHours", current.autoStopHours),
                autoDeleteDays = obj.optInt("autoDeleteDays", current.autoDeleteDays)
            )
            store.saveSettings(requested)
            val saved = store.loadSettings()

            if (FieldLogService.isRecording(appContext)) {
                val refreshIntent = Intent(appContext, FieldLogService::class.java).apply {
                    action = FieldLogService.ACTION_START
                }
                ContextCompat.startForegroundService(appContext, refreshIntent)
            } else {
                FieldLogService.notifyStatusChanged(appContext)
            }

            val settingsJson = JSONObject()
                .put("intervalSec", saved.intervalSec)
                .put("autoStopHours", saved.autoStopHours)
                .put("autoDeleteDays", saved.autoDeleteDays)
            JSONObject()
                .put("ok", true)
                .put("settings", settingsJson)
                .toString()
        } catch (e: Exception) {
            Log.e(TAG, "fieldLogSaveSettingsJson エラー", e)
            JSONObject()
                .put("ok", false)
                .put("error", e.message ?: "Save settings failed")
                .toString()
        }
    }

    // -------------------------------------------------------------------------
    // スマホ内画像フォルダ（Camera等）閲覧・タグ付け・母艦 Loome\case 転送 API
    // -------------------------------------------------------------------------

    @JavascriptInterface
    fun phoneCaseListFoldersJson(): String {
        return phoneCaseManager.listFoldersJson()
    }

    @JavascriptInterface
    fun phoneCasePickFolderJson(): String {
        return try {
            onLaunchPhoneFolderPicker.invoke()
            JSONObject().put("ok", true).put("status", "picker_launched").toString()
        } catch (e: Exception) {
            Log.e(TAG, "phoneCasePickFolderJson エラー", e)
            JSONObject().put("ok", false).put("error", e.message ?: "Picker failed").toString()
        }
    }

    /**
     * 端末の標準カメラアプリを起動する
     */
    @JavascriptInterface
    fun launchCameraAppJson(): String {
        return try {
            val launched = onLaunchCamera.invoke()
            if (launched) {
                JSONObject().put("ok", true).put("status", "camera_launched").toString()
            } else {
                JSONObject().put("ok", false).put("error", "カメラアプリが見つかりません").toString()
            }
        } catch (e: Exception) {
            Log.e(TAG, "launchCameraAppJson エラー", e)
            JSONObject().put("ok", false).put("error", e.message ?: "Camera launch failed").toString()
        }
    }

    @JavascriptInterface
    fun phoneCaseRemoveFolderJson(folderId: String): String {
        return phoneCaseManager.removeFolderJson(folderId)
    }

    @JavascriptInterface
    fun phoneCaseSetFolderModeJson(folderId: String, mode: String): String {
        return phoneCaseManager.setFolderModeJson(folderId, mode)
    }

    @JavascriptInterface
    fun phoneCaseScanPhotosJson(folderId: String): String {
        return phoneCaseManager.scanFolderPhotosJson(
            folderId = folderId, includeItems = true, allowLiveReconcile = false, minFreshMs = 3000L
        )
    }

    @JavascriptInterface
    fun phoneCaseScanPhotosAsyncJson(
        requestId: String,
        folderId: String,
        includeItems: Boolean,
        forceFresh: Boolean
    ): String {
        return try {
            Thread({
                val outObj = try {
                    val freshWindow = if (forceFresh) 0L else if (includeItems) 1500L else 3000L
                    val raw = phoneCaseManager.scanFolderPhotosJson(
                        folderId = folderId,
                        includeItems = includeItems,
                        allowLiveReconcile = includeItems,
                        minFreshMs = freshWindow
                    )
                    JSONObject(raw).put("requestId", requestId)
                } catch (e: Exception) {
                    Log.e(TAG, "phoneCaseScanPhotosAsync スレッドエラー", e)
                    JSONObject().put("ok", false).put("requestId", requestId)
                        .put("error", e.message ?: "Scan thread error").put("items", JSONArray())
                }
                val esc = JSONObject.quote(outObj.toString())
                onEvalJs("if(window.__onTetheractPhoneScanCompleted){window.__onTetheractPhoneScanCompleted(JSON.parse($esc));}")
            }, "PhoneScanAsync").apply { isDaemon = true; start() }
            JSONObject().put("ok", true).put("status", "scan_started").put("requestId", requestId).toString()
        } catch (e: Exception) {
            Log.e(TAG, "phoneCaseScanPhotosAsyncJson 起動エラー", e)
            JSONObject().put("ok", false).put("requestId", requestId).put("error", e.message ?: "Failed to start scan").toString()
        }
    }

    @JavascriptInterface
    fun phoneCaseSaveDraftJson(payloadJson: String): String {
        return phoneCaseManager.saveDraftChangesJson(payloadJson)
    }

    @JavascriptInterface
    fun phoneCaseSaveArtFramerOutputJson(payloadJson: String): String {
        return phoneCaseManager.saveArtFramerOutputJson(payloadJson)
    }

    @JavascriptInterface
    fun phoneCaseEnsurePhotoExifJson(photoId: Long): String {
        return phoneCaseManager.ensurePhotoExifJson(photoId)
    }

    @JavascriptInterface
    fun phoneCaseDetectFacesJson(dataUrl: String): String {
        return phoneCaseManager.detectFacesFromDataUrlJson(dataUrl)
    }

    @JavascriptInterface
    fun phoneCaseDetectPrivacyAsyncJson(requestId: String, dataUrl: String): String {
        return try {
            Thread({
                val outObj = try {
                    val raw = phoneCaseManager.detectFacesFromDataUrlJson(dataUrl)
                    JSONObject(raw).put("requestId", requestId)
                } catch (e: Exception) {
                    Log.e(TAG, "phoneCaseDetectPrivacyAsync スレッドエラー", e)
                    JSONObject().put("ok", false).put("requestId", requestId)
                        .put("error", e.message ?: "Detect thread error")
                        .put("faces", JSONArray())
                        .put("plates", JSONArray())
                }
                val esc = JSONObject.quote(outObj.toString())
                onEvalJs("if(window.__onTetheractPrivacyDetectCompleted){window.__onTetheractPrivacyDetectCompleted(JSON.parse($esc));}")
            }, "PrivacyDetectAsync").apply { isDaemon = true; start() }
            JSONObject().put("ok", true).put("status", "detect_started").put("requestId", requestId).toString()
        } catch (e: Exception) {
            Log.e(TAG, "phoneCaseDetectPrivacyAsyncJson 起動エラー", e)
            JSONObject().put("ok", false).put("requestId", requestId).put("error", e.message ?: "Failed to start detect").toString()
        }
    }

    @JavascriptInterface
    fun phoneCaseTransferAsyncJson(payloadJson: String): String {
        return try {
            Thread {
                onKeepScreenOn(true)
                try {
                    val res = phoneCaseManager.transferToMotherShipSync(payloadJson) { progJson ->
                        val escProg = JSONObject.quote(progJson.toString())
                        onEvalJs("if(window.__onTetheractCaseTransferProgress){window.__onTetheractCaseTransferProgress(JSON.parse($escProg));}")
                    }
                    val escRes = JSONObject.quote(res.toString())
                    onEvalJs("if(window.__onTetheractCaseTransferCompleted){window.__onTetheractCaseTransferCompleted(JSON.parse($escRes));}")
                    if (!res.optBoolean("aborted", false) && (res.optInt("importedCount", 0) > 0 || res.optInt("appliedToExisting", 0) > 0 || res.optInt("queuedPendingSignals", 0) > 0 || res.optInt("signalSyncedCount", 0) > 0)) {
                        // 転送完了直後のWebView側ローカルSQLite再集計とDB差し替えが衝突しないよう遅延後に直列実行する
                        onTriggerWifiSyncAsync.invoke(false, 1500L)
                    }
                } catch (e: Exception) {
                    Log.e(TAG, "phoneCaseTransferAsync スレッドエラー", e)
                    val errObj = JSONObject().put("ok", false).put("error", e.message ?: "Transfer thread error")
                    val escErr = JSONObject.quote(errObj.toString())
                    onEvalJs("if(window.__onTetheractCaseTransferCompleted){window.__onTetheractCaseTransferCompleted(JSON.parse($escErr));}")
                } finally {
                    onKeepScreenOn(false)
                }
            }.start()
            JSONObject().put("ok", true).put("status", "transfer_started").toString()
        } catch (e: Exception) {
            Log.e(TAG, "phoneCaseTransferAsyncJson 起動エラー", e)
            JSONObject().put("ok", false).put("error", e.message ?: "Failed to start transfer").toString()
        }
    }

    @JavascriptInterface
    fun listWatermarkAssetsJson(): String {
        return lockerDbManager.watermarkStore.listAssetsJson()
    }

    @JavascriptInterface
    fun saveWatermarkAssetJson(payloadJson: String): String {
        return lockerDbManager.watermarkStore.saveAssetJson(payloadJson)
    }

    @JavascriptInterface
    fun deleteWatermarkAssetJson(assetId: String): String {
        return lockerDbManager.watermarkStore.deleteAssetJson(assetId)
    }

    @JavascriptInterface
    fun sharePhotoToSnsJson(payloadJson: String): String {
        return quickShareHelper.sharePhotoFromDataUrlJson(payloadJson)
    }
}
