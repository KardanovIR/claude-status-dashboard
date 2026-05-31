package com.claudestatus.dashboard

import android.content.Context
import androidx.core.content.edit

object Prefs {
    private const val FILE = "claude_status_prefs"
    private const val KEY_URL = "dashboard_url"
    private const val KEY_KEEP_AWAKE = "keep_awake"

    fun dashboardUrl(context: Context): String? =
        context.getSharedPreferences(FILE, Context.MODE_PRIVATE)
            .getString(KEY_URL, null)
            ?.takeIf { it.isNotBlank() }

    fun setDashboardUrl(context: Context, url: String) {
        context.getSharedPreferences(FILE, Context.MODE_PRIVATE).edit {
            putString(KEY_URL, url.trim())
        }
    }

    fun keepAwake(context: Context): Boolean =
        context.getSharedPreferences(FILE, Context.MODE_PRIVATE)
            .getBoolean(KEY_KEEP_AWAKE, true)

    fun setKeepAwake(context: Context, value: Boolean) {
        context.getSharedPreferences(FILE, Context.MODE_PRIVATE).edit {
            putBoolean(KEY_KEEP_AWAKE, value)
        }
    }
}
