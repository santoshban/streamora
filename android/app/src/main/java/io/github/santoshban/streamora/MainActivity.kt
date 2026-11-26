package io.github.santoshban.streamora

import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.SystemClock
import android.webkit.CookieManager
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.core.content.ContextCompat
import androidx.core.net.toUri
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.isVisible
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import io.github.santoshban.streamora.databinding.ActivityMainBinding
import org.json.JSONObject

/**
 * The server's web UI in a WebView. The page hands videos to [PlayerActivity]
 * through `window.StreamoraAndroid` (see frontend/src/lib/native.ts).
 */
class MainActivity : ComponentActivity() {

    private companion object {
        const val BRIDGE = "StreamoraAndroid"
        const val RESUMED_EVENT = "streamora:app-resumed"
    }

    private lateinit var b: ActivityMainBinding
    private lateinit var server: String
    private var webGone = false
    private var playerOpenedAt = 0L

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
        )
        super.onCreate(savedInstanceState)
        val saved = ServerStore(this).serverUrl
        if (saved == null) {
            startActivity(ConnectActivity.intent(this))
            finish()
            return
        }
        server = saved
        b = ActivityMainBinding.inflate(layoutInflater)
        setContentView(b.root)

        // The page sits between the status bar and the navigation bar (or keyboard).
        ViewCompat.setOnApplyWindowInsetsListener(b.root) { view, insets ->
            val bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime(),
            )
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }

        b.errorLogo.text = wordmark(this)
        b.retry.setOnClickListener { load() }
        b.changeServer.setOnClickListener { startActivity(ConnectActivity.intent(this)) }
        onBackPressedDispatcher.addCallback(
            this,
            object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() {
                    if (!b.errorPanel.isVisible && b.web.canGoBack()) {
                        b.web.goBack()
                    } else {
                        isEnabled = false
                        onBackPressedDispatcher.onBackPressed()
                        isEnabled = true
                    }
                }
            },
        )

        setUpWebView()
        if (savedInstanceState == null || b.web.restoreState(savedInstanceState) == null) load()
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setUpWebView() {
        val web = b.web
        web.setBackgroundColor(ContextCompat.getColor(this, R.color.surface))
        with(web.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            // Trailers autoplay, muted, while browsing.
            mediaPlaybackRequiresUserGesture = false
            userAgentString = "$userAgentString StreamoraAndroid/${BuildConfig.VERSION_NAME}"
            setSupportZoom(false)
        }
        CookieManager.getInstance().setAcceptCookie(true)

        // Only the server's own pages get the bridge, never the YouTube trailer frames.
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(web, BRIDGE, setOf(server)) { _, message, _, isMainFrame, _ ->
                if (isMainFrame) onPageMessage(message.data)
            }
        }

        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (!request.isForMainFrame || isServer(request.url)) return false
                openExternally(request.url)
                return true
            }

            override fun onPageCommitVisible(view: WebView, url: String) {
                b.loading.isVisible = false
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (!request.isForMainFrame) return
                b.loading.isVisible = false
                b.errorText.text = getString(R.string.unreachable, ServerAddress.display(server))
                b.errorPanel.isVisible = true
            }

            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                // The page's process crashed or was killed for memory: start over with a new WebView.
                webGone = true
                b.root.removeView(view)
                view.destroy()
                startActivity(Intent(this@MainActivity, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK))
                finish()
                return true
            }
        }
    }

    private fun load() {
        b.errorPanel.isVisible = false
        b.loading.isVisible = true
        b.web.loadUrl(server)
    }

    private fun onPageMessage(data: String?) {
        val message = runCatching { JSONObject(data ?: return) }.getOrNull() ?: return
        when (message.optString("type")) {
            "play" -> {
                val fileId = message.optInt("fileId", -1)
                val now = SystemClock.elapsedRealtime()
                // One player for a double tap.
                if (fileId <= 0 || now - playerOpenedAt < 1500) return
                playerOpenedAt = now
                startActivity(PlayerActivity.intent(this, server, fileId, message.double("startSeconds")))
            }
            "changeServer" -> startActivity(ConnectActivity.intent(this))
        }
    }

    private fun isServer(url: Uri): Boolean {
        val home = server.toUri()
        fun Uri.effectivePort() = if (port != -1) port else if (scheme == "https") 443 else 80
        return url.scheme == home.scheme && url.host.equals(home.host, ignoreCase = true) && url.effectivePort() == home.effectivePort()
    }

    private fun openExternally(url: Uri) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, url))
        } catch (_: ActivityNotFoundException) {
            // Nothing can open it.
        }
    }

    override fun onResume() {
        super.onResume()
        if (!::b.isInitialized || webGone) return
        b.web.onResume()
        if (playerOpenedAt != 0L) {
            playerOpenedAt = 0L
            // Positions and Continue Watching changed while the player was open.
            b.web.evaluateJavascript("window.dispatchEvent(new Event('$RESUMED_EVENT'))", null)
        }
    }

    override fun onPause() {
        if (::b.isInitialized && !webGone) b.web.onPause()
        CookieManager.getInstance().flush()
        super.onPause()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        if (::b.isInitialized && !webGone) b.web.saveState(outState)
    }

    override fun onDestroy() {
        if (::b.isInitialized && !webGone) {
            b.root.removeView(b.web)
            b.web.destroy()
        }
        super.onDestroy()
    }
}
