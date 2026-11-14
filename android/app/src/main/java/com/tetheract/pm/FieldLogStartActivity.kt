package com.tetheract.pm

import android.Manifest
import android.app.Activity
import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.widget.Toast
import androidx.core.content.ContextCompat

/**
 * クイック設定タイル等から GPS フィールドログを開始するための透明トランポリン Activity。
 * 必要な実行時権限（ACCESS_FINE_LOCATION / POST_NOTIFICATIONS）を確認・要求し、
 * 正確な位置情報が許可されたら FieldLogService を前面起動して即座に終了する。
 */
class FieldLogStartActivity : Activity() {

    companion object {
        private const val TAG = "FieldLogStartActivity"
        private const val REQ_CODE_PERMISSIONS = 4301
        private const val PREFS_NAME = "tetheract_fieldlog_start"
        private const val KEY_NOTIF_ASKED_ONCE = "notif_asked_once"
        private const val FINE_LOCATION_REQUIRED_MSG =
            "GPSログの記録には『正確な位置情報』の許可が必要です"
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
        }

        if (savedInstanceState != null) {
            // 権限ダイアログ表示中の再生成時はコールバック待機を継続する
            return
        }

        val hasFineLocation = hasFineLocationPermission()
        val needNotifPerm = shouldRequestNotificationPermission()

        if (hasFineLocation && !needNotifPerm) {
            startLoggingServiceAndFinish()
            return
        }

        val permissionsToRequest = mutableListOf<String>()
        if (!hasFineLocation) {
            permissionsToRequest.add(Manifest.permission.ACCESS_FINE_LOCATION)
            permissionsToRequest.add(Manifest.permission.ACCESS_COARSE_LOCATION)
        }
        if (needNotifPerm && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            markNotificationAsked()
            permissionsToRequest.add(Manifest.permission.POST_NOTIFICATIONS)
        }

        if (permissionsToRequest.isEmpty()) {
            startLoggingServiceAndFinish()
        } else {
            requestPermissions(permissionsToRequest.toTypedArray(), REQ_CODE_PERMISSIONS)
        }
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQ_CODE_PERMISSIONS) return

        if (hasFineLocationPermission()) {
            // 通知権限が拒否されていても正確な位置情報があれば記録を開始する
            startLoggingServiceAndFinish()
        } else {
            Toast.makeText(applicationContext, FINE_LOCATION_REQUIRED_MSG, Toast.LENGTH_LONG).show()
            FieldLogService.notifyStatusChanged(applicationContext)
            finishWithoutAnimation()
        }
    }

    private fun hasFineLocationPermission(): Boolean {
        return ContextCompat.checkSelfPermission(
            this,
            Manifest.permission.ACCESS_FINE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED
    }

    private fun shouldRequestNotificationPermission(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return false
        val granted = ContextCompat.checkSelfPermission(
            this,
            Manifest.permission.POST_NOTIFICATIONS
        ) == PackageManager.PERMISSION_GRANTED
        if (granted) return false

        // ロック画面上から起動された場合、位置情報が既に許可済みなら通知ダイアログを出さず即開始する
        val km = getSystemService(Context.KEYGUARD_SERVICE) as? KeyguardManager
        if (km?.isKeyguardLocked == true && hasFineLocationPermission()) {
            return false
        }

        val prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val askedOnce = prefs.getBoolean(KEY_NOTIF_ASKED_ONCE, false)
        // 位置情報未許可時は初回フローで一緒に要求し、位置許可済みの場合は未要求の1回のみ尋ねる
        return !askedOnce || !hasFineLocationPermission()
    }

    private fun markNotificationAsked() {
        getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putBoolean(KEY_NOTIF_ASKED_ONCE, true)
            .apply()
    }

    private fun startLoggingServiceAndFinish() {
        val serviceIntent = Intent(this, FieldLogService::class.java).apply {
            action = FieldLogService.ACTION_START
        }
        try {
            ContextCompat.startForegroundService(this, serviceIntent)
        } catch (e: Exception) {
            Log.e(TAG, "FieldLogService の起動に失敗しました", e)
            Toast.makeText(applicationContext, "GPSログを開始できませんでした", Toast.LENGTH_SHORT).show()
        }
        finishWithoutAnimation()
    }

    private fun finishWithoutAnimation() {
        finish()
        @Suppress("DEPRECATION")
        overridePendingTransition(0, 0)
    }
}
