package io.github.santoshban.streamora

import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.os.Bundle
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.isVisible
import androidx.lifecycle.lifecycleScope
import io.github.santoshban.streamora.databinding.ActivityConnectBinding
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Picks the Streamora server: typed in, or found on the local network. */
class ConnectActivity : ComponentActivity() {

    companion object {
        fun intent(context: Context): Intent = Intent(context, ConnectActivity::class.java)
    }

    private lateinit var b: ActivityConnectBinding
    private lateinit var store: ServerStore
    private var scanJob: Job? = null
    private var connectJob: Job? = null
    private val listed = mutableSetOf<String>()

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
        )
        super.onCreate(savedInstanceState)
        b = ActivityConnectBinding.inflate(layoutInflater)
        setContentView(b.root)
        store = ServerStore(this)

        ViewCompat.setOnApplyWindowInsetsListener(b.root) { view, insets ->
            val bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime(),
            )
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }
        // A narrow column on tablets and in landscape.
        val maxWidth = dp(520)
        if (resources.displayMetrics.widthPixels > maxWidth) {
            b.content.layoutParams = (b.content.layoutParams as FrameLayout.LayoutParams).apply { width = maxWidth }
        }

        b.logo.text = wordmark(this)
        store.serverUrl?.let { b.address.setText(ServerAddress.display(it)) }
        b.address.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_GO) {
                connectTyped()
                true
            } else {
                false
            }
        }
        b.connect.setOnClickListener { connectTyped() }
        b.rescan.setOnClickListener { scan() }
        scan()
    }

    private fun connectTyped() {
        val url = ServerAddress.normalize(b.address.text.toString())
        if (url == null) {
            showError(getString(R.string.connect_invalid))
            return
        }
        connect(url)
    }

    private fun connect(url: String) {
        getSystemService(InputMethodManager::class.java)?.hideSoftInputFromWindow(b.address.windowToken, 0)
        showError(null)
        setBusy(true)
        connectJob?.cancel()
        connectJob = lifecycleScope.launch {
            val server = withContext(Dispatchers.IO) { ServerProbe.check(url) }
            setBusy(false)
            if (server == null) {
                showError(getString(R.string.connect_failed, ServerAddress.display(url)))
                return@launch
            }
            store.serverUrl = server.url
            startActivity(
                Intent(this@ConnectActivity, MainActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK),
            )
            finish()
        }
    }

    private fun scan() {
        scanJob?.cancel()
        listed.clear()
        b.found.removeAllViews()
        b.scanProgress.isVisible = true
        b.rescan.isVisible = false
        b.scanStatus.isVisible = true
        b.scanStatus.setText(R.string.scanning)
        scanJob = lifecycleScope.launch {
            val onLocalNetwork = Discovery.scan(this@ConnectActivity, ::addServer)
            b.scanProgress.isVisible = false
            b.rescan.isVisible = true
            when {
                !onLocalNetwork -> b.scanStatus.setText(R.string.scan_no_wifi)
                listed.isEmpty() -> b.scanStatus.setText(R.string.scan_none)
            }
        }
    }

    private fun addServer(server: ServerInfo) {
        if (!listed.add(server.url)) return
        b.scanStatus.isVisible = false
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundResource(R.drawable.row_background)
            setPadding(dp(16), dp(14), dp(16), dp(14))
            isClickable = true
            isFocusable = true
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
                .apply { topMargin = dp(8) }
            setOnClickListener {
                b.address.setText(ServerAddress.display(server.url))
                connect(server.url)
            }
        }
        row.addView(
            TextView(this).apply {
                text = ServerAddress.display(server.url)
                setTextColor(0xFFFFFFFF.toInt())
                textSize = 17f
                typeface = Typeface.DEFAULT_BOLD
            },
        )
        row.addView(
            TextView(this).apply {
                text = server.version?.let { getString(R.string.server_version, it) } ?: getString(R.string.server_unknown_version)
                setTextColor(ContextCompat.getColor(context, R.color.soft))
                textSize = 14f
            },
        )
        b.found.addView(row)
    }

    private fun setBusy(busy: Boolean) {
        b.connect.isEnabled = !busy
        b.connect.setText(if (busy) R.string.connecting else R.string.connect)
    }

    private fun showError(message: String?) {
        b.error.text = message
        b.error.isVisible = message != null
    }
}
