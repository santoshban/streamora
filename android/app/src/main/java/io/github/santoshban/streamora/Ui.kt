package io.github.santoshban.streamora

import android.content.Context
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.style.ForegroundColorSpan
import androidx.core.content.ContextCompat

/** The web UI's wordmark: STREAM in red, ORA in white. */
fun wordmark(context: Context): CharSequence = SpannableStringBuilder().apply {
    append("STREAM", ForegroundColorSpan(ContextCompat.getColor(context, R.color.brand)), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    append("ORA", ForegroundColorSpan(0xFFFFFFFF.toInt()), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
}

fun Context.dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()
