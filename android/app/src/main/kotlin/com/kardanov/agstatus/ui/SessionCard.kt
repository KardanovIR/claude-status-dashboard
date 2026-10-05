package com.kardanov.agstatus.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.FlipToFront
import androidx.compose.material.icons.outlined.PlayArrow
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.TextStyle
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
 * (killed mid-turn, crashed machine) — stop reading it as live and dim it.
 */
private const val STALE_AFTER_MILLIS = 10 * 60 * 1000L

/**
 * One agent session, readable at arm's length: big name, the state as a shape
 * and a word, the last message, and the facts underneath. `nowMillis` is
 * supplied by the caller's clock so the timestamp and staleness refresh
 * together.
 *
 * A session that reports a host gets a Focus footer: an explicit control —
 * never the card's tap, which is history — enabled only while that machine's
 * listener is online, and the outcome of the last tap under it.
 */
@OptIn(ExperimentalLayoutApi::class)
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
    val shape = RoundedCornerShape(16.dp)

    Column(
        modifier = modifier
            .fillMaxWidth()
            .semantics(mergeDescendants = true) {}
            // Only staleness dims a card now. `done` used to be dimmed to 0.55
            // as well, from when it meant "finished, nothing to see". It means
            // the agent handed back and is waiting on YOU — and it is the
            // board's accent colour — so dimming it hid the one state this
            // board most needs to surface.
            .alpha(if (stale) 0.62f else 1f)
            // No glow. The blocked card used to carry a 12dp coloured shadow;
            // a lit halo is the trading-terminal tell, and it is exactly wrong
            // in a dark room at 1am, which is when this board gets read. The
            // brighter edge below is what marks blocked instead.
            .clip(shape)
            // The whole surface carries the state, so the board can be sorted
            // by colour before a word is read. This replaces a 4dp coloured
            // stripe down the leading edge: that pattern is the most overused
            // device in dashboard UI and never reads as intentional, whatever
            // colour or corner radius it is given. A large tinted area also
            // reads from much further away than a 4dp sliver.
            .background(Theme.cardSurface(session.status))
            .border(1.dp, Theme.cardEdge(session.status), shape)
            .padding(14.dp),
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
            StatusMark(status = session.status, color = statusColor)
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

        MetaLine(session = session, nowMillis = nowMillis, machines = machines)

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

// MARK: - Status

/**
 * The state as a shape, a word and a colour — in that order of reliability.
 *
 * The pulsing pill that used to live here is gone, and so is the pill. It
 * looped forever on every active card, which is ambient animation: it reported
 * nothing, it never stopped, and on a board left open all day it cost battery
 * to say the same thing continuously. Motion on this board now means something
 * changed. The pill itself was a status badge of the kind the enterprise admin
 * panel is made of; the card's own tint does that job across a far larger area.
 */
@Composable
private fun StatusMark(status: AgentStatus, color: Color) {
    Row(
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalAlignment = Alignment.CenterVertically,
        // One node reading "Coding", not a glyph and a word in sequence.
        modifier = Modifier.clearAndSetSemantics { contentDescription = status.label },
    ) {
        Icon(
            imageVector = Theme.iconFor(status),
            contentDescription = null,
            tint = color,
            modifier = Modifier.size(14.dp),
        )
        Text(
            text = status.label.uppercase(),
            style = TextStyle(
                fontSize = 12.sp,
                fontWeight = FontWeight.SemiBold,
                letterSpacing = 0.6.sp,
            ),
            color = color,
            maxLines = 1,
        )
    }
}

// MARK: - Meta

/**
 * Agent, machine, directory, when — four different facts, one line.
 *
 * The machine is the one the card never showed: it was buried inside the Focus
 * control's label, so two sessions of the same project on two machines were
 * indistinguishable at a glance.
 *
 * It wraps, because it must. The web board shipped this same line as a
 * non-wrapping flex row and a 320px card rendered the machine name four pixels
 * wide — present to a screen reader, invisible to everyone else. A FlowRow
 * cannot fail that way: it takes a second line instead of taking it out of the
 * one item that can shrink.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun MetaLine(
    session: Session,
    nowMillis: Long,
    machines: Map<String, MachinePresence>,
) {
    val machine = session.host?.let { remember(it, machines) { FocusCopy.machineLabel(it, machines) } }
    val project = session.project.takeIf { it.isNotEmpty() && it != session.displayName }

    FlowRow(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        // Which agent, as a word in a box. No glyph: "CLAUDE" and "CODEX" are
        // already distinct at a glance, and the one mark this card needs to
        // carry without colour is the status.
        Text(
            text = session.source.uppercase(),
            style = TextStyle(
                fontSize = 10.sp,
                fontWeight = FontWeight.SemiBold,
                letterSpacing = 0.4.sp,
            ),
            color = Theme.textTertiary,
            maxLines = 1,
            modifier = Modifier
                .border(1.dp, Theme.cardBorder, RoundedCornerShape(4.dp))
                .padding(horizontal = 5.dp, vertical = 2.dp),
        )
        if (machine != null) {
            MetaSeparator()
            MetaFact(machine)
        }
        // Only when the session has MOVED. The name is pinned at the session's
        // first event while `project` follows the live directory, so the two
        // are identical for a session that stayed put and differ precisely when
        // one moved — which is also where its tokens are being attributed.
        if (project != null) {
            MetaSeparator()
            MetaFact("in $project")
        }
        MetaSeparator()
        Text(
            text = TimeFormat.relative(session.updatedAt, nowMillis),
            // Tabular figures: this ticks in place on the board's clock, and
            // proportional digits make the whole line twitch sideways each time.
            style = TextStyle(fontSize = 12.sp, fontFeatureSettings = "tnum"),
            color = Theme.textTertiary,
            maxLines = 1,
        )
    }
}

@Composable
private fun MetaFact(text: String) {
    Text(
        text = text,
        fontSize = 12.sp,
        color = Theme.textTertiary,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
    )
}

/**
 * The dot between two facts.
 *
 * [Theme.textTertiary], the same colour as the facts it separates — NOT a
 * hairline token. The web board shipped these in `--ink-700` and they were the
 * only contrast failure its audit found, all seventeen of them, at 1.52:1. The
 * strong hairline is barely better: 1.80:1 against the card. A glyph is text
 * whatever job it is doing.
 */
@Composable
private fun MetaSeparator() {
    Text(
        text = "·",
        fontSize = 12.sp,
        color = Theme.textTertiary,
        modifier = Modifier.clearAndSetSemantics {},
    )
}

// MARK: - Focus footer

/**
 * "Focus" on the machine this session runs on, a Resume control after
 * "not running", and one line of status: why the control is disabled, or how
 * the last tap went.
 *
 * The verb alone on the button. "Bring to front on Mac mini" is the better
 * sentence but it is most of a card's width, and it was the second-loudest
 * element on a card whose job is to have exactly one. The full phrasing
 * survives where width is free: the accessibility label.
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
                label = "Focus",
                description = "Bring to front on $name",
                icon = Icons.Outlined.FlipToFront,
                enabled = online,
                disabledReason = offlineNote,
                onClick = { onCommand(CommandType.FOCUS) },
            )
            if (status?.offersResume == true) {
                FocusButton(
                    label = "Resume",
                    description = "Resume on $name",
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
 * [description] is what TalkBack reads — the whole sentence the visible label
 * abbreviates. [disabledReason], when given, becomes the state description, so
 * the label, "disabled", and why are read together.
 */
@Composable
private fun FocusButton(
    label: String,
    description: String,
    icon: ImageVector,
    enabled: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    disabledReason: String? = null,
) {
    Button(
        onClick = onClick,
        enabled = enabled,
        shape = RoundedCornerShape(10.dp),
        modifier = modifier
            // 44dp, the comfortable target. The side padding is deliberately
            // modest: this sits on a card, and width here comes off the name.
            .defaultMinSize(minHeight = 44.dp)
            .semantics {
                contentDescription = description
                if (!enabled && disabledReason != null) stateDescription = disabledReason
            },
        // NOT the accent, though it is the card's only control.
        //
        // Filled in accent green it became the loudest thing on the card by a
        // wide margin — a 56dp saturated pill against a 20sp name — and a card
        // with two loudest elements has failed the first design principle. The
        // state is what you read; this is what you do about it, and it waits.
        // iOS's FocusButtonStyle is the same raised surface and hairline.
        //
        // Disabled drops to the card surface rather than rising above it, so
        // "no listener on that machine" reads as recessed at a glance and not
        // only in the label's brightness.
        colors = ButtonDefaults.buttonColors(
            containerColor = Theme.raised,
            contentColor = Theme.textPrimary,
            disabledContainerColor = Theme.card,
            disabledContentColor = Theme.textTertiary,
        ),
        border = BorderStroke(1.dp, Theme.cardBorder),
        contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp),
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
