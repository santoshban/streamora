package io.github.santoshban.streamora

import android.content.Context
import android.content.Intent
import android.os.SystemClock
import org.json.JSONObject

/** What the web page's music player is doing (see frontend/src/music/context.tsx). */
data class MusicInfo(
    val trackId: Int,
    val title: String,
    val artist: String,
    val album: String,
    val art: String?,
    val durationMs: Long,
    val positionMs: Long,
    val playing: Boolean,
    val buffering: Boolean,
    val hasNext: Boolean,
    val receivedAt: Long = SystemClock.elapsedRealtime(),
) {
    /** Where playback is now, counting on from the last report while playing. */
    fun positionNow(): Long {
        val elapsed = if (playing && !buffering) SystemClock.elapsedRealtime() - receivedAt else 0L
        val position = positionMs + elapsed
        return if (durationMs > 0) position.coerceAtMost(durationMs) else position
    }

    companion object {
        /** `null` when nothing is loaded (`state: 'stopped'`). */
        fun from(message: JSONObject): MusicInfo? {
            val track = message.obj("track") ?: return null
            if (message.optString("state") == "stopped") return null
            return MusicInfo(
                trackId = track.optInt("id"),
                title = track.str("title").orEmpty(),
                artist = track.str("artist").orEmpty(),
                album = track.str("album").orEmpty(),
                art = track.str("art"),
                durationMs = message.optLong("durationMs"),
                positionMs = message.optLong("positionMs"),
                playing = message.optString("state") == "playing",
                buffering = message.optBoolean("buffering"),
                hasNext = message.optBoolean("hasNext"),
            )
        }
    }
}

/**
 * Connects the page's music player (in [MainActivity]'s WebView) with
 * [MusicService], which shows the media notification and lock screen controls
 * and keeps the app running while music plays in the background.
 * Everything here runs on the main thread.
 */
object MusicBridge {
    /** Set by [MainActivity]: runs a command (`play`, `pause`, `next`, `previous`, `seek`) in the page. */
    var commands: ((action: String, positionMs: Long?) -> Unit)? = null

    private var player: WebMusicPlayer? = null
    private var latest: MusicInfo? = null

    /** A report from the page. Starts the service when music starts, stops it when the queue is gone. */
    fun update(context: Context, info: MusicInfo?) {
        latest = info
        player?.update(info)
        val intent = Intent(context, MusicService::class.java)
        if (info == null) {
            if (player != null) context.stopService(intent)
        } else if (player == null && info.playing) {
            // Started while the app is on screen (the user just pressed play), which Android allows.
            runCatching { context.startService(intent) }
        }
    }

    fun send(action: String, positionMs: Long? = null) {
        commands?.invoke(action, positionMs)
    }

    internal fun attach(p: WebMusicPlayer) {
        player = p
        p.update(latest)
    }

    internal fun detach(p: WebMusicPlayer) {
        if (player === p) player = null
    }
}
