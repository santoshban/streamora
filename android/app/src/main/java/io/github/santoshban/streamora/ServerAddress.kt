package io.github.santoshban.streamora

import java.net.URI

/** Turns what people type into a server origin: "192.168.1.20" → "http://192.168.1.20:8484". */
object ServerAddress {
    const val DEFAULT_PORT = 8484

    /** The origin (scheme, host, port; no path), or null when [input] can't be a server address. */
    fun normalize(input: String): String? {
        val trimmed = input.trim()
        if (trimmed.isEmpty() || trimmed.any { it.isWhitespace() }) return null
        val hasScheme = "://" in trimmed
        val uri = try {
            URI(if (hasScheme) trimmed else "http://$trimmed")
        } catch (_: Exception) {
            return null
        }
        val scheme = uri.scheme?.lowercase()
        if (scheme != "http" && scheme != "https") return null
        val host = uri.host?.takeIf { it.isNotEmpty() } ?: return null
        val port = when {
            uri.port != -1 -> uri.port
            // "http://nas.local" means port 80, as typed; a bare host means Streamora's port.
            hasScheme -> -1
            else -> DEFAULT_PORT
        }
        return if (port == -1) "$scheme://$host" else "$scheme://$host:$port"
    }

    /** "http://192.168.1.20:8484" → "192.168.1.20:8484", for showing to people. */
    fun display(origin: String): String = origin.removePrefix("http://")
}
