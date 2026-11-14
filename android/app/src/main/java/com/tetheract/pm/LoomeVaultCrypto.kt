package com.tetheract.pm

import android.content.ContentResolver
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.util.Log
import org.json.JSONObject
import java.io.FileInputStream
import java.io.InputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.channels.FileChannel
import java.security.MessageDigest
import java.util.Arrays
import java.util.Locale
import javax.crypto.Mac
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.PBEKeySpec
import javax.crypto.spec.SecretKeySpec

/**
 * Tetheract Photo Manager の Lv.1 サムネイル暗号化および Lv.2 Loome カプセル化（TETHVLT1）を
 * 端末ストレージへ秘密鍵を一切保存せずオンメモリのみで透過復号する暗号オブジェクト。
 */
object LoomeVaultCrypto {

    private const val TAG = "LoomeVaultCrypto"

    val THUMB_ENC_MAGIC: ByteArray = byteArrayOf('T'.code.toByte(), 'E'.code.toByte(), 'N'.code.toByte(), 'C'.code.toByte(), 0x01)
    const val THUMB_ENC_HEADER_SIZE: Int = 53
    val THUMB_AAD: ByteArray = "TETH_THUMB_V1".toByteArray(Charsets.UTF_8)

    val VAULT_MAGIC: ByteArray = "TETHVLT1".toByteArray(Charsets.UTF_8)
    const val VAULT_CHUNK_SIZE: Int = 65536
    const val VAULT_FOOTER_SIZE: Int = 72

    const val PBKDF2_ITERATIONS: Int = 200_000
    const val RECOVERY_ALPHABET: String = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"

    private val TETH_MAC_V1_BYTES = "TETH_MAC_V1".toByteArray(Charsets.UTF_8)
    private val TETH_ENC_V1_BYTES = "TETH_ENC_V1".toByteArray(Charsets.UTF_8)
    private val VAULT_MAC_V1_BYTES = "VAULT_MAC_V1".toByteArray(Charsets.UTF_8)
    private val VAULT_ENC_V1_BYTES = "VAULT_ENC_V1".toByteArray(Charsets.UTF_8)
    private const val SHAKE256_RATE = 136

    private val KECCAK_RC = longArrayOf(
        0x0000000000000001L, 0x0000000000008082L, -0x7fffffffffff7f76L, -0x7fffffff7fff8000L,
        0x000000000000808bL, 0x0000000080000001L, -0x7fffffff7fff7f7fL, -0x7fffffffffff7ff7L,
        0x000000000000008aL, 0x0000000000000088L, 0x0000000080008009L, 0x000000008000000aL,
        0x000000008000808bL, -0x7fffffffffffff75L, -0x7fffffffffff7f77L, -0x7fffffffffff7ffdL,
        -0x7fffffffffff7ffeL, -0x7fffffffffffff80L, 0x000000000000800aL, -0x7fffffff7ffffff6L,
        -0x7fffffff7fff7f7fL, -0x7fffffffffff7f80L, 0x0000000080000001L, -0x7fffffff7fff7ff8L
    )

    private val KECCAK_RHO = intArrayOf(
        0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14
    )

    private val keyLock = Any()
    private val activeDeks = mutableListOf<ByteArray>()

    /** 解錠された DEK リストを RAM 上にセットする（既存の鍵はゼロクリアして置換） */
    fun setUnlockedDeks(deks: List<ByteArray>) = synchronized(keyLock) {
        clearMemoryKeysLocked()
        for (dek in deks) {
            if (dek.size == 32 && activeDeks.none { it.contentEquals(dek) }) {
                activeDeks.add(dek.copyOf())
            }
        }
    }

    /** 現在 RAM 上に有効な DEK が保持されているかを返す */
    fun hasActiveDeks(): Boolean = synchronized(keyLock) { activeDeks.isNotEmpty() }

    /** 現在 RAM 上に保持されている DEK リストの防御的コピーを返す */
    fun getActiveDeks(): List<ByteArray> = synchronized(keyLock) { activeDeks.map { it.copyOf() } }

    /** RAM 上に保持されているすべての鍵バイト列を 0 で上書き消去して破棄する */
    fun clearMemoryKeys() = synchronized(keyLock) { clearMemoryKeysLocked() }

    private fun clearMemoryKeysLocked() {
        for (k in activeDeks) Arrays.fill(k, 0.toByte())
        activeDeks.clear()
    }

    /** FIPS 202 SHAKE256 可変長出力ハッシュ (Keccak-f[1600], rate=136B, domain suffix=0x1F) */
    fun shake256(input: ByteArray, outLen: Int): ByteArray {
        if (outLen <= 0) return ByteArray(0)
        val state = LongArray(25)
        val tempB = LongArray(25)
        val tempC = LongArray(5)

        var offset = 0
        while (offset + SHAKE256_RATE <= input.size) {
            val bb = ByteBuffer.wrap(input, offset, SHAKE256_RATE).order(ByteOrder.LITTLE_ENDIAN)
            for (i in 0 until 17) state[i] = state[i] xor bb.long
            keccakF1600(state, tempB, tempC)
            offset += SHAKE256_RATE
        }

        val rem = input.size - offset
        val padBlock = ByteArray(SHAKE256_RATE)
        if (rem > 0) System.arraycopy(input, offset, padBlock, 0, rem)
        padBlock[rem] = (padBlock[rem].toInt() xor 0x1F).toByte()
        padBlock[SHAKE256_RATE - 1] = (padBlock[SHAKE256_RATE - 1].toInt() xor 0x80).toByte()

        val padBb = ByteBuffer.wrap(padBlock).order(ByteOrder.LITTLE_ENDIAN)
        for (i in 0 until 17) state[i] = state[i] xor padBb.long
        keccakF1600(state, tempB, tempC)

        val out = ByteArray(outLen)
        var outOffset = 0
        val squeezeBlock = ByteArray(SHAKE256_RATE)
        val sqBb = ByteBuffer.wrap(squeezeBlock).order(ByteOrder.LITTLE_ENDIAN)
        while (outOffset < outLen) {
            sqBb.clear()
            for (i in 0 until 17) sqBb.putLong(state[i])
            val copyLen = minOf(SHAKE256_RATE, outLen - outOffset)
            System.arraycopy(squeezeBlock, 0, out, outOffset, copyLen)
            outOffset += copyLen
            if (outOffset < outLen) keccakF1600(state, tempB, tempC)
        }
        Arrays.fill(squeezeBlock, 0.toByte())
        Arrays.fill(state, 0L)
        return out
    }

    private fun keccakF1600(state: LongArray, b: LongArray, c: LongArray) {
        for (round in 0 until 24) {
            for (x in 0..4) {
                c[x] = state[x] xor state[x + 5] xor state[x + 10] xor state[x + 15] xor state[x + 20]
            }
            for (x in 0..4) {
                val d = c[(x + 4) % 5] xor java.lang.Long.rotateLeft(c[(x + 1) % 5], 1)
                for (y in 0..20 step 5) state[x + y] = state[x + y] xor d
            }
            for (x in 0..4) {
                for (y in 0..4) {
                    val idx = x + 5 * y
                    b[y + 5 * ((2 * x + 3 * y) % 5)] = java.lang.Long.rotateLeft(state[idx], KECCAK_RHO[idx])
                }
            }
            for (y in 0..20 step 5) {
                for (x in 0..4) {
                    state[x + y] = b[x + y] xor (b[(x + 1) % 5 + y].inv() and b[(x + 2) % 5 + y])
                }
            }
            state[0] = state[0] xor KECCAK_RC[round]
        }
    }

    /** パスワードとソルトから PBKDF2-HMAC-SHA256 で 32 バイトの KEK を導出する */
    fun deriveKek(password: String, salt: ByteArray, iterations: Int = PBKDF2_ITERATIONS): ByteArray {
        val chars = password.toCharArray()
        val spec = PBEKeySpec(chars, salt, iterations, 256)
        return try {
            SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).encoded
        } finally {
            spec.clearPassword()
            Arrays.fill(chars, 0.toChar())
        }
    }

    private fun hmacSha256(key: ByteArray, data: ByteArray): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(key, "HmacSHA256"))
        return mac.doFinal(data)
    }

    private fun xorBytes(data: ByteArray, keystream: ByteArray): ByteArray {
        val out = ByteArray(data.size)
        for (i in data.indices) out[i] = (data[i].toInt() xor keystream[i].toInt()).toByte()
        return out
    }

    /** server/security.py の aead_decrypt と完全互換の検証・復号を行う */
    fun aeadDecrypt(key: ByteArray, blob: ByteArray, aad: ByteArray = ByteArray(0)): ByteArray {
        require(key.size == 32) { "復号キーは32バイトである必要があります" }
        require(blob.size >= THUMB_ENC_HEADER_SIZE && startsWithMagic(blob, THUMB_ENC_MAGIC)) { "暗号化フォーマットが不正です" }
        val nonce = blob.copyOfRange(5, 21)
        val mac = blob.copyOfRange(21, 53)
        val ciphertext = blob.copyOfRange(53, blob.size)

        val macKey = shake256(key + nonce + TETH_MAC_V1_BYTES, 32)
        val expectedMac = hmacSha256(macKey, THUMB_ENC_MAGIC + nonce + aad + ciphertext)
        Arrays.fill(macKey, 0.toByte())
        require(MessageDigest.isEqual(mac, expectedMac)) { "暗号データの認証に失敗しました" }

        val ks = shake256(key + nonce + TETH_ENC_V1_BYTES, ciphertext.size)
        return try { xorBytes(ciphertext, ks) } finally { Arrays.fill(ks, 0.toByte()) }
    }

    /** リカバリーコードのハイフン・空白・TETHプレフィックスを正規化する */
    fun normalizeRecoveryCode(code: String): String {
        val cleaned = code.uppercase(Locale.US).trim().filter { it.isLetterOrDigit() }
        return if (cleaned.startsWith("TETH")) cleaned.substring(4) else cleaned
    }

    /** .loome_seal（および previous_seals 履歴）からパスワードまたはリカバリーコードで復号可能な DEK を抽出する */
    fun extractDeksFromSeal(sealObj: JSONObject, secretInput: String): List<ByteArray> {
        val candidate = secretInput.trim()
        if (candidate.isEmpty()) return emptyList()

        val foundDeks = mutableListOf<ByteArray>()
        val entries = mutableListOf(sealObj)
        val prevArr = sealObj.optJSONArray("previous_seals")
        if (prevArr != null) {
            for (i in 0 until prevArr.length()) prevArr.optJSONObject(i)?.let { entries.add(it) }
        }
        val recNorm = normalizeRecoveryCode(candidate)

        for (entry in entries) {
            val aadBytes = entry.optString("owner_id", "").toByteArray(Charsets.UTF_8)
            val pwSaltHex = entry.optString("pw_salt", "").trim()
            val pwWrapHex = entry.optString("wrapped_owner_bundle", "").trim()
                .ifEmpty { entry.optString("dek_wrapped_pw", "").trim() }
            tryUnwrapDek(candidate, pwSaltHex, pwWrapHex, aadBytes)?.let { dek ->
                if (foundDeks.none { it.contentEquals(dek) }) foundDeks.add(dek)
            }

            val recSaltHex = entry.optString("recovery_salt", "").trim()
            val recWrapHex = entry.optString("dek_wrapped_recovery", "").trim()
            if (recNorm.isNotEmpty()) {
                tryUnwrapDek(recNorm, recSaltHex, recWrapHex, aadBytes)?.let { dek ->
                    if (foundDeks.none { it.contentEquals(dek) }) foundDeks.add(dek)
                }
            }
        }
        return foundDeks
    }

    private fun tryUnwrapDek(secret: String, saltHex: String, wrapHex: String, aadBytes: ByteArray): ByteArray? {
        if (saltHex.isEmpty() || wrapHex.isEmpty()) return null
        return try {
            val kek = deriveKek(secret, hexToBytes(saltHex))
            val bundleBytes = try { aeadDecrypt(kek, hexToBytes(wrapHex), aadBytes) } finally { Arrays.fill(kek, 0.toByte()) }
            try {
                if (bundleBytes.size == 32) return bundleBytes.copyOf()
                val dekHex = JSONObject(String(bundleBytes, Charsets.UTF_8)).optString("dek", "").trim()
                val dek = if (dekHex.isNotEmpty()) hexToBytes(dekHex) else ByteArray(0)
                if (dek.size == 32) dek else null
            } finally {
                Arrays.fill(bundleBytes, 0.toByte())
            }
        } catch (_: Exception) { null }
    }

    /** サムネイル BLOB が TENC\x01 で暗号化されている場合、現在解錠されている DEK で復号して返す */
    fun decryptThumbnailIfNeeded(blob: ByteArray, photoId: Long? = null): ByteArray {
        if (blob.size < THUMB_ENC_HEADER_SIZE || !startsWithMagic(blob, THUMB_ENC_MAGIC)) return blob
        val deks = getActiveDeks()
        if (deks.isEmpty()) return blob

        val aads = if (photoId != null) {
            arrayOf(THUMB_AAD, photoId.toString().toByteArray(Charsets.UTF_8), ByteArray(0))
        } else {
            arrayOf(THUMB_AAD, ByteArray(0))
        }
        try {
            for (dek in deks) {
                for (aad in aads) {
                    try { return aeadDecrypt(dek, blob, aad) } catch (_: Exception) {}
                }
            }
        } finally {
            for (dek in deks) Arrays.fill(dek, 0.toByte())
        }
        return blob
    }

    /** SAF の Uri から Loome 原本ファイルを開き、Lv.2 カプセル化ファイル (TETHVLT1) は透過復号する InputStream を返す */
    fun openLoomeFileStream(contentResolver: ContentResolver, uri: Uri): InputStream? {
        val pfd: ParcelFileDescriptor = try { contentResolver.openFileDescriptor(uri, "r") } catch (_: Exception) { null }
            ?: return try { contentResolver.openInputStream(uri) } catch (_: Exception) { null }

        var fis: FileInputStream? = null
        try {
            fis = FileInputStream(pfd.fileDescriptor)
            val channel = fis.channel
            val head8 = readFullyAt(channel, 0L, 8)
            if (head8 == null || !startsWithMagic(head8, VAULT_MAGIC)) {
                channel.position(0L)
                return PfdBackedInputStream(pfd, fis)
            }

            val totalSize = pfd.statSize.takeIf { it > 0L } ?: channel.size()
            val deks = getActiveDeks()
            if (totalSize <= VAULT_FOOTER_SIZE || deks.isEmpty()) {
                for (d in deks) Arrays.fill(d, 0.toByte())
                fis.close(); pfd.close()
                return null
            }

            try {
                val origSize = totalSize - VAULT_FOOTER_SIZE.toLong()
                val chunkLen = minOf(origSize, VAULT_CHUNK_SIZE.toLong()).toInt()
                val diskChunk = readFullyAt(channel, 0L, chunkLen)
                val footer = readFullyAt(channel, origSize, VAULT_FOOTER_SIZE)
                if (diskChunk == null || footer == null || !regionEquals(footer, 64, VAULT_MAGIC, 8)) {
                    fis.close(); pfd.close()
                    return null
                }

                val cipherHead8 = footer.copyOfRange(0, 8)
                val nonce = footer.copyOfRange(8, 24)
                val mac = footer.copyOfRange(24, 56)
                val origMtimeBytes = footer.copyOfRange(56, 64)

                val cipherChunk = ByteArray(chunkLen)
                System.arraycopy(cipherHead8, 0, cipherChunk, 0, minOf(8, chunkLen))
                if (chunkLen > 8) System.arraycopy(diskChunk, 8, cipherChunk, 8, chunkLen - 8)

                var plainChunk: ByteArray? = null
                for (candKey in deks) {
                    val macKey = shake256(candKey + nonce + VAULT_MAC_V1_BYTES, 32)
                    val expectedMac = hmacSha256(macKey, VAULT_MAGIC + nonce + origMtimeBytes + cipherChunk)
                    Arrays.fill(macKey, 0.toByte())
                    if (MessageDigest.isEqual(mac, expectedMac)) {
                        val ks = shake256(candKey + nonce + VAULT_ENC_V1_BYTES, chunkLen)
                        plainChunk = xorBytes(cipherChunk, ks)
                        Arrays.fill(ks, 0.toByte())
                        break
                    }
                }
                if (plainChunk == null) {
                    fis.close(); pfd.close()
                    return null
                }

                channel.position(chunkLen.toLong())
                return VaultDecryptedInputStream(pfd, fis, plainChunk, origSize - chunkLen.toLong())
            } finally {
                for (dek in deks) Arrays.fill(dek, 0.toByte())
            }
        } catch (e: Exception) {
            Log.w(TAG, "Loome ストリーム復号オープン失敗", e)
            try { fis?.close() } catch (_: Exception) {}
            try { pfd.close() } catch (_: Exception) {}
            return null
        }
    }

    private fun readFullyAt(channel: FileChannel, pos: Long, len: Int): ByteArray? {
        val out = ByteArray(len)
        val buf = ByteBuffer.wrap(out)
        var readTotal = 0
        while (readTotal < len) {
            val n = channel.read(buf, pos + readTotal)
            if (n <= 0) break
            readTotal += n
        }
        return if (readTotal == len) out else null
    }

    private fun startsWithMagic(data: ByteArray, magic: ByteArray): Boolean =
        data.size >= magic.size && (magic.indices).all { data[it] == magic[it] }

    private fun regionEquals(data: ByteArray, offset: Int, target: ByteArray, len: Int): Boolean =
        offset >= 0 && data.size >= offset + len && target.size >= len && (0 until len).all { data[offset + it] == target[it] }

    private fun hexToBytes(hex: String): ByteArray {
        val clean = hex.trim()
        require(clean.length % 2 == 0) { "Invalid hex length" }
        return ByteArray(clean.length / 2) { i ->
            val hi = Character.digit(clean[i * 2], 16)
            val lo = Character.digit(clean[i * 2 + 1], 16)
            require(hi >= 0 && lo >= 0) { "Invalid hex character" }
            ((hi shl 4) or lo).toByte()
        }
    }

    private class PfdBackedInputStream(private val pfd: ParcelFileDescriptor, private val fis: FileInputStream) : InputStream() {
        private var closed = false
        override fun read(): Int = fis.read()
        override fun read(b: ByteArray, off: Int, len: Int): Int = fis.read(b, off, len)
        override fun close() {
            if (closed) return
            closed = true
            try { fis.close() } catch (_: Exception) {}
            try { pfd.close() } catch (_: Exception) {}
        }
    }

    private class VaultDecryptedInputStream(
        private val pfd: ParcelFileDescriptor,
        private val fis: FileInputStream,
        private val plainHead: ByteArray,
        private var tailRemaining: Long
    ) : InputStream() {
        private var headPos = 0
        private var closed = false

        override fun read(): Int {
            if (headPos < plainHead.size) return plainHead[headPos++].toInt() and 0xFF
            if (tailRemaining <= 0L) return -1
            val b = fis.read()
            if (b >= 0) tailRemaining--
            return b
        }

        override fun read(b: ByteArray, off: Int, len: Int): Int {
            if (len == 0) return 0
            if (headPos < plainHead.size) {
                val copyLen = minOf(len, plainHead.size - headPos)
                System.arraycopy(plainHead, headPos, b, off, copyLen)
                headPos += copyLen
                return copyLen
            }
            if (tailRemaining <= 0L) return -1
            val n = fis.read(b, off, minOf(len.toLong(), tailRemaining).toInt())
            if (n > 0) tailRemaining -= n.toLong()
            return n
        }

        override fun close() {
            if (closed) return
            closed = true
            Arrays.fill(plainHead, 0.toByte())
            try { fis.close() } catch (_: Exception) {}
            try { pfd.close() } catch (_: Exception) {}
        }
    }
}
