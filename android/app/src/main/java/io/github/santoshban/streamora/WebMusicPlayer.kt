package io.github.santoshban.streamora

import android.os.Looper
import androidx.annotation.OptIn
import androidx.core.net.toUri
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.common.SimpleBasePlayer
import androidx.media3.common.util.UnstableApi
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture

/**
 * A Media3 [Player] that plays nothing itself: it mirrors the web page's music
 * player, so the media notification, lock screen and headset buttons show it
 * and control it. Commands go to the page through [MusicBridge].
 *
 * The playlist is the current song between "previous" and "next" placeholders,
 * so the skip buttons work; the page decides what they mean.
 */
@OptIn(UnstableApi::class)
class WebMusicPlayer(looper: Looper) : SimpleBasePlayer(looper) {

    private companion object {
        const val CURRENT = 1
        val COMMANDS: Player.Commands = Player.Commands.Builder()
            .addAll(
                Player.COMMAND_PLAY_PAUSE,
                Player.COMMAND_PREPARE,
                Player.COMMAND_STOP,
                Player.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM,
                Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM,
                Player.COMMAND_SEEK_TO_PREVIOUS,
                Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM,
                Player.COMMAND_SEEK_TO_NEXT,
                Player.COMMAND_GET_CURRENT_MEDIA_ITEM,
                Player.COMMAND_GET_METADATA,
                Player.COMMAND_RELEASE,
            )
            .build()
    }

    private var info: MusicInfo? = null

    /** Must run on the main thread. */
    fun update(next: MusicInfo?) {
        info = next
        invalidateState()
    }

    override fun getState(): State {
        val builder = State.Builder().setAvailableCommands(COMMANDS)
        val i = info ?: return builder.setPlaybackState(Player.STATE_IDLE).build()
        val metadata = MediaMetadata.Builder()
            .setTitle(i.title)
            .setArtist(i.artist)
            .setAlbumTitle(i.album)
            .setArtworkUri(i.art?.toUri())
            .setMediaType(MediaMetadata.MEDIA_TYPE_MUSIC)
            .build()
        val current = MediaItemData.Builder("track:${i.trackId}")
            .setMediaItem(MediaItem.Builder().setMediaId(i.trackId.toString()).setMediaMetadata(metadata).build())
            .setDurationUs(if (i.durationMs > 0) i.durationMs * 1000 else C.TIME_UNSET)
            .setIsSeekable(i.durationMs > 0)
            .build()
        val playlist = buildList {
            add(placeholder("previous"))
            add(current)
            if (i.hasNext) add(placeholder("next"))
        }
        return builder
            .setPlaylist(playlist)
            .setCurrentMediaItemIndex(CURRENT)
            .setPlayWhenReady(i.playing, Player.PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST)
            .setPlaybackState(if (i.playing && i.buffering) Player.STATE_BUFFERING else Player.STATE_READY)
            .setContentPositionMs { i.positionNow() }
            .build()
    }

    private fun placeholder(name: String) =
        MediaItemData.Builder("placeholder:$name").setMediaItem(MediaItem.Builder().setMediaId(name).build()).build()

    override fun handleSetPlayWhenReady(playWhenReady: Boolean): ListenableFuture<*> {
        MusicBridge.send(if (playWhenReady) "play" else "pause")
        return Futures.immediateVoidFuture()
    }

    override fun handlePrepare(): ListenableFuture<*> = Futures.immediateVoidFuture()

    override fun handleStop(): ListenableFuture<*> {
        MusicBridge.send("pause")
        return Futures.immediateVoidFuture()
    }

    override fun handleSeek(mediaItemIndex: Int, positionMs: Long, seekCommand: Int): ListenableFuture<*> {
        when {
            seekCommand == Player.COMMAND_SEEK_TO_NEXT || seekCommand == Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM -> MusicBridge.send("next")
            // The page restarts the song when it's past the first seconds, like its own button.
            seekCommand == Player.COMMAND_SEEK_TO_PREVIOUS || seekCommand == Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM -> MusicBridge.send("previous")
            mediaItemIndex > CURRENT -> MusicBridge.send("next")
            mediaItemIndex < CURRENT -> MusicBridge.send("previous")
            else -> MusicBridge.send("seek", positionMs.coerceAtLeast(0))
        }
        return Futures.immediateVoidFuture()
    }

    override fun handleRelease(): ListenableFuture<*> = Futures.immediateVoidFuture()
}
