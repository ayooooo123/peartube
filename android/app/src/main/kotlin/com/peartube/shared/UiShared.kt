package com.peartube.shared

import android.app.Activity
import android.view.View
import android.view.WindowManager
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel
import kotlin.math.min

@Composable
fun QrCodeView(data: String, modifier: Modifier = Modifier) {
    val matrix = remember(data) {
        QRCodeWriter().encode(
            data,
            BarcodeFormat.QR_CODE,
            1,
            1,
            mapOf(
                EncodeHintType.ERROR_CORRECTION to ErrorCorrectionLevel.M,
                EncodeHintType.MARGIN to 4,
            ),
        )
    }
    Canvas(modifier.aspectRatio(1f).clip(RoundedCornerShape(18.dp)).background(Color.White)) {
        val module = (min(size.width, size.height) / matrix.width).toInt()
        if (module > 0) {
            val left = ((size.width - matrix.width * module) / 2).toInt()
            val top = ((size.height - matrix.height * module) / 2).toInt()
            for (y in 0 until matrix.height) {
                for (x in 0 until matrix.width) {
                    if (matrix[x, y]) {
                        drawRect(
                            Color.Black,
                            Offset((left + x * module).toFloat(), (top + y * module).toFloat()),
                            Size(module.toFloat(), module.toFloat()),
                        )
                    }
                }
            }
        }
    }
}

fun Activity.setImmersive(on: Boolean, view: View) {
    WindowCompat.setDecorFitsSystemWindows(window, false)
    val bars = WindowCompat.getInsetsController(window, view)
    if (on) {
        bars.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        bars.hide(WindowInsetsCompat.Type.systemBars())
    } else {
        bars.isAppearanceLightStatusBars = false
        bars.isAppearanceLightNavigationBars = false
        bars.show(WindowInsetsCompat.Type.systemBars())
    }
    window.attributes = window.attributes.apply {
        layoutInDisplayCutoutMode = if (on) WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
        else WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_DEFAULT
    }
}
