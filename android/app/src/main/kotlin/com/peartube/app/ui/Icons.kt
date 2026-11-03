package com.peartube.app.ui

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.unit.dp

// The player's icons, from Material Icons' path data (Apache-2.0). None of them are text:
// Android draws characters such as ⏸ as colour emoji whatever the variation selector.

val PlayIcon = icon("Play", "M8 5v14l11-7z")
val PauseIcon = icon("Pause", "M6 19h4V5H6v14zm8-14v14h4V5h-4z")
val BackIcon = icon("Back", "M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z")
val ReplayIcon = icon("Replay", "M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z")
val FullscreenIcon = icon("Fullscreen", "M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z")
val FullscreenExitIcon = icon("Exit fullscreen", "M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z")
val SubtitlesIcon = icon(
    "Subtitles",
    "M19 4H5c-1.11 0-2 .9-2 2v12c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm-8 7H9.5v-.5h-2v3h2V13H11v1c0 .55-.45 1-1 1H7c-.55 0-1-.45-1-1v-4c0-.55.45-1 1-1h3c.55 0 1 .45 1 1v1zm7 0h-1.5v-.5h-2v3h2V13H18v1c0 .55-.45 1-1 1h-3c-.55 0-1-.45-1-1v-4c0-.55.45-1 1-1h3c.55 0 1 .45 1 1v1z",
)
val AudioIcon = icon("Audio", "M12 3v9.28c-.47-.17-.97-.28-1.5-.28C8.01 12 6 14.01 6 16.5S8.01 21 10.5 21c2.31 0 4.2-1.75 4.45-4H15V6h4V3h-7z")
val CheckIcon = icon("Selected", "M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z")
val ExpandIcon = icon("Choose", "M16.59 8.59L12 13.17 7.41 8.59 6 10l6 6 6-6z")
val CastIcon = icon("Cast", "M1 18v3h3a3 3 0 0 0-3-3zm0-4v2a5 5 0 0 1 5 5h2a7 7 0 0 0-7-7zm0-4v2a9 9 0 0 1 9 9h2A11 11 0 0 0 1 10zm20-7H3a2 2 0 0 0-2 2v3h2V5h18v14h-7v2h7a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z")
val CastConnectedIcon = icon("Casting", "M1 18v3h3a3 3 0 0 0-3-3zm0-4v2a5 5 0 0 1 5 5h2a7 7 0 0 0-7-7zm0-4v2a9 9 0 0 1 9 9h2A11 11 0 0 0 1 10zM21 3H3a2 2 0 0 0-2 2v3h2V5h18v14h-7v2h7a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zM5 7v1.63A13 13 0 0 1 13.37 17H19V7z")
val TvIcon = icon("TV Mode", "M21 3H3a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h5v2h8v-2h5a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm0 14H3V5h18z")
val QrCodeScannerIcon = icon("Scan QR code", "M4 4h4V2H2v6h2V4zm16 0v4h2V2h-6v2h4zM4 16H2v6h6v-2H4v-4zm16 4h-4v2h6v-6h-2v4zM6 6h5v5H6V6zm1 1v3h3V7H7zm6-1h5v5h-5V6zm1 1v3h3V7h-3zM6 13h5v5H6v-5zm1 1v3h3v-3H7zm6-1h2v2h-2zm3 0h2v3h-2zm-3 3h3v2h-3zm4 1h1v1h-1z")
val QrCodeIcon = icon("QR code", "M3 3h7v7H3V3zm2 2v3h3V5H5zm9-2h7v7h-7V3zm2 2v3h3V5h-3zM3 14h7v7H3v-7zm2 2v3h3v-3H5zm9-2h3v3h-3zm4 0h3v2h-3zm-4 4h2v3h-2zm3-1h4v4h-4z")
val SettingsIcon = icon("Settings", "M19.43 12.98c.04-.32.07-.65.07-.98s-.03-.66-.08-.98l2.11-1.65-2-3.46-2.49 1a7.3 7.3 0 0 0-1.69-.98L15 3h-4l-.35 2.93c-.61.25-1.18.58-1.69.98l-2.49-1-2 3.46 2.11 1.65a7.6 7.6 0 0 0 0 1.96l-2.11 1.65 2 3.46 2.49-1c.51.4 1.08.73 1.69.98L11 21h4l.35-2.93c.61-.25 1.18-.58 1.69-.98l2.49 1 2-3.46-2.1-1.65zM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z")
val SearchIcon = icon("Search", "M9.5 3a6.5 6.5 0 1 0 3.98 11.64L19.84 21 21 19.84l-6.36-6.36A6.5 6.5 0 0 0 9.5 3zm0 2a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9z")
val CloseIcon = icon("Close", "M18.3 5.71 12 12l6.3 6.29-1.41 1.42L10.59 13.4 4.3 19.71l-1.42-1.42L9.18 12l-6.3-6.29L4.3 4.29l6.29 6.3 6.3-6.3z")
val MoreVertIcon = icon("More", "M12 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm0 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm0 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z")
val ChevronRightIcon = icon("Expand", "M9.29 6.71 14.59 12l-5.3 5.29L10.71 18.7 17.41 12l-6.7-6.71z")
val ChevronDownIcon = ExpandIcon
val FlashOnIcon = icon("Torch on", "M7 2v11h3v9l7-12h-4l4-8z")
val FlashOffIcon = icon("Torch off", "M3.27 2 2 3.27 9 10.27V13h3v9l4.01-6.87L20.73 20 22 18.73 3.27 2zM17 2h-4l-2.14 4.28L15.58 11H17l-4-1 4-8z")
val ShareIcon = icon("Share", "M18 16a3 3 0 0 0-2.38 1.17L8.91 13.3a3 3 0 0 0 0-2.6l6.71-3.87A3 3 0 1 0 15 5l.04.48-6.71 3.88a3 3 0 1 0 0 5.28l6.71 3.88L15 19a3 3 0 1 0 3-3z")
val DeleteSweepIcon = icon("Free up cache", "M3 6h11v2H3V6zm2 3h7v12H5V9zm2-6h3v2H7V3zm9 6h6v2h-6V9zm0 4h5v2h-5v-2zm0 4h4v2h-4v-2z")
val AddIcon = icon("Add", "M19 11h-6V5h-2v6H5v2h6v6h2v-6h6z")
val InfoIcon = icon("Content info", "M11 17h2v-6h-2v6zm1-15a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16zM11 9h2V7h-2v2z")
val DownloadIcon = icon("Download", "M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z")

private fun icon(name: String, path: String) =
    ImageVector.Builder(name, 24.dp, 24.dp, 24f, 24f)
        .addPath(addPathNodes(path), fill = SolidColor(Color.White))
        .build()
