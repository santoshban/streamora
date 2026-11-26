package io.github.santoshban.streamora

import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Color
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
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
import androidx.lifecycle.lifecycleScope
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import io.github.santoshban.streamora.databinding.ActivityMainBinding
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * The server's web UI in a WebView. The page hands videos to [PlayerActivity]
 * through `window.StreamoraAndroid` (see frontend/src/lib/native.ts).
 *
 * The server may be known at several addresses (home network, Tailscale): the
 * best one that answers is used, and checked again when the network changes.
 */
class MainActivity : ComponentActivity() {

    private companion object {
        const val BRIDGE = "StreamoraAndroid"
        const val RESUMED_EVENT = "streamora:app-resumed"
        /** The server's session cookie (backend/src/lib/session.ts). */
        const val SESSION_COOKIE = "ls_session"
        const val SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60
        /** Networks often come and go in bursts (Wi-Fi handing over to mobile data). */
        const val NETWORK_SETTLE_MS = 2000L
    }

    private lateinit var b: ActivityMainBinding
    private lateinit var store: ServerStore
    /** The address the page is loaded from. */
    private var server: String? = null
    private var bridgeAttached = false
    private var clearHistoryOnLoad = false
    private var webGone = false
    private var playerOpenedAt = 0L
    private var connectJob: Job? = null

    private val handler = Handler(Looper.getMainLooper())
    private val recheck = Runnable { recheckServer() }
    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) = networkChanged()
        override fun onLost(network: Network) = networkChanged()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
        )
        super.onCreate(savedInstanceState)
        store = ServerStore(this)
        val saved = store.serverUrl
        if (saved == null) {
            startActivity(ConnectActivity.intent(this))
            finish()
            return
        }
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
        b.retry.setOnClickListener { connect() }
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
        if (savedInstanceState != null && b.web.restoreState(savedInstanceState) != null) use(saved, reload = false) else connect()
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

        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (!request.isForMainFrame || isServer(request.url)) return false
                openExternally(request.url)
                return true
            }

            override fun onPageCommitVisible(view: WebView, url: String) {
                b.loading.isVisible = false
            }

            override fun onPageFinished(view: WebView, url: String) {
                if (clearHistoryOnLoad) {
                    clearHistoryOnLoad = false
                    view.clearHistory()
                }
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) showUnreachable()
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

    // ── choosing the address ─────────────────────────────────────────────────

    /** Finds the best address that answers and loads the page from it. */
    private fun connect() {
        b.errorPanel.isVisible = false
        b.loading.isVisible = true
        connectJob?.cancel()
        connectJob = lifecycleScope.launch {
            val found = ServerSelector.find(this@MainActivity, store)
            if (found == null) showUnreachable() else use(found.url, reload = true)
        }
    }

    /**
     * After a network change: moves to a better address (home Wi-Fi again, or the
     * VPN after leaving home). When nothing answers, the page stays as it is and
     * says the server can't be reached.
     */
    private fun recheckServer() {
        if (connectJob?.isActive == true || webGone || isFinishing) return
        connectJob = lifecycleScope.launch {
            val found = ServerSelector.find(this@MainActivity, store) ?: return@launch
            if (found.url != server || b.errorPanel.isVisible) use(found.url, reload = true)
        }
    }

    private fun networkChanged() {
        handler.removeCallbacks(recheck)
        handler.postDelayed(recheck, NETWORK_SETTLE_MS)
    }

    private fun use(url: String, reload: Boolean) {
        val previous = server ?: store.serverUrl
        if (previous != null && previous != url) carrySession(previous, url)
        server = url
        store.serverUrl = url
        attachBridge(url)
        if (reload) {
            b.errorPanel.isVisible = false
            b.loading.isVisible = true
            // Back mustn't lead to pages of the old address.
            clearHistoryOnLoad = true
            b.web.loadUrl(url)
        }
    }

    /**
     * Signs in at the new address with the session from the old one, so moving
     * between home and VPN doesn't ask "Who's watching?" again. Both addresses
     * were checked to be the same server.
     */
    private fun carrySession(from: String, to: String) {
        val cookies = CookieManager.getInstance()
        if (cookies.getCookie(to)?.contains("$SESSION_COOKIE=") == true) return
        val session = cookies.getCookie(from)?.split(';')?.map { it.trim() }?.firstOrNull { it.startsWith("$SESSION_COOKIE=") } ?: return
        cookies.setCookie(to, "$session; Path=/; Max-Age=$SESSION_MAX_AGE_SECONDS; HttpOnly; SameSite=Lax")
        cookies.flush()
    }

    /** Only the server's own pages get the bridge, never the YouTube trailer frames. */
    private fun attachBridge(origin: String) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return
        if (bridgeAttached) WebViewCompat.removeWebMessageListener(b.web, BRIDGE)
        WebViewCompat.addWebMessageListener(b.web, BRIDGE, setOf(origin)) { _, message, _, isMainFrame, _ ->
            if (isMainFrame) onPageMessage(message.data)
        }
        bridgeAttached = true
    }

    /** Remembers the server's other addresses (home network, VPN) for later. */
    private fun learnAddresses() {
        val url = server ?: return
        lifecycleScope.launch {
            val reply = runCatching { StreamoraApi(url).get("/api/server/addresses") }.getOrNull() ?: return@launch
            store.learn(reply.str("serverId"), reply.optJSONArray("addresses").mapObjects { it.str("url") }.filterNotNull())
        }
    }

    private fun showUnreachable() {
        b.loading.isVisible = false
        val address = ServerAddress.display(server ?: store.serverUrl.orEmpty())
        val away = Discovery.localAddress(this) == null
        b.errorText.text = getString(R.string.unreachable, address) + if (away) "\n\n" + getString(R.string.unreachable_away) else ""
        b.errorPanel.isVisible = true
    }

    // ── page ─────────────────────────────────────────────────────────────────

    private fun onPageMessage(data: String?) {
        val message = runCatching { JSONObject(data ?: return) }.getOrNull() ?: return
        when (message.optString("type")) {
            "play" -> {
                val url = server ?: return
                val fileId = message.optInt("fileId", -1)
                val now = SystemClock.elapsedRealtime()
                // One player for a double tap.
                if (fileId <= 0 || now - playerOpenedAt < 1500) return
                playerOpenedAt = now
                startActivity(PlayerActivity.intent(this, url, fileId, message.double("startSeconds")))
            }
            "changeServer" -> startActivity(ConnectActivity.intent(this))
            "signedIn" -> learnAddresses()
        }
    }

    private fun isServer(url: Uri): Boolean {
        val home = server?.toUri() ?: return false
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

    // ── lifecycle ────────────────────────────────────────────────────────────

    override fun onStart() {
        super.onStart()
        if (!::b.isInitialized) return
        // Any network coming or going: Wi-Fi with or without internet access, mobile data, and VPNs
        // (Tailscale being switched on or off). A plain request would leave out the last two kinds.
        val request = NetworkRequest.Builder()
            .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .removeCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN)
            .build()
        getSystemService(ConnectivityManager::class.java)?.registerNetworkCallback(request, networkCallback)
    }

    override fun onStop() {
        if (::b.isInitialized) {
            handler.removeCallbacks(recheck)
            runCatching { getSystemService(ConnectivityManager::class.java)?.unregisterNetworkCallback(networkCallback) }
        }
        super.onStop()
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
        handler.removeCallbacks(recheck)
        if (::b.isInitialized && !webGone) {
            b.root.removeView(b.web)
            b.web.destroy()
        }
        super.onDestroy()
    }
}
