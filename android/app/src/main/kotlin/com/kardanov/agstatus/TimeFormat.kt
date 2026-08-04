package com.kardanov.agstatus

import kotlin.math.max

/** Relative timestamps in the board's voice, shared by cards and timelines. */
object TimeFormat {

    /** "just now", "5m ago", "3h ago", "2d ago". Future instants read as now. */
    fun relative(fromMillis: Long, nowMillis: Long): String {
        val seconds = ((nowMillis - fromMillis) / 1000).coerceAtLeast(0)
        return when {
            seconds < 45 -> "just now"
            seconds < 3600 -> "${max(1L, seconds / 60)}m ago"
            seconds < 86_400 -> "${seconds / 3600}h ago"
            else -> "${seconds / 86_400}d ago"
        }
    }
}
