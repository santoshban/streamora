package io.github.santoshban.streamora

import android.content.Context
import java.net.URI
import kotlinx.coroutines.async

/**
 * Picks the address to reach the server at: the home network when the phone is
 * on it, otherwise a VPN address (Tailscale), otherwise anything else known.
 */
object ServerSelector {
    enum class Kind { LAN, VPN, OTHER }

    private const val PROBE_TIMEOUT_MS = 3000

    fun kind(url: String): Kind {
        val host = runCatching { URI(url).host }.getOrNull()?.trim('[', ']')?.lowercase() ?: return Kind.OTHER
        if (host.endsWith(".local")) return Kind.LAN
        if (host.endsWith(".ts.net")) return Kind.VPN
        val parts = host.split('.')
        val octets = parts.mapNotNull { it.toIntOrNull() }
        if (parts.size != 4 || octets.size != 4) return Kind.OTHER
        val (a, b) = octets
        return when {
            a == 10 || (a == 172 && b in 16..31) || (a == 192 && b == 168) -> Kind.LAN
            // 100.64/10: the range Tailscale gives its devices.
            a == 100 && b in 64..127 -> Kind.VPN
            else -> Kind.OTHER
        }
    }

    /**
     * The order to try addresses in: home network, VPN, the rest; the one in use
     * first within each group. Away from Wi-Fi, home addresses go last rather
     * than being dropped (a VPN may route them).
     */
    fun ordered(addresses: List<String>, current: String?, onLocalNetwork: Boolean): List<String> {
        fun group(url: String): Int = when (kind(url)) {
            Kind.LAN -> if (onLocalNetwork) 0 else 3
            Kind.VPN -> 1
            Kind.OTHER -> 2
        }
        return addresses.distinct().sortedWith(compareBy({ group(it) }, { if (it == current) 0 else 1 }))
    }

    /**
     * The best address where this server answers, or null. All addresses are
     * asked at once and the first in [ordered] order wins, so a home address
     * that times out away from home costs nothing when the VPN one answers.
     */
    suspend fun find(context: Context, store: ServerStore): ServerInfo? {
        val candidates = ordered(store.addresses, store.serverUrl, Discovery.localAddress(context) != null)
        val id = store.serverId
        // Not children of the caller: a probe stuck in a timeout mustn't hold up the answer.
        val probes = candidates.map { url ->
            StreamoraApi.background.async {
                ServerProbe.check(url, PROBE_TIMEOUT_MS)?.takeIf { id == null || it.id == null || it.id == id }
            }
        }
        for (probe in probes) {
            probe.await()?.let { return it }
        }
        return null
    }
}
