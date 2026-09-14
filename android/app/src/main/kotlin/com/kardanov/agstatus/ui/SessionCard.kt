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
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.FlipToFront
import androidx.compose.material.icons.outlined.PlayArrow
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.kardanov.agstatus.AgentStatus
import com.kardanov.agstatus.CommandType
import com.kardanov.agstatus.FocusCopy
import com.kardanov.agstatus.FocusStatus
import com.kardanov.agstatus.MachinePresence
import com.kardanov.agstatus.Session
import com.kardanov.agstatus.SessionHost
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
 *
 * A session that reports a host gets a Focus footer: an explicit control —
 * never the card's tap, which is history — enabled only while that machine's
 * listener is online, and the outcome of the last tap under it.
 */
@Composable
fun SessionCard(
    session: Session,
    nowMillis: Long,
    modifier: Modifier = Modifier,
    machines: Map<String, MachinePresence> = emptyMap(),
    focus: FocusStatus? = null,
    onCommand: (CommandType) -> Unit = {},
) {
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

        session.host?.let { host ->
            FocusFooter(
                host = host,
                machines = machines,
                status = focus,
                nowMillis = nowMillis,
                onCommand = onCommand,
            )
        }
    }
}

// MARK: - Focus footer

/**
 * "Bring to front on <machine>", a Resume control after "not running", and
 * one line of status: why the control is disabled, or how the last tap went.
 */
@Composable
private fun FocusFooter(
    host: SessionHost,
    machines: Map<String, MachinePresence>,
    status: FocusStatus?,
    nowMillis: Long,
    onCommand: (CommandType) -> Unit,
) {
    val name = remember(host, machines) { FocusCopy.machineLabel(host, machines) }
    val online = FocusCopy.isOnline(host, machines)
    // Shown under the control, and read with it: TalkBack announces a
    // disabled button as "<label>, disabled" and nothing else, while the
    // reason would otherwise only surface in the card's merged node.
    val offlineNote = if (online) null else FocusCopy.offlineNote(host, name, machines, nowMillis)

    Column(
        modifier = Modifier.padding(top = 2.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            FocusButton(
                label = "Bring to front on $name",
                icon = Icons.Outlined.FlipToFront,
                enabled = online,
                disabledReason = offlineNote,
                onClick = { onCommand(CommandType.FOCUS) },
                modifier = Modifier.weight(1f, fill = false),
            )
            if (status?.offersResume == true) {
                FocusButton(
                    label = "Resume",
                    icon = Icons.Outlined.PlayArrow,
                    enabled = online,
                    disabledReason = offlineNote,
                    onClick = { onCommand(CommandType.RESUME) },
                )
            }
        }

        when {
            status != null -> {
                val color = when (status.phase) {
                    FocusStatus.Phase.PENDING -> Theme.textSecondary
                    FocusStatus.Phase.OK -> Theme.done
                    FocusStatus.Phase.FAIL -> Theme.blocked
                }
                Text(
                    text = status.text,
                    fontSize = 12.sp,
                    color = color,
                    // Its own node, so the card's merged description doesn't
                    // become a live region and only this line is announced.
                    modifier = Modifier.semantics(mergeDescendants = true) {
                        liveRegion = LiveRegionMode.Polite
                        contentDescription = status.text
                    },
                )
            }

            offlineNote != null -> Text(
                text = offlineNote,
                fontSize = 12.sp,
                color = Theme.textTertiary,
            )
        }
    }
}

/**
 * [disabledReason], when given, becomes the button's state description, so
 * TalkBack reads the label, "disabled", and why together.
 */
@Composable
private fun FocusButton(
    label: String,
    icon: ImageVector,
    enabled: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    disabledReason: String? = null,
) {
    Button(
        onClick = onClick,
        enabled = enabled,
        modifier = modifier.semantics {
            if (!enabled && disabledReason != null) stateDescription = disabledReason
        },
        colors = ButtonDefaults.buttonColors(
            containerColor = Theme.planning,
            contentColor = Color.White,
            disabledContainerColor = Theme.cardBorder,
            disabledContentColor = Theme.textSecondary,
        ),
        contentPadding = PaddingValues(horizontal = 14.dp, vertical = 8.dp),
    ) {
        Icon(
            imageVector = icon,
            contentDescription = null,
            modifier = Modifier.size(16.dp),
        )
        Spacer(Modifier.width(6.dp))
        Text(
            text = label,
            style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.SemiBold),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
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
