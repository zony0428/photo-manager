package com.tetheract.pm

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.exp
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sqrt

/**
 * YuNet (顔検出) および LPD-YuNet (ナンバープレート4頂点検出) の ONNX モデルを
 * 追加ネイティブライブラリなしで実行する軽量 NHWC CPU 推論エンジン。
 */
object OnnxPrivacyEngine {

    private const val TAG = "OnnxPrivacyEngine"
    private const val FACE_ASSET_PATH = "models/privacy/face_detection_yunet_2023mar.onnx"
    private const val PLATE_ASSET_PATH = "models/privacy/license_plate_detection_lpd_yunet_2023mar.onnx"

    private const val YUNET_SIZE = 640
    private const val LPD_W = 320
    private const val LPD_H = 240

    private val workerCount = Runtime.getRuntime().availableProcessors().coerceIn(2, 4)
    private val pool = Executors.newFixedThreadPool(workerCount)

    private val loadLock = Any()
    @Volatile private var loaded = false
    private var faceGraph: OnnxGraph? = null
    private var plateGraph: OnnxGraph? = null
    private var lpdPriors: FloatArray? = null

    data class FaceCandidate(
        val x: Float,
        val y: Float,
        val r: Float,
        val score: Float
    )

    data class PlateCandidate(
        val pts: FloatArray, // [x0,y0, x1,y1, x2,y2, x3,y3] normalized 0..1
        val score: Float,
        val strictIsolation: Boolean
    )

    private class Tensor3D(val h: Int, val w: Int, val c: Int, val data: FloatArray)

    private class WeightTensor(val dims: IntArray, val data: FloatArray)

    private class OnnxNode(
        val op: String,
        val inputs: List<String>,
        val outputs: List<String>,
        val strides: IntArray,
        val pads: IntArray,
        val group: Int
    )

    private class OnnxGraph(
        val weights: Map<String, WeightTensor>,
        val nodes: List<OnnxNode>,
        val lastUseIdx: Map<String, Int>
    )

    /** アセット上の ONNX モデル availability を保証する（スレッドセーフ遅延ロード） */
    fun ensureLoaded(context: Context): Pair<Boolean, Boolean> {
        if (loaded) return (faceGraph != null) to (plateGraph != null)
        synchronized(loadLock) {
            if (loaded) return (faceGraph != null) to (plateGraph != null)
            try {
                faceGraph = loadAssetGraph(context, FACE_ASSET_PATH, stopNodeCount = 70)
            } catch (e: Exception) {
                Log.w(TAG, "YuNet 顔モデル読込警告: ${e.message}")
            }
            try {
                plateGraph = loadAssetGraph(context, PLATE_ASSET_PATH, stopNodeCount = 69)
                if (plateGraph != null) {
                    lpdPriors = buildLpdPriors(LPD_W, LPD_H)
                }
            } catch (e: Exception) {
                Log.w(TAG, "LPD-YuNet ナンバーモデル読込警告: ${e.message}")
            }
            loaded = true
            return (faceGraph != null) to (plateGraph != null)
        }
    }

    /** YuNet (640x640) によるオンデバイス顔検出を実行する。モデル未配置時は null を返す */
    fun detectFacesYuNet(context: Context, bmp: Bitmap, scoreThresh: Float = 0.58f): List<FaceCandidate>? {
        val (hasFace, _) = ensureLoaded(context)
        val graph = faceGraph
        if (!hasFace || graph == null) return null

        val cw = bmp.width
        val ch = bmp.height
        if (cw < 16 || ch < 16) return emptyList()

        val scale = min(YUNET_SIZE.toFloat() / cw.toFloat(), YUNET_SIZE.toFloat() / ch.toFloat())
        val nw = max(1, (cw * scale).roundToInt())
        val nh = max(1, (ch * scale).roundToInt())

        val resized = Bitmap.createScaledBitmap(bmp, nw, nh, true)
        val pixels = IntArray(nw * nh)
        resized.getPixels(pixels, 0, nw, 0, 0, nw, nh)
        if (resized !== bmp && !resized.isRecycled) resized.recycle()

        // YuNet 入力は 640x640 レターボックス BGR (0..255 float)
        val canvasData = FloatArray(YUNET_SIZE * YUNET_SIZE * 3)
        for (y in 0 until nh) {
            val srcRow = y * nw
            val dstRow = y * YUNET_SIZE * 3
            for (x in 0 until nw) {
                val px = pixels[srcRow + x]
                val di = dstRow + x * 3
                canvasData[di] = (px and 0xFF).toFloat()
                canvasData[di + 1] = ((px ushr 8) and 0xFF).toFloat()
                canvasData[di + 2] = ((px ushr 16) and 0xFF).toFloat()
            }
        }

        val keepHeads = setOf("258", "260", "262", "264", "266", "268", "270", "272", "274")
        val acts = runGraph(graph, Tensor3D(YUNET_SIZE, YUNET_SIZE, 3, canvasData), keepHeads)

        val headSpecs = arrayOf(
            Triple(8, "258", Pair("270", "264")),
            Triple(16, "260", Pair("272", "266")),
            Triple(32, "262", Pair("274", "268"))
        )

        data class RawBox(val x1: Float, val y1: Float, val x2: Float, val y2: Float, val score: Float)
        val rawBoxes = ArrayList<RawBox>()

        for ((stride, clsKey, objBboxPair) in headSpecs) {
            val clsT = acts[clsKey] ?: continue
            val objT = acts[objBboxPair.first] ?: continue
            val bboxT = acts[objBboxPair.second] ?: continue
            val clsData = clsT.data
            val objData = objT.data
            val bboxData = bboxT.data
            val cols = YUNET_SIZE / stride
            val nCells = min(clsData.size, objData.size)

            for (idx in 0 until nCells) {
                val cProb = sigmoid(clsData[idx])
                val oProb = sigmoid(objData[idx])
                val sc = sqrt(cProb * oProb)
                if (sc < scoreThresh) continue

                val rIdx = idx / cols
                val cIdx = idx % cols
                val bo = idx * 4
                val cx = (cIdx + bboxData[bo]) * stride
                val cy = (rIdx + bboxData[bo + 1]) * stride
                val bw = exp(bboxData[bo + 2].coerceIn(-5f, 5f)) * stride
                val bh = exp(bboxData[bo + 3].coerceIn(-5f, 5f)) * stride

                val x1 = (cx - bw * 0.5f) / nw.toFloat()
                val y1 = (cy - bh * 0.5f) / nh.toFloat()
                val x2 = (cx + bw * 0.5f) / nw.toFloat()
                val y2 = (cy + bh * 0.5f) / nh.toFloat()
                if (x2 <= 0.02f || y2 <= 0.02f || x1 >= 0.98f || y1 >= 0.98f) continue

                rawBoxes.add(
                    RawBox(
                        x1 = x1.coerceIn(0f, 1f) * cw,
                        y1 = y1.coerceIn(0f, 1f) * ch,
                        x2 = x2.coerceIn(0f, 1f) * cw,
                        y2 = y2.coerceIn(0f, 1f) * ch,
                        score = sc
                    )
                )
            }
        }

        if (rawBoxes.isEmpty()) return emptyList()

        rawBoxes.sortByDescending { it.score }
        val kept = ArrayList<RawBox>()
        for (cand in rawBoxes) {
            var overlap = false
            for (k in kept) {
                val ix1 = max(cand.x1, k.x1)
                val iy1 = max(cand.y1, k.y1)
                val ix2 = min(cand.x2, k.x2)
                val iy2 = min(cand.y2, k.y2)
                val inter = max(0f, ix2 - ix1) * max(0f, iy2 - iy1)
                val areaA = max(1f, (cand.x2 - cand.x1) * (cand.y2 - cand.y1))
                val areaB = max(1f, (k.x2 - k.x1) * (k.y2 - k.y1))
                if (inter / (areaA + areaB - inter + 1e-6f) > 0.35f) {
                    overlap = true
                    break
                }
            }
            if (!overlap) {
                kept.add(cand)
                if (kept.size >= 24) break
            }
        }

        val longEdge = max(cw, ch).toFloat()
        return kept.map { b ->
            val cx = ((b.x1 + b.x2) * 0.5f) / cw.toFloat()
            val cy = ((b.y1 + b.y2) * 0.5f) / ch.toFloat()
            val r = ((max(b.x2 - b.x1, b.y2 - b.y1) * 0.74f) / longEdge).coerceIn(0.018f, 0.35f)
            FaceCandidate(
                x = cx.coerceIn(0f, 1f),
                y = cy.coerceIn(0f, 1f),
                r = r,
                score = b.score
            )
        }
    }

    /** LPD-YuNet (320x240 マルチウィンドウ) でナンバープレート4頂点候補を検出する。モデル未配置時は null を返す */
    fun detectPlatesLpdYuNet(context: Context, bmp: Bitmap, confThresh: Float = 0.50f): List<PlateCandidate>? {
        val (_, hasPlate) = ensureLoaded(context)
        val graph = plateGraph
        val priors = lpdPriors
        if (!hasPlate || graph == null || priors == null) return null

        val w = bmp.width
        val h = bmp.height
        if (w < 48 || h < 36) return emptyList()

        data class ScanWindow(val x1: Float, val y1: Float, val x2: Float, val y2: Float, val th: Float, val strict: Boolean)
        val windows = listOf(
            ScanWindow(0.00f, 0.00f, 1.00f, 1.00f, confThresh, false),
            ScanWindow(0.00f, 0.28f, 0.52f, 0.96f, confThresh + 0.02f, true),
            ScanWindow(0.24f, 0.28f, 0.76f, 0.96f, confThresh + 0.02f, true),
            ScanWindow(0.48f, 0.28f, 1.00f, 0.96f, confThresh + 0.02f, true)
        )

        val out = ArrayList<PlateCandidate>()
        for (win in windows) {
            val px1 = (w * win.x1).roundToInt().coerceIn(0, w - 1)
            val py1 = (h * win.y1).roundToInt().coerceIn(0, h - 1)
            val px2 = (w * win.x2).roundToInt().coerceIn(px1 + 1, w)
            val py2 = (h * win.y2).roundToInt().coerceIn(py1 + 1, h)
            val cw = px2 - px1
            val ch = py2 - py1
            if (cw < 48 || ch < 36) continue

            val subBmp = if (px1 == 0 && py1 == 0 && cw == w && ch == h) {
                bmp
            } else {
                Bitmap.createBitmap(bmp, px1, py1, cw, ch)
            }
            val hits = runLpdSingleWindow(graph, priors, subBmp, win.th, rejectBorderClipped = win.strict)
            if (subBmp !== bmp && !subBmp.isRecycled) subBmp.recycle()

            val winW = win.x2 - win.x1
            val winH = win.y2 - win.y1
            for ((localQuad, sc) in hits) {
                val gQuad = FloatArray(8)
                for (i in 0 until 4) {
                    gQuad[i * 2] = (win.x1 + localQuad[i * 2] * winW).coerceIn(0f, 1f)
                    gQuad[i * 2 + 1] = (win.y1 + localQuad[i * 2 + 1] * winH).coerceIn(0f, 1f)
                }
                out.add(PlateCandidate(gQuad, sc, strictIsolation = win.strict))
            }
        }
        return out
    }

    private fun runLpdSingleWindow(
        graph: OnnxGraph,
        priors: FloatArray,
        cropBmp: Bitmap,
        confThresh: Float,
        rejectBorderClipped: Boolean
    ): List<Pair<FloatArray, Float>> {
        val resized = if (cropBmp.width == LPD_W && cropBmp.height == LPD_H) {
            cropBmp
        } else {
            Bitmap.createScaledBitmap(cropBmp, LPD_W, LPD_H, true)
        }
        val pixels = IntArray(LPD_W * LPD_H)
        resized.getPixels(pixels, 0, LPD_W, 0, 0, LPD_W, LPD_H)
        if (resized !== cropBmp && !resized.isRecycled) resized.recycle()

        val inpData = FloatArray(LPD_W * LPD_H * 3)
        for (i in pixels.indices) {
            val px = pixels[i]
            val di = i * 3
            inpData[di] = (px and 0xFF).toFloat()
            inpData[di + 1] = ((px ushr 8) and 0xFF).toFloat()
            inpData[di + 2] = ((px ushr 16) and 0xFF).toFloat()
        }

        val headKeys = listOf("242", "249", "256", "263")
        val acts = runGraph(graph, Tensor3D(LPD_H, LPD_W, 3, inpData), headKeys.toSet())

        val numPriors = priors.size / 4
        var anchorOffset = 0
        val var0 = 0.1f
        val results = ArrayList<Pair<FloatArray, Float>>()

        for (hk in headKeys) {
            val t = acts[hk] ?: continue
            val d = t.data
            val nRows = d.size / 17
            for (r in 0 until nRows) {
                val priorIdx = anchorOffset + r
                if (priorIdx >= numPriors) break
                val rowOff = r * 17
                val logit0 = d[rowOff + 14]
                val logit1 = d[rowOff + 15]
                val maxL = max(logit0, logit1)
                val e0 = exp((logit0 - maxL).toDouble())
                val e1 = exp((logit1 - maxL).toDouble())
                val clsScore = (e1 / (e0 + e1)).toFloat().coerceIn(0f, 1f)
                val iouScore = d[rowOff + 16].coerceIn(0f, 1f)
                val score = sqrt(clsScore * iouScore)
                if (score < confThresh) continue

                val po = priorIdx * 4
                val px = priors[po]
                val py = priors[po + 1]
                val pw = priors[po + 2]
                val ph = priors[po + 3]

                val quad = floatArrayOf(
                    px + d[rowOff + 4] * var0 * pw, py + d[rowOff + 5] * var0 * ph,
                    px + d[rowOff + 6] * var0 * pw, py + d[rowOff + 7] * var0 * ph,
                    px + d[rowOff + 10] * var0 * pw, py + d[rowOff + 11] * var0 * ph,
                    px + d[rowOff + 12] * var0 * pw, py + d[rowOff + 13] * var0 * ph
                )

                val minQx = min(min(quad[0], quad[2]), min(quad[4], quad[6]))
                val maxQx = max(max(quad[0], quad[2]), max(quad[4], quad[6]))
                val minQy = min(min(quad[1], quad[3]), min(quad[5], quad[7]))
                val maxQy = max(max(quad[1], quad[3]), max(quad[5], quad[7]))
                val bw = maxQx - minQx
                val bh = maxQy - minQy
                if (bw < 0.015f || bh < 0.010f || bw > 0.85f || bh > 0.65f) continue
                if (rejectBorderClipped && (minQx < 0.015f || maxQx > 0.985f || minQy < 0.015f || maxQy > 0.985f)) {
                    continue
                }
                if (!quadIsWellFormed320x240(quad)) continue
                results.add(quad to score)
            }
            anchorOffset += nRows
        }
        return results
    }

    private fun quadIsWellFormed320x240(quad: FloatArray): Boolean {
        val ptsPx = Array(4) { i ->
            floatArrayOf(quad[i * 2] * LPD_W.toFloat(), quad[i * 2 + 1] * LPD_H.toFloat())
        }
        var cx = 0f
        var cy = 0f
        for (p in ptsPx) {
            cx += p[0]
            cy += p[1]
        }
        cx /= 4f
        cy /= 4f
        val sorted = ptsPx.sortedBy { atan2((it[1] - cy).toDouble(), (it[0] - cx).toDouble()) }
        val lens = FloatArray(4) { k ->
            val a = sorted[k]
            val b = sorted[(k + 1) % 4]
            hypot((b[0] - a[0]).toDouble(), (b[1] - a[1]).toDouble()).toFloat()
        }
        if ((lens.minOrNull() ?: 0f) <= 1e-3f) return false

        val oppW = min(lens[0], lens[2]) / max(lens[0], lens[2])
        val oppH = min(lens[1], lens[3]) / max(lens[1], lens[3])
        if (oppW < 0.56f || oppH < 0.56f) return false

        for (k in 0 until 4) {
            val prev = sorted[(k + 3) % 4]
            val cur = sorted[k]
            val next = sorted[(k + 1) % 4]
            val v1x = prev[0] - cur[0]
            val v1y = prev[1] - cur[1]
            val v2x = next[0] - cur[0]
            val v2y = next[1] - cur[1]
            val n1 = hypot(v1x.toDouble(), v1y.toDouble()).toFloat()
            val n2 = hypot(v2x.toDouble(), v2y.toDouble()).toFloat()
            val sinAng = abs(v1x * v2y - v1y * v2x) / max(1e-6f, n1 * n2)
            if (sinAng < 0.58f) return false
        }
        return true
    }

    private fun sigmoid(x: Float): Float = (1.0 / (1.0 + exp((-x).toDouble()))).toFloat().coerceIn(0f, 1f)

    private fun buildLpdPriors(width: Int, height: Int): FloatArray {
        val minSizesGroups = arrayOf(
            intArrayOf(10, 16, 24),
            intArrayOf(32, 48),
            intArrayOf(64, 96),
            intArrayOf(128, 192, 256)
        )
        val steps = intArrayOf(8, 16, 32, 64)
        val fm2H = ((height + 1) / 2) / 2
        val fm2W = ((width + 1) / 2) / 2
        val fm3 = intArrayOf(fm2H / 2, fm2W / 2)
        val fm4 = intArrayOf(fm3[0] / 2, fm3[1] / 2)
        val fm5 = intArrayOf(fm4[0] / 2, fm4[1] / 2)
        val fm6 = intArrayOf(fm5[0] / 2, fm5[1] / 2)
        val featureMaps = arrayOf(fm3, fm4, fm5, fm6)

        val list = ArrayList<Float>(4385 * 4)
        for (k in featureMaps.indices) {
            val fm = featureMaps[k]
            val msList = minSizesGroups[k]
            val step = steps[k].toFloat()
            for (i in 0 until fm[0]) {
                for (j in 0 until fm[1]) {
                    for (ms in msList) {
                        list.add((j + 0.5f) * step / width.toFloat())
                        list.add((i + 0.5f) * step / height.toFloat())
                        list.add(ms.toFloat() / width.toFloat())
                        list.add(ms.toFloat() / height.toFloat())
                    }
                }
            }
        }
        return list.toFloatArray()
    }

    // ==================== NHWC 推論ランタイム ====================

    private fun runGraph(graph: OnnxGraph, inputTensor: Tensor3D, keepOutputs: Set<String>): Map<String, Tensor3D> {
        val acts = HashMap<String, Tensor3D>()
        acts["input"] = inputTensor

        for ((nodeIdx, node) in graph.nodes.withIndex()) {
            when (node.op) {
                "Conv" -> {
                    val x = acts[node.inputs[0]] ?: continue
                    val w = graph.weights[node.inputs[1]] ?: continue
                    val b = graph.weights[node.inputs[2]] ?: continue
                    acts[node.outputs[0]] = execConvNhwc(x, w, b, node.strides, node.pads, node.group)
                }
                "Relu" -> {
                    val x = acts[node.inputs[0]] ?: continue
                    val out = FloatArray(x.data.size)
                    val src = x.data
                    for (i in src.indices) {
                        val v = src[i]
                        out[i] = if (v > 0f) v else 0f
                    }
                    acts[node.outputs[0]] = Tensor3D(x.h, x.w, x.c, out)
                }
                "MaxPool" -> {
                    val x = acts[node.inputs[0]] ?: continue
                    acts[node.outputs[0]] = execMaxPool2x2(x)
                }
                "Resize" -> {
                    val x = acts[node.inputs[0]] ?: continue
                    acts[node.outputs[0]] = execResize2xNearest(x)
                }
                "Add" -> {
                    val a = acts[node.inputs[0]] ?: continue
                    val b = acts[node.inputs[1]] ?: continue
                    val out = FloatArray(a.data.size)
                    val da = a.data
                    val db = b.data
                    for (i in out.indices) {
                        out[i] = da[i] + db[i]
                    }
                    acts[node.outputs[0]] = Tensor3D(a.h, a.w, a.c, out)
                }
            }

            // メモリ削減のため、以降どのノードも参照しない中間テンソルを即解放
            for (inpName in node.inputs) {
                if (inpName in keepOutputs) continue
                val lastIdx = graph.lastUseIdx[inpName] ?: -1
                if (nodeIdx >= lastIdx) {
                    acts.remove(inpName)
                }
            }
        }
        return acts
    }

    private fun parallelForRows(totalRows: Int, task: (rowStart: Int, rowEnd: Int) -> Unit) {
        if (totalRows <= 1 || workerCount <= 1) {
            task(0, totalRows)
            return
        }
        val chunks = min(workerCount, totalRows)
        val latch = CountDownLatch(chunks)
        val base = totalRows / chunks
        val rem = totalRows % chunks
        var cur = 0
        for (c in 0 until chunks) {
            val len = base + if (c < rem) 1 else 0
            val r0 = cur
            val r1 = cur + len
            cur = r1
            pool.execute {
                try {
                    task(r0, r1)
                } finally {
                    latch.countDown()
                }
            }
        }
        latch.await(15, TimeUnit.SECONDS)
    }

    private fun execConvNhwc(
        x: Tensor3D,
        w: WeightTensor,
        b: WeightTensor,
        strides: IntArray,
        pads: IntArray,
        group: Int
    ): Tensor3D {
        val inH = x.h
        val inW = x.w
        val cIn = x.c
        val cOut = w.dims[0]
        val kH = w.dims[2]
        val kW = w.dims[3]
        val sh = strides[0]
        val sw = strides[1]
        val padT = pads[0]
        val padL = pads[1]
        val padB = pads[2]
        val padR = pads[3]

        val outH = (inH + padT + padB - kH) / sh + 1
        val outW = (inW + padL + padR - kW) / sw + 1
        val out = FloatArray(outH * outW * cOut)
        val xData = x.data
        val wData = w.data
        val bData = b.data

        if (kH == 1 && kW == 1 && group == 1) {
            val workMacs = outH.toLong() * outW * cIn * cOut
            val rowRunner = { y0: Int, y1: Int ->
                val cOut4 = cOut and 3.inv()
                for (y in y0 until y1) {
                    val inRowBase = y * inW * cIn
                    val outRowBase = y * outW * cOut
                    for (px in 0 until outW) {
                        val xOff = inRowBase + px * cIn
                        val oOff = outRowBase + px * cOut
                        var oc = 0
                        while (oc < cOut4) {
                            val wOff0 = oc * cIn
                            val wOff1 = wOff0 + cIn
                            val wOff2 = wOff1 + cIn
                            val wOff3 = wOff2 + cIn
                            var s0 = bData[oc]
                            var s1 = bData[oc + 1]
                            var s2 = bData[oc + 2]
                            var s3 = bData[oc + 3]
                            for (ic in 0 until cIn) {
                                val xv = xData[xOff + ic]
                                s0 += xv * wData[wOff0 + ic]
                                s1 += xv * wData[wOff1 + ic]
                                s2 += xv * wData[wOff2 + ic]
                                s3 += xv * wData[wOff3 + ic]
                            }
                            out[oOff + oc] = s0
                            out[oOff + oc + 1] = s1
                            out[oOff + oc + 2] = s2
                            out[oOff + oc + 3] = s3
                            oc += 4
                        }
                        while (oc < cOut) {
                            val wOff = oc * cIn
                            var s = bData[oc]
                            for (ic in 0 until cIn) {
                                s += xData[xOff + ic] * wData[wOff + ic]
                            }
                            out[oOff + oc] = s
                            oc++
                        }
                    }
                }
            }
            if (workMacs >= 500_000L) parallelForRows(outH, rowRunner) else rowRunner(0, outH)
            return Tensor3D(outH, outW, cOut, out)
        }

        if (group == cIn && group == cOut) {
            // Depthwise 畳み込み (3x3等)
            val rowRunner = { y0: Int, y1: Int ->
                val kArea = kH * kW
                for (oy in y0 until y1) {
                    val outRow = oy * outW * cOut
                    val baseY = oy * sh - padT
                    for (ox in 0 until outW) {
                        val oOff = outRow + ox * cOut
                        System.arraycopy(bData, 0, out, oOff, cOut)
                        val baseX = ox * sw - padL
                        for (ky in 0 until kH) {
                            val iy = baseY + ky
                            if (iy < 0 || iy >= inH) continue
                            val inRow = iy * inW * cIn
                            for (kx in 0 until kW) {
                                val ix = baseX + kx
                                if (ix < 0 || ix >= inW) continue
                                val xOff = inRow + ix * cIn
                                val kOff = ky * kW + kx
                                for (c in 0 until cOut) {
                                    out[oOff + c] += xData[xOff + c] * wData[c * kArea + kOff]
                                }
                            }
                        }
                    }
                }
            }
            if (outH.toLong() * outW * cOut * kH * kW >= 500_000L) {
                parallelForRows(outH, rowRunner)
            } else {
                rowRunner(0, outH)
            }
            return Tensor3D(outH, outW, cOut, out)
        }

        // 一般畳み込み (Stem 3x3 stride 2 等)
        val rowRunner = { y0: Int, y1: Int ->
            val kArea = kH * kW
            val wStrideOc = cIn * kArea
            for (oy in y0 until y1) {
                val outRow = oy * outW * cOut
                val baseY = oy * sh - padT
                for (ox in 0 until outW) {
                    val oOff = outRow + ox * cOut
                    System.arraycopy(bData, 0, out, oOff, cOut)
                    val baseX = ox * sw - padL
                    for (ky in 0 until kH) {
                        val iy = baseY + ky
                        if (iy < 0 || iy >= inH) continue
                        val inRow = iy * inW * cIn
                        for (kx in 0 until kW) {
                            val ix = baseX + kx
                            if (ix < 0 || ix >= inW) continue
                            val xOff = inRow + ix * cIn
                            val kOff = ky * kW + kx
                            for (oc in 0 until cOut) {
                                val wOc = oc * wStrideOc + kOff
                                var s = 0f
                                for (ic in 0 until cIn) {
                                    s += xData[xOff + ic] * wData[wOc + ic * kArea]
                                }
                                out[oOff + oc] += s
                            }
                        }
                    }
                }
            }
        }
        if (outH.toLong() * outW * cOut * cIn * kH * kW >= 500_000L) {
            parallelForRows(outH, rowRunner)
        } else {
            rowRunner(0, outH)
        }
        return Tensor3D(outH, outW, cOut, out)
    }

    private fun execMaxPool2x2(x: Tensor3D): Tensor3D {
        val outH = x.h / 2
        val outW = x.w / 2
        val c = x.c
        val out = FloatArray(outH * outW * c)
        val src = x.data
        val inRowStride = x.w * c
        for (oy in 0 until outH) {
            val iy0 = (oy * 2) * inRowStride
            val iy1 = iy0 + inRowStride
            val outRow = oy * outW * c
            for (ox in 0 until outW) {
                val ix0 = (ox * 2) * c
                val ix1 = ix0 + c
                val oOff = outRow + ox * c
                for (ch in 0 until c) {
                    val a = src[iy0 + ix0 + ch]
                    val b = src[iy0 + ix1 + ch]
                    val d = src[iy1 + ix0 + ch]
                    val e = src[iy1 + ix1 + ch]
                    out[oOff + ch] = max(max(a, b), max(d, e))
                }
            }
        }
        return Tensor3D(outH, outW, c, out)
    }

    private fun execResize2xNearest(x: Tensor3D): Tensor3D {
        val outH = x.h * 2
        val outW = x.w * 2
        val c = x.c
        val out = FloatArray(outH * outW * c)
        val src = x.data
        for (iy in 0 until x.h) {
            val inRow = iy * x.w * c
            val outRow0 = (iy * 2) * outW * c
            val outRow1 = outRow0 + outW * c
            for (ix in 0 until x.w) {
                val xOff = inRow + ix * c
                val dOff00 = outRow0 + (ix * 2) * c
                val dOff01 = dOff00 + c
                val dOff10 = outRow1 + (ix * 2) * c
                val dOff11 = dOff10 + c
                System.arraycopy(src, xOff, out, dOff00, c)
                System.arraycopy(src, xOff, out, dOff01, c)
                System.arraycopy(src, xOff, out, dOff10, c)
                System.arraycopy(src, xOff, out, dOff11, c)
            }
        }
        return Tensor3D(outH, outW, c, out)
    }

    // ==================== 最小 ONNX Protobuf ローダ ====================

    private fun loadAssetGraph(context: Context, assetPath: String, stopNodeCount: Int): OnnxGraph? {
        val rawBytes = context.assets.open(assetPath).use { ins ->
            val baos = ByteArrayOutputStream()
            val buf = ByteArray(16384)
            while (true) {
                val n = ins.read(buf)
                if (n <= 0) break
                baos.write(buf, 0, n)
            }
            baos.toByteArray()
        }

        val topFields = parseProtoFields(rawBytes, 0, rawBytes.size)
        val graphRange = topFields.firstOrNull { it.fieldNum == 7 } ?: return null
        val graphFields = parseProtoFields(rawBytes, graphRange.start, graphRange.end)

        val weights = HashMap<String, WeightTensor>()
        val rawNodes = ArrayList<ProtoField>()
        for (gf in graphFields) {
            when (gf.fieldNum) {
                1 -> rawNodes.add(gf)
                5 -> parseFloatTensorProto(rawBytes, gf.start, gf.end)?.let { (name, wt) ->
                    weights[name] = wt
                }
            }
        }

        val nodes = ArrayList<OnnxNode>(min(stopNodeCount, rawNodes.size))
        for (i in 0 until min(stopNodeCount, rawNodes.size)) {
            val nf = parseProtoFields(rawBytes, rawNodes[i].start, rawNodes[i].end)
            val inputs = ArrayList<String>()
            val outputs = ArrayList<String>()
            var opType = ""
            var strides = intArrayOf(1, 1)
            var pads = intArrayOf(0, 0, 0, 0)
            var group = 1

            for (f in nf) {
                when (f.fieldNum) {
                    1 -> inputs.add(String(rawBytes, f.start, f.end - f.start, Charsets.UTF_8))
                    2 -> outputs.add(String(rawBytes, f.start, f.end - f.start, Charsets.UTF_8))
                    4 -> opType = String(rawBytes, f.start, f.end - f.start, Charsets.UTF_8)
                    5 -> {
                        val (attrName, attrInt, attrInts) = parseAttrProto(rawBytes, f.start, f.end)
                        when (attrName) {
                            "strides" -> if (attrInts.size >= 2) strides = intArrayOf(attrInts[0], attrInts[1])
                            "pads" -> if (attrInts.size >= 4) pads = intArrayOf(attrInts[0], attrInts[1], attrInts[2], attrInts[3])
                            "group" -> if (attrInt != null) group = attrInt
                        }
                    }
                }
            }
            nodes.add(OnnxNode(opType, inputs, outputs, strides, pads, group))
        }

        val lastUseIdx = HashMap<String, Int>()
        for ((idx, node) in nodes.withIndex()) {
            for (inp in node.inputs) {
                lastUseIdx[inp] = idx
            }
        }
        return OnnxGraph(weights, nodes, lastUseIdx)
    }

    private class ProtoField(val fieldNum: Int, val wireType: Int, val varintVal: Long, val start: Int, val end: Int)

    private fun readVarint(buf: ByteArray, startPos: Int): Pair<Long, Int> {
        var res = 0L
        var shift = 0
        var pos = startPos
        while (true) {
            val b = buf[pos++].toInt() and 0xFF
            res = res or ((b and 0x7F).toLong() shl shift)
            if ((b and 0x80) == 0) return res to pos
            shift += 7
        }
    }

    private fun parseProtoFields(buf: ByteArray, start: Int, end: Int): List<ProtoField> {
        val out = ArrayList<ProtoField>()
        var pos = start
        while (pos < end) {
            val (tag, afterTag) = readVarint(buf, pos)
            pos = afterTag
            val fieldNum = (tag ushr 3).toInt()
            val wireType = (tag and 7L).toInt()
            when (wireType) {
                0 -> {
                    val (v, np) = readVarint(buf, pos)
                    out.add(ProtoField(fieldNum, wireType, v, pos, np))
                    pos = np
                }
                1 -> {
                    out.add(ProtoField(fieldNum, wireType, 0L, pos, pos + 8))
                    pos += 8
                }
                2 -> {
                    val (ln, np) = readVarint(buf, pos)
                    val lenInt = ln.toInt()
                    out.add(ProtoField(fieldNum, wireType, ln, np, np + lenInt))
                    pos = np + lenInt
                }
                5 -> {
                    out.add(ProtoField(fieldNum, wireType, 0L, pos, pos + 4))
                    pos += 4
                }
                else -> break
            }
        }
        return out
    }

    private fun parseFloatTensorProto(buf: ByteArray, start: Int, end: Int): Pair<String, WeightTensor>? {
        val fields = parseProtoFields(buf, start, end)
        val dims = ArrayList<Int>()
        var dtype = 0
        var name = ""
        var rawRange: ProtoField? = null
        val floatList = ArrayList<Float>()

        for (f in fields) {
            when (f.fieldNum) {
                1 -> {
                    if (f.wireType == 0) {
                        dims.add(f.varintVal.toInt())
                    } else if (f.wireType == 2) {
                        var p = f.start
                        while (p < f.end) {
                            val (d, np) = readVarint(buf, p)
                            dims.add(d.toInt())
                            p = np
                        }
                    }
                }
                2 -> dtype = f.varintVal.toInt()
                4 -> {
                    if (f.wireType == 5) {
                        val bits = ByteBuffer.wrap(buf, f.start, 4).order(ByteOrder.LITTLE_ENDIAN).float
                        floatList.add(bits)
                    } else if (f.wireType == 2) {
                        val bb = ByteBuffer.wrap(buf, f.start, f.end - f.start).order(ByteOrder.LITTLE_ENDIAN)
                        while (bb.remaining() >= 4) floatList.add(bb.float)
                    }
                }
                8 -> name = String(buf, f.start, f.end - f.start, Charsets.UTF_8)
                9 -> rawRange = f
            }
        }

        // FLOAT (1) のみ推論用重みとして保持し、Shape用 Int64 定数等は破棄
        if (dtype != 1 || name.isEmpty()) return null

        val data: FloatArray = if (rawRange != null) {
            val byteLen = rawRange.end - rawRange.start
            val arr = FloatArray(byteLen / 4)
            ByteBuffer.wrap(buf, rawRange.start, byteLen).order(ByteOrder.LITTLE_ENDIAN).asFloatBuffer().get(arr)
            arr
        } else {
            floatList.toFloatArray()
        }
        return name to WeightTensor(dims.toIntArray(), data)
    }

    private fun parseAttrProto(buf: ByteArray, start: Int, end: Int): Triple<String, Int?, IntArray> {
        val fields = parseProtoFields(buf, start, end)
        var name = ""
        var iVal: Int? = null
        val ints = ArrayList<Int>()
        for (f in fields) {
            when (f.fieldNum) {
                1 -> name = String(buf, f.start, f.end - f.start, Charsets.UTF_8)
                3 -> iVal = f.varintVal.toInt()
                8 -> {
                    if (f.wireType == 0) {
                        ints.add(f.varintVal.toInt())
                    } else if (f.wireType == 2) {
                        var p = f.start
                        while (p < f.end) {
                            val (v, np) = readVarint(buf, p)
                            ints.add(v.toInt())
                            p = np
                        }
                    }
                }
            }
        }
        return Triple(name, iVal, ints.toIntArray())
    }

    /** フォールバック顔検出向け: 候補円内が極端な青・灰色標識等でないか最低限の肌トーン検証を行う */
    fun hasPlausibleSkinTone(bmp: Bitmap, cx: Float, cy: Float, radius: Float): Boolean {
        val w = bmp.width
        val h = bmp.height
        val x0 = max(0, (cx - radius * 0.6f).roundToInt())
        val y0 = max(0, (cy - radius * 0.6f).roundToInt())
        val x1 = min(w - 1, (cx + radius * 0.6f).roundToInt())
        val y1 = min(h - 1, (cy + radius * 0.6f).roundToInt())
        val stepX = max(1, (x1 - x0) / 14)
        val stepY = max(1, (y1 - y0) / 14)
        var total = 0
        var skinHits = 0
        var sumDiffRb = 0f
        var y = y0
        while (y <= y1) {
            var x = x0
            while (x <= x1) {
                val px = bmp.getPixel(x, y)
                val r = Color.red(px).toFloat()
                val g = Color.green(px).toFloat()
                val b = Color.blue(px).toFloat()
                val cr = 128f + 0.5f * r - 0.418688f * g - 0.081312f * b
                val cb = 128f - 0.168736f * r - 0.331264f * g + 0.5f * b
                val lum = 0.299f * r + 0.587f * g + 0.114f * b
                sumDiffRb += (r - b)
                if (lum in 45f..245f && cr in 133f..178f && cb in 76f..129f && r > g && r > b) {
                    skinHits++
                }
                total++
                x += stepX
            }
            y += stepY
        }
        if (total < 9) return false
        return (skinHits.toFloat() / total.toFloat()) >= 0.35f && (sumDiffRb / total.toFloat()) >= 6f
    }

    /** ONNX 顔＋ナンバー検出結果を JSON 化する（フロントエンド返却用ヘルパ） */
    fun encodeDetectionsJson(
        faces: List<FaceCandidate>,
        plates: List<PlateCandidate>,
        engine: String
    ): JSONObject {
        val outFaces = JSONArray()
        for (f in faces) {
            outFaces.put(
                JSONObject()
                    .put("x", kotlin.math.round(f.x * 100000.0) / 100000.0)
                    .put("y", kotlin.math.round(f.y * 100000.0) / 100000.0)
                    .put("r", kotlin.math.round(f.r * 100000.0) / 100000.0)
                    .put("style", "frosted")
                    .put("strength", 0.92)
                    .put("score", kotlin.math.round(f.score * 1000.0) / 1000.0)
            )
        }
        val outPlates = JSONArray()
        for (p in plates) {
            val ptsArr = JSONArray()
            for (i in 0 until 4) {
                ptsArr.put(
                    JSONObject()
                        .put("x", kotlin.math.round(p.pts[i * 2] * 100000.0) / 100000.0)
                        .put("y", kotlin.math.round(p.pts[i * 2 + 1] * 100000.0) / 100000.0)
                )
            }
            outPlates.put(
                JSONObject()
                    .put("pts", ptsArr)
                    .put("score", kotlin.math.round(p.score * 1000.0) / 1000.0)
                    .put("strictIsolation", p.strictIsolation)
            )
        }
        return JSONObject()
            .put("ok", true)
            .put("engine", engine)
            .put("faces", outFaces)
            .put("plates", outPlates)
    }
}
