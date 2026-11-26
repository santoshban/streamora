package io.github.santoshban.streamora

import android.content.Context
import androidx.core.content.edit
import org.json.JSONArray

/**
 * The server this phone uses, and every address it is known at: typically the
 * home network and a VPN such as Tailscale.
 */
class ServerStore(context: Context) {
    private val prefs = context.getSharedPreferences("streamora", Context.MODE_PRIVATE)

    /** The address in use (or last used). */
    var serverUrl: String?
        get() = prefs.getString(KEY_SERVER, null)
        set(value) = prefs.edit { if (value == null) remove(KEY_SERVER) else putString(KEY_SERVER, value) }

    /** The server's ID, so addresses of another server are never mixed in. */
    var serverId: String?
        get() = prefs.getString(KEY_ID, null)
        private set(value) = prefs.edit { if (value == null) remove(KEY_ID) else putString(KEY_ID, value) }

    /** Every known address of the server, the one in use included. */
    var addresses: List<String>
        get() {
            val saved = prefs.getString(KEY_ADDRESSES, null)?.let { raw ->
                runCatching { JSONArray(raw).let { array -> (0 until array.length()).map { array.getString(it) } } }.getOrNull()
            }
            return (listOfNotNull(serverUrl) + saved.orEmpty()).distinct()
        }
        private set(value) = prefs.edit { putString(KEY_ADDRESSES, JSONArray(value).toString()) }

    /** A server picked on the connect screen. Another server's addresses are forgotten. */
    fun choose(server: ServerInfo) {
        val sameServer = server.id != null && server.id == serverId
        addresses = if (sameServer) (listOf(server.url) + addresses).distinct() else listOf(server.url)
        serverId = server.id
        serverUrl = server.url
    }

    /** Addresses the server reported (`/api/server/addresses`). Newest first; stale ones drop off the end. */
    fun learn(id: String?, urls: List<String>) {
        if (id == null || (serverId != null && id != serverId)) return
        serverId = id
        val reported = urls.mapNotNull { ServerAddress.normalize(it) }
        addresses = (listOfNotNull(serverUrl) + reported + addresses).distinct().take(MAX_ADDRESSES)
    }

    private companion object {
        const val KEY_SERVER = "server"
        const val KEY_ID = "serverId"
        const val KEY_ADDRESSES = "addresses"
        const val MAX_ADDRESSES = 12
    }
}
