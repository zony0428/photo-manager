package com.tetheract.pm

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.BatteryManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.service.quicksettings.TileService
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.util.Locale

/**
 * GPS フィールドログをバックグラウンドで記録する前面サービス（foregroundServiceType="location"）。
 * Google Play 開発者サービスに依存せず Android 標準の LocationManager を直接購読する。
 */
class FieldLogService : Service() {

    companion object {
        private const val TAG = "FieldLogService"
        const val ACTION_START = "com.tetheract.pm.action.FIELD_LOG_START"
        const val ACTION_STOP = "com.tetheract.pm.action.FIELD_LOG_STOP"
        const val ACTION_OPEN_FIELD_LOG = "com.tetheract.pm.action.OPEN_FIELD_LOG"

        private const val PREFS_NAME = "tetheract_fieldlog_service"
        private const val KEY_RECORDING = "recording"
        private const val KEY_STARTED_AT = "started_at"
        private const val KEY_INTERRUPTED = "interrupted"

        private const val CHANNEL_ID = "tetheract_fieldlog_channel"
        private const val NOTIF_ID = 4101
        private const val REQ_OPEN_UI = 4102
        private const val REQ_STOP_ACTION = 4103

        private const val TICK_INTERVAL_MS = 60_000L
        private const val MIN_POINT_NOTIF_UPDATE_MS = 3_000L
        private const val LOW_BATTERY_PERCENT = 15

        private val stateLock = Any()

        @Volatile
        var isRunningInMemory: Boolean = false
            private set

        @Volatile
        private var statusListener: ((JSONObject) -> Unit)? = null

        private fun servicePrefs(context: Context): SharedPreferences {
            return context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        }

        /**
         * 現在フィールドログを記録中かどうかを返す。
         * SharedPreferences の recording が true でもプロセス内でサービスが稼働していない場合は
         * OS 強制終了と判定し、session stop (reason="killed") を補完追記して false を返す。
         */
        fun isRecording(context: Context): Boolean {
            val appCtx = context.applicationContext
            val detectedKill: Boolean
            synchronized(stateLock) {
                val prefs = servicePrefs(appCtx)
                val prefRecording = prefs.getBoolean(KEY_RECORDING, false)
                if (!prefRecording) return false
                if (isRunningInMemory) return true

                prefs.edit()
                    .putBoolean(KEY_RECORDING, false)
                    .putLong(KEY_STARTED_AT, 0L)
                    .putBoolean(KEY_INTERRUPTED, true)
                    .apply()
                detectedKill = true
            }
            if (detectedKill) {
                try {
                    FieldLogStore.get(appCtx).appendSession("stop", "killed")
                } catch (e: Exception) {
                    Log.w(TAG, "強制終了セッションの補完追記警告", e)
                }
            }
            return false
        }

        /** UI で中断通知を確認または記録再開した際に中断フラグをクリアする */
        fun clearInterruptedFlag(context: Context) {
            val appCtx = context.applicationContext
            synchronized(stateLock) {
                servicePrefs(appCtx).edit().putBoolean(KEY_INTERRUPTED, false).apply()
            }
        }

        /** ブリッジの fieldLogGetStatusJson と同一構造のステータス JSONObject を組み立てる */
        fun buildStatusJson(context: Context): JSONObject {
            val appCtx = context.applicationContext
            val recording = isRecording(appCtx)
            val store = FieldLogStore.get(appCtx)
            val settings = store.loadSettings()

            val startedAt: Long
            val interrupted: Boolean
            synchronized(stateLock) {
                val prefs = servicePrefs(appCtx)
                startedAt = if (recording) prefs.getLong(KEY_STARTED_AT, 0L) else 0L
                interrupted = prefs.getBoolean(KEY_INTERRUPTED, false)
            }

            val hasLocationPerm = ContextCompat.checkSelfPermission(
                appCtx,
                Manifest.permission.ACCESS_FINE_LOCATION
            ) == PackageManager.PERMISSION_GRANTED

            val hasNotifPerm = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                ContextCompat.checkSelfPermission(
                    appCtx,
                    Manifest.permission.POST_NOTIFICATIONS
                ) == PackageManager.PERMISSION_GRANTED
            } else {
                true
            }

            val settingsJson = JSONObject()
                .put("intervalSec", settings.intervalSec)
                .put("autoStopHours", settings.autoStopHours)
                .put("autoDeleteDays", settings.autoDeleteDays)

            val permJson = JSONObject()
                .put("location", hasLocationPerm)
                .put("notification", hasNotifPerm)

            return JSONObject()
                .put("recording", recording)
                .put("startedAt", startedAt)
                .put("todayPoints", store.todayPoints())
                .put("settings", settingsJson)
                .put("permission", permJson)
                .put("interrupted", interrupted)
        }

        /** MainActivity が状態変化を受け取るためのプロセス内リスナーを設定する */
        fun setStatusListener(listener: ((JSONObject) -> Unit)?) {
            statusListener = listener
        }

        /** 画面リスナーとクイック設定タイルの双方へ最新の記録状態を通知する */
        fun notifyStatusChanged(context: Context) {
            val appCtx = context.applicationContext
            try {
                TileService.requestListeningState(
                    appCtx,
                    ComponentName(appCtx, FieldLogTileService::class.java)
                )
            } catch (e: Exception) {
                Log.d(TAG, "TileService 更新通知スキップ: ${e.message}")
            }

            val listener = statusListener ?: return
            val statusJson = buildStatusJson(appCtx)
            if (Looper.myLooper() == Looper.getMainLooper()) {
                listener.invoke(statusJson)
            } else {
                Handler(Looper.getMainLooper()).post {
                    statusListener?.invoke(statusJson)
                }
            }
        }
    }

    private val mainHandler = Handler(Looper.getMainLooper())
    private var locationManager: LocationManager? = null
    private var sessionStartedAtMs: Long = 0L
    private var lastPointNotifUpdateMs: Long = 0L
    private var stoppingGracefully: Boolean = false

    private val periodicTickRunnable = object : Runnable {
        override fun run() {
            if (!isRunningInMemory) return
            val now = System.currentTimeMillis()
            val store = FieldLogStore.get(applicationContext)
            val settings = store.loadSettings()

            val maxDurationMs = settings.autoStopHours.coerceIn(1, 24) * 3_600_000L
            if (sessionStartedAtMs > 0L && now - sessionStartedAtMs >= maxDurationMs) {
                Log.i(TAG, "自動停止時間に達したためフィールドログを停止します (${settings.autoStopHours}h)")
                stopRecordingAndSelf("auto_timeout")
                return
            }

            if (isBatteryLow()) {
                Log.i(TAG, "電池残量低下のためフィールドログを自動停止します (< $LOW_BATTERY_PERCENT%)")
                stopRecordingAndSelf("low_battery")
                return
            }

            updateForegroundNotification(store.todayPoints(now))
            notifyStatusChanged(applicationContext)
            mainHandler.postDelayed(this, TICK_INTERVAL_MS)
        }
    }

    private val locationListener = object : LocationListener {
        override fun onLocationChanged(location: Location) {
            handleNewLocation(location)
        }

        @Deprecated("Deprecated in Java")
        override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {
            // API 26〜28 互換のため空実装を維持
        }

        override fun onProviderEnabled(provider: String) {}

        override fun onProviderDisabled(provider: String) {}
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> stopRecordingAndSelf("user")
            ACTION_START -> startOrRefreshRecording()
            else -> {
                if (!isRunningInMemory) {
                    stopSelf()
                }
            }
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        mainHandler.removeCallbacksAndMessages(null)
        unregisterLocationUpdates()

        var unexpectedKill = false
        synchronized(stateLock) {
            isRunningInMemory = false
            val prefs = servicePrefs(applicationContext)
            if (!stoppingGracefully && prefs.getBoolean(KEY_RECORDING, false)) {
                prefs.edit()
                    .putBoolean(KEY_RECORDING, false)
                    .putLong(KEY_STARTED_AT, 0L)
                    .putBoolean(KEY_INTERRUPTED, true)
                    .apply()
                unexpectedKill = true
            }
        }
        if (unexpectedKill) {
            try {
                FieldLogStore.get(applicationContext).appendSession("stop", "killed")
            } catch (e: Exception) {
                Log.w(TAG, "onDestroy 時の中断セッション記録警告", e)
            }
            notifyStatusChanged(applicationContext)
        }
        super.onDestroy()
    }

    private fun startOrRefreshRecording() {
        val hasFineLocation = ContextCompat.checkSelfPermission(
            this,
            Manifest.permission.ACCESS_FINE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED
        if (!hasFineLocation) {
            Log.w(TAG, "ACCESS_FINE_LOCATION 未保持のためサービスを終了します")
            notifyStatusChanged(applicationContext)
            stopSelf()
            return
        }

        ensureNotificationChannel()
        val store = FieldLogStore.get(applicationContext)
        val alreadyRunning = isRunningInMemory
        val now = System.currentTimeMillis()
        if (!alreadyRunning || sessionStartedAtMs <= 0L) {
            sessionStartedAtMs = now
        }

        val initialNotif = buildForegroundNotification(sessionStartedAtMs, store.todayPoints(now))
        val fgType = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
        } else {
            0
        }
        try {
            ServiceCompat.startForeground(this, NOTIF_ID, initialNotif, fgType)
        } catch (se: SecurityException) {
            Log.e(TAG, "前面サービスの開始時に SecurityException が発生しました", se)
            notifyStatusChanged(applicationContext)
            stopSelf()
            return
        } catch (e: Exception) {
            Log.e(TAG, "前面サービスの開始に失敗しました", e)
            notifyStatusChanged(applicationContext)
            stopSelf()
            return
        }

        stoppingGracefully = false
        if (!alreadyRunning) {
            // 前回の強制終了が未回収だった場合は先に killed を補完してから新しい start を記録する
            isRecording(applicationContext)
            synchronized(stateLock) {
                isRunningInMemory = true
                servicePrefs(applicationContext).edit()
                    .putBoolean(KEY_RECORDING, true)
                    .putLong(KEY_STARTED_AT, sessionStartedAtMs)
                    .putBoolean(KEY_INTERRUPTED, false)
                    .apply()
            }
            store.appendSession("start", "user")
        }

        val settings = store.loadSettings()
        if (!registerLocationUpdates(settings)) {
            Log.w(TAG, "利用可能な位置情報プロバイダの購読に失敗したため停止します")
            stopRecordingAndSelf("user")
            return
        }

        mainHandler.removeCallbacks(periodicTickRunnable)
        mainHandler.postDelayed(periodicTickRunnable, TICK_INTERVAL_MS)
        notifyStatusChanged(applicationContext)
    }

    private fun stopRecordingAndSelf(reason: String) {
        stoppingGracefully = true
        mainHandler.removeCallbacksAndMessages(null)
        unregisterLocationUpdates()

        val wasRecording: Boolean
        synchronized(stateLock) {
            val prefs = servicePrefs(applicationContext)
            wasRecording = isRunningInMemory || prefs.getBoolean(KEY_RECORDING, false)
            prefs.edit()
                .putBoolean(KEY_RECORDING, false)
                .putLong(KEY_STARTED_AT, 0L)
                .apply()
            isRunningInMemory = false
        }
        sessionStartedAtMs = 0L

        if (wasRecording) {
            try {
                FieldLogStore.get(applicationContext).appendSession("stop", reason)
            } catch (e: Exception) {
                Log.w(TAG, "停止セッション記録警告 ($reason)", e)
            }
        }

        try {
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        } catch (e: Exception) {
            Log.d(TAG, "stopForeground スキップ: ${e.message}")
        }
        notifyStatusChanged(applicationContext)
        stopSelf()
    }

    private fun registerLocationUpdates(settings: FieldLogSettings): Boolean {
        unregisterLocationUpdates()
        val lm = getSystemService(Context.LOCATION_SERVICE) as? LocationManager ?: return false
        locationManager = lm

        val intervalMs = settings.intervalSec.coerceIn(5, 300) * 1000L
        var registered = false
        val providers = try {
            lm.allProviders
        } catch (e: Exception) {
            Log.w(TAG, "プロバイダ一覧の取得失敗", e)
            emptyList()
        }

        if (providers.contains(LocationManager.GPS_PROVIDER)) {
            try {
                lm.requestLocationUpdates(
                    LocationManager.GPS_PROVIDER,
                    intervalMs,
                    0f,
                    locationListener,
                    Looper.getMainLooper()
                )
                registered = true
            } catch (se: SecurityException) {
                Log.e(TAG, "GPS_PROVIDER 購読の権限エラー", se)
            } catch (e: Exception) {
                Log.w(TAG, "GPS_PROVIDER 購読失敗", e)
            }
        }

        if (providers.contains(LocationManager.NETWORK_PROVIDER)) {
            val netIntervalMs = maxOf(intervalMs * 2L, 60_000L)
            try {
                lm.requestLocationUpdates(
                    LocationManager.NETWORK_PROVIDER,
                    netIntervalMs,
                    0f,
                    locationListener,
                    Looper.getMainLooper()
                )
                registered = true
            } catch (se: SecurityException) {
                Log.w(TAG, "NETWORK_PROVIDER 購読の権限警告", se)
            } catch (e: Exception) {
                Log.w(TAG, "NETWORK_PROVIDER 購読スキップ: ${e.message}")
            }
        }
        return registered
    }

    private fun unregisterLocationUpdates() {
        val lm = locationManager ?: return
        try {
            lm.removeUpdates(locationListener)
        } catch (se: SecurityException) {
            Log.d(TAG, "removeUpdates 権限警告: ${se.message}")
        } catch (e: Exception) {
            Log.d(TAG, "removeUpdates 警告: ${e.message}")
        }
    }

    private fun handleNewLocation(location: Location) {
        if (!isRunningInMemory) return
        val store = FieldLogStore.get(applicationContext)
        val beforePoints = store.todayPoints()
        store.appendPoint(location)
        val afterPoints = store.todayPoints()

        if (afterPoints != beforePoints) {
            val now = System.currentTimeMillis()
            if (now - lastPointNotifUpdateMs >= MIN_POINT_NOTIF_UPDATE_MS) {
                lastPointNotifUpdateMs = now
                updateForegroundNotification(afterPoints)
            }
            notifyStatusChanged(applicationContext)
        }
    }

    private fun isBatteryLow(): Boolean {
        return try {
            val bm = getSystemService(Context.BATTERY_SERVICE) as? BatteryManager ?: return false
            if (bm.isCharging) return false
            val capacity = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
            capacity in 1 until LOW_BATTERY_PERCENT
        } catch (e: Exception) {
            Log.d(TAG, "電池残量チェック警告: ${e.message}")
            false
        }
    }

    private fun ensureNotificationChannel() {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
        val channel = NotificationChannel(
            CHANNEL_ID,
            "GPSフィールドログ記録",
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = "撮影中のGPSフィールドログ記録状態を表示します"
            setShowBadge(false)
        }
        nm.createNotificationChannel(channel)
    }

    private fun updateForegroundNotification(todayPoints: Int) {
        if (!isRunningInMemory) return
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
        try {
            nm.notify(NOTIF_ID, buildForegroundNotification(sessionStartedAtMs, todayPoints))
        } catch (se: SecurityException) {
            Log.d(TAG, "通知更新スキップ（POST_NOTIFICATIONS 未許可）: ${se.message}")
        } catch (e: Exception) {
            Log.w(TAG, "通知更新警告", e)
        }
    }

    private fun buildForegroundNotification(startedAtMs: Long, todayPoints: Int): Notification {
        val baseStart = if (startedAtMs > 0L) startedAtMs else System.currentTimeMillis()
        val elapsedMinutes = ((System.currentTimeMillis() - baseStart).coerceAtLeast(0L)) / 60_000L
        val hours = elapsedMinutes / 60L
        val minutes = elapsedMinutes % 60L
        val elapsedStr = String.format(Locale.US, "%d:%02d", hours, minutes)
        val titleText = "GPSログ記録中 · 経過 $elapsedStr · ${todayPoints}点"

        val openIntent = Intent(this, MainActivity::class.java).apply {
            action = ACTION_OPEN_FIELD_LOG
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val openPendingIntent = PendingIntent.getActivity(
            this,
            REQ_OPEN_UI,
            openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val stopIntent = Intent(this, FieldLogService::class.java).apply {
            action = ACTION_STOP
        }
        val stopPendingIntent = PendingIntent.getService(
            this,
            REQ_STOP_ACTION,
            stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_tile_fieldlog)
            .setContentTitle(titleText)
            .setContentText("タップしてフィールドログ画面を開く")
            .setContentIntent(openPendingIntent)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .addAction(0, "停止", stopPendingIntent)
            .build()
    }
}
