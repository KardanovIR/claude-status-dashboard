package com.kardanov.agstatus.ui

import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.kardanov.agstatus.AgentStatus
import com.kardanov.agstatus.Session
import com.kardanov.agstatus.Theme
import com.kardanov.agstatus.TimeFormat

/**
 * An active card gone quiet for this long is probably a dead agent
 * (killed mid-turn, crashed machine) — stop pulsing and dim it.
 */
private const val STALE_AFTER_MILLIS = 10 * 60 * 1000L

/**
 * One agent session, readable at arm's length: big name, colored status,
 * last message, and how fresh it all is. `nowMillis` is supplied by the
 * caller's clock so the timestamp and staleness refresh together.
 */
@Composable
fun SessionCard(session: Session, nowMillis: Long, modifier: Modifier = Modifier) {
    val statusColor = Theme.colorFor(session.status)
    val stale = session.status.isActive && nowMillis - session.updatedAt > STALE_AFTER_MILLIS
    val blocked = session.status == AgentStatus.BLOCKED
    val shape = RoundedCornerShape(16.dp)

    Column(
        modifier = modifier
            .fillMaxWidth()
            .semantics(mergeDescendants = true) {}
            .alpha(if (session.status == AgentStatus.DONE || stale) 0.55f else 1f)
            .shadow(
                elevation = if (blocked) 12.dp else 0.dp,
                shape = shape,
                clip = false,
                ambientColor = statusColor,
                spotColor = statusColor,
            )
            // A plain full-height stripe, clipped by the card's own shape so it
            // hugs the rounded left edge instead of floating beside it.
            .clip(shape)
            .background(Theme.card)
            .drawBehind {
                drawRect(color = statusColor, size = Size(4.dp.toPx(), size.height))
            }
            .border(
                width = 1.dp,
                color = if (blocked) statusColor.copy(alpha = 0.45f) else Theme.cardBorder,
                shape = shape,
            )
            .padding(start = 18.dp, top = 14.dp, end = 14.dp, bottom = 14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = session.displayName,
                style = TextStyle(fontSize = 20.sp, fontWeight = FontWeight.SemiBold),
                color = Theme.textPrimary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            Spacer(Modifier.width(8.dp))
            StatusBadge(
                status = session.status,
                color = statusColor,
                pulsing = session.status.isActive && !stale,
            )
        }

        if (session.project.isNotEmpty() && session.project != session.displayName) {
            Text(
                text = session.project,
                style = TextStyle(fontSize = 11.sp, fontFamily = FontFamily.Monospace),
                color = Theme.textSecondary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier
                    .background(Theme.cardBorder, CircleShape)
                    .padding(horizontal = 8.dp, vertical = 3.dp),
            )
        }

        if (session.message.isNotEmpty()) {
            Text(
                text = session.message,
                fontSize = 14.sp,
                color = Theme.textSecondary,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }

        Text(
            text = TimeFormat.relative(session.updatedAt, nowMillis),
            style = TextStyle(fontSize = 12.sp, fontFeatureSettings = "tnum"),
            color = Theme.textSecondary.copy(alpha = 0.75f),
        )
    }
}

@Composable
private fun StatusBadge(status: AgentStatus, color: Color, pulsing: Boolean) {
    val alpha = if (pulsing) {
        val transition = rememberInfiniteTransition(label = "badgePulse")
        val animated by transition.animateFloat(
            initialValue = 1f,
            targetValue = 0.45f,
            animationSpec = infiniteRepeatable(
                animation = tween(durationMillis = 1100, easing = FastOutSlowInEasing),
                repeatMode = RepeatMode.Reverse,
            ),
            label = "badgeAlpha",
        )
        animated
    } else {
        1f
    }

    Text(
        text = status.label,
        style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.SemiBold),
        color = color,
        maxLines = 1,
        modifier = Modifier
            .alpha(alpha)
            .background(color.copy(alpha = 0.16f), CircleShape)
            .border(1.dp, color.copy(alpha = 0.35f), CircleShape)
            .padding(horizontal = 10.dp, vertical = 4.dp),
    )
}
