package com.peartube.app.ui

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts.RequestPermission
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.peartube.shared.QrCodeView
import com.google.zxing.*
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeReader
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.min


@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun QrScannerSheet(onScanned: (String) -> Unit, onClose: () -> Unit) {
    ModalBottomSheet(onDismissRequest = onClose, containerColor = CardBg) {
        QrScannerView(onScanned, onClose)
    }
}

@Composable
fun QrScannerView(onScanned: (String) -> Unit, onClose: () -> Unit) {
    val context = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current
    val haptic = LocalHapticFeedback.current
    val deliver by rememberUpdatedState(onScanned)
    var allowed by remember { mutableStateOf(ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) }
    var requested by remember { mutableStateOf(false) }
    var problem by remember { mutableStateOf<String?>(null) }
    var camera by remember { mutableStateOf<Camera?>(null) }
    var torch by remember { mutableStateOf(false) }
    val preview = remember { PreviewView(context).apply { scaleType = PreviewView.ScaleType.FILL_CENTER } }
    val launcher = rememberLauncherForActivityResult(RequestPermission()) { allowed = it; requested = true }
    LaunchedEffect(Unit) {
        if (!context.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)) {
            problem = "This screen doesn't have a camera. Select a nearby TV from Cast instead."
        } else if (!allowed) launcher.launch(Manifest.permission.CAMERA)
    }
    DisposableEffect(allowed, lifecycle) {
        val stopped = AtomicBoolean(false)
        val matched = AtomicBoolean(false)
        val executor = Executors.newSingleThreadExecutor()
        val future = if (allowed) ProcessCameraProvider.getInstance(context) else null
        var provider: ProcessCameraProvider? = null
        var analysis: ImageAnalysis? = null
        var livePreview: Preview? = null
        future?.addListener({
            if (!stopped.get()) {
                try {
                    val owner = future!!.get()
                    provider = owner
                    val p = Preview.Builder().build().also { it.setSurfaceProvider(preview.surfaceProvider) }
                    livePreview = p
                    val reader = QRCodeReader()
                    val hints = mapOf(DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE), DecodeHintType.TRY_HARDER to true)
                    var luminance = ByteArray(0)
                    val a = ImageAnalysis.Builder().setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST).build()
                    analysis = a
                    a.setAnalyzer(executor) { image ->
                        try {
                            if (!stopped.get() && !matched.get()) {
                                val plane = image.planes[0]
                                val buffer = plane.buffer
                                val width = image.width
                                val height = image.height
                                val base = buffer.position()
                                val rotation = image.imageInfo.rotationDegrees
                                val outWidth = if (rotation == 90 || rotation == 270) height else width
                                val outHeight = if (rotation == 90 || rotation == 270) width else height
                                if (luminance.size != width * height) luminance = ByteArray(width * height)
                                val bytes = luminance
                                for (y in 0 until height) for (x in 0 until width) {
                                    val value = buffer.get(base + y * plane.rowStride + x * plane.pixelStride)
                                    val index = when (rotation) {
                                        90 -> x * outWidth + height - 1 - y
                                        180 -> (height - 1 - y) * outWidth + width - 1 - x
                                        270 -> (width - 1 - x) * outWidth + y
                                        else -> y * outWidth + x
                                    }
                                    bytes[index] = value
                                }
                                val source = PlanarYUVLuminanceSource(bytes, outWidth, outHeight, 0, 0, outWidth, outHeight, false)
                                val text = reader.decode(BinaryBitmap(HybridBinarizer(source)), hints).text.trim()
                                val uri = android.net.Uri.parse(text)
                                val valid = uri.scheme.equals("peartube", true) || ((uri.scheme.equals("https", true) || uri.scheme.equals("http", true)) && !uri.host.isNullOrBlank())
                                if (valid && matched.compareAndSet(false, true)) {
                                    a.clearAnalyzer()
                                    ContextCompat.getMainExecutor(context).execute {
                                        if (!stopped.get()) {
                                            camera?.cameraControl?.enableTorch(false)
                                            owner.unbind(p, a)
                                            haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                                            deliver(text)
                                        }
                                    }
                                }
                            }
                        } catch (_: ReaderException) {
                        } catch (_: IllegalArgumentException) {
                        } finally {
                            reader.reset()
                            image.close()
                        }
                    }
                    val selector = if (owner.hasCamera(CameraSelector.DEFAULT_BACK_CAMERA)) CameraSelector.DEFAULT_BACK_CAMERA else CameraSelector.DEFAULT_FRONT_CAMERA
                    camera = owner.bindToLifecycle(lifecycle, selector, p, a)
                } catch (_: Exception) {
                    problem = "The camera couldn't open. You can still select a nearby TV from Cast."
                }
            }
        }, ContextCompat.getMainExecutor(context))
        onDispose {
            stopped.set(true)
            analysis?.clearAnalyzer()
            camera?.cameraControl?.enableTorch(false)
            livePreview?.let { p -> analysis?.let { a -> provider?.unbind(p, a) } }
            executor.shutdown()
        }
    }
    Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Scan a little magic", color = Ink, fontSize = 22.sp, modifier = Modifier.weight(1f))
            IconButton(onClick = onClose) { Icon(CloseIcon, "Close scanner", tint = Ink) }
        }
        when {
            problem != null -> Text(problem!!, color = Dim)
            !allowed -> Text(if (requested) "Camera access is off. Select a nearby TV from Cast, or allow camera access in Android Settings to scan a link." else "Allow camera access to scan a TV or channel QR code.", color = Dim)
            else -> {
                Box(Modifier.fillMaxWidth().height(320.dp).clip(RoundedCornerShape(24.dp))) {
                    AndroidView(factory = { preview }, modifier = Modifier.fillMaxSize())
                    Canvas(Modifier.fillMaxSize()) {
                        val side = min(size.width, size.height) * .72f
                        val x = (size.width - side) / 2
                        val y = (size.height - side) / 2
                        val arm = 26.dp.toPx()
                        for ((cx, cy) in listOf(x to y, (x + side) to y, x to (y + side), (x + side) to (y + side))) {
                            drawLine(Color.White, Offset(cx, cy), Offset(cx + if (cx == x) arm else -arm, cy), 3.dp.toPx(), StrokeCap.Round)
                            drawLine(Color.White, Offset(cx, cy), Offset(cx, cy + if (cy == y) arm else -arm), 3.dp.toPx(), StrokeCap.Round)
                        }
                    }
                    if (camera?.cameraInfo?.hasFlashUnit() == true) IconButton(
                        onClick = { torch = !torch; camera?.cameraControl?.enableTorch(torch) },
                        modifier = Modifier.align(Alignment.BottomCenter).padding(12.dp).background(Color.Black.copy(alpha = .5f), RoundedCornerShape(24.dp)),
                    ) { Icon(if (torch) FlashOnIcon else FlashOffIcon, "Toggle torch", tint = Color.White) }
                }
                Text("Point at a PearTube QR code. We'll take it from here.", color = Dim)
            }
        }
    }
}
