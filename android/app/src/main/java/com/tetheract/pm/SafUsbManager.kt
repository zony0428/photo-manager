package com.tetheract.pm

import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.util.Log
import androidx.documentfile.provider.DocumentFile
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.util.Arrays
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap

/**
 * Android SAF (Storage Access Framework) を用いて USB メモリ内の Loome 保管庫を
 * 完全読み取り専用（Read-Only）でマウントし、エシカル保護・Lv.2 オンメモリ復号ストリーム供給を行うクラス。
 */
class SafUsbManager(
    private val context: Context,
    private val lockerDbManager: LockerDatabaseManager
) {

    companion object {
        private const val TAG = "SafUsbManager"
        private const val PREFS_NAME = "tetheract_saf_prefs"
        private const val KEY_USB_TREE_URI = "usb_tree_uri"
        private val SKIP_SUBDIR_NAMES = setOf(
            "cache", "python", "frontend", "server", "android", "models",
            "licenses", "docs", "tests", "launcher", ".git", ".agents",
            "system volume information", "\$recycle.bin"
        )
        private val RAW_EXTENSIONS = setOf(
            ".rw2", ".arw", ".srf", ".sr2", ".arq", ".cr2", ".cr3", ".crw", ".nef", ".nrw", ".dng",
            ".raf", ".orf", ".pef", ".srw", ".x3f", ".erf", ".3fr", ".fff",
            ".iiq", ".rwl", ".mrw", ".kdc", ".dcr"
        )

        fun isRawFileName(name: String): Boolean {
            val clean = name.substringAfterLast('/').substringAfterLast(':')
            val dot = clean.lastIndexOf('.')
            if (dot < 0) return false
            return clean.substring(dot).lowercase(Locale.US) in RAW_EXTENSIONS
        }

        private const val INITIAL_RAW_HEADER_BYTES = 2 * 1024 * 1024
        private const val MAX_RAW_PREVIEW_BYTES = 24 * 1024 * 1024
        private const val MAX_RAW_SCAN_WINDOW_BYTES = 16 * 1024 * 1024

        /**
         * 各社カメラ RAW ストリームからファイル全体（40〜100MB）をヒープ展開せず、
         * 先頭ヘッダ枠と前方スキップのみで最大埋め込み JPEG プレビューを省メモリ高速抽出する。
         * 1. TIFF IFDツリー (Sony ARW / Nikon NEF / Canon CR2 / DNG / RW2 / ORF / PEF):
         *    先頭2MB窓から候補 (offset, length) を収集し、ストリームを前方スキップして対象JPEG範囲のみ読み出す。
         * 2. Fujifilm RAF: 先頭92バイトの埋め込みJPEGオフセット・サイズヘッダから直接読み出す。
         * 3. 非TIFF形式 (CR3 / X3F 等): 最大16MB上限のプレフィックス窓で JPEG SOI〜EOI を走査する。
         */
        fun extractEmbeddedJpegFromRawStream(input: InputStream): ByteArray? {
            val prefix = readUpToBytes(input, INITIAL_RAW_HEADER_BYTES)
            if (prefix.size < 4096) return null
            var streamPos = prefix.size.toLong()

            // 1. Fujifilm RAF 固定ヘッダ ("FUJIFILMCCD-RAW ") の直接オフセット抽出
            if (prefix.size >= 92 &&
                prefix[0] == 'F'.code.toByte() && prefix[1] == 'U'.code.toByte() &&
                prefix[2] == 'J'.code.toByte() && prefix[3] == 'I'.code.toByte() &&
                prefix[4] == 'F'.code.toByte() && prefix[5] == 'I'.code.toByte()
            ) {
                val rafOff = readBeInt(prefix, 84)
                val rafLen = readBeInt(prefix, 88)
                if (rafOff >= 92 && rafLen in 4096..MAX_RAW_PREVIEW_BYTES) {
                    val (slice, nextPos) = readCandidateSliceFromStream(input, prefix, streamPos, rafOff, rafLen)
                    streamPos = nextPos
                    if (slice != null && slice.size >= 4096) {
                        val soi = findJpegSoiWithin64(slice, 0, slice.size)
                        if (soi >= 0) {
                            return if (soi == 0) slice else slice.copyOfRange(soi, slice.size)
                        }
                    }
                }
            }

            // 2. TIFF ベース RAW (II / MM) の IFD オフセット範囲読み出し
            val isTiff = (prefix[0] == 'I'.code.toByte() && prefix[1] == 'I'.code.toByte()) ||
                (prefix[0] == 'M'.code.toByte() && prefix[1] == 'M'.code.toByte())
            if (isTiff) {
                val (tiffPreview, nextPos) = extractTiffIfdPreviewFromStream(input, prefix, streamPos)
                streamPos = nextPos
                if (tiffPreview != null) return tiffPreview
            }

            // 3. CR3 等の非TIFF形式またはフォールバック: ストリーム先頭が未消費の場合のみ上限16MBまで拡張して走査
            val scanBuf = if (streamPos == prefix.size.toLong() && prefix.size == INITIAL_RAW_HEADER_BYTES) {
                val extra = readUpToBytes(input, MAX_RAW_SCAN_WINDOW_BYTES - prefix.size)
                if (extra.isEmpty()) prefix else prefix + extra
            } else {
                prefix
            }
            return scanLargestJpegInBuffer(scanBuf)
        }

        private fun readUpToBytes(input: InputStream, maxBytes: Int): ByteArray {
            if (maxBytes <= 0) return ByteArray(0)
            val out = ByteArrayOutputStream(minOf(maxBytes, 262_144))
            val chunk = ByteArray(32_768)
            var remaining = maxBytes
            while (remaining > 0) {
                val n = input.read(chunk, 0, minOf(chunk.size, remaining))
                if (n <= 0) break
                out.write(chunk, 0, n)
                remaining -= n
            }
            return out.toByteArray()
        }

        private fun readExactBytes(input: InputStream, targetLen: Int): ByteArray {
            if (targetLen <= 0) return ByteArray(0)
            val buf = ByteArray(targetLen)
            var filled = 0
            while (filled < targetLen) {
                val n = input.read(buf, filled, targetLen - filled)
                if (n <= 0) return buf.copyOf(filled)
                filled += n
            }
            return buf
        }

        private fun skipStreamBytes(input: InputStream, bytesToSkip: Long): Long {
            if (bytesToSkip <= 0L) return 0L
            var remaining = bytesToSkip
            val scratch = ByteArray(16_384)
            while (remaining > 0L) {
                val skipped = input.skip(remaining)
                if (skipped > 0L) {
                    remaining -= skipped
                    continue
                }
                val readN = input.read(scratch, 0, minOf(scratch.size.toLong(), remaining).toInt())
                if (readN <= 0) break
                remaining -= readN.toLong()
            }
            return bytesToSkip - remaining
        }

        private fun readBeInt(buf: ByteArray, off: Int): Int {
            if (off < 0 || off + 4 > buf.size) return 0
            return ((buf[off].toInt() and 0xFF) shl 24) or
                ((buf[off + 1].toInt() and 0xFF) shl 16) or
                ((buf[off + 2].toInt() and 0xFF) shl 8) or
                (buf[off + 3].toInt() and 0xFF)
        }

        private fun findJpegSoiWithin64(buf: ByteArray, startOff: Int, maxLen: Int): Int {
            val probeEnd = minOf(startOff + 64, startOff + maxLen - 3, buf.size - 3)
            for (p in startOff until probeEnd) {
                if ((buf[p].toInt() and 0xFF) == 0xFF &&
                    (buf[p + 1].toInt() and 0xFF) == 0xD8 &&
                    (buf[p + 2].toInt() and 0xFF) == 0xFF
                ) {
                    return p
                }
            }
            return -1
        }

        /**
         * 先頭 prefix と前進専用 InputStream を組み合わせて指定 [off, off + len) 範囲を読み出す。
         * 先頭64バイトに JPEG SOI が無い非JPEGストリップ（RAWセンサーデータ等）は64バイト確認時点で即スキップする。
         */
        private fun readCandidateSliceFromStream(
            input: InputStream,
            prefix: ByteArray,
            currentStreamPos: Long,
            off: Int,
            len: Int
        ): Pair<ByteArray?, Long> {
            if (off < 0 || len <= 1024 || len > MAX_RAW_PREVIEW_BYTES) return null to currentStreamPos
            val endOff = off.toLong() + len.toLong()

            if (endOff <= prefix.size.toLong()) {
                val soi = findJpegSoiWithin64(prefix, off, len)
                if (soi < 0) return null to currentStreamPos
                return prefix.copyOfRange(soi, off + len) to currentStreamPos
            }

            var streamPos = currentStreamPos
            if (off < prefix.size) {
                if (streamPos != prefix.size.toLong()) return null to streamPos
                if (off + 64 <= prefix.size && findJpegSoiWithin64(prefix, off, len) < 0) {
                    return null to streamPos
                }
                val headLen = prefix.size - off
                val tailLen = len - headLen
                val tail = readExactBytes(input, tailLen)
                streamPos += tail.size.toLong()
                if (tail.isEmpty()) return null to streamPos
                val combined = ByteArray(headLen + tail.size)
                System.arraycopy(prefix, off, combined, 0, headLen)
                System.arraycopy(tail, 0, combined, headLen, tail.size)
                val soi = findJpegSoiWithin64(combined, 0, combined.size)
                if (soi < 0) return null to streamPos
                return (if (soi == 0) combined else combined.copyOfRange(soi, combined.size)) to streamPos
            }

            if (off.toLong() < streamPos) return null to streamPos
            val toSkip = off.toLong() - streamPos
            val skipped = skipStreamBytes(input, toSkip)
            streamPos += skipped
            if (skipped < toSkip) return null to streamPos

            val probeLen = minOf(64, len)
            val probe = readExactBytes(input, probeLen)
            streamPos += probe.size.toLong()
            if (probe.size < 4) return null to streamPos
            val soiInProbe = findJpegSoiWithin64(probe, 0, probe.size)
            if (soiInProbe < 0) return null to streamPos

            val restLen = len - probe.size
            val rest = readExactBytes(input, restLen)
            streamPos += rest.size.toLong()
            val keepHead = probe.size - soiInProbe
            val result = ByteArray(keepHead + rest.size)
            System.arraycopy(probe, soiInProbe, result, 0, keepHead)
            System.arraycopy(rest, 0, result, keepHead, rest.size)
            return result to streamPos
        }

        private fun scanLargestJpegInBuffer(data: ByteArray): ByteArray? {
            if (data.size < 4096) return null
            var bestStart = -1
            var bestLen = 0
            var bestArea = 0
            var pos = 0
            val limit = data.size - 4

            while (pos < limit) {
                if ((data[pos].toInt() and 0xFF) != 0xFF ||
                    (data[pos + 1].toInt() and 0xFF) != 0xD8 ||
                    (data[pos + 2].toInt() and 0xFF) != 0xFF
                ) {
                    pos++
                    continue
                }
                val third = data[pos + 3].toInt() and 0xFF
                if (third !in 0xC0..0xFE || third == 0xD8 || third == 0xD9) {
                    pos += 2
                    continue
                }

                val eoiEnd = findJpegEndAfterSos(data, pos)
                if (eoiEnd > pos + 8192) {
                    val candLen = eoiEnd - pos
                    val opts = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                    BitmapFactory.decodeByteArray(data, pos, candLen, opts)
                    val area = opts.outWidth * opts.outHeight
                    if (opts.outWidth >= 320 && opts.outHeight >= 240 && (area > bestArea || (area == bestArea && candLen > bestLen))) {
                        bestArea = area
                        bestStart = pos
                        bestLen = candLen
                    }
                    pos = eoiEnd
                } else {
                    pos += 2
                }
            }

            if (bestStart >= 0 && bestLen > 0) {
                return data.copyOfRange(bestStart, bestStart + bestLen)
            }
            return null
        }

        fun decodeRawPreviewThumbnailBytes(resolver: ContentResolver, docUri: Uri): ByteArray? {
            return try {
                val rawJpeg = resolver.openInputStream(docUri)?.use { extractEmbeddedJpegFromRawStream(it) } ?: return null
                val boundsOpt = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeByteArray(rawJpeg, 0, rawJpeg.size, boundsOpt)
                val w = boundsOpt.outWidth
                val h = boundsOpt.outHeight
                if (w <= 0 || h <= 0) return null
                var sample = 1
                while (maxOf(w, h) / sample > 480) sample *= 2
                val bmp = BitmapFactory.decodeByteArray(rawJpeg, 0, rawJpeg.size, BitmapFactory.Options().apply { inSampleSize = sample }) ?: return null
                val out = ByteArrayOutputStream()
                bmp.compress(Bitmap.CompressFormat.JPEG, 80, out)
                bmp.recycle()
                out.toByteArray()
            } catch (_: Exception) { null }
        }

        private fun extractTiffIfdPreviewFromStream(
            input: InputStream,
            header: ByteArray,
            initialStreamPos: Long
        ): Pair<ByteArray?, Long> {
            val n = header.size
            if (n < 64) return null to initialStreamPos
            val isLe = (header[0] == 'I'.code.toByte() && header[1] == 'I'.code.toByte())
            val isBe = (header[0] == 'M'.code.toByte() && header[1] == 'M'.code.toByte())
            if (!isLe && !isBe) return null to initialStreamPos

            fun u16(off: Int): Int {
                if (off < 0 || off + 2 > n) return 0
                val b0 = header[off].toInt() and 0xFF
                val b1 = header[off + 1].toInt() and 0xFF
                return if (isLe) (b0 or (b1 shl 8)) else ((b0 shl 8) or b1)
            }

            fun u32(off: Int): Int {
                if (off < 0 || off + 4 > n) return 0
                val b0 = header[off].toInt() and 0xFF
                val b1 = header[off + 1].toInt() and 0xFF
                val b2 = header[off + 2].toInt() and 0xFF
                val b3 = header[off + 3].toInt() and 0xFF
                return if (isLe) (b0 or (b1 shl 8) or (b2 shl 16) or (b3 shl 24))
                else ((b0 shl 24) or (b1 shl 16) or (b2 shl 8) or b3)
            }

            val queue = ArrayDeque<Int>()
            val visited = HashSet<Int>()
            val firstIfd = u32(4)
            if (firstIfd in 8 until n) queue.add(firstIfd)

            val candidates = mutableListOf<Pair<Int, Int>>()

            while (queue.isNotEmpty() && visited.size < 24) {
                val ifdOff = queue.removeFirst()
                if (ifdOff <= 0 || ifdOff + 2 > n || !visited.add(ifdOff)) continue
                val count = u16(ifdOff)
                if (count <= 0 || count > 512 || ifdOff + 2 + count * 12 > n) continue

                var jpegOff = 0
                var jpegLen = 0
                var stripOff = 0
                var stripLen = 0

                for (i in 0 until count) {
                    val eOff = ifdOff + 2 + i * 12
                    val tag = u16(eOff)
                    val typ = u16(eOff + 2)
                    val cnt = u32(eOff + 4)
                    val valOff = eOff + 8
                    val scalar = if (typ == 3 && cnt == 1) u16(valOff) else u32(valOff)

                    when (tag) {
                        0x0201 -> jpegOff = scalar
                        0x0202 -> jpegLen = scalar
                        0x0111 -> if (cnt == 1) stripOff = scalar
                        0x0117 -> if (cnt == 1) stripLen = scalar
                        0x002E, 0x2001 -> if (cnt in 1025..MAX_RAW_PREVIEW_BYTES && scalar > 0) candidates.add(scalar to cnt)
                        0x014A, 0x8769 -> {
                            if (cnt == 1 && scalar in 8 until n) {
                                queue.add(scalar)
                            } else if (cnt in 2..16 && scalar > 0 && scalar + cnt * 4 <= n) {
                                for (k in 0 until cnt) {
                                    val sub = u32(scalar + k * 4)
                                    if (sub in 8 until n) queue.add(sub)
                                }
                            }
                        }
                    }
                }

                if (jpegOff > 0 && jpegLen in 1025..MAX_RAW_PREVIEW_BYTES) candidates.add(jpegOff to jpegLen)
                if (stripOff > 0 && stripLen in 1025..MAX_RAW_PREVIEW_BYTES) candidates.add(stripOff to stripLen)

                val nextIfd = u32(ifdOff + 2 + count * 12)
                if (nextIfd in 8 until n) queue.add(nextIfd)
            }

            if (candidates.isEmpty()) return null to initialStreamPos

            var streamPos = initialStreamPos
            var bestBytes: ByteArray? = null
            var bestArea = 0

            // まず既に header (先頭2MB) 内に収まっている候補をI/Oゼロで評価し、十分大きければ即返却する
            val inHeader = candidates.distinct().filter { (off, len) -> off.toLong() + len.toLong() <= header.size.toLong() }
            for ((off, len) in inHeader.sortedByDescending { it.second }) {
                val soi = findJpegSoiWithin64(header, off, len)
                if (soi < 0) continue
                val actualLen = len - (soi - off)
                val opts = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeByteArray(header, soi, actualLen, opts)
                val area = opts.outWidth * opts.outHeight
                if (area > bestArea) {
                    bestArea = area
                    bestBytes = header.copyOfRange(soi, soi + actualLen)
                    if (maxOf(opts.outWidth, opts.outHeight) >= 1600) {
                        return bestBytes to streamPos
                    }
                }
            }

            // header 外にある候補をオフセット昇順で前方スキップしながら読み出す
            val beyondHeader = candidates.distinct()
                .filter { (off, len) -> off.toLong() + len.toLong() > header.size.toLong() }
                .sortedBy { it.first }
            for ((off, len) in beyondHeader) {
                val (slice, nextPos) = readCandidateSliceFromStream(input, header, streamPos, off, len)
                streamPos = nextPos
                if (slice == null || slice.size < 1024) continue
                val opts = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeByteArray(slice, 0, slice.size, opts)
                val area = opts.outWidth * opts.outHeight
                if (area > bestArea) {
                    bestArea = area
                    bestBytes = slice
                    if (maxOf(opts.outWidth, opts.outHeight) >= 1600) break
                }
            }

            return bestBytes to streamPos
        }

        private fun findJpegEndAfterSos(data: ByteArray, soiPos: Int): Int {
            var p = soiPos + 2
            val n = data.size
            var sawSos = false
            while (p + 2 <= n) {
                if ((data[p].toInt() and 0xFF) != 0xFF) {
                    if (!sawSos) return -1
                    var s = p
                    var foundNextMarker = false
                    while (s + 1 < n) {
                        if ((data[s].toInt() and 0xFF) == 0xFF) {
                            val nxt = data[s + 1].toInt() and 0xFF
                            if (nxt == 0x00 || nxt == 0xFF || nxt in 0xD0..0xD7) {
                                s += 2
                                continue
                            }
                            if (nxt == 0xD9) return s + 2
                            p = s
                            foundNextMarker = true
                            break
                        }
                        s++
                    }
                    if (!foundNextMarker) return -1
                }
                while (p < n && (data[p].toInt() and 0xFF) == 0xFF) p++
                if (p >= n) return -1
                val marker = data[p].toInt() and 0xFF
                p++
                if (marker == 0xD9) return if (sawSos) p else -1
                if (marker == 0x00 || marker == 0xD8) return -1
                if (marker in 0xD0..0xD7 || marker == 0x01) continue
                if (p + 2 > n) return -1
                val segLen = ((data[p].toInt() and 0xFF) shl 8) or (data[p + 1].toInt() and 0xFF)
                if (segLen < 2 || p + segLen > n) return -1
                p += segLen
                if (marker == 0xDA) sawSos = true
            }
            return -1
        }
    }

    private val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    private val mountLock = Any()
    private val dirChildCache = ConcurrentHashMap<String, Map<String, DocumentFile>>()
    private val photoDocCache = ConcurrentHashMap<Long, DocumentFile>()

    @Volatile
    private var cachedLoomeDirUri: String = ""

    @Volatile
    private var cachedSealJson: JSONObject? = null

    @Volatile
    private var unlockedSealIdentity: String = ""

    @Volatile
    private var cachedUsbConnected: Boolean = false

    @Volatile
    private var cachedUsbFolderName: String = ""

    @Volatile
    private var cachedUsbVsn: String = ""

    /** 記憶されている USB フォルダの SAF Tree URI を返す */
    fun getSavedUsbTreeUri(): Uri? {
        val raw = prefs.getString(KEY_USB_TREE_URI, null) ?: return null
        return try { Uri.parse(raw) } catch (_: Exception) { null }
    }

    /** UIスレッドや同期JNIをブロックせずに直近キャッシュ済みのUSB接続状態を返す */
    fun isUsbConnectedCached(): Boolean = cachedUsbConnected

    /** UIスレッドや同期JNIをブロックせずに直近キャッシュ済みのUSBフォルダ表示名を返す */
    fun getUsbFolderDisplayNameCached(): String =
        cachedUsbFolderName.ifEmpty { lockerDbManager.readLockerMeta().optString("usb_folder_name", "") }

    /** UIスレッドをブロックせずに現在マウント中USB LoomeのVSN（シリアル）を返す */
    fun getMountedUsbVsnCached(): String = cachedUsbVsn

    /** バックグラウンドスレッド上でSAF DocumentFile接続状態を再確認してキャッシュを更新する */
    fun refreshUsbConnectionState(): Boolean = getConnectedUsbRootDocument() != null

    /** 現在 USB メモリが接続されており、記憶済み SAF フォルダに読み取りアクセス可能か判定する */
    fun getConnectedUsbRootDocument(): DocumentFile? {
        val uri = getSavedUsbTreeUri() ?: run {
            cachedUsbConnected = false
            return null
        }
        return try {
            val hasPerm = context.contentResolver.persistedUriPermissions.any { it.uri == uri && it.isReadPermission }
            if (!hasPerm) {
                cachedUsbConnected = false
                LoomeVaultCrypto.clearMemoryKeys()
                return null
            }
            val doc = DocumentFile.fromTreeUri(context, uri)
            val valid = doc != null && doc.exists() && doc.canRead()
            cachedUsbConnected = valid
            if (valid && doc != null) {
                val docName = doc.name?.trim().orEmpty()
                if (docName.isNotEmpty()) cachedUsbFolderName = docName
                doc
            } else {
                LoomeVaultCrypto.clearMemoryKeys()
                null
            }
        } catch (e: Exception) {
            cachedUsbConnected = false
            LoomeVaultCrypto.clearMemoryKeys()
            Log.w(TAG, "USBルートDocument確認失敗", e)
            null
        }
    }

    fun isUsbConnected(): Boolean = getConnectedUsbRootDocument() != null

    fun getUsbFolderDisplayName(): String {
        val doc = getConnectedUsbRootDocument()
        if (doc != null && !doc.name.isNullOrEmpty()) return doc.name ?: "Loome USB"
        return getUsbFolderDisplayNameCached()
    }

    /** ACTION_OPEN_DOCUMENT_TREE で選択された USB フォルダ URI の読み取り永続権限を取得し、Loome をマウントする */
    fun onUsbTreeSelected(treeUri: Uri): JSONObject {
        return try {
            try {
                context.contentResolver.takePersistableUriPermission(treeUri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
            } catch (_: Exception) {
                context.contentResolver.takePersistableUriPermission(
                    treeUri,
                    Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                )
            }
            prefs.edit().putString(KEY_USB_TREE_URI, treeUri.toString()).apply()
            clearUsbLookupCache()
            mountConnectedLoome()
        } catch (e: Exception) {
            Log.e(TAG, "SAF永続権限取得エラー", e)
            JSONObject().put("ok", false).put("error", e.message ?: "Failed to take persistable URI permission")
        }
    }

    /** 選択された USB ルート DocumentFile から Loome（または storage）ディレクトリを探索する */
    fun findLoomeDirectory(rootDoc: DocumentFile): DocumentFile? {
        val rootName = (rootDoc.name ?: "").trim()
        if (rootName.equals("Loome", ignoreCase = true) ||
            rootName.equals("storage", ignoreCase = true) ||
            rootDoc.findFile(".loome_seal")?.isFile == true
        ) {
            return rootDoc
        }
        for (dirName in arrayOf("Loome", "storage")) {
            val direct = rootDoc.findFile(dirName)
            if (direct != null && direct.isDirectory && direct.canRead()) return direct
        }
        return try {
            for (child in rootDoc.listFiles()) {
                if (!child.isDirectory) continue
                val childName = (child.name ?: "").lowercase(Locale.US)
                if (childName.isEmpty() || childName.startsWith(".") || childName in SKIP_SUBDIR_NAMES) continue
                for (dirName in arrayOf("Loome", "storage")) {
                    val nested = child.findFile(dirName)
                    if (nested != null && nested.isDirectory && nested.canRead()) return nested
                }
            }
            null
        } catch (e: Exception) {
            Log.w(TAG, "サブフォルダからの Loome 探索警告", e)
            null
        }
    }

    private fun hasCatalogDbFile(dir: DocumentFile): Boolean {
        val libDoc = dir.findFile("library.db")
        if (libDoc != null && libDoc.isFile && libDoc.canRead()) return true
        val deltaDoc = dir.findFile("mobile_delta.db")
        return deltaDoc != null && deltaDoc.isFile && deltaDoc.canRead()
    }

    /** 選択された USB ルート DocumentFile から読み取り専用の cache ディレクトリを探索する */
    fun findCacheDirectory(rootDoc: DocumentFile): DocumentFile? {
        if (!rootDoc.isDirectory || !rootDoc.canRead()) return null
        val rootName = (rootDoc.name ?: "").trim()
        if (rootName.equals("cache", ignoreCase = true) && hasCatalogDbFile(rootDoc)) {
            return rootDoc
        }
        val directCache = rootDoc.findFile("cache")
        if (directCache != null && directCache.isDirectory && directCache.canRead() && hasCatalogDbFile(directCache)) {
            return directCache
        }
        return try {
            for (child in rootDoc.listFiles()) {
                if (!child.isDirectory || !child.canRead()) continue
                val childName = (child.name ?: "").lowercase(Locale.US)
                if (childName.isEmpty() || childName.startsWith(".") || childName in SKIP_SUBDIR_NAMES) continue
                val nestedCache = child.findFile("cache")
                if (nestedCache != null && nestedCache.isDirectory && nestedCache.canRead() && hasCatalogDbFile(nestedCache)) {
                    return nestedCache
                }
            }
            null
        } catch (e: Exception) {
            Log.w(TAG, "サブフォルダからの cache 探索警告", e)
            null
        }
    }

    private fun readLoomeSealJson(rootDoc: DocumentFile, loomeDir: DocumentFile?): JSONObject? {
        val sealDoc = loomeDir?.findFile(".loome_seal")?.takeIf { it.isFile }
            ?: rootDoc.findFile(".loome_seal")?.takeIf { it.isFile }
            ?: return null
        return try {
            val txt = context.contentResolver.openInputStream(sealDoc.uri)
                ?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: return null
            JSONObject(txt)
        } catch (e: Exception) {
            Log.w(TAG, ".loome_seal 読み取り失敗", e)
            null
        }
    }

    /** 接続中の USB ドライブ上の Loome を読み取り専用でマウントし、エシカル保護および Lv.2 ロック判定を行う */
    fun mountConnectedLoome(): JSONObject = synchronized(mountLock) {
        val rootDoc = getConnectedUsbRootDocument()
            ?: return JSONObject().put("ok", false).put("usbConnected", false).put("reason", "usb_not_connected")

        val loomeDir = findLoomeDirectory(rootDoc)
        val seal = readLoomeSealJson(rootDoc, loomeDir)
        val sealOwner = seal?.optString("owner_id", "")?.trim() ?: ""
        val sealVsn = seal?.optString("vsn", "")?.trim()?.uppercase(Locale.US) ?: ""
        val secLevel = seal?.optInt("security_level", 0) ?: 0

        val pwProtected = (seal?.optBoolean("pw_protected", false) == true &&
            seal.optString("pw_salt", "").isNotEmpty() &&
            (seal.optString("wrapped_owner_bundle", "").isNotEmpty() || seal.optString("dek_wrapped_pw", "").isNotEmpty())) ||
            (seal?.optString("recovery_salt", "")?.isNotEmpty() == true &&
                seal.optString("dek_wrapped_recovery", "").isNotEmpty()) ||
            (seal?.optJSONArray("previous_seals")?.length() ?: 0) > 0

        val localOwner = lockerDbManager.readLocalOwnerId()
        val isForeignOwner = localOwner.isNotEmpty() && sealOwner.isNotEmpty() && localOwner != sealOwner

        if (isForeignOwner && !pwProtected) {
            return JSONObject()
                .put("ok", false)
                .put("usbConnected", true)
                .put("reason", "ethical_foreign_owner")
                .put("error", "別のオーナーの Loome が検出されたため、エシカル保護によりアクセスをブロックしました")
        }

        val sealIdentity = "$sealOwner:$sealVsn"
        val isLockedLoome = secLevel >= 2 || (isForeignOwner && pwProtected)
        val isSealUnlocked = LoomeVaultCrypto.hasActiveDeks() && (!isForeignOwner || unlockedSealIdentity == sealIdentity)
        val folderLabel = rootDoc.name ?: "Loome USB"

        if (isLockedLoome && seal != null && !isSealUnlocked) {
            cachedUsbVsn = ""
            return JSONObject()
                .put("ok", true)
                .put("usbConnected", true)
                .put("loomeMounted", true)
                .put("locked", true)
                .put("needsPassword", true)
                .put("vsn", sealVsn)
                .put("usbFolderName", folderLabel)
                .put("dbPhotoCount", lockerDbManager.getPhotoCount())
        }

        cachedUsbVsn = sealVsn
        JSONObject()
            .put("ok", true)
            .put("usbConnected", true)
            .put("loomeMounted", true)
            .put("locked", false)
            .put("needsPassword", false)
            .put("syncMode", "loome_mount")
            .put("vsn", sealVsn)
            .put("usbFolderName", folderLabel)
            .put("dbPhotoCount", lockerDbManager.getPhotoCount())
            .put("pendingChangeCount", lockerDbManager.getPendingChangeCount())
    }

    /** パスワードまたはリカバリーコードで接続中 Loome（またはロッカーDB）の DEK を RAM 上へ解錠する */
    fun unlockLoomeWithPassword(secretInput: String): JSONObject = synchronized(mountLock) {
        val rootDoc = getConnectedUsbRootDocument()
        val loomeDir = if (rootDoc != null) findLoomeDirectory(rootDoc) else null
        val usbSeal = if (rootDoc != null) readLoomeSealJson(rootDoc, loomeDir) else null
        val dbSeal = lockerDbManager.readSecuritySealFromDb()

        val primarySeal = usbSeal ?: dbSeal
            ?: return JSONObject().put("ok", false).put("error", "解錠対象のセキュリティ情報（.loome_seal）が見つかりません")

        val primaryDeks = LoomeVaultCrypto.extractDeksFromSeal(primarySeal, secretInput)
        if (primaryDeks.isEmpty()) {
            return JSONObject().put("ok", false).put("error", "パスワードまたはリカバリーコードが正しくありません")
        }

        val allDeks = mutableListOf<ByteArray>().apply { addAll(primaryDeks) }
        try {
            if (usbSeal != null && dbSeal != null) {
                for (d in LoomeVaultCrypto.extractDeksFromSeal(dbSeal, secretInput)) {
                    if (allDeks.none { it.contentEquals(d) }) allDeks.add(d)
                }
            }

            LoomeVaultCrypto.setUnlockedDeks(allDeks)
            if (usbSeal != null) {
                val sOwner = usbSeal.optString("owner_id", "").trim()
                val sVsn = usbSeal.optString("vsn", "").trim().uppercase(Locale.US)
                unlockedSealIdentity = "$sOwner:$sVsn"
            }
        } finally {
            for (d in primaryDeks) Arrays.fill(d, 0.toByte())
            for (d in allDeks) Arrays.fill(d, 0.toByte())
        }

        JSONObject()
            .put("ok", true)
            .put("unlocked", true)
            .put("usbFolderName", getUsbFolderDisplayName())
            .put("dbPhotoCount", lockerDbManager.getPhotoCount())
    }

    /** USB メモリ取り外し時またはセッション終了時に RAM 上の復号鍵をゼロクリアする */
    fun onUsbDetached() {
        cachedUsbConnected = false
        cachedUsbVsn = ""
        unlockedSealIdentity = ""
        clearUsbLookupCache()
        LoomeVaultCrypto.clearMemoryKeys()
    }

    private fun clearUsbLookupCache() {
        dirChildCache.clear()
        photoDocCache.clear()
        cachedLoomeDirUri = ""
        cachedSealJson = null
        cachedUsbVsn = ""
    }

    /** USB接続中に写真の原本画像ストリームを SAF 経由で開く（Lv.2 TETHVLT1 復号 ＆ RAW 埋め込みJPEGプレビュー高速抽出対応） */
    fun openUsbPhotoStream(photoId: Long): Pair<String, InputStream>? {
        val rootDoc = getConnectedUsbRootDocument() ?: return null
        val loomeDir = getCachedLoomeDirectory(rootDoc)
        val seal = cachedSealJson ?: readLoomeSealJson(rootDoc, loomeDir)?.also { cachedSealJson = it }
        val connectedVsn = seal?.optString("vsn", "")?.trim()?.uppercase(Locale.US) ?: ""

        val meta = lockerDbManager.getPhotoFileMeta(photoId) ?: return null
        val fileName = meta.optString("file_name", "").trim()
        if (fileName.isEmpty()) return null

        val cachedDoc = photoDocCache[photoId]?.takeIf { it.isFile && it.canRead() }
        val doc = cachedDoc ?: run {
            val candidatePaths = buildCandidatePaths(meta, connectedVsn)
            resolvePhotoDocumentInUsb(rootDoc, loomeDir, candidatePaths, fileName)?.also {
                if (photoDocCache.size > 2000) photoDocCache.clear()
                photoDocCache[photoId] = it
            }
        } ?: return null

        return try {
            val resolvedName = doc.name ?: fileName
            val stream = LoomeVaultCrypto.openLoomeFileStream(context.contentResolver, doc.uri) ?: return null
            if (isRawFileName(resolvedName)) {
                val rawPreviewBytes = stream.use { extractEmbeddedJpegFromRawStream(it) } ?: return null
                return Pair("image/jpeg", ByteArrayInputStream(rawPreviewBytes))
            }
            Pair(guessImageMimeType(resolvedName), stream)
        } catch (e: Exception) {
            Log.w(TAG, "USB実画像ストリームオープン失敗: $fileName", e)
            null
        }
    }

    private fun getCachedLoomeDirectory(rootDoc: DocumentFile): DocumentFile? {
        if (cachedLoomeDirUri.isNotEmpty()) {
            try {
                val doc = DocumentFile.fromTreeUri(context, Uri.parse(cachedLoomeDirUri))
                if (doc != null && doc.isDirectory && doc.canRead()) return doc
            } catch (_: Exception) {}
        }
        return findLoomeDirectory(rootDoc)?.also { cachedLoomeDirUri = it.uri.toString() }
    }

    private fun buildCandidatePaths(meta: JSONObject, connectedVsn: String): List<String> {
        val vsnMatched = mutableListOf<String>()
        val loomeMatched = mutableListOf<String>()
        val fallback = mutableListOf<String>()

        fun addCandidate(pathStr: String, vsn: String) {
            val clean = pathStr.trim()
            if (clean.isEmpty()) return
            val lower = clean.lowercase(Locale.US)
            if (connectedVsn.isNotEmpty() && vsn == connectedVsn) {
                vsnMatched.add(clean)
            } else if (lower.contains("loome") || lower.contains("storage")) {
                loomeMatched.add(clean)
            } else {
                fallback.add(clean)
            }
        }

        val links = meta.optJSONArray("links")
        if (links != null) {
            for (i in 0 until links.length()) {
                val link = links.optJSONObject(i) ?: continue
                val vsn = link.optString("volume_serial", "").trim().uppercase(Locale.US)
                addCandidate(link.optString("rel_path", ""), vsn)
                addCandidate(link.optString("file_path", ""), vsn)
            }
        }
        val mainVsn = meta.optString("volume_serial", "").trim().uppercase(Locale.US)
        addCandidate(meta.optString("file_path", ""), mainVsn)
        addCandidate(meta.optString("paired_raw_path", ""), mainVsn)
        return (vsnMatched + loomeMatched + fallback).distinct()
    }

    private fun resolvePhotoDocumentInUsb(
        rootDoc: DocumentFile,
        loomeDir: DocumentFile?,
        candidatePaths: List<String>,
        fileName: String
    ): DocumentFile? {
        for (rawPath in candidatePaths) {
            val cleanPath = rawPath.replace('\\', '/')
                .replace(Regex("^[A-Za-z0-9_-]+::"), "")
                .replace(Regex("^[A-Za-z]:/"), "")
                .trim('/')
            val segments = cleanPath.split('/').filter { it.isNotEmpty() }
            if (segments.isEmpty()) continue

            if (loomeDir != null) {
                val loomeIdx = segments.indexOfFirst { it.equals("Loome", ignoreCase = true) || it.equals("storage", ignoreCase = true) }
                if (loomeIdx >= 0 && loomeIdx + 1 < segments.size) {
                    walkDocumentPath(loomeDir, segments.subList(loomeIdx + 1, segments.size))?.let { return it }
                }
                walkDocumentPath(loomeDir, segments)?.let { return it }
            }
            walkDocumentPath(rootDoc, segments)?.let { return it }
        }
        if (loomeDir != null) {
            findChildCached(loomeDir, fileName)?.takeIf { it.isFile && it.canRead() }?.let { return it }
        }
        findChildCached(rootDoc, fileName)?.takeIf { it.isFile && it.canRead() }?.let { return it }
        return null
    }

    private fun walkDocumentPath(baseDir: DocumentFile, segments: List<String>): DocumentFile? {
        var cur: DocumentFile = baseDir
        for (seg in segments) {
            cur = findChildCached(cur, seg) ?: return null
        }
        return if (cur.isFile && cur.canRead()) cur else null
    }

    private fun findChildCached(dir: DocumentFile, childName: String): DocumentFile? {
        val dirKey = dir.uri.toString()
        val map = dirChildCache.getOrPut(dirKey) {
            try {
                dir.listFiles().mapNotNull { f ->
                    val n = f.name?.trim()?.lowercase(Locale.US)
                    if (!n.isNullOrEmpty()) n to f else null
                }.toMap()
            } catch (_: Exception) {
                emptyMap()
            }
        }
        return map[childName.trim().lowercase(Locale.US)]
    }

    private fun guessImageMimeType(name: String): String {
        val lower = name.lowercase(Locale.US)
        return when {
            lower.endsWith(".webp") -> "image/webp"
            lower.endsWith(".png") -> "image/png"
            lower.endsWith(".gif") -> "image/gif"
            else -> "image/jpeg"
        }
    }
}
