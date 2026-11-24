package com.peartube.app.ui

import android.content.ClipData
import android.content.ClipboardManager
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

// Tokens from design/tokens.json (dark palette + violet brand)
val Bg = Color(0xFF08090C)
val CardBg = Color(0xFF101218)
val CardElevated = Color(0xFF171A22)
val Line = Color(0xFF232733)
val Ink = Color(0xFFF2F4F8)
val Dim = Color(0xFF98A0B3)
val Accent = Color(0xFF45D08A)
val Warn = Color(0xFFE8B45C)
val Brand = Color(0xFF9147FF)
val BrandHover = Color(0xFFA866FF)
val BrandRing = Color(0xFFB98BFF)
val Danger = Color(0xFFFF7D7D)
val HeroPrimaryInk = Color(0xFF111111)
val OverlayPanelBg = Color(0xF00F131C)
val SourceYoutube = Color(0xFFE05252)
val SourceSoundCloud = Color(0xFFFF7A33)
val SourceRumble = Color(0xFF7FD14B)

val ControlShape = RoundedCornerShape(10.dp)
val HeroButtonShape = RoundedCornerShape(12.dp)
val CardShape = RoundedCornerShape(14.dp)
val PanelShape = RoundedCornerShape(18.dp)
val HeroShape = RoundedCornerShape(22.dp)
val PillShape = RoundedCornerShape(999.dp)

@Composable
fun PearTubeTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = darkColorScheme(
            primary = Brand,
            onPrimary = Color.White,
            background = Bg,
            onBackground = Ink,
            surface = Bg,
            onSurface = Ink,
            surfaceVariant = CardBg,
            onSurfaceVariant = Dim,
            surfaceContainer = CardBg,
            surfaceContainerHigh = CardElevated,
            surfaceContainerHighest = CardElevated,
            outline = Line,
            outlineVariant = Line,
            error = Danger,
        ),
        content = content,
    )
}

@Composable
internal fun rememberCopyText(): (String) -> Unit {
    val context = LocalContext.current
    return remember(context) {
        { text ->
            context.getSystemService(ClipboardManager::class.java)
                ?.setPrimaryClip(ClipData.newPlainText("PearTube", text))
        }
    }
}

@Composable
internal fun CinemaIcon(
    icon: ImageVector,
    description: String,
    tint: Color = Dim,
    onClick: () -> Unit,
) {
    IconButton(onClick = onClick, modifier = Modifier.size(44.dp)) {
        Icon(icon, description, tint = tint, modifier = Modifier.size(22.dp))
    }
}

@Composable
fun fieldColors() = OutlinedTextFieldDefaults.colors(
    focusedTextColor = Ink,
    unfocusedTextColor = Ink,
    focusedContainerColor = CardBg,
    unfocusedContainerColor = CardBg,
    focusedBorderColor = Brand,
    unfocusedBorderColor = Line,
    focusedPlaceholderColor = Dim,
    unfocusedPlaceholderColor = Dim,
    cursorColor = Brand,
)

/** Primary violet brand button matching sketch .btn.primary. */
@Composable
fun PrimaryBrandButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    icon: ImageVector? = null,
    enabled: Boolean = true,
) {
    Button(
        onClick = onClick,
        enabled = enabled,
        shape = ControlShape,
        colors = ButtonDefaults.buttonColors(
            containerColor = Brand,
            contentColor = Color.White,
            disabledContainerColor = CardElevated,
            disabledContentColor = Dim,
        ),
        contentPadding = PaddingValues(horizontal = 18.dp, vertical = 11.dp),
        modifier = modifier,
    ) {
        if (icon != null) {
            Icon(icon, null, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(6.dp))
        }
        Text(text, fontWeight = FontWeight.SemiBold, fontSize = 14.sp, maxLines = 1)
    }
}

/** Solid white hero primary button (#FFFFFF bg / #111111 ink) matching sketch .hero .btn.primary. */
@Composable
fun HeroPrimaryButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    icon: ImageVector? = null,
    enabled: Boolean = true,
) {
    Button(
        onClick = onClick,
        enabled = enabled,
        shape = HeroButtonShape,
        colors = ButtonDefaults.buttonColors(
            containerColor = Color.White,
            contentColor = HeroPrimaryInk,
            disabledContainerColor = Color.White.copy(alpha = 0.25f),
            disabledContentColor = Color.White.copy(alpha = 0.6f),
        ),
        contentPadding = PaddingValues(horizontal = 18.dp, vertical = 12.dp),
        modifier = modifier,
    ) {
        if (icon != null) {
            Icon(icon, null, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(7.dp))
        }
        Text(text, fontWeight = FontWeight.SemiBold, fontSize = 14.sp, maxLines = 1)
    }
}

/** Translucent frosted-glass hero secondary button matching sketch .hero .btn. */
@Composable
fun HeroGlassButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    icon: ImageVector? = null,
    enabled: Boolean = true,
) {
    OutlinedButton(
        onClick = onClick,
        enabled = enabled,
        shape = HeroButtonShape,
        border = BorderStroke(1.dp, Color.White.copy(alpha = if (enabled) 0.28f else 0.14f)),
        colors = ButtonDefaults.outlinedButtonColors(
            containerColor = Color.White.copy(alpha = 0.16f),
            contentColor = Color.White,
            disabledContainerColor = Color.White.copy(alpha = 0.08f),
            disabledContentColor = Color.White.copy(alpha = 0.45f),
        ),
        contentPadding = PaddingValues(horizontal = 16.dp, vertical = 12.dp),
        modifier = modifier,
    ) {
        if (icon != null) {
            Icon(icon, null, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(7.dp))
        }
        Text(text, fontWeight = FontWeight.SemiBold, fontSize = 14.sp, maxLines = 1)
    }
}

/** The main action is the light button (design/unified-library.md). */
@Composable
fun PrimaryLightButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    icon: ImageVector? = null,
    enabled: Boolean = true,
) {
    Button(
        onClick = onClick,
        enabled = enabled,
        shape = ControlShape,
        colors = ButtonDefaults.buttonColors(
            containerColor = Ink,
            contentColor = Bg,
            disabledContainerColor = CardElevated,
            disabledContentColor = Dim,
        ),
        contentPadding = PaddingValues(horizontal = 16.dp, vertical = 10.dp),
        modifier = modifier,
    ) {
        if (icon != null) {
            Icon(icon, null, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(6.dp))
        }
        Text(text, fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
    }
}

@Composable
fun QuietActionButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    icon: ImageVector? = null,
    active: Boolean = false,
    enabled: Boolean = true,
) {
    OutlinedButton(
        onClick = onClick,
        enabled = enabled,
        shape = ControlShape,
        border = BorderStroke(1.dp, if (active) Brand else Line),
        colors = ButtonDefaults.outlinedButtonColors(
            containerColor = if (active) Brand.copy(alpha = 0.16f) else CardElevated,
            contentColor = Ink,
            disabledContainerColor = CardBg,
            disabledContentColor = Dim,
        ),
        contentPadding = PaddingValues(horizontal = 14.dp, vertical = 10.dp),
        modifier = modifier,
    ) {
        if (icon != null) {
            Icon(
                icon,
                null,
                tint = if (!enabled) Dim else if (active) Brand else Ink,
                modifier = Modifier.size(18.dp),
            )
            Spacer(Modifier.width(6.dp))
        }
        Text(text, fontWeight = FontWeight.Medium, fontSize = 14.sp)
    }
}

@Composable
fun SectionHeader(
    title: String,
    actionLabel: String? = null,
    onAction: (() -> Unit)? = null,
    trailing: (@Composable RowScope.() -> Unit)? = null,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier = modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = title,
            color = Ink,
            fontSize = 18.sp,
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier.weight(1f),
        )
        if (trailing != null) {
            trailing()
        } else if (actionLabel != null && onAction != null) {
            TextButton(onClick = onAction, contentPadding = PaddingValues(horizontal = 8.dp, vertical = 4.dp)) {
                Text(actionLabel, color = Dim, fontSize = 13.sp, fontWeight = FontWeight.Medium)
            }
        }
    }
}
