package io.github.santoshban.streamora

import android.app.PendingIntent
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.webkit.CookieManager
import androidx.annotation.OptIn
import androidx.media3.common.util.BitmapLoader
import androidx.media3.common.util.UnstableApi
import androidx.media3.common.util.Util
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.ListeningExecutorService
import com.google.common.util.concurrent.MoreExecutors
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Callable
import java.util.concurrent.Executors

/**
 * Runs while the web page plays music: a media session with its notification,
 * lock screen and headset controls. Being a foreground service while playing
 * also stops Android from freezing the app, so music goes on in the background.
 */
@OptIn(UnstableApi::class)
class MusicService : MediaSessionService() {

    private var session: MediaSession? = null
    private var player: WebMusicPlayer? = null

    override fun onCreate() {
        super.onCreate()
        val p = WebMusicPlayer(mainLooper)
        val open = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val s = MediaSession.Builder(this, p)
            .setSessionActivity(open)
            .setBitmapLoader(CookieBitmapLoader())
            .build()
        // Without a controller connecting first, the service only manages the notification (and with it
        // the foreground state Android needs to grant audio focus in the background) for added sessions.
        addSession(s)
        session = s
        player = p
        MusicBridge.attach(p)
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = session

    /** The page lives in the app's window: once the app is swiped away, there's nothing left to play. */
    override fun onTaskRemoved(rootIntent: Intent?) {
        MusicBridge.send("pause")
        stopSelf()
    }

    override fun onDestroy() {
        player?.let(MusicBridge::detach)
        session?.run {
            player.release()
            release()
        }
        session = null
        player = null
        super.onDestroy()
    }
}

/**
 * Loads album art for the notification with the web UI's session cookie: the
 * server only serves artwork to signed-in profiles. Keeps the last cover, which
 * is asked for again on every play/pause.
 */
@OptIn(UnstableApi::class)
private class CookieBitmapLoader : BitmapLoader {
    private val executor: ListeningExecutorService = MoreExecutors.listeningDecorator(Executors.newSingleThreadExecutor())
    private var lastUri: Uri? = null
    private var lastBitmap: ListenableFuture<Bitmap>? = null

    override fun supportsMimeType(mimeType: String): Boolean = Util.isBitmapFactorySupportedMimeType(mimeType)

    override fun decodeBitmap(data: ByteArray): ListenableFuture<Bitmap> =
        executor.submit(Callable { BitmapFactory.decodeByteArray(data, 0, data.size) ?: throw IOException("Not an image") })

    override fun loadBitmap(uri: Uri): ListenableFuture<Bitmap> {
        val cached = lastBitmap
        if (uri == lastUri && cached != null && !(cached.isDone && runCatching { Futures.getDone(cached) }.isFailure)) return cached
        val future = executor.submit(Callable { download(uri) })
        lastUri = uri
        lastBitmap = future
        return future
    }

    private fun download(uri: Uri): Bitmap {
        val url = uri.toString()
        val conn = URL(url).openConnection() as HttpURLConnection
        try {
            conn.connectTimeout = 10_000
            conn.readTimeout = 20_000
            CookieManager.getInstance().getCookie(url)?.let { conn.setRequestProperty("Cookie", it) }
            if (conn.responseCode != HttpURLConnection.HTTP_OK) throw IOException("HTTP ${conn.responseCode}")
            return conn.inputStream.use { BitmapFactory.decodeStream(it) } ?: throw IOException("Not an image")
        } finally {
            conn.disconnect()
        }
    }
}
