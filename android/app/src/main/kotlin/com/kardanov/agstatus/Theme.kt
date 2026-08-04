package com.kardanov.agstatus

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

/**
 * Design tokens shared with the iOS app (Theme.swift) and the web dashboard:
 * background #0B0D12, cards #141822, and the six status colors. The board is
 * always dark — the status colors are the whole visual language and they are
 * tuned for a dark surface.
 */
object Theme {
    val background = Color(0xFF0B0D12)
    val card = Color(0xFF141822)
    val cardBorder = Color(0x14FFFFFF) // white @ 8%
    val textPrimary = Color(0xFFE9EDF5)
    val textSecondary = Color(0xFF8B93A7)

    val idle = Color(0xFF8B93A7)
    val planning = Color(0xFF4D9FFF)
    val coding = Color(0xFFB17AFF)
    val testing = Color(0xFFFFB02E)
    val blocked = Color(0xFFFF5C5C)
    val done = Color(0xFF3ECF8E)

    fun colorFor(status: AgentStatus): Color = when (status) {
        AgentStatus.IDLE -> idle
        AgentStatus.PLANNING -> planning
        AgentStatus.CODING -> coding
        AgentStatus.TESTING -> testing
        AgentStatus.BLOCKED -> blocked
        AgentStatus.DONE -> done
    }

    /** Bar color for a usage percentage — green, amber past 60, red past 85. */
    fun usageColor(usedPct: Double): Color = when {
        usedPct >= 85 -> blocked
        usedPct >= 60 -> testing
        else -> done
    }
}

private val AgStatusColorScheme = darkColorScheme(
    primary = Theme.coding,
    onPrimary = Color.White,
    background = Theme.background,
    onBackground = Theme.textPrimary,
    surface = Theme.card,
    onSurface = Theme.textPrimary,
    error = Theme.blocked,
)

private val AgStatusTypography = Typography(
    // Monospace for the small uppercase labels that echo terminal output.
    labelSmall = TextStyle(
        fontFamily = FontFamily.Monospace,
        fontWeight = FontWeight.Medium,
        fontSize = 11.sp,
        letterSpacing = 0.9.sp,
    ),
)

@Composable
fun AgStatusTheme(
    @Suppress("UNUSED_PARAMETER") darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    // Always dark: the six status colors are calibrated for this background.
    MaterialTheme(
        colorScheme = AgStatusColorScheme,
        typography = AgStatusTypography,
        content = content,
    )
}
