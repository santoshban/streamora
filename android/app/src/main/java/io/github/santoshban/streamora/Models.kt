package io.github.santoshban.streamora

import java.util.Locale
import org.json.JSONObject

// The parts of the server's player API (frontend/src/lib/types.ts) the app uses.

data class AudioTrackInfo(
    val index: Int,
    val codec: String,
    val language: String?,
    val title: String?,
    val channels: Int?,
) {
    val label: String
        get() = listOfNotNull(
            languageName(language) ?: title ?: "Track ${index + 1}",
            title?.takeIf { language != null && !it.equals(languageName(language), ignoreCase = true) },
            channelLabel(channels),
        ).joinToString(" · ")

    companion object {
        fun from(json: JSONObject) = AudioTrackInfo(
            index = json.optInt("index"),
            codec = json.optString("codec"),
            language = json.str("language"),
            title = json.str("title"),
            channels = json.int("channels"),
        )
    }
}

data class SubtitleInfo(
    val id: Int,
    /** `embedded`, `sidecar` or `downloaded`. */
    val source: String,
    val language: String?,
    val label: String?,
    val forced: Boolean,
    val hearingImpaired: Boolean,
    /** Relative WebVTT URL; null for image-based subtitles. */
    val url: String?,
) {
    companion object {
        fun from(json: JSONObject) = SubtitleInfo(
            id = json.optInt("id"),
            source = json.optString("source"),
            language = json.str("language"),
            label = json.str("label"),
            forced = json.optBoolean("forced"),
            hearingImpaired = json.optBoolean("hearingImpaired"),
            url = if (json.optBoolean("renderable")) json.str("url") else null,
        )
    }
}

data class PlaybackPlan(
    /** `direct`, `remux` or `transcode`. */
    val method: String,
    val url: String,
    val sessionId: String?,
    val audioStreamIndex: Int?,
    val audioTracks: List<AudioTrackInfo>,
    val subtitles: List<SubtitleInfo>,
) {
    val isDirect: Boolean get() = method == "direct"

    companion object {
        fun from(json: JSONObject) = PlaybackPlan(
            method = json.optString("method"),
            url = json.optString("url"),
            sessionId = json.str("sessionId"),
            audioStreamIndex = json.int("audioStreamIndex"),
            audioTracks = json.optJSONArray("audioTracks").mapObjects(AudioTrackInfo::from).sortedBy { it.index },
            subtitles = json.optJSONArray("subtitles").mapObjects(SubtitleInfo::from),
        )
    }
}

data class PlayTarget(
    val fileId: Int,
    val episodeLabel: String?,
    val episodeTitle: String?,
    val positionSeconds: Double,
    val resume: Boolean,
) {
    /** Where the web UI's `watchUrl()` would start it. */
    val startSeconds: Double get() = if (resume) positionSeconds else 0.0

    companion object {
        fun from(json: JSONObject) = PlayTarget(
            fileId = json.optInt("fileId"),
            episodeLabel = json.str("episodeLabel"),
            episodeTitle = json.str("episodeTitle"),
            positionSeconds = json.double("positionSeconds") ?: 0.0,
            resume = json.optBoolean("resume"),
        )
    }
}

data class Preferences(
    val audioLanguage: String?,
    val subtitleLanguage: String?,
    /** `small`, `medium` or `large`. */
    val subtitleSize: String,
    /** `none`, `shadow` or `box`. */
    val subtitleBackground: String,
    val autoplayNext: Boolean,
) {
    companion object {
        fun from(json: JSONObject?): Preferences {
            val style = json?.obj("subtitleStyle")
            return Preferences(
                audioLanguage = json?.str("audioLanguage")?.takeIf { it.isNotBlank() },
                subtitleLanguage = json?.str("subtitleLanguage")?.takeIf { it.isNotBlank() },
                subtitleSize = style?.str("size") ?: "medium",
                subtitleBackground = style?.str("background") ?: "shadow",
                autoplayNext = json?.optBoolean("autoplayNext", true) ?: true,
            )
        }
    }
}

data class PlayerContext(
    val title: String,
    val year: Int?,
    val episodeLabel: String?,
    val episodeTitle: String?,
    val resumeSeconds: Double,
    val next: PlayTarget?,
    val preferences: Preferences,
) {
    /** The line under the title: `S1:E2 “Pilot”`, or the year. */
    val subtitle: String?
        get() = when {
            episodeLabel != null -> listOfNotNull(episodeLabel, episodeTitle?.let { "“$it”" }).joinToString(" ")
            else -> year?.toString()
        }

    companion object {
        fun from(json: JSONObject): PlayerContext {
            val item = json.obj("item") ?: JSONObject()
            val episode = json.obj("episode")
            return PlayerContext(
                title = item.optString("title"),
                year = item.int("year"),
                episodeLabel = episode?.str("label"),
                episodeTitle = episode?.str("title"),
                resumeSeconds = json.double("resumeSeconds") ?: 0.0,
                next = json.obj("next")?.let(PlayTarget::from),
                preferences = Preferences.from(json.obj("preferences")),
            )
        }
    }
}

/** "eng" / "en" → "English"; null when unknown. */
fun languageName(code: String?): String? {
    if (code.isNullOrBlank() || code.equals("und", ignoreCase = true)) return null
    val name = Locale.forLanguageTag(code).getDisplayLanguage(Locale.getDefault())
    return name.takeIf { it.isNotBlank() && !it.equals(code, ignoreCase = true) } ?: code
}

fun channelLabel(channels: Int?): String? = when (channels) {
    null -> null
    1 -> "Mono"
    2 -> "Stereo"
    6 -> "5.1"
    8 -> "7.1"
    else -> "$channels ch"
}
