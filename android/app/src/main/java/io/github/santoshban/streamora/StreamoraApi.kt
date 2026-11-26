package io.github.santoshban.streamora

import android.webkit.CookieManager
import java.net.HttpURLConnection
import java.net.URL
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.withContext
import org.json.JSONObject

class ApiException(val status: Int, message: String) : Exception(message)

/**
 * The few server calls the player makes. It signs in with the web UI's session
 * cookie, which the WebView keeps in [CookieManager].
 */
class StreamoraApi(private val server: String) {

    /** Outlives the player screen, so progress saved while it closes still arrives. */
    companion object {
        val background = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    }

    fun cookie(): String? = CookieManager.getInstance().getCookie(server)

    suspend fun get(path: String): JSONObject = request("GET", path, null) ?: JSONObject()

    suspend fun post(path: String, body: JSONObject = JSONObject()): JSONObject? = request("POST", path, body)

    suspend fun put(path: String, body: JSONObject): JSONObject? = request("PUT", path, body)

    /**
     * Sends `{}`: Android's HttpURLConnection gives a bodiless DELETE a form-encoded
     * Content-Type, which the server rejects with 415.
     */
    suspend fun delete(path: String) {
        request("DELETE", path, JSONObject())
    }

    private suspend fun request(method: String, path: String, body: JSONObject?): JSONObject? = withContext(Dispatchers.IO) {
        val conn = URL(server + path).openConnection() as HttpURLConnection
        try {
            conn.requestMethod = method
            conn.connectTimeout = 10_000
            // Starting a transcode probes the file first.
            conn.readTimeout = 60_000
            conn.setRequestProperty("Accept", "application/json")
            cookie()?.let { conn.setRequestProperty("Cookie", it) }
            if (body != null) {
                conn.doOutput = true
                conn.setRequestProperty("Content-Type", "application/json")
                conn.outputStream.use { it.write(body.toString().toByteArray()) }
            }
            val code = conn.responseCode
            val text = (if (code >= 400) conn.errorStream else conn.inputStream)
                ?.bufferedReader()?.use { it.readText() }.orEmpty()
            if (code >= 400) {
                val message = runCatching { JSONObject(text).str("message") }.getOrNull()
                throw ApiException(code, message?.takeIf { it.isNotBlank() } ?: "HTTP $code")
            }
            if (text.isBlank()) null else JSONObject(text)
        } finally {
            conn.disconnect()
        }
    }
}
