package io.github.santoshban.streamora

import java.net.HttpURLConnection
import java.net.URL
import org.json.JSONObject

data class ServerInfo(val url: String, val version: String?)

object ServerProbe {
    /** Asks `/api/health`; returns the server when it is a Streamora server. Blocking. */
    fun check(url: String, timeoutMs: Int = 5000): ServerInfo? = try {
        val conn = URL("$url/api/health").openConnection() as HttpURLConnection
        conn.connectTimeout = timeoutMs
        conn.readTimeout = timeoutMs
        conn.setRequestProperty("Accept", "application/json")
        try {
            if (conn.responseCode != HttpURLConnection.HTTP_OK) {
                null
            } else {
                val json = JSONObject(conn.inputStream.bufferedReader().use { it.readText() })
                if (json.optString("name") == "Streamora") ServerInfo(url, json.str("version")) else null
            }
        } finally {
            conn.disconnect()
        }
    } catch (_: Exception) {
        null
    }
}
