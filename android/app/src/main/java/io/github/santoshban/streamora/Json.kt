package io.github.santoshban.streamora

import org.json.JSONArray
import org.json.JSONObject

// org.json's opt* getters turn JSON null into "null" / 0; these keep it null.

fun JSONObject.str(name: String): String? = if (isNull(name)) null else optString(name)

fun JSONObject.int(name: String): Int? = if (isNull(name)) null else optInt(name)

fun JSONObject.double(name: String): Double? = if (isNull(name)) null else optDouble(name).takeIf { !it.isNaN() }

fun JSONObject.obj(name: String): JSONObject? = if (isNull(name)) null else optJSONObject(name)

fun <T> JSONArray?.mapObjects(transform: (JSONObject) -> T): List<T> =
    if (this == null) emptyList() else (0 until length()).mapNotNull { optJSONObject(it)?.let(transform) }
