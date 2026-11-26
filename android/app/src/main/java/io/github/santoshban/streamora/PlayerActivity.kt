package io.github.santoshban.streamora

import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.View
import androidx.activity.ComponentActivity
import androidx.activity.addCallback
import androidx.annotation.OptIn
import androidx.core.net.toUri
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.core.view.isVisible
import androidx.lifecycle.lifecycleScope
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.common.Tracks
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.datasource.HttpDataSource
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.exoplayer.util.EventLogger
import androidx.media3.ui.CaptionStyleCompat
import androidx.media3.ui.PlayerView
import androidx.media3.ui.SubtitleView
import io.github.santoshban.streamora.databinding.ActivityPlayerBinding
import java.io.IOException
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * Plays a file with Media3. It follows the web player (frontend/src/pages/Player.tsx):
 * the server decides between direct play and HLS, progress is saved every 10 s, and
 * the next episode starts after a countdown.
 */
@OptIn(UnstableApi::class)
class PlayerActivity : ComponentActivity() {

    companion object {
        private const val TAG = "StreamoraPlayer"
        private const val EXTRA_SERVER = "server"
        private const val EXTRA_FILE = "fileId"
        private const val EXTRA_START = "startSeconds"
        private const val SAVE_EVERY_MS = 10_000L
        private const val KEEPALIVE_EVERY_MS = 60_000L
        private const val UP_NEXT_MS = 30_000L
        private const val AUTOPLAY_COUNTDOWN = 10
        private val QUALITIES = listOf("original", "2160p", "1080p", "720p", "480p")

        /** [startSeconds] null resumes from the saved position. */
        fun intent(context: Context, server: String, fileId: Int, startSeconds: Double?): Intent =
            Intent(context, PlayerActivity::class.java)
                .putExtra(EXTRA_SERVER, server)
                .putExtra(EXTRA_FILE, fileId)
                .apply { if (startSeconds != null) putExtra(EXTRA_START, startSeconds) }

        private fun Intent.startSeconds(): Double? = if (hasExtra(EXTRA_START)) getDoubleExtra(EXTRA_START, 0.0) else null
    }

    private lateinit var b: ActivityPlayerBinding
    private lateinit var server: String
    private lateinit var api: StreamoraApi
    private lateinit var player: ExoPlayer

    private var fileId = 0
    private var info: PlayerContext? = null
    private var plan: PlaybackPlan? = null
    private var quality = "original"
    /** Audio stream picked in the Audio menu (HLS only; direct play switches inside the file). */
    private var chosenAudio: Int? = null
    /** Direct play failed to decode, so the server converts the file instead. */
    private var forceTranscode = false
    private var expiredRetries = 0
    private var audioMatched = false
    private var upNextDismissed = false
    private var countdown: Int? = null
    private var loadJob: Job? = null
    private var lastSave = 0L
    private var lastKeepalive = 0L

    private val ticker = Handler(Looper.getMainLooper())
    private val tick = object : Runnable {
        override fun run() {
            onTick()
            ticker.postDelayed(this, 1000)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        server = intent.getStringExtra(EXTRA_SERVER) ?: run {
            finish()
            return
        }
        api = StreamoraApi(server)
        b = ActivityPlayerBinding.inflate(layoutInflater)
        setContentView(b.root)

        WindowCompat.setDecorFitsSystemWindows(window, false)
        hideSystemBars()
        // Keep the picture and controls out of the camera cutout.
        ViewCompat.setOnApplyWindowInsetsListener(b.root) { view, insets ->
            val cutout = insets.getInsets(WindowInsetsCompat.Type.displayCutout())
            view.setPadding(cutout.left, cutout.top, cutout.right, cutout.bottom)
            insets
        }

        player = buildPlayer()
        b.playerView.player = player
        b.playerView.setControllerVisibilityListener(PlayerView.ControllerVisibilityListener { visibility -> showTopBar(visibility == View.VISIBLE) })

        b.back.setOnClickListener { close() }
        b.quality.setOnClickListener { chooseQuality() }
        b.audio.setOnClickListener { chooseAudio() }
        b.next.setOnClickListener { playNext() }
        b.upNextPlay.setOnClickListener { playNext() }
        b.upNextDismiss.setOnClickListener {
            upNextDismissed = true
            b.upNext.isVisible = false
            if (player.playbackState == Player.STATE_ENDED) close()
        }
        b.errorRetry.setOnClickListener {
            if (info == null) openFile(fileId, intent.startSeconds()) else restart(positionSeconds())
        }
        b.errorBack.setOnClickListener { close() }
        onBackPressedDispatcher.addCallback(this) { close() }

        openFile(intent.getIntExtra(EXTRA_FILE, 0), intent.startSeconds())
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        openFile(intent.getIntExtra(EXTRA_FILE, 0), intent.startSeconds())
    }

    private fun buildPlayer(): ExoPlayer {
        val http = DefaultHttpDataSource.Factory()
            .setUserAgent("StreamoraAndroid/${BuildConfig.VERSION_NAME}")
            .setConnectTimeoutMs(15_000)
            // After a seek the server may need a while to transcode the next segment.
            .setReadTimeoutMs(120_000)
            .setDefaultRequestProperties(api.cookie()?.let { mapOf("Cookie" to it) } ?: emptyMap())
        // FFmpeg decodes the audio formats the phone has no decoder for (AC3, E-AC3, DTS, TrueHD).
        val renderers = DefaultRenderersFactory(this)
            .setExtensionRendererMode(DefaultRenderersFactory.EXTENSION_RENDERER_MODE_ON)
            .setEnableDecoderFallback(true)
        return ExoPlayer.Builder(this, renderers)
            .setMediaSourceFactory(DefaultMediaSourceFactory(http))
            .setAudioAttributes(
                AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MOVIE).build(),
                true,
            )
            .setHandleAudioBecomingNoisy(true)
            .setWakeMode(C.WAKE_MODE_NETWORK)
            .setSeekBackIncrementMs(10_000)
            .setSeekForwardIncrementMs(10_000)
            .build()
            .also {
                it.addListener(listener)
                if (BuildConfig.DEBUG) it.addAnalyticsListener(EventLogger())
            }
    }

    private val listener = object : Player.Listener {
        override fun onPlaybackStateChanged(state: Int) {
            if (state == Player.STATE_READY || state == Player.STATE_ENDED) b.starting.isVisible = false
            if (state == Player.STATE_ENDED) {
                saveProgress()
                // With a next episode, the up-next card (updated every second) takes over.
                if (info?.next == null || upNextDismissed) close()
            }
        }

        override fun onIsPlayingChanged(isPlaying: Boolean) {
            b.playerView.keepScreenOn = isPlaying
            if (!isPlaying) saveProgress()
        }

        override fun onTracksChanged(tracks: Tracks) = matchServerAudio(tracks)

        override fun onPlayerError(error: PlaybackException) = handleError(error)
    }

    // ── loading ──────────────────────────────────────────────────────────────

    private fun openFile(id: Int, startSeconds: Double?) {
        if (id <= 0) {
            finish()
            return
        }
        // Moving on (next episode): keep the subtitle language that was on.
        val keepText = if (info != null) selectedTextLanguage() else null
        saveProgress()
        val oldSession = plan?.sessionId
        player.stop()
        player.clearMediaItems()
        oldSession?.let(::deleteSession)

        fileId = id
        info = null
        plan = null
        chosenAudio = null
        forceTranscode = false
        expiredRetries = 0
        upNextDismissed = false
        countdown = null
        b.upNext.isVisible = false
        showError(null)
        b.starting.isVisible = true

        loadJob?.cancel()
        loadJob = lifecycleScope.launch {
            try {
                val context = PlayerContext.from(api.get("/api/catalog/files/$id/context"))
                info = context
                b.title.text = context.title
                b.subtitle.text = context.subtitle
                b.subtitle.isVisible = context.subtitle != null
                b.next.isVisible = context.next != null
                applySubtitleStyle(context.preferences)
                applyTrackPreferences(context.preferences, keepText)
                start(startSeconds ?: context.resumeSeconds)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                b.starting.isVisible = false
                showError(describe(e))
            }
        }
    }

    /** Asks the server how to play the file, then plays it from [atSeconds]. */
    private suspend fun start(atSeconds: Double) {
        b.starting.isVisible = true
        showError(null)
        val body = JSONObject()
            .put("capabilities", DeviceCapabilities.get(this).toJson())
            .put("quality", quality)
        chosenAudio?.let { body.put("audioStreamIndex", it) }
        if (forceTranscode) body.put("forceTranscode", true)
        val next = PlaybackPlan.from(api.post("/api/files/$fileId/playback", body) ?: JSONObject())
        if (BuildConfig.DEBUG) Log.i(TAG, "file $fileId: ${next.method} ${next.url}; sent $body")

        val oldSession = plan?.sessionId
        plan = next
        audioMatched = false
        b.audio.isVisible = !next.isDirect && next.audioTracks.size > 1
        val item = MediaItem.Builder()
            .setUri(server + next.url)
            .apply { if (!next.isDirect) setMimeType(MimeTypes.APPLICATION_M3U8) }
            .setSubtitleConfigurations(subtitleConfigurations(next))
            .build()
        player.setMediaItem(item, (atSeconds * 1000).toLong().coerceAtLeast(0))
        player.prepare()
        player.playWhenReady = true
        // Only now: the old stream must not be cut off while it still plays.
        if (oldSession != null && oldSession != next.sessionId) deleteSession(oldSession)
    }

    /** Restarts playback with the current options (quality, audio track) at [atSeconds]. */
    private fun restart(atSeconds: Double) {
        loadJob?.cancel()
        loadJob = lifecycleScope.launch {
            try {
                start(atSeconds)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                b.starting.isVisible = false
                showError(describe(e))
            }
        }
    }

    private fun subtitleConfigurations(plan: PlaybackPlan): List<MediaItem.SubtitleConfiguration> = plan.subtitles
        // Direct play reads embedded subtitles from the file itself (image-based ones too).
        .filter { it.url != null && !(plan.isDirect && it.source == "embedded") }
        .map { track ->
            MediaItem.SubtitleConfiguration.Builder((server + track.url).toUri())
                .setId("streamora-${track.id}")
                .setMimeType(MimeTypes.TEXT_VTT)
                .setLanguage(track.language)
                .setLabel(subtitleLabel(track))
                .setSelectionFlags(if (track.forced) C.SELECTION_FLAG_FORCED else 0)
                .setRoleFlags(if (track.hearingImpaired) C.ROLE_FLAG_DESCRIBES_MUSIC_AND_SOUND else 0)
                .build()
        }

    private fun subtitleLabel(track: SubtitleInfo): String {
        val language = languageName(track.language)
        val parts = mutableListOf(language ?: track.label ?: "Unknown")
        if (track.forced) parts += "Forced"
        if (track.hearingImpaired) parts += "SDH"
        val label = track.label
        if (label != null && language != null && !label.equals(language, ignoreCase = true) && !Regex("^(forced|sdh)$", RegexOption.IGNORE_CASE).matches(label)) {
            parts += label
        }
        return parts.joinToString(" · ")
    }

    // ── tracks ───────────────────────────────────────────────────────────────

    private fun applyTrackPreferences(prefs: Preferences, keepTextLanguage: String?) {
        val textLanguage = keepTextLanguage ?: prefs.subtitleLanguage
        player.trackSelectionParameters = player.trackSelectionParameters.buildUpon()
            .clearOverrides()
            .setPreferredAudioLanguage(prefs.audioLanguage)
            .setPreferredTextLanguage(textLanguage)
            // Like the web player: no subtitles unless asked for, except forced ones.
            .setIgnoredTextSelectionFlags(if (textLanguage == null) C.SELECTION_FLAG_DEFAULT else 0)
            .build()
    }

    private fun selectedTextLanguage(): String? = player.currentTracks.groups
        .firstOrNull { it.type == C.TRACK_TYPE_TEXT && it.isSelected }
        ?.let { group -> (0 until group.length).firstOrNull { group.isTrackSelected(it) }?.let { group.getTrackFormat(it).language } }

    /**
     * Direct play: selects the audio track the server chose (the profile's language).
     * Media3 and ffprobe list a file's tracks in the same order, so they match by position.
     */
    private fun matchServerAudio(tracks: Tracks) {
        val plan = plan ?: return
        if (audioMatched || !plan.isDirect) return
        val groups = tracks.groups.filter { it.type == C.TRACK_TYPE_AUDIO }
        if (groups.isEmpty()) return
        audioMatched = true
        val wanted = plan.audioTracks.indexOfFirst { it.index == plan.audioStreamIndex }
        if (wanted < 0 || groups.size != plan.audioTracks.size) return
        val group = groups[wanted]
        if (group.isSelected || !group.isSupported) return
        player.trackSelectionParameters = player.trackSelectionParameters.buildUpon()
            .setOverrideForType(TrackSelectionOverride(group.mediaTrackGroup, 0))
            .build()
    }

    private fun applySubtitleStyle(prefs: Preferences) {
        val view = b.playerView.subtitleView ?: return
        view.setFractionalTextSize(
            when (prefs.subtitleSize) {
                "small" -> 0.045f
                "large" -> 0.068f
                else -> SubtitleView.DEFAULT_TEXT_SIZE_FRACTION
            },
        )
        val (background, edge) = when (prefs.subtitleBackground) {
            "box" -> 0xC7000000.toInt() to CaptionStyleCompat.EDGE_TYPE_NONE
            "none" -> Color.TRANSPARENT to CaptionStyleCompat.EDGE_TYPE_NONE
            else -> Color.TRANSPARENT to CaptionStyleCompat.EDGE_TYPE_DROP_SHADOW
        }
        view.setStyle(CaptionStyleCompat(Color.WHITE, background, Color.TRANSPARENT, edge, Color.BLACK, null))
    }

    // ── menus ────────────────────────────────────────────────────────────────

    private fun chooseQuality() {
        val labels = resources.getStringArray(R.array.qualities)
        AlertDialog.Builder(this, R.style.Streamora_Dialog)
            .setTitle(R.string.player_quality)
            .setSingleChoiceItems(labels, QUALITIES.indexOf(quality)) { dialog, which ->
                dialog.dismiss()
                if (QUALITIES[which] == quality) return@setSingleChoiceItems
                quality = QUALITIES[which]
                restart(positionSeconds())
            }
            .setOnDismissListener { hideSystemBars() }
            .show()
    }

    /** HLS streams carry one audio track: another one needs a new stream. */
    private fun chooseAudio() {
        val plan = plan ?: return
        val tracks = plan.audioTracks
        AlertDialog.Builder(this, R.style.Streamora_Dialog)
            .setTitle(R.string.player_audio)
            .setSingleChoiceItems(tracks.map { it.label }.toTypedArray(), tracks.indexOfFirst { it.index == plan.audioStreamIndex }) { dialog, which ->
                dialog.dismiss()
                if (tracks[which].index == plan.audioStreamIndex) return@setSingleChoiceItems
                chosenAudio = tracks[which].index
                restart(positionSeconds())
            }
            .setOnDismissListener { hideSystemBars() }
            .show()
    }

    // ── progress, sessions, up next ──────────────────────────────────────────

    private fun onTick() {
        val now = SystemClock.elapsedRealtime()
        if (player.isPlaying && now - lastSave >= SAVE_EVERY_MS) saveProgress()
        val session = plan?.sessionId
        if (session != null && !player.isPlaying && now - lastKeepalive >= KEEPALIVE_EVERY_MS) {
            lastKeepalive = now
            StreamoraApi.background.launch { runCatching { api.post("/api/hls/$session/keepalive") } }
        }
        updateUpNext()
    }

    private fun updateUpNext() {
        val next = info?.next
        val duration = player.duration
        val ended = player.playbackState == Player.STATE_ENDED
        val show = next != null && !upNextDismissed && duration != C.TIME_UNSET && duration > 0 &&
            (ended || duration - player.currentPosition <= UP_NEXT_MS)
        if (!show) {
            b.upNext.isVisible = false
            countdown = null
            return
        }
        if (!b.upNext.isVisible) {
            b.upNextTitle.text = listOfNotNull(next.episodeLabel, next.episodeTitle).joinToString(" · ")
            b.upNext.isVisible = true
        }
        if (info?.preferences?.autoplayNext == false) {
            b.upNextPlay.setText(R.string.up_next_play)
            return
        }
        val remaining = countdown?.let { if (player.isPlaying || ended) it - 1 else it } ?: AUTOPLAY_COUNTDOWN
        countdown = remaining
        if (remaining <= 0) playNext() else b.upNextPlay.text = getString(R.string.up_next_play_in, remaining)
    }

    private fun playNext() {
        val next = info?.next ?: return
        openFile(next.fileId, next.startSeconds)
    }

    private fun positionSeconds(): Double = player.currentPosition / 1000.0

    private fun saveProgress() {
        if (info == null) return
        val position = positionSeconds()
        if (position < 1) return
        lastSave = SystemClock.elapsedRealtime()
        val body = JSONObject().put("positionSeconds", position)
        player.duration.takeIf { it != C.TIME_UNSET && it > 0 }?.let { body.put("durationSeconds", it / 1000.0) }
        val id = fileId
        StreamoraApi.background.launch { runCatching { api.put("/api/progress/$id", body) } }
    }

    private fun deleteSession(session: String) {
        StreamoraApi.background.launch {
            val result = runCatching { api.delete("/api/hls/$session") }
            if (BuildConfig.DEBUG) Log.i(TAG, "closed stream $session: ${result.exceptionOrNull() ?: "ok"}")
        }
    }

    // ── errors ───────────────────────────────────────────────────────────────

    private fun handleError(error: PlaybackException) {
        val plan = plan
        val status = (error.cause as? HttpDataSource.InvalidResponseCodeException)?.responseCode
        if (plan != null && !plan.isDirect && status == 404 && expiredRetries < 2) {
            // The server forgot an idle stream: start a new one where we are.
            expiredRetries++
            restart(positionSeconds())
            return
        }
        val decoding = error.errorCode in PlaybackException.ERROR_CODE_DECODER_INIT_FAILED..PlaybackException.ERROR_CODE_DECODING_FORMAT_UNSUPPORTED ||
            error.errorCode == PlaybackException.ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED
        if (plan != null && plan.isDirect && decoding && !forceTranscode) {
            // The phone said it could play this file but can't: let the server convert it.
            forceTranscode = true
            restart(positionSeconds())
            return
        }
        b.starting.isVisible = false
        showError(
            if (status == 401) {
                getString(R.string.session_ended)
            } else {
                getString(R.string.playback_failed, error.errorCodeName + (status?.let { ", HTTP $it" } ?: ""))
            },
        )
    }

    private fun describe(e: Exception): String = when (e) {
        is ApiException -> if (e.status == 401) getString(R.string.session_ended) else e.message.orEmpty()
        is IOException -> getString(R.string.unreachable, ServerAddress.display(server))
        else -> e.message ?: e.javaClass.simpleName
    }

    private fun showError(message: String?) {
        b.errorText.text = message
        b.errorPanel.isVisible = message != null
        if (message != null) b.playerView.hideController()
    }

    // ── window ───────────────────────────────────────────────────────────────

    private fun showTopBar(visible: Boolean) {
        val bar = b.topBar
        bar.animate().cancel()
        if (visible) {
            bar.isVisible = true
            bar.animate().alpha(1f).setDuration(200).start()
        } else {
            bar.animate().alpha(0f).setDuration(200).withEndAction { bar.visibility = View.INVISIBLE }.start()
        }
    }

    private fun hideSystemBars() {
        WindowCompat.getInsetsController(window, window.decorView).apply {
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            hide(WindowInsetsCompat.Type.systemBars())
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) hideSystemBars()
    }

    private fun close() {
        saveProgress()
        finish()
    }

    override fun onStart() {
        super.onStart()
        ticker.post(tick)
    }

    override fun onStop() {
        ticker.removeCallbacks(tick)
        player.pause()
        super.onStop()
    }

    override fun onDestroy() {
        if (BuildConfig.DEBUG) Log.i(TAG, "destroyed; stream ${plan?.sessionId}")
        ticker.removeCallbacks(tick)
        if (::player.isInitialized) {
            plan?.sessionId?.let(::deleteSession)
            player.release()
        }
        super.onDestroy()
    }
}
