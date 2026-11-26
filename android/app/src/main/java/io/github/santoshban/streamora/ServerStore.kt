package io.github.santoshban.streamora

import android.content.Context
import androidx.core.content.edit

/** The server this phone uses. */
class ServerStore(context: Context) {
    private val prefs = context.getSharedPreferences("streamora", Context.MODE_PRIVATE)

    var serverUrl: String?
        get() = prefs.getString(KEY_SERVER, null)
        set(value) = prefs.edit { if (value == null) remove(KEY_SERVER) else putString(KEY_SERVER, value) }

    private companion object {
        const val KEY_SERVER = "server"
    }
}
