package com.peartube.app

import android.graphics.Bitmap
import android.util.LruCache
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import java.util.Base64
import java.util.concurrent.ConcurrentHashMap
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Decoded raw RGBA pixels from a ThumbHash.
 */
data class ThumbHashImage(
    val width: Int,
    val height: Int,
    val rgba: ByteArray,
) {
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is ThumbHashImage) return false
        return width == other.width && height == other.height && rgba.contentEquals(other.rgba)
    }

    override fun hashCode(): Int {
        var result = width
        result = 31 * result + height
        result = 31 * result + rgba.contentHashCode()
        return result
    }
}

/**
 * Pure-Kotlin Evan Wallace ThumbHash decoder with an in-memory LRU cache of decoded [ImageBitmap]s
 * and a lightweight lookup table mapping media IDs / art URLs to their base64 ThumbHash.
 */
object ThumbHash {
    private const val MAX_BITMAP_CACHE = 128
    private const val MAX_KEY_ENTRIES = 1024

    private val bitmapCache by lazy { object : LruCache<String, ImageBitmap>(MAX_BITMAP_CACHE) {} }
    private val keyToHash = ConcurrentHashMap<String, String>()

    /**
     * Associates [key] (canonical metadata id, IMDb id, resolved art URL, or album cache key)
     * with a base64-encoded ThumbHash so UI sleeves/posters can show instant blurred placeholders.
     */
    fun rememberThumbHash(key: String?, base64: String?) {
        val cleanKey = key?.trim().orEmpty()
        val cleanHash = base64?.trim().orEmpty()
        if (cleanKey.isEmpty() || cleanHash.isEmpty()) return
        if (keyToHash.size >= MAX_KEY_ENTRIES && !keyToHash.containsKey(cleanKey)) {
            val iter = keyToHash.keys.iterator()
            var removed = 0
            while (iter.hasNext() && removed < 128) {
                iter.next()
                iter.remove()
                removed++
            }
        }
        keyToHash[cleanKey] = cleanHash
    }

    fun thumbHashFor(key: String?): String? {
        val cleanKey = key?.trim().orEmpty()
        if (cleanKey.isEmpty()) return null
        return keyToHash[cleanKey]
    }

    fun previewBitmapFor(vararg keys: String?): ImageBitmap? {
        for (k in keys) {
            val b64 = thumbHashFor(k) ?: continue
            decodeThumbHashBitmap(b64)?.let { return it }
        }
        return null
    }

    internal fun clearKeysForTest() {
        keyToHash.clear()
    }

    /**
     * Decodes standard or URL-safe base64 (with or without padding) into raw bytes,
     * returning `null` on empty or malformed input.
     */
    fun decodeBase64(base64: String): ByteArray? {
        val trimmed = base64.trim()
        if (trimmed.isEmpty()) return null
        val compact = buildString(trimmed.length) {
            for (ch in trimmed) {
                if (!ch.isWhitespace()) append(ch)
            }
        }
        if (compact.isEmpty()) return null
        return runCatching {
            if (compact.indexOf('-') >= 0 || compact.indexOf('_') >= 0) {
                Base64.getUrlDecoder().decode(compact)
            } else {
                Base64.getDecoder().decode(compact)
            }
        }.getOrNull()?.takeIf { it.isNotEmpty() }
    }

    /**
     * Standard Evan Wallace ThumbHash decoder: converts a compact ThumbHash byte array
     * into RGBA8888 pixels. Returns `null` if [hash] is truncated or corrupt.
     */
    fun thumbHashToRGBA(hash: ByteArray): ThumbHashImage? {
        if (hash.size < 5) return null

        val header24 = (hash[0].toInt() and 0xFF) or
            ((hash[1].toInt() and 0xFF) shl 8) or
            ((hash[2].toInt() and 0xFF) shl 16)
        val header16 = (hash[3].toInt() and 0xFF) or
            ((hash[4].toInt() and 0xFF) shl 8)

        val lDc = (header24 and 63).toFloat() / 63.0f
        val pDc = ((header24 shr 6) and 63).toFloat() / 31.5f - 1.0f
        val qDc = ((header24 shr 12) and 63).toFloat() / 31.5f - 1.0f
        val lScale = ((header24 shr 18) and 31).toFloat() / 31.0f
        val hasAlpha = (header24 shr 23) != 0
        val pScale = ((header16 shr 3) and 63).toFloat() / 63.0f
        val qScale = ((header16 shr 9) and 63).toFloat() / 63.0f
        val isLandscape = (header16 shr 15) != 0

        val shortAxis = header16 and 7
        if (shortAxis == 0) return null

        val lx = max(3, if (isLandscape) (if (hasAlpha) 5 else 7) else shortAxis)
        val ly = max(3, if (isLandscape) shortAxis else (if (hasAlpha) 5 else 7))

        if (hasAlpha && hash.size < 6) return null
        val aDc = if (hasAlpha) (hash[5].toInt() and 15).toFloat() / 15.0f else 1.0f
        val aScale = if (hasAlpha) ((hash[5].toInt() shr 4) and 15).toFloat() / 15.0f else 0.0f

        val acStart = if (hasAlpha) 6 else 5
        var acIndex = 0

        fun decodeChannel(nx: Int, ny: Int, scale: Float): FloatArray? {
            val ac = FloatArray(nx * ny)
            var n = 0
            for (cy in 0 until ny) {
                var cx = if (cy > 0) 0 else 1
                while (cx * ny < nx * (ny - cy)) {
                    val byteIdx = acStart + (acIndex shr 1)
                    if (byteIdx >= hash.size) return null
                    val nibble = (hash[byteIdx].toInt() shr ((acIndex and 1) shl 2)) and 15
                    ac[n++] = (nibble.toFloat() / 7.5f - 1.0f) * scale
                    acIndex++
                    cx++
                }
            }
            return ac
        }

        val lAc = decodeChannel(lx, ly, lScale) ?: return null
        val pAc = decodeChannel(3, 3, pScale * 1.25f) ?: return null
        val qAc = decodeChannel(3, 3, qScale * 1.25f) ?: return null
        val aAc = if (hasAlpha) (decodeChannel(5, 5, aScale) ?: return null) else null

        val ratioLx = if (isLandscape) (if (hasAlpha) 5 else 7) else shortAxis
        val ratioLy = if (isLandscape) shortAxis else (if (hasAlpha) 5 else 7)
        val ratio = ratioLx.toFloat() / ratioLy.toFloat()
        val w = max(1, (if (ratio > 1.0f) 32.0f else 32.0f * ratio).roundToInt())
        val h = max(1, (if (ratio > 1.0f) 32.0f / ratio else 32.0f).roundToInt())

        val rgba = ByteArray(w * h * 4)
        val fxLen = max(lx, if (hasAlpha) 5 else 3)
        val fyLen = max(ly, if (hasAlpha) 5 else 3)
        val fx = FloatArray(fxLen)
        val fy = FloatArray(fyLen)

        var idx = 0
        for (y in 0 until h) {
            for (cy in 0 until fyLen) {
                fy[cy] = cos(PI / h * (y + 0.5) * cy).toFloat()
            }
            for (x in 0 until w) {
                var l = lDc
                var p = pDc
                var q = qDc
                var a = aDc

                for (cx in 0 until fxLen) {
                    fx[cx] = cos(PI / w * (x + 0.5) * cx).toFloat()
                }

                // Decode L
                var j = 0
                for (cy in 0 until ly) {
                    val fy2 = fy[cy] * 2.0f
                    var cx = if (cy > 0) 0 else 1
                    while (cx * ly < lx * (ly - cy)) {
                        l += lAc[j++] * fx[cx] * fy2
                        cx++
                    }
                }

                // Decode P and Q
                j = 0
                for (cy in 0 until 3) {
                    val fy2 = fy[cy] * 2.0f
                    var cx = if (cy > 0) 0 else 1
                    while (cx < 3 - cy) {
                        val f = fx[cx] * fy2
                        p += pAc[j] * f
                        q += qAc[j] * f
                        j++
                        cx++
                    }
                }

                // Decode A
                if (hasAlpha && aAc != null) {
                    j = 0
                    for (cy in 0 until 5) {
                        val fy2 = fy[cy] * 2.0f
                        var cx = if (cy > 0) 0 else 1
                        while (cx < 5 - cy) {
                            a += aAc[j++] * fx[cx] * fy2
                            cx++
                        }
                    }
                }

                // Convert LPQA to RGBA
                val b = l - 2.0f / 3.0f * p
                val r = (3.0f * l - b + q) / 2.0f
                val g = r - q
                rgba[idx++] = (max(0.0f, min(1.0f, r)) * 255.0f).toInt().toByte()
                rgba[idx++] = (max(0.0f, min(1.0f, g)) * 255.0f).toInt().toByte()
                rgba[idx++] = (max(0.0f, min(1.0f, b)) * 255.0f).toInt().toByte()
                rgba[idx++] = (max(0.0f, min(1.0f, a)) * 255.0f).toInt().toByte()
            }
        }

        return ThumbHashImage(width = w, height = h, rgba = rgba)
    }

    /**
     * Decodes a base64 ThumbHash into an [ImageBitmap], backed by a 128-entry LRU cache.
     * Returns `null` on empty, corrupt, or unrenderable input.
     */
    fun decodeThumbHashBitmap(base64: String): ImageBitmap? {
        val clean = base64.trim()
        if (clean.isEmpty()) return null
        val cached = runCatching { synchronized(bitmapCache) { bitmapCache.get(clean) } }.getOrNull()
        if (cached != null) return cached

        val bytes = decodeBase64(clean) ?: return null
        val img = thumbHashToRGBA(bytes) ?: return null

        return runCatching {
            val pixelCount = img.width * img.height
            val pixels = IntArray(pixelCount)
            var src = 0
            for (p in 0 until pixelCount) {
                val r = img.rgba[src++].toInt() and 0xFF
                val g = img.rgba[src++].toInt() and 0xFF
                val b = img.rgba[src++].toInt() and 0xFF
                val a = img.rgba[src++].toInt() and 0xFF
                pixels[p] = (a shl 24) or (r shl 16) or (g shl 8) or b
            }
            val bmp = Bitmap.createBitmap(pixels, img.width, img.height, Bitmap.Config.ARGB_8888)
            val imageBitmap = bmp.asImageBitmap()
            synchronized(bitmapCache) { bitmapCache.put(clean, imageBitmap) }
            imageBitmap
        }.getOrNull()
    }
}
