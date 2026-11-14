package com.tetheract.pm

import android.content.Context
import android.location.Location
import android.os.Build
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.security.MessageDigest
import java.util.Calendar
import java.util.Locale
import java.util.TimeZone
import java.util.UUID
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.roundToLong
import kotlin.math.sin
import kotlin.math.sqrt

/** 日付別フィールドログのサマリ情報 */
data class FieldLogDay(
    val date: String,
    val points: Int,
    val firstT: Long,
    val lastT: Long,
    val distanceM: Double,
    val bytes: Long,
    val uploaded: Boolean
)

/** フィールドログの記録・自動停止・自動削除設定 */
data class FieldLogSettings(
    val intervalSec: Int = 30,
    val autoStopHours: Int = 12,
    val autoDeleteDays: Int = 30
)

/**
 * フィールドログ（filesDir/fieldlog/YYYY-MM-DD.jsonl）の永続化・集計・送信状態を管理するストア。
 * ロッカー（filesDir/locker/）とは完全に分離し、DB には位置履歴を一切格納しない。
 */
class FieldLogStore private constructor(context: Context) {

    companion object {
        private const val TAG = "FieldLogStore"
        private const val DIR_NAME = "fieldlog"
        private const val UPLOAD_STATE_FILE = "upload_state.json"
        private const val FORMAT_VERSION = "tetheract-fieldlog-v1"
        private const val PREFS_NAME = "tetheract_fieldlog_store"
        private const val KEY_DEVICE_ID = "device_id"
        private const val KEY_INTERVAL_SEC = "interval_sec"
        private const val KEY_AUTO_STOP_HOURS = "auto_stop_hours"
        private const val KEY_AUTO_DELETE_DAYS = "auto_delete_days"

        private const val MAX_ACCURACY_METERS = 50f
        private const val STATIONARY_DIST_METERS = 5.0
        private const val STATIONARY_KEEPALIVE_MS = 300_000L

        private val DATE_REGEX = Regex("^\\d{4}-\\d{2}-\\d{2}$")
        private val DEVICE_ID_REGEX = Regex("^[0-9a-f-]{8,64}$")
        private val ALLOWED_AUTO_DELETE_DAYS = listOf(7, 30, 90)

        @Volatile
        private var instance: FieldLogStore? = null

        /** サービス・ブリッジ・アップローダが同じインスタンスを共有する（プロセス内シングルトン。全メソッドは内部で同期化する） */
        fun get(context: Context): FieldLogStore {
            return instance ?: synchronized(this) {
                instance ?: FieldLogStore(context.applicationContext).also { instance = it }
            }
        }
    }

    private val appContext: Context = context.applicationContext
    private val logDir: File = File(appContext.filesDir, DIR_NAME)
    private val uploadStateFile: File = File(logDir, UPLOAD_STATE_FILE)
    private val prefs = appContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    private val lock = Any()

    // 静止時の間引き判定用メモリキャッシュ
    private var hasLastPoint: Boolean = false
    private var lastPointDate: String = ""
    private var lastLat: Double = 0.0
    private var lastLon: Double = 0.0
    private var lastTimeMs: Long = 0L

    // 当日点数表示用の軽量キャッシュ
    private var cachedTodayDate: String = ""
    private var cachedTodayPoints: Int = 0

    /** 初回生成して永続化するランダム小文字 UUID を返す（ハードウェアID不使用） */
    fun deviceId(): String = synchronized(lock) {
        deviceIdLocked()
    }

    /** ヘッダやPC送信時に使用する端末表示名を返す */
    fun deviceName(): String = synchronized(lock) {
        resolveDeviceName()
    }

    /** 位置点を精度・静止フィルタに通した上で当日（ローカル日付）の JSONL に追記する */
    fun appendPoint(loc: Location) = synchronized(lock) {
        if (loc.latitude.isNaN() || loc.longitude.isNaN() || loc.latitude.isInfinite() || loc.longitude.isInfinite()) {
            return
        }
        if (loc.hasAccuracy() && loc.accuracy > MAX_ACCURACY_METERS) {
            return
        }

        val t = if (loc.time > 0L) loc.time else System.currentTimeMillis()
        val date = formatLocalDate(t)
        val targetFile = File(logDir, "$date.jsonl")
        if (!targetFile.exists() || targetFile.length() == 0L) {
            clearLastPointCacheLocked()
            if (cachedTodayDate == date) {
                cachedTodayDate = ""
                cachedTodayPoints = 0
            }
        }

        if (hasLastPoint && lastPointDate == date) {
            val movedMeters = haversineMeters(lastLat, lastLon, loc.latitude, loc.longitude)
            val elapsedMs = t - lastTimeMs
            if (movedMeters < STATIONARY_DIST_METERS && elapsedMs in 0L until STATIONARY_KEEPALIVE_MS) {
                return
            }
        }

        val dayFile = ensureDayFileWithHeaderLocked(date)
        val record = JSONObject()
            .put("type", "pt")
            .put("t", t)
            .put("tz", tzOffsetMinutes(t))
            .put("lat", loc.latitude)
            .put("lon", loc.longitude)

        if (loc.hasAccuracy() && !loc.accuracy.isNaN()) {
            record.put("acc", roundDecimals(loc.accuracy.toDouble(), 1))
        }
        if (loc.hasAltitude() && !loc.altitude.isNaN()) {
            record.put("alt", roundDecimals(loc.altitude, 1))
        }
        if (loc.hasSpeed() && !loc.speed.isNaN()) {
            record.put("spd", roundDecimals(loc.speed.toDouble(), 2))
        }
        val prov = loc.provider?.trim()?.lowercase(Locale.US) ?: ""
        if (prov.isNotEmpty()) {
            record.put("prov", prov)
        }

        appendLineLocked(dayFile, record.toString())

        hasLastPoint = true
        lastPointDate = date
        lastLat = loc.latitude
        lastLon = loc.longitude
        lastTimeMs = t

        if (cachedTodayDate == date) {
            cachedTodayPoints += 1
        } else {
            cachedTodayDate = date
            cachedTodayPoints = countPointsInFileLocked(dayFile)
        }
    }

    /** セッションの開始・終了イベントを当日（ローカル日付）の JSONL に追記する */
    fun appendSession(state: String, reason: String) = synchronized(lock) {
        val now = System.currentTimeMillis()
        val date = formatLocalDate(now)
        val dayFile = ensureDayFileWithHeaderLocked(date)
        val record = JSONObject()
            .put("type", "session")
            .put("t", now)
            .put("tz", tzOffsetMinutes(now))
            .put("state", state)
        if (reason.isNotEmpty()) {
            record.put("reason", reason)
        }
        appendLineLocked(dayFile, record.toString())
        // 再開直後の1点目が静止間引きで落ちないようキャッシュをリセット
        clearLastPointCacheLocked()
    }

    /** 保存済みの日別ログ一覧を新しい日付順で返す */
    fun listDays(): List<FieldLogDay> = synchronized(lock) {
        if (!logDir.exists()) return emptyList()
        val uploadMap = loadUploadStateLocked()
        val files = logDir.listFiles() ?: return emptyList()
        val days = mutableListOf<FieldLogDay>()

        for (file in files) {
            if (!file.isFile || !file.name.endsWith(".jsonl")) continue
            val date = file.name.removeSuffix(".jsonl")
            if (!DATE_REGEX.matches(date)) continue
            days.add(summarizeDayFileLocked(file, date, uploadMap))
        }
        days.sortedByDescending { it.date }
    }

    /** 指定した日付リストのログファイルを削除し、削除した日数を返す */
    fun deleteDays(dates: List<String>): Int = synchronized(lock) {
        deleteDaysLocked(dates)
    }

    /** すべてのフィールドログファイルと送信状態記録を削除し、削除した日数を返す */
    fun deleteAll(): Int = synchronized(lock) {
        var deleted = 0
        if (logDir.exists()) {
            val files = logDir.listFiles() ?: emptyArray()
            for (file in files) {
                if (!file.isFile || !file.name.endsWith(".jsonl")) continue
                val date = file.name.removeSuffix(".jsonl")
                if (!DATE_REGEX.matches(date)) continue
                if (file.delete()) {
                    deleted += 1
                }
            }
        }
        saveUploadStateLocked(mutableMapOf())
        clearLastPointCacheLocked()
        cachedTodayDate = ""
        cachedTodayPoints = 0
        deleted
    }

    /** 指定日の JSONL バイナリを読み込む（存在しない場合は null） */
    fun readDay(date: String): ByteArray? = synchronized(lock) {
        if (!DATE_REGEX.matches(date)) return null
        val file = File(logDir, "$date.jsonl")
        if (!file.exists() || !file.isFile) return null
        try {
            file.readBytes()
        } catch (e: Exception) {
            Log.w(TAG, "ログファイル読込失敗 ($date)", e)
            null
        }
    }

    /** 指定日の JSONL の SHA-256 ハッシュ（小文字 hex 64文字）を返す */
    fun sha256(date: String): String? = synchronized(lock) {
        if (!DATE_REGEX.matches(date)) return null
        val file = File(logDir, "$date.jsonl")
        if (!file.exists() || !file.isFile) return null
        sha256FileLocked(file)
    }

    /** 指定日の送信完了ハッシュを fieldlog/upload_state.json に記録する */
    fun markUploaded(date: String, sha256: String) = synchronized(lock) {
        if (!DATE_REGEX.matches(date)) return
        val cleanHash = sha256.trim().lowercase(Locale.US)
        if (cleanHash.isEmpty()) return
        val map = loadUploadStateLocked()
        map[date] = cleanHash
        saveUploadStateLocked(map)
    }

    /** 未送信、または送信後に追記されてハッシュが変化した日の昇順リストを返す */
    fun pendingUploadDates(): List<String> = synchronized(lock) {
        if (!logDir.exists()) return emptyList()
        val uploadMap = loadUploadStateLocked()
        val files = logDir.listFiles() ?: return emptyList()
        val pending = mutableListOf<String>()

        for (file in files) {
            if (!file.isFile || !file.name.endsWith(".jsonl")) continue
            val date = file.name.removeSuffix(".jsonl")
            if (!DATE_REGEX.matches(date)) continue
            val recordedSha = uploadMap[date]
            val currentSha = sha256FileLocked(file) ?: continue
            if (recordedSha == null || recordedSha != currentSha) {
                pending.add(date)
            }
        }
        pending.sorted()
    }

    /** 別ライブラリへ切り替える際、日別ログ本体は残したまま送信済み状態のみリセットする */
    fun resetUploadStateForSwitch() = synchronized(lock) {
        if (uploadStateFile.exists()) uploadStateFile.delete()
    }

    /** PC送信済み（現在の sha256 と一致）かつ autoDeleteDays 日より古いログを削除する */
    fun applyAutoDelete(nowMs: Long): Int = synchronized(lock) {
        val settings = loadSettingsLocked()
        if (settings.autoDeleteDays <= 0) return 0
        if (!logDir.exists()) return 0

        val cal = Calendar.getInstance(TimeZone.getDefault())
        cal.timeInMillis = nowMs
        cal.add(Calendar.DAY_OF_YEAR, -settings.autoDeleteDays)
        val cutoffDate = formatLocalDate(cal.timeInMillis)

        val uploadMap = loadUploadStateLocked()
        val files = logDir.listFiles() ?: return 0
        val targets = mutableListOf<String>()

        for (file in files) {
            if (!file.isFile || !file.name.endsWith(".jsonl")) continue
            val date = file.name.removeSuffix(".jsonl")
            if (!DATE_REGEX.matches(date)) continue
            if (date >= cutoffDate) continue
            val recordedSha = uploadMap[date] ?: continue
            val currentSha = sha256FileLocked(file) ?: continue
            if (currentSha == recordedSha) {
                targets.add(date)
            }
        }
        if (targets.isEmpty()) 0 else deleteDaysLocked(targets)
    }

    /** 現在の設定を読み込む */
    fun loadSettings(): FieldLogSettings = synchronized(lock) {
        loadSettingsLocked()
    }

    /** 設定を正規化して保存する */
    fun saveSettings(s: FieldLogSettings) = synchronized(lock) {
        val norm = normalizeSettings(s)
        prefs.edit()
            .putInt(KEY_INTERVAL_SEC, norm.intervalSec)
            .putInt(KEY_AUTO_STOP_HOURS, norm.autoStopHours)
            .putInt(KEY_AUTO_DELETE_DAYS, norm.autoDeleteDays)
            .apply()
    }

    /** 当日（端末ローカル日付）に記録された測位点（pt）の件数を返す */
    fun todayPoints(nowMs: Long = System.currentTimeMillis()): Int = synchronized(lock) {
        val today = formatLocalDate(nowMs)
        val file = File(logDir, "$today.jsonl")
        if (!file.exists() || !file.isFile) {
            cachedTodayDate = today
            cachedTodayPoints = 0
            return 0
        }
        if (cachedTodayDate != today) {
            cachedTodayDate = today
            cachedTodayPoints = countPointsInFileLocked(file)
        }
        cachedTodayPoints
    }

    private fun deviceIdLocked(): String {
        val saved = prefs.getString(KEY_DEVICE_ID, null)?.trim()?.lowercase(Locale.US)
        if (saved != null && DEVICE_ID_REGEX.matches(saved)) {
            return saved
        }
        val generated = UUID.randomUUID().toString().lowercase(Locale.US)
        prefs.edit().putString(KEY_DEVICE_ID, generated).apply()
        return generated
    }

    private fun resolveDeviceName(): String {
        val model = Build.MODEL?.trim().orEmpty()
        return model.ifEmpty { "Android" }
    }

    private fun loadSettingsLocked(): FieldLogSettings {
        val raw = FieldLogSettings(
            intervalSec = prefs.getInt(KEY_INTERVAL_SEC, 30),
            autoStopHours = prefs.getInt(KEY_AUTO_STOP_HOURS, 12),
            autoDeleteDays = prefs.getInt(KEY_AUTO_DELETE_DAYS, 30)
        )
        return normalizeSettings(raw)
    }

    private fun normalizeSettings(s: FieldLogSettings): FieldLogSettings {
        val interval = s.intervalSec.coerceIn(5, 300)
        val autoStop = s.autoStopHours.coerceIn(1, 24)
        val autoDelete = if (s.autoDeleteDays <= 0) {
            0
        } else {
            ALLOWED_AUTO_DELETE_DAYS.minByOrNull { abs(it - s.autoDeleteDays) } ?: 30
        }
        return FieldLogSettings(
            intervalSec = interval,
            autoStopHours = autoStop,
            autoDeleteDays = autoDelete
        )
    }

    private fun ensureDayFileWithHeaderLocked(date: String): File {
        if (!logDir.exists()) {
            logDir.mkdirs()
        }
        val file = File(logDir, "$date.jsonl")
        if (!file.exists() || file.length() == 0L) {
            val header = JSONObject()
                .put("type", "header")
                .put("format", FORMAT_VERSION)
                .put("device_id", deviceIdLocked())
                .put("device_name", resolveDeviceName())
                .put("date", date)
            try {
                FileOutputStream(file, false).use { fos ->
                    fos.write((header.toString() + "\n").toByteArray(Charsets.UTF_8))
                    fos.flush()
                }
            } catch (e: Exception) {
                Log.e(TAG, "ヘッダ行の書き込みに失敗しました ($date)", e)
            }
        }
        return file
    }

    private fun appendLineLocked(file: File, jsonLine: String) {
        try {
            FileOutputStream(file, true).use { fos ->
                fos.write((jsonLine + "\n").toByteArray(Charsets.UTF_8))
                fos.flush()
            }
        } catch (e: Exception) {
            Log.e(TAG, "ログ行の追記に失敗しました (${file.name})", e)
        }
    }

    private fun deleteDaysLocked(dates: List<String>): Int {
        val uploadMap = loadUploadStateLocked()
        var deleted = 0
        var stateChanged = false

        for (rawDate in dates) {
            val date = rawDate.trim()
            if (!DATE_REGEX.matches(date)) continue
            val file = File(logDir, "$date.jsonl")
            if (file.exists() && file.delete()) {
                deleted += 1
            }
            if (uploadMap.remove(date) != null) {
                stateChanged = true
            }
            if (lastPointDate == date) {
                clearLastPointCacheLocked()
            }
            if (cachedTodayDate == date) {
                cachedTodayDate = ""
                cachedTodayPoints = 0
            }
        }
        if (stateChanged) {
            saveUploadStateLocked(uploadMap)
        }
        return deleted
    }

    private fun clearLastPointCacheLocked() {
        hasLastPoint = false
        lastPointDate = ""
        lastLat = 0.0
        lastLon = 0.0
        lastTimeMs = 0L
    }

    private fun summarizeDayFileLocked(file: File, date: String, uploadMap: Map<String, String>): FieldLogDay {
        var points = 0
        var firstT = 0L
        var lastT = 0L
        var distanceM = 0.0
        var hasPrevPt = false
        var prevLat = 0.0
        var prevLon = 0.0

        try {
            file.bufferedReader(Charsets.UTF_8).useLines { lines ->
                for (rawLine in lines) {
                    val line = rawLine.trim()
                    if (line.isEmpty()) continue
                    val obj = try {
                        JSONObject(line)
                    } catch (_: Exception) {
                        // 最終行の途中切れ等の不正行は無視して続行する
                        continue
                    }
                    if (obj.optString("type", "") != "pt") {
                        // header / session / mark などは読み飛ばす
                        continue
                    }
                    val lat = obj.optDouble("lat", Double.NaN)
                    val lon = obj.optDouble("lon", Double.NaN)
                    val t = obj.optLong("t", 0L)
                    if (lat.isNaN() || lon.isNaN() || lat.isInfinite() || lon.isInfinite()) continue

                    points += 1
                    if (t > 0L) {
                        if (firstT == 0L || t < firstT) firstT = t
                        if (t > lastT) lastT = t
                    }
                    if (hasPrevPt) {
                        distanceM += haversineMeters(prevLat, prevLon, lat, lon)
                    }
                    hasPrevPt = true
                    prevLat = lat
                    prevLon = lon
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "日別ログ集計中に読込警告 (${file.name})", e)
        }

        val recordedSha = uploadMap[date]
        val isUploaded = recordedSha != null && sha256FileLocked(file) == recordedSha
        return FieldLogDay(
            date = date,
            points = points,
            firstT = firstT,
            lastT = lastT,
            distanceM = roundDecimals(distanceM, 1),
            bytes = file.length(),
            uploaded = isUploaded
        )
    }

    private fun countPointsInFileLocked(file: File): Int {
        var count = 0
        try {
            file.bufferedReader(Charsets.UTF_8).useLines { lines ->
                for (rawLine in lines) {
                    val line = rawLine.trim()
                    if (line.isEmpty()) continue
                    val obj = try {
                        JSONObject(line)
                    } catch (_: Exception) {
                        continue
                    }
                    if (obj.optString("type", "") == "pt") {
                        count += 1
                    }
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "当日点数カウント警告 (${file.name})", e)
        }
        return count
    }

    private fun sha256FileLocked(file: File): String? {
        return try {
            val md = MessageDigest.getInstance("SHA-256")
            val buf = ByteArray(16 * 1024)
            FileInputStream(file).use { fis ->
                while (true) {
                    val read = fis.read(buf)
                    if (read <= 0) break
                    md.update(buf, 0, read)
                }
            }
            val digest = md.digest()
            val sb = StringBuilder(digest.size * 2)
            for (b in digest) {
                sb.append(String.format(Locale.US, "%02x", b))
            }
            sb.toString()
        } catch (e: Exception) {
            Log.w(TAG, "SHA-256 算出失敗 (${file.name})", e)
            null
        }
    }

    private fun loadUploadStateLocked(): MutableMap<String, String> {
        val result = mutableMapOf<String, String>()
        if (!uploadStateFile.exists() || !uploadStateFile.isFile) return result
        try {
            val raw = uploadStateFile.readText(Charsets.UTF_8)
            if (raw.isBlank()) return result
            val root = JSONObject(raw)
            val target = root.optJSONObject("uploaded") ?: root
            val keys = target.keys()
            while (keys.hasNext()) {
                val k = keys.next()
                if (DATE_REGEX.matches(k)) {
                    val v = target.optString(k, "").trim().lowercase(Locale.US)
                    if (v.isNotEmpty()) result[k] = v
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "upload_state.json の読込失敗のため初期化します", e)
        }
        return result
    }

    private fun saveUploadStateLocked(map: Map<String, String>) {
        try {
            if (!logDir.exists()) {
                logDir.mkdirs()
            }
            val uploadedObj = JSONObject()
            for ((date, sha) in map.toSortedMap()) {
                uploadedObj.put(date, sha)
            }
            val root = JSONObject().put("uploaded", uploadedObj)
            val payload = (root.toString(2) + "\n").toByteArray(Charsets.UTF_8)
            val tmpFile = File(logDir, "$UPLOAD_STATE_FILE.tmp")
            FileOutputStream(tmpFile, false).use { fos ->
                fos.write(payload)
                fos.flush()
            }
            if (!tmpFile.renameTo(uploadStateFile)) {
                FileOutputStream(uploadStateFile, false).use { fos ->
                    fos.write(payload)
                    fos.flush()
                }
                tmpFile.delete()
            }
        } catch (e: Exception) {
            Log.e(TAG, "upload_state.json の保存失敗", e)
        }
    }

    private fun formatLocalDate(epochMs: Long): String {
        val cal = Calendar.getInstance(TimeZone.getDefault())
        cal.timeInMillis = epochMs
        val year = cal.get(Calendar.YEAR)
        val month = cal.get(Calendar.MONTH) + 1
        val day = cal.get(Calendar.DAY_OF_MONTH)
        return String.format(Locale.US, "%04d-%02d-%02d", year, month, day)
    }

    private fun tzOffsetMinutes(epochMs: Long): Int {
        return TimeZone.getDefault().getOffset(epochMs) / 60_000
    }

    private fun haversineMeters(lat1: Double, lon1: Double, lat2: Double, lon2: Double): Double {
        val earthRadiusM = 6_371_000.0
        val dLat = Math.toRadians(lat2 - lat1)
        val dLon = Math.toRadians(lon2 - lon1)
        val sinLat = sin(dLat / 2.0)
        val sinLon = sin(dLon / 2.0)
        val a = sinLat * sinLat +
            cos(Math.toRadians(lat1)) * cos(Math.toRadians(lat2)) * sinLon * sinLon
        val c = 2.0 * atan2(sqrt(a), sqrt((1.0 - a).coerceAtLeast(0.0)))
        return earthRadiusM * c
    }

    private fun roundDecimals(value: Double, decimals: Int): Double {
        var factor = 1.0
        repeat(decimals) { factor *= 10.0 }
        return (value * factor).roundToLong().toDouble() / factor
    }
}
