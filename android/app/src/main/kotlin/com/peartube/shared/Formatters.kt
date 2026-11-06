package com.peartube.shared

import java.util.Locale

fun formatBytes(bytes: Long): String {
    val kb = 1024.0
    val mb = kb * 1024
    val gb = mb * 1024
    val tb = gb * 1024
    return when {
        bytes >= tb -> "%.2f TB".format(Locale.ROOT, bytes / tb)
        bytes >= gb -> "%.1f GB".format(Locale.ROOT, bytes / gb)
        bytes >= mb -> "%.1f MB".format(Locale.ROOT, bytes / mb)
        bytes >= kb -> "%.1f KB".format(Locale.ROOT, bytes / kb)
        else -> "$bytes B"
    }
}

fun clock(ms: Long): String {
    val s = ms.coerceAtLeast(0L) / 1000
    return if (s >= 3600) "%d:%02d:%02d".format(Locale.ROOT, s / 3600, s / 60 % 60, s % 60)
    else "%d:%02d".format(Locale.ROOT, s / 60, s % 60)
}

fun prettyCodec(raw: String): String = when (raw.lowercase(Locale.ROOT)) {
    "h264", "avc", "avc1" -> "H.264"
    "h265", "hevc", "hev1", "hvc1" -> "HEVC"
    "av1", "av01" -> "AV1"
    "vp9" -> "VP9"
    "vp8" -> "VP8"
    "mpeg4", "xvid", "divx" -> "MPEG-4"
    "mpeg2video", "mpeg2" -> "MPEG-2"
    "vc1" -> "VC-1"
    "truehd" -> "TrueHD"
    "mlp" -> "Meridian Lossless"
    "eac3", "ec-3" -> "Dolby E-AC-3"
    "ac3" -> "Dolby AC-3"
    "dts", "dca" -> "DTS-HD"
    "flac" -> "FLAC"
    "alac" -> "ALAC"
    "wavpack" -> "WavPack"
    "als" -> "MPEG-4 ALS"
    "ape" -> "Monkey's Audio"
    "tak" -> "TAK"
    "tta" -> "TTA"
    "shorten" -> "Shorten"
    "dsd_lsbf", "dsd_msbf", "dsd_lsbf_planar", "dsd_msbf_planar" -> "DSD"
    "aac" -> "AAC"
    "opus" -> "Opus"
    "vorbis" -> "Vorbis"
    "mp3" -> "MP3"
    "subrip", "srt" -> "SRT"
    "ass", "ssa" -> "ASS"
    "hdmv_pgs_subtitle", "pgs" -> "PGS"
    "dvd_subtitle", "vobsub" -> "VobSub"
    else -> raw.uppercase(Locale.ROOT)
}
