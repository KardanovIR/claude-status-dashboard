package com.kardanov.agstatus.ui

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.kardanov.agstatus.Theme
import com.kardanov.agstatus.UsageInfo
import com.kardanov.agstatus.UsageWindow
import kotlinx.coroutines.delay
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * Full-width plan-limit bars pinned above the board: one row per reported
 * window (current 5-hour session, weekly caps, …).
 */
@Composable
fun UsageBars(usage: List<UsageInfo>, modifier: Modifier = Modifier) {
    // Redraws every minute so the "resets in …" countdowns stay honest.
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(60_000)
            now = System.currentTimeMillis()
        }
    }

    val shape = RoundedCornerShape(14.dp)
    Column(
        modifier = modifier
            .fillMaxWidth()
            .background(Theme.card, shape)
            .border(1.dp, Theme.cardBorder, shape)
            .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        for (info in usage) {
            for (window in info.windows) {
                UsageBarRow(sourceName = info.displayName, window = window, nowMillis = now)
            }
        }
    }
}

@Composable
private fun UsageBarRow(sourceName: String, window: UsageWindow, nowMillis: Long) {
    val barColor = Theme.usageColor(window.usedPct)
    val pctText = "${window.usedPct.roundToInt()}%"
    val reset = resetText(window.resetsAt, nowMillis)
    val fraction by animateFloatAsState(window.fraction, label = "usageFraction")

    val description = buildString {
        append("$sourceName ${window.displayLabel}: $pctText used")
        if (reset != null) append(", $reset")
    }

    Column(
        modifier = Modifier.clearAndSetSemantics { contentDescription = description },
        verticalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        Row(modifier = Modifier.fillMaxWidth()) {
            Text(
                text = "$sourceName · ${window.displayLabel}".uppercase(),
                style = MaterialTheme.typography.labelSmall,
                color = Theme.textSecondary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier
                    .alignByBaseline()
                    .weight(1f)
                    .padding(end = 8.dp),
            )
            Text(
                text = pctText,
                style = TextStyle(
                    fontSize = 12.sp,
                    fontWeight = FontWeight.Bold,
                    fontFeatureSettings = "tnum",
                ),
                color = Theme.textPrimary,
                maxLines = 1,
                modifier = Modifier.alignByBaseline(),
            )
            if (reset != null) {
                Text(
                    text = " · $reset",
                    fontSize = 11.sp,
                    color = Theme.textSecondary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.alignByBaseline(),
                )
            }
        }
        Canvas(modifier = Modifier.fillMaxWidth().height(6.dp)) {
            val radius = CornerRadius(size.height / 2)
            drawRoundRect(color = Color.White.copy(alpha = 0.06f), cornerRadius = radius)
            if (fraction > 0f) {
                // A hairline of progress stays visible even at ~0%.
                val filled = max(size.width * fraction, 4.dp.toPx())
                drawRoundRect(
                    color = barColor,
                    size = Size(filled, size.height),
                    cornerRadius = radius,
                )
            }
        }
    }
}

/** "resets in 2h 15m" — null once the reset time is unknown or passed. */
internal fun resetText(resetsAt: Long?, nowMillis: Long): String? {
    if (resetsAt == null) return null
    val seconds = ((resetsAt - nowMillis) / 1000L).toInt()
    if (seconds <= 60) return if (seconds > 0) "resets soon" else null
    // Derive units from one rounded minute total so 7199s is "2h", never "1h 60m".
    val totalMinutes = (seconds + 30) / 60
    if (totalMinutes < 60) return "resets in ${totalMinutes}m"
    val totalHours = totalMinutes / 60
    if (totalHours < 24) {
        val minutes = totalMinutes % 60
        return if (minutes > 0) "resets in ${totalHours}h ${minutes}m" else "resets in ${totalHours}h"
    }
    val days = totalHours / 24
    val hours = totalHours % 24
    return if (hours > 0) "resets in ${days}d ${hours}h" else "resets in ${days}d"
}
