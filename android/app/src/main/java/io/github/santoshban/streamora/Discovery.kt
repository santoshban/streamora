package io.github.santoshban.streamora

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import java.io.IOException
import java.net.Inet4Address
import java.net.InetSocketAddress
import java.net.Socket
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext

/**
 * Finds Streamora servers on the phone's Wi-Fi or Ethernet network by asking every
 * address of its /24 subnet. The server doesn't announce itself, so this is a scan.
 */
object Discovery {
    /** The desktop app moves to the next free port when 8484 is taken. */
    val PORTS = intArrayOf(8484, 8485, 8486)

    private const val CONNECT_TIMEOUT_MS = 350
    private const val PARALLEL = 64

    /** Every other host address of the /24 subnet around [own] (four IPv4 bytes). */
    fun neighbours(own: ByteArray): List<String> {
        require(own.size == 4) { "IPv4 address expected" }
        val prefix = own.take(3).joinToString(".") { (it.toInt() and 0xFF).toString() }
        val self = own[3].toInt() and 0xFF
        return (1..254).filter { it != self }.map { "$prefix.$it" }
    }

    /**
     * The phone's private IPv4 address on Wi-Fi or Ethernet; never mobile data. Every
     * network is checked, not just the default one: a home Wi-Fi without internet
     * access stays connected while mobile data remains the default.
     */
    @Suppress("DEPRECATION") // allNetworks: the callback API would be overkill for a one-off lookup.
    fun localAddress(context: Context): Inet4Address? {
        val cm = context.getSystemService(ConnectivityManager::class.java) ?: return null
        val networks = listOfNotNull(cm.activeNetwork) + cm.allNetworks
        return networks.asSequence()
            .filter { network ->
                val caps = cm.getNetworkCapabilities(network)
                caps != null && (
                    caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) ||
                        caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)
                    )
            }
            .flatMap { network -> cm.getLinkProperties(network)?.linkAddresses.orEmpty().asSequence() }
            .map { it.address }
            .filterIsInstance<Inet4Address>()
            .firstOrNull { !it.isLoopbackAddress && it.isSiteLocalAddress }
    }

    /**
     * Calls [onFound] (on the main thread) for each server as it answers.
     * Returns false when the phone isn't on a local network.
     */
    suspend fun scan(context: Context, onFound: (ServerInfo) -> Unit): Boolean {
        val own = localAddress(context) ?: return false
        val gate = Semaphore(PARALLEL)
        coroutineScope {
            for (host in neighbours(own.address)) {
                for (port in PORTS) {
                    launch(Dispatchers.IO) {
                        val found = gate.withPermit {
                            if (isOpen(host, port)) ServerProbe.check("http://$host:$port", 2500) else null
                        }
                        if (found != null) withContext(Dispatchers.Main) { onFound(found) }
                    }
                }
            }
        }
        return true
    }

    private fun isOpen(host: String, port: Int): Boolean = try {
        Socket().use { it.connect(InetSocketAddress(host, port), CONNECT_TIMEOUT_MS) }
        true
    } catch (_: IOException) {
        false
    }
}
