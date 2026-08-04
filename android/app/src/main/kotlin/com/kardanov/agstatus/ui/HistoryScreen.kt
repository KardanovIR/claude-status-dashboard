package com.kardanov.agstatus.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.outlined.History
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.kardanov.agstatus.AgentStatus
import com.kardanov.agstatus.HistoryEvent
import com.kardanov.agstatus.Session
import com.kardanov.agstatus.SessionStore
import com.kardanov.agstatus.Theme
import com.kardanov.agstatus.TimeFormat
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * The timeline of one agent session: every status/message transition with its
 * timestamp, newest first, in the board's color scheme.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HistoryScreen(
    store: SessionStore,
    sessionId: String,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val sessions by store.sessions.collectAsState()
    val session = sessions.firstOrNull { it.id == sessionId }

    var events by remember(sessionId) { mutableStateOf<List<HistoryEvent>>(emptyList()) }
    var loaded by remember(sessionId) { mutableStateOf(false) }
    var refreshing by remember(sessionId) { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val now = rememberHistoryClock()

    // Live: any update to this session (a new SSE event) is a new timeline entry.
    LaunchedEffect(sessionId, session?.updatedAt) {
        events = loadHistory(store, sessionId)
        loaded = true
    }

    Scaffold(
        modifier = modifier,
        containerColor = Theme.background,
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        text = session?.displayName ?: sessionId,
                        fontSize = 17.sp,
                        fontWeight = FontWeight.SemiBold,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = Theme.background,
                    scrolledContainerColor = Theme.background,
                    titleContentColor = Theme.textPrimary,
                    navigationIconContentColor = Theme.textPrimary,
                    actionIconContentColor = Theme.textPrimary,
                ),
            )
        },
    ) { padding ->
        PullToRefreshBox(
            isRefreshing = refreshing,
            onRefresh = {
                scope.launch {
                    refreshing = true
                    events = loadHistory(store, sessionId)
                    loaded = true
                    refreshing = false
                }
            },
            modifier = Modifier
                .padding(padding)
                .fillMaxSize(),
        ) {
            if (loaded && events.isEmpty()) {
                HistoryEmptyState()
            } else {
                LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(bottom = 24.dp),
                ) {
                    if (session != null) {
                        item(key = "header") { HistoryHeader(session) }
                    }
                    itemsIndexed(events, key = { _, event -> event.seq }) { index, event ->
                        HistoryTimelineRow(
                            event = event,
                            isFirst = index == 0,
                            isLast = index == events.lastIndex,
                            nowMillis = now,
                            modifier = Modifier.padding(horizontal = 16.dp),
                        )
                    }
                }
            }
        }
    }
}

/** The server answers newest first; sorting keeps that true for any server. */
private suspend fun loadHistory(store: SessionStore, sessionId: String): List<HistoryEvent> =
    store.history(sessionId).sortedByDescending { it.seq }

// MARK: - Header

@Composable
private fun HistoryHeader(session: Session) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = 16.dp, end = 16.dp, top = 10.dp, bottom = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (session.project.isNotEmpty()) {
            Text(
                text = session.project,
                fontFamily = FontFamily.Monospace,
                fontSize = 12.sp,
                color = Theme.textSecondary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier
                    .clip(CircleShape)
                    .background(Theme.cardBorder)
                    .padding(horizontal = 10.dp, vertical = 4.dp),
            )
        }
        Spacer(Modifier.weight(1f))
        HistoryStatusBadge(session.status)
    }
}

@Composable
private fun HistoryStatusBadge(status: AgentStatus) {
    val color = Theme.colorFor(status)
    Text(
        text = status.label,
        fontSize = 12.sp,
        fontWeight = FontWeight.SemiBold,
        color = color,
        modifier = Modifier
            .clip(CircleShape)
            .background(color.copy(alpha = 0.16f))
            .border(1.dp, color.copy(alpha = 0.35f), CircleShape)
            .padding(horizontal = 10.dp, vertical = 4.dp),
    )
}

// MARK: - Timeline row

@Composable
private fun HistoryTimelineRow(
    event: HistoryEvent,
    isFirst: Boolean,
    isLast: Boolean,
    nowMillis: Long,
    modifier: Modifier = Modifier,
) {
    val color = Theme.colorFor(event.status)
    Row(
        // Intrinsic height lets the gutter line stretch to whatever the text needs.
        modifier = modifier
            .fillMaxWidth()
            .height(IntrinsicSize.Min),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Column(
            modifier = Modifier
                .width(12.dp)
                .fillMaxHeight(),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Box(
                Modifier
                    .width(2.dp)
                    .height(10.dp)
                    .background(if (isFirst) Color.Transparent else Theme.cardBorder)
            )
            Box(
                contentAlignment = Alignment.Center,
                modifier = Modifier
                    .size(12.dp)
                    .then(
                        // The newest event glows; the older ones are plain dots.
                        if (isFirst) {
                            Modifier
                                .clip(CircleShape)
                                .background(color.copy(alpha = 0.25f))
                        } else {
                            Modifier
                        }
                    ),
            ) {
                Box(
                    Modifier
                        .size(9.dp)
                        .clip(CircleShape)
                        .background(color)
                )
            }
            Box(
                Modifier
                    .width(2.dp)
                    .weight(1f)
                    .background(if (isLast) Color.Transparent else Theme.cardBorder)
            )
        }

        Column(
            modifier = Modifier
                .weight(1f)
                .padding(vertical = 10.dp),
            verticalArrangement = Arrangement.spacedBy(3.dp),
        ) {
            Row(verticalAlignment = Alignment.Bottom) {
                Text(
                    text = event.status.label,
                    fontSize = 15.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = color,
                    modifier = Modifier.alignByBaseline(),
                )
                Spacer(Modifier.weight(1f))
                Text(
                    text = absoluteTime(event.at, nowMillis),
                    fontSize = 12.sp,
                    fontFamily = FontFamily.Monospace,
                    color = Theme.textSecondary,
                    modifier = Modifier
                        .alignByBaseline()
                        .padding(start = 8.dp),
                )
                Text(
                    text = TimeFormat.relative(event.at, nowMillis),
                    fontSize = 11.sp,
                    color = Theme.textSecondary.copy(alpha = 0.6f),
                    maxLines = 1,
                    modifier = Modifier
                        .alignByBaseline()
                        .padding(start = 8.dp),
                )
            }
            if (event.message.isNotEmpty()) {
                Text(
                    text = event.message,
                    fontSize = 15.sp,
                    color = if (isFirst) Theme.textPrimary else Theme.textSecondary,
                    maxLines = 3,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

// MARK: - Empty state

@Composable
private fun HistoryEmptyState() {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Icon(
            imageVector = Icons.Outlined.History,
            contentDescription = null,
            tint = Theme.textSecondary,
            modifier = Modifier.size(40.dp),
        )
        Spacer(Modifier.height(12.dp))
        Text(
            text = "No history yet",
            fontSize = 20.sp,
            fontWeight = FontWeight.SemiBold,
            color = Theme.textPrimary,
        )
        Spacer(Modifier.height(12.dp))
        Text(
            text = "Events appear here as the agent works.",
            fontSize = 15.sp,
            color = Theme.textSecondary,
            textAlign = TextAlign.Center,
        )
    }
}

// MARK: - Time

private val TIME_ONLY: DateTimeFormatter = DateTimeFormatter.ofPattern("HH:mm", Locale.getDefault())
private val DATE_AND_TIME: DateTimeFormatter =
    DateTimeFormatter.ofPattern("MMM d, HH:mm", Locale.getDefault())

/** "18:42" for today, "Aug 2, 18:42" otherwise. */
private fun absoluteTime(atMillis: Long, nowMillis: Long): String {
    val zone = ZoneId.systemDefault()
    val at = Instant.ofEpochMilli(atMillis).atZone(zone)
    val today = Instant.ofEpochMilli(nowMillis).atZone(zone).toLocalDate()
    return if (at.toLocalDate() == today) at.format(TIME_ONLY) else at.format(DATE_AND_TIME)
}

/** One shared clock keeping the relative ages honest, ticking every 30 s. */
@Composable
private fun rememberHistoryClock(): Long {
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(30_000)
            now = System.currentTimeMillis()
        }
    }
    return now
}
