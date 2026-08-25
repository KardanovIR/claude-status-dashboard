package com.kardanov.agstatus.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.outlined.Bedtime
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.HelpOutline
import androidx.compose.material.icons.outlined.Laptop
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.TextButton
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.SwipeToDismissBoxState
import androidx.compose.material3.rememberSwipeToDismissBoxState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.kardanov.agstatus.AgentStatus
import com.kardanov.agstatus.Board
import com.kardanov.agstatus.SessionStore
import com.kardanov.agstatus.Theme
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.math.abs

/** The live board: one glanceable card per agent session. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BoardScreen(
    store: SessionStore,
    onOpenHistory: (String) -> Unit,
    onOpenSettings: () -> Unit,
    onOpenPair: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val sessions by store.sessions.collectAsState()
    val usage by store.usage.collectAsState()
    val connection by store.connection.collectAsState()
    val board by store.board.collectAsState()

    val isDemo = connection == SessionStore.Connection.DEMO
    val boardGone = connection == SessionStore.Connection.BOARD_GONE
    val scope = rememberCoroutineScope()

    var refreshing by remember { mutableStateOf(false) }
    val refresh: () -> Unit = {
        if (!refreshing) {
            refreshing = true
            scope.launch {
                try {
                    store.refresh()
                } finally {
                    refreshing = false
                }
            }
        }
    }

    // Only limits of agents that actually have sessions on the board — a
    // Claude-only evening doesn't need Codex bars. With no sessions there is
    // nothing to disambiguate, and the limits still matter between runs, so
    // everything is shown rather than nothing.
    val visibleUsage = remember(sessions, usage) {
        val active = sessions.mapTo(mutableSetOf()) { it.source }
        if (active.isEmpty()) usage else usage.filter { it.source in active }
    }

    Scaffold(
        modifier = modifier,
        containerColor = Theme.background,
        topBar = {
            CenterAlignedTopAppBar(
                colors = TopAppBarDefaults.centerAlignedTopAppBarColors(
                    containerColor = Theme.background,
                    scrolledContainerColor = Theme.background,
                    titleContentColor = Theme.textPrimary,
                    navigationIconContentColor = Theme.textPrimary,
                    actionIconContentColor = Theme.textPrimary,
                ),
                title = {
                    Text(
                        text = "AgStatus",
                        style = TextStyle(fontSize = 17.sp, fontWeight = FontWeight.Bold),
                        color = Theme.textPrimary,
                    )
                },
                navigationIcon = {
                    Box(Modifier.padding(start = 16.dp)) {
                        if (isDemo) DemoBadge() else ConnectionDot(connection)
                    }
                },
                actions = {
                    // The demo badge says where you are; this says how you leave.
                    if (isDemo) {
                        TextButton(onClick = { store.stopDemo() }) {
                            Text(
                                text = "Exit demo",
                                style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.SemiBold),
                                color = Theme.planning,
                            )
                        }
                    }
                    if (board?.token != null && !boardGone) {
                        IconButton(onClick = onOpenPair) {
                            Icon(
                                imageVector = Icons.Outlined.Laptop,
                                contentDescription = "Pair your computer",
                                tint = Theme.textPrimary,
                            )
                        }
                    }
                    IconButton(onClick = onOpenSettings) {
                        Icon(
                            imageVector = Icons.Outlined.Settings,
                            contentDescription = "Settings",
                            tint = Theme.textPrimary,
                        )
                    }
                },
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .padding(padding)
                .fillMaxSize(),
        ) {
            if (visibleUsage.isNotEmpty() && !boardGone) {
                UsageBars(
                    usage = visibleUsage,
                    modifier = Modifier
                        .padding(horizontal = 16.dp)
                        .padding(top = 10.dp, bottom = 2.dp),
                )
            }
            Box(Modifier.weight(1f)) {
                when {
                    boardGone -> BoardGoneState(onStartOver = store::disconnectBoard)

                    sessions.isEmpty() -> PullToRefreshBox(
                        isRefreshing = refreshing,
                        onRefresh = refresh,
                        modifier = Modifier.fillMaxSize(),
                    ) {
                        // "No agents yet" is only true when we're actually live —
                        // while (re)connecting, an empty list just means "unknown".
                        if (isDemo || connection == SessionStore.Connection.LIVE) {
                            EmptyState(board = board, onOpenPair = onOpenPair)
                        } else {
                            ConnectingState()
                        }
                    }

                    else -> PullToRefreshBox(
                        isRefreshing = refreshing,
                        onRefresh = refresh,
                        modifier = Modifier.fillMaxSize(),
                    ) {
                        val now by rememberTickingClock(30_000L)
                        LazyColumn(
                            modifier = Modifier.fillMaxSize(),
                            contentPadding = PaddingValues(horizontal = 16.dp, vertical = 6.dp),
                            verticalArrangement = Arrangement.spacedBy(12.dp),
                        ) {
                            items(sessions, key = { it.id }) { session ->
                                val current by rememberUpdatedState(session)
                                val dismissState = rememberSwipeToDismissBoxState(
                                    confirmValueChange = { value ->
                                        if (value == SwipeToDismissBoxValue.EndToStart) {
                                            scope.launch { store.dismiss(current) }
                                            true
                                        } else {
                                            false
                                        }
                                    },
                                )
                                SwipeToDismissBox(
                                    state = dismissState,
                                    modifier = Modifier.animateItem(),
                                    enableDismissFromStartToEnd = false,
                                    enableDismissFromEndToStart = true,
                                    backgroundContent = { DismissBackground(dismissState) },
                                ) {
                                    SessionCard(
                                        session = session,
                                        nowMillis = now,
                                        modifier = Modifier.clickable {
                                            onOpenHistory(session.id)
                                        },
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

// MARK: - Session list decoration

/** Drag distance at which the dismiss background reaches full opacity. */
private const val DISMISS_REVEAL_PX = 220f

/**
 * Faded in with the drag itself. The box draws this behind the card at all
 * times, and a done card is translucent, so a fixed-opacity background would
 * bleed red through every finished session.
 */
@Composable
private fun DismissBackground(state: SwipeToDismissBoxState) {
    val dragged = runCatching { abs(state.requireOffset()) }.getOrDefault(0f)
    val revealed = (dragged / DISMISS_REVEAL_PX).coerceIn(0f, 1f)
    Row(
        modifier = Modifier
            .fillMaxSize()
            .clip(RoundedCornerShape(16.dp))
            .alpha(revealed)
            .background(Theme.blocked)
            .padding(horizontal = 20.dp),
        horizontalArrangement = Arrangement.End,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = Icons.Filled.Close,
            contentDescription = null,
            tint = Color.White,
            modifier = Modifier.size(18.dp),
        )
        Spacer(Modifier.size(8.dp))
        Text(
            text = "Dismiss",
            style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.SemiBold),
            color = Color.White,
        )
    }
}

// MARK: - Empty state

@Composable
private fun EmptyState(board: Board?, onOpenPair: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(24.dp)
            .padding(top = 64.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Icon(
            imageVector = Icons.Outlined.Bedtime,
            contentDescription = null,
            tint = Theme.textSecondary,
            modifier = Modifier.size(44.dp),
        )
        Text(
            text = "No agents yet",
            style = TextStyle(fontSize = 22.sp, fontWeight = FontWeight.SemiBold),
            color = Theme.textPrimary,
        )
        Text(
            text = "Pair your computer and your coding agents will show up here " +
                "the moment they report in.",
            fontSize = 14.sp,
            color = Theme.textSecondary,
            textAlign = TextAlign.Center,
        )

        if (board?.token != null) {
            Button(
                onClick = onOpenPair,
                colors = ButtonDefaults.buttonColors(
                    containerColor = Theme.planning,
                    contentColor = Color.White,
                ),
                contentPadding = PaddingValues(horizontal = 20.dp, vertical = 12.dp),
            ) {
                Icon(
                    imageVector = Icons.Outlined.Laptop,
                    contentDescription = null,
                    modifier = Modifier.size(18.dp),
                )
                Spacer(Modifier.size(8.dp))
                Text(
                    text = "Pair your computer",
                    style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold),
                )
            }
        }

        if (board != null) {
            Column(
                modifier = Modifier.padding(top = 16.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(
                    text = "Or send updates straight to the webhook:",
                    fontSize = 12.sp,
                    color = Theme.textSecondary,
                )
                WebhookRow(url = board.webhookUrl)
            }
        }
    }
}

@Composable
private fun WebhookRow(url: String) {
    val context = LocalContext.current
    val haptics = LocalHapticFeedback.current
    var copied by remember { mutableStateOf(false) }

    LaunchedEffect(copied) {
        if (copied) {
            delay(1500)
            copied = false
        }
    }

    val shape = RoundedCornerShape(10.dp)
    Row(
        modifier = Modifier
            .clip(shape)
            .background(Theme.card)
            .border(1.dp, Theme.cardBorder, shape)
            .clickable {
                val clipboard =
                    context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                clipboard.setPrimaryClip(ClipData.newPlainText("AgStatus webhook", url))
                haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                copied = true
            }
            .semantics { contentDescription = "Copy webhook URL" }
            .padding(horizontal = 12.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = url,
            style = TextStyle(fontSize = 12.sp, fontFamily = FontFamily.Monospace),
            color = Theme.textSecondary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f, fill = false),
        )
        Icon(
            imageVector = if (copied) Icons.Outlined.Check else Icons.Outlined.ContentCopy,
            contentDescription = null,
            tint = if (copied) Theme.done else Theme.textSecondary,
            modifier = Modifier.size(16.dp),
        )
    }
}

// MARK: - Connecting

@Composable
private fun ConnectingState() {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(top = 160.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        CircularProgressIndicator(color = Theme.textSecondary)
        Text(
            text = "Connecting to your board…",
            style = TextStyle(fontSize = 17.sp, fontWeight = FontWeight.Medium),
            color = Theme.textSecondary,
        )
        Text(
            text = "Pull down to retry.",
            fontSize = 12.sp,
            color = Theme.textSecondary.copy(alpha = 0.7f),
        )
    }
}

// MARK: - Board gone

@Composable
private fun BoardGoneState(onStartOver: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterVertically),
    ) {
        Icon(
            imageVector = Icons.Outlined.HelpOutline,
            contentDescription = null,
            tint = Theme.blocked,
            modifier = Modifier.size(44.dp),
        )
        Text(
            text = "This board no longer exists",
            style = TextStyle(fontSize = 22.sp, fontWeight = FontWeight.SemiBold),
            color = Theme.textPrimary,
            textAlign = TextAlign.Center,
        )
        Text(
            text = "It was probably deleted. Your device is fine — just set up a new one.",
            fontSize = 14.sp,
            color = Theme.textSecondary,
            textAlign = TextAlign.Center,
        )
        Button(
            onClick = onStartOver,
            colors = ButtonDefaults.buttonColors(
                containerColor = Theme.planning,
                contentColor = Color.White,
            ),
            contentPadding = PaddingValues(horizontal = 24.dp, vertical = 12.dp),
        ) {
            Text(
                text = "Start over",
                style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold),
            )
        }
    }
}

// MARK: - Toolbar bits

@Composable
private fun ConnectionDot(connection: SessionStore.Connection) {
    val color = when (connection) {
        SessionStore.Connection.LIVE -> Theme.colorFor(AgentStatus.DONE)
        SessionStore.Connection.CONNECTING,
        SessionStore.Connection.RECONNECTING -> Theme.colorFor(AgentStatus.TESTING)
        SessionStore.Connection.BOARD_GONE -> Theme.colorFor(AgentStatus.BLOCKED)
        SessionStore.Connection.IDLE,
        SessionStore.Connection.DEMO -> Theme.colorFor(AgentStatus.IDLE)
    }
    val description = when (connection) {
        SessionStore.Connection.LIVE -> "Connected"
        SessionStore.Connection.CONNECTING -> "Connecting"
        SessionStore.Connection.RECONNECTING -> "Reconnecting"
        SessionStore.Connection.BOARD_GONE -> "Board not found"
        SessionStore.Connection.IDLE -> "Not connected"
        SessionStore.Connection.DEMO -> "Demo"
    }
    Box(
        modifier = Modifier
            .size(9.dp)
            .shadow(3.dp, CircleShape, clip = false, ambientColor = color, spotColor = color)
            .background(color, CircleShape)
            .semantics { contentDescription = description },
    )
}

@Composable
private fun DemoBadge() {
    val color = Theme.colorFor(AgentStatus.CODING)
    Text(
        text = "DEMO",
        style = TextStyle(
            fontSize = 10.sp,
            fontWeight = FontWeight.Bold,
            letterSpacing = 1.sp,
        ),
        color = color,
        maxLines = 1,
        modifier = Modifier
            .background(color.copy(alpha = 0.15f), CircleShape)
            .border(1.dp, color.copy(alpha = 0.35f), CircleShape)
            .padding(horizontal = 8.dp, vertical = 3.dp)
            .semantics { contentDescription = "Demo mode" },
    )
}

/** A clock that ticks on a fixed period so cards can restate "5m ago". */
@Composable
private fun rememberTickingClock(periodMillis: Long): State<Long> {
    val clock = remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(periodMillis) {
        while (true) {
            delay(periodMillis)
            clock.longValue = System.currentTimeMillis()
        }
    }
    return clock
}
