package io.github.santoshban.streamora

import android.content.Context
import android.hardware.display.DisplayManager
import android.media.MediaCodecInfo.CodecProfileLevel
import android.media.MediaCodecList
import android.os.Build
import android.view.Display
import androidx.annotation.OptIn
import androidx.media3.common.util.UnstableApi
import androidx.media3.decoder.ffmpeg.FfmpegLibrary
import org.json.JSONArray
import org.json.JSONObject

/** What the server's playback decision needs to know (backend/src/streaming/decision.ts). */
data class Capabilities(
    val containers: List<String>,
    val videoCodecs: List<String>,
    val audioCodecs: List<String>,
    val maxAudioChannels: Int,
    val hdr: Boolean,
    /** Null when the phone decodes 4K. */
    val maxWidth: Int?,
    val maxHeight: Int?,
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("containers", JSONArray(containers))
        put("videoCodecs", JSONArray(videoCodecs))
        put("audioCodecs", JSONArray(audioCodecs))
        put("maxAudioChannels", maxAudioChannels)
        put("hdr", hdr)
        maxWidth?.let { put("maxWidth", it) }
        maxHeight?.let { put("maxHeight", it) }
        // ExoPlayer switches audio tracks inside the file, so any track can be direct-played.
        put("selectsAudioTrack", true)
    }

    companion object {
        /** ffprobe codec names (as the server stores them) → Android MIME types. */
        val VIDEO_MIME = linkedMapOf(
            "h264" to "video/avc",
            "hevc" to "video/hevc",
            "vp8" to "video/x-vnd.on2.vp8",
            "vp9" to "video/x-vnd.on2.vp9",
            "av1" to "video/av01",
            "mpeg2video" to "video/mpeg2",
            "mpeg4" to "video/mp4v-es",
        )
        val AUDIO_MIME = linkedMapOf(
            "aac" to "audio/mp4a-latm",
            "mp3" to "audio/mpeg",
            "opus" to "audio/opus",
            "vorbis" to "audio/vorbis",
            "flac" to "audio/flac",
            "alac" to "audio/alac",
            "ac3" to "audio/ac3",
            "eac3" to "audio/eac3",
            "dts" to "audio/vnd.dts",
            "truehd" to "audio/true-hd",
        )

        /** Containers Media3's extractors read, named as the server's `containerOf()` names them. */
        val CONTAINERS = listOf("mp4", "m4v", "mov", "mkv", "webm", "ts", "avi", "mpg", "flv")

        /** Server names for the codecs whose MIME type passes [supported], in table order. */
        fun names(table: Map<String, String>, supported: (String) -> Boolean): List<String> =
            table.filterValues(supported).keys.toList()
    }
}

/** Reads the phone's decoders and display once. */
@OptIn(UnstableApi::class)
object DeviceCapabilities {
    @Volatile private var cached: Capabilities? = null

    fun get(context: Context): Capabilities = cached ?: detect(context).also { cached = it }

    private fun detect(context: Context): Capabilities {
        val decoders = MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos.filter { !it.isEncoder }
        fun decodersFor(mime: String) = decoders.filter { info -> info.supportedTypes.any { it.equals(mime, ignoreCase = true) } }
        fun profiles(mime: String) = decodersFor(mime).flatMap { info ->
            runCatching { info.getCapabilitiesForType(mime).profileLevels.map { it.profile } }.getOrDefault(emptyList())
        }
        fun decodes(mime: String, width: Int, height: Int) = decodersFor(mime).any { info ->
            runCatching { info.getCapabilitiesForType(mime).videoCapabilities?.isSizeSupported(width, height) == true }.getOrDefault(false)
        }

        val hevc = "video/hevc"
        val hevcProfiles = profiles(hevc)
        val video = Capabilities.names(Capabilities.VIDEO_MIME) { mime ->
            when (mime) {
                // Most HEVC releases are 10-bit: an 8-bit-only decoder would fail on them.
                hevc -> CodecProfileLevel.HEVCProfileMain10 in hevcProfiles || CodecProfileLevel.HEVCProfileMain10HDR10 in hevcProfiles
                else -> decodersFor(mime).isNotEmpty()
            }
        }

        val ffmpeg = FfmpegLibrary.isAvailable()
        val audio = Capabilities.names(Capabilities.AUDIO_MIME) { mime ->
            decodersFor(mime).isNotEmpty() || (ffmpeg && FfmpegLibrary.supportsFormat(mime))
        }

        val uhd = decodes(hevc, 3840, 2160) || decodes("video/avc", 3840, 2160)
        val hdr = displaySupportsHdr10(context) && CodecProfileLevel.HEVCProfileMain10HDR10 in hevcProfiles

        return Capabilities(
            containers = Capabilities.CONTAINERS,
            videoCodecs = video,
            audioCodecs = audio,
            // Android mixes surround down for the phone's speakers or headphones.
            maxAudioChannels = 6,
            hdr = hdr,
            maxWidth = if (uhd) null else 1920,
            maxHeight = if (uhd) null else 1080,
        )
    }

    @Suppress("DEPRECATION")
    private fun displaySupportsHdr10(context: Context): Boolean {
        val display = context.getSystemService(DisplayManager::class.java)?.getDisplay(Display.DEFAULT_DISPLAY) ?: return false
        val types = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            display.mode.supportedHdrTypes
        } else {
            display.hdrCapabilities?.supportedHdrTypes
        }
        return types?.contains(Display.HdrCapabilities.HDR_TYPE_HDR10) == true
    }
}
