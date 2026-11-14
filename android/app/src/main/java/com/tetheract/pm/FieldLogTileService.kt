package com.tetheract.pm

import android.Manifest
import android.app.PendingIntent
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.drawable.Icon
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import android.util.Log
import androidx.core.content.ContextCompat

/**
 * Android クイック設定パネルからワンタップで GPS フィールドログを ON/OFF する TileService。
 * Android 14 のバックグラウンド前面サービス制限に対応するため、開始時は FieldLogStartActivity を経由する。
 */
class FieldLogTileService : TileService() {

    companion object {
        private const val TAG = "FieldLogTileService"
        private const val REQ_START_ACTIVITY = 4201
        private const val TILE_LABEL = "GPSログ"
    }

    override fun onStartListening() {
        super.onStartListening()
        refreshTileVisuals()
    }

    override fun onClick() {
        super.onClick()
        if (FieldLogService.isRecording(this)) {
            stopRecordingFromTile()
            return
        }

        val hasFineLocation = ContextCompat.checkSelfPermission(
            this,
            Manifest.permission.ACCESS_FINE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED

        if (isLocked && !hasFineLocation) {
            unlockAndRun { launchStartActivity() }
        } else {
            launchStartActivity()
        }
    }

    private fun stopRecordingFromTile() {
        val stopIntent = Intent(this, FieldLogService::class.java).apply {
            action = FieldLogService.ACTION_STOP
        }
        try {
            startService(stopIntent)
        } catch (e: Exception) {
            Log.w(TAG, "タイルからのフィールドログ停止要求エラー", e)
        }
        qsTile?.let { tile ->
            tile.state = Tile.STATE_INACTIVE
            tile.label = TILE_LABEL
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                tile.subtitle = "OFF"
            }
            tile.updateTile()
        }
    }

    private fun launchStartActivity() {
        val startIntent = Intent(this, FieldLogStartActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        }
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                val pendingIntent = PendingIntent.getActivity(
                    this,
                    REQ_START_ACTIVITY,
                    startIntent,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                )
                startActivityAndCollapse(pendingIntent)
            } else {
                @Suppress("DEPRECATION")
                startActivityAndCollapse(startIntent)
            }
        } catch (e: Exception) {
            Log.e(TAG, "FieldLogStartActivity の起動失敗", e)
        }
    }

    private fun refreshTileVisuals() {
        val tile = qsTile ?: return
        val recording = FieldLogService.isRecording(this)
        tile.label = TILE_LABEL
        tile.icon = Icon.createWithResource(this, R.drawable.ic_tile_fieldlog)
        tile.state = if (recording) Tile.STATE_ACTIVE else Tile.STATE_INACTIVE
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            tile.subtitle = if (recording) "記録中" else "OFF"
        }
        tile.updateTile()
    }
}
