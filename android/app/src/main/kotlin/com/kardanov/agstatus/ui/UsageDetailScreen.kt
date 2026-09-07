package com.kardanov.agstatus.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.kardanov.agstatus.ProjectTotal
import com.kardanov.agstatus.SessionStore
import com.kardanov.agstatus.Theme
import com.kardanov.agstatus.UsageDetail
import com.kardanov.agstatus.UsageHistory
import com.kardanov.agstatus.UsageSeries
import com.kardanov.agstatus.sourceDisplayName
import kotlinx.coroutines.launch
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * One agent's last thirty days: the tokens it actually spent, the plan limits
 * recorded over the same span, and where those tokens went. Mirrors the web
 * dashboard's usage detail view (public/app.js, "usage detail") so every
 * client tells the same story with the same numbers.
 *
 * The endpoint behind it is new. An older server 404s, the store turns that
 * into an empty [UsageHistory], and this screen simply draws nothing — it
 * never fails loudly over a board that predates the feature.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun UsageDetailScreen(
    store: SessionStore,
    source: String,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val usage by store.usage.collectAsState()
    val info = usage.firstOrNull { it.source == source }
    val name = info?.displayName ?: sourceDisplayName(source)

    var data by remember(source) { mutableStateOf(UsageHistory()) }
    var loaded by remember(source) { mutableStateOf(false) }
    var refreshing by remember(source) { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    // Live, like the session timeline: a fresh limit reading on the board is a
    // fresh point on this chart.
    LaunchedEffect(source, info?.updatedAt) {
        data = store.usageHistory()
        loaded = true
    }

    val days = remember(data) { UsageDetail.dayRange(data.days.coerceIn(1, UsageDetail.MAX_DAYS)) }
    val tokensPerDay = remember(data, source, days) {
        UsageDetail.tokensPerDay(data.projects, source, days)
    }
    val projects = remember(data, source) { UsageDetail.projectTotals(data.projects, source) }
    val series = remember(data, source) { data.history.filter { it.source == source } }
    val totalTokens = remember(tokensPerDay) { tokensPerDay.sum() }
    val maxTokens = remember(tokensPerDay) { max(1L, tokensPerDay.maxOrNull() ?: 0L) }

    Scaffold(
        modifier = modifier,
        containerColor = Theme.background,
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        text = "$name · last ${days.size} days",
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
                    data = store.usageHistory()
                    loaded = true
                    refreshing = false
                }
            },
            modifier = Modifier
                .padding(padding)
                .fillMaxSize(),
        ) {
            if (!loaded) {
                LoadingState()
            } else {
                Column(
                    modifier = Modifier
                        .fillMaxSize()
                        .verticalScroll(rememberScrollState())
                        .padding(horizontal = 16.dp)
                        .padding(top = 4.dp, bottom = 28.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    DetailCard {
                        ChartHeader(totalTokens = totalTokens, series = series)
                        TokensChart(
                            name = name,
                            days = days,
                            tokensPerDay = tokensPerDay,
                            maxTokens = maxTokens,
                            series = series,
                            modifier = Modifier.padding(top = 6.dp),
                        )
                    }

                    DetailCard {
                        SectionTitle("WHERE THE TOKENS WENT")
                        if (projects.isEmpty()) {
                            Text(
                                text = "No per-project token data reported yet.",
                                fontSize = 13.sp,
                                color = Theme.textSecondary,
                                modifier = Modifier.padding(top = 8.dp),
                            )
                        } else {
                            // Bar widths compare projects to the biggest one;
                            // the percentage is of everything this agent spent.
                            val largest = max(1L, projects.first().tokens)
                            for (total in projects) {
                                ProjectRow(
                                    total = total,
                                    share = (total.tokens.toDouble() / largest).toFloat(),
                                    percent = if (totalTokens > 0L) {
                                        (total.tokens * 100.0 / totalTokens).roundToInt()
                                    } else {
                                        0
                                    },
                                    modifier = Modifier.padding(top = 10.dp),
                                )
                            }
                        }
                    }

                    // The two series share an axis but not a unit, and saying so
                    // is the whole reason this note is not optional.
                    Text(
                        text = "Bars are tokens your agent spent, read from its own local logs. " +
                            "Lines are the account-wide plan limit, recorded from when this " +
                            "board first saw it. They track each other but are not the same measure.",
                        fontSize = 11.sp,
                        lineHeight = 16.sp,
                        color = Theme.textTertiary,
                        modifier = Modifier.padding(horizontal = 2.dp),
                    )
                }
            }
        }
    }
}

// MARK: - Cards

@Composable
private fun DetailCard(content: @Composable ColumnScope.() -> Unit) {
    val shape = RoundedCornerShape(14.dp)
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(Theme.card, shape)
            .border(1.dp, Theme.cardBorder, shape)
            .padding(horizontal = 14.dp, vertical = 12.dp),
        content = content,
    )
}

@Composable
private fun SectionTitle(text: String, modifier: Modifier = Modifier) {
    Text(
        text = text,
        style = MaterialTheme.typography.labelSmall,
        color = Theme.textSecondary,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        modifier = modifier,
    )
}

/** "TOKENS PER DAY · 512.4M total" on the left, the line legend on the right. */
@Composable
private fun ChartHeader(totalTokens: Long, series: List<UsageSeries>) {
    // A phone width cannot hold the title and three legend keys on one line
    // without cutting one of them, so there the legend drops underneath.
    val wide = LocalConfiguration.current.screenWidthDp >= 600
    if (wide) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.Bottom,
        ) {
            ChartTitle(
                totalTokens = totalTokens,
                modifier = Modifier
                    .weight(1f)
                    .padding(end = 10.dp),
            )
            ChartLegend(series, alignment = Alignment.End)
        }
    } else {
        Column(
            modifier = Modifier.fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            ChartTitle(totalTokens, Modifier.fillMaxWidth())
            ChartLegend(series, Modifier.fillMaxWidth(), alignment = Alignment.Start)
        }
    }
}

@Composable
private fun ChartTitle(totalTokens: Long, modifier: Modifier = Modifier) {
    Row(modifier = modifier) {
        SectionTitle("TOKENS PER DAY", Modifier.alignByBaseline())
        // Weighted, so a cramped header trims the total rather than the label.
        Text(
            text = " · ${UsageDetail.fmtTokens(totalTokens)} total",
            fontSize = 11.sp,
            color = Theme.textTertiary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier
                .alignByBaseline()
                .weight(1f, fill = false),
        )
    }
}

/** A coloured dash per window id, in the same order the lines are drawn. */
@Composable
private fun ChartLegend(
    series: List<UsageSeries>,
    modifier: Modifier = Modifier,
    alignment: Alignment.Horizontal = Alignment.End,
) {
    if (series.isEmpty()) {
        Text(
            text = "limit history starts once reported",
            fontSize = 10.sp,
            color = Theme.textTertiary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = modifier,
        )
        return
    }
    Column(
        modifier = modifier,
        horizontalAlignment = alignment,
        verticalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        // Three keys sit across a phone width; a chattier agent wraps onto
        // further lines rather than squeezing the title out of the header.
        for (row in series.withIndex().chunked(3)) {
            Row(
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                for ((index, entry) in row) {
                    Row(
                        horizontalArrangement = Arrangement.spacedBy(5.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Box(
                            Modifier
                                .size(width = 10.dp, height = 2.dp)
                                .background(Theme.usageLineColor(index), RoundedCornerShape(1.dp))
                        )
                        Text(
                            text = entry.windowId,
                            fontSize = 10.sp,
                            color = Theme.textSecondary,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            }
        }
    }
}

// MARK: - Chart

private val CHART_HEIGHT = 196.dp

/**
 * Tokens per day as bars against the left axis, each recorded limit window as
 * a line against the right axis, on one shared 30-day scale. Hand-drawn on a
 * Canvas — the app carries no charting dependency.
 */
@Composable
private fun TokensChart(
    name: String,
    days: List<String>,
    tokensPerDay: List<Long>,
    maxTokens: Long,
    series: List<UsageSeries>,
    modifier: Modifier = Modifier,
) {
    val measurer = rememberTextMeasurer()
    val axisStyle = remember { TextStyle(fontSize = 9.sp, color = Theme.textTertiary) }
    val sampled = remember(series, days) {
        series.map { UsageDetail.sampleSeries(it.points, days) }
    }
    val topLabel = remember(maxTokens) { UsageDetail.fmtTokens(maxTokens) }
    val barColor = Theme.usageTokenBar
    val gridColor = Theme.cardBorder
    val description = "$name: tokens per day and recorded plan limits over ${days.size} days"

    Canvas(
        modifier = modifier
            .fillMaxWidth()
            .height(CHART_HEIGHT)
            .semantics { contentDescription = description },
    ) {
        if (days.isEmpty()) return@Canvas
        val left = 40.dp.toPx()
        val right = 34.dp.toPx()
        val top = 10.dp.toPx()
        val bottom = 20.dp.toPx()
        val plotWidth = size.width - left - right
        val plotHeight = size.height - top - bottom
        if (plotWidth <= 0f || plotHeight <= 0f) return@Canvas

        val lastIndex = days.lastIndex
        fun xAt(index: Int): Float =
            if (lastIndex == 0) left + plotWidth / 2f else left + index * plotWidth / lastIndex

        fun yAt(percent: Double): Float =
            top + plotHeight - (percent.coerceIn(0.0, 100.0) / 100.0).toFloat() * plotHeight

        // Grid, and the right-hand percentage axis the lines are read against.
        for (percent in 0..100 step 25) {
            val gridY = yAt(percent.toDouble())
            drawLine(
                color = gridColor,
                start = Offset(left, gridY),
                end = Offset(size.width - right, gridY),
                strokeWidth = 1.dp.toPx(),
            )
            val label = measurer.measure("$percent%", axisStyle)
            drawText(
                textLayoutResult = label,
                topLeft = Offset(
                    size.width - right + 6.dp.toPx(),
                    gridY - label.size.height / 2f,
                ),
            )
        }

        // Left-hand axis: only the busiest day and zero, because the bars are
        // a relative shape, not a table.
        val gap = 8.dp.toPx()
        val maxLabel = measurer.measure(topLabel, axisStyle)
        drawText(
            textLayoutResult = maxLabel,
            topLeft = Offset(left - gap - maxLabel.size.width, top - maxLabel.size.height / 2f),
        )
        val zeroLabel = measurer.measure("0", axisStyle)
        drawText(
            textLayoutResult = zeroLabel,
            topLeft = Offset(
                left - gap - zeroLabel.size.width,
                top + plotHeight - zeroLabel.size.height / 2f,
            ),
        )

        // Bars: tokens spent, scaled to the busiest day.
        val barWidth = max(2.dp.toPx(), (plotWidth / days.size) * 0.62f)
        for (index in days.indices) {
            val tokens = tokensPerDay.getOrElse(index) { 0L }
            if (tokens <= 0L) continue
            val height = (tokens.toDouble() / maxTokens.toDouble()).toFloat() * plotHeight
            drawRoundRect(
                color = barColor,
                topLeft = Offset(xAt(index) - barWidth / 2f, top + plotHeight - height),
                size = Size(barWidth, height),
                cornerRadius = CornerRadius(1.5.dp.toPx()),
            )
        }

        // Lines: the plan limits, over the bars.
        for ((seriesIndex, values) in sampled.withIndex()) {
            val color = Theme.usageLineColor(seriesIndex)
            val recorded = values.count { it != null }
            if (recorded == 0) continue
            if (recorded == 1) {
                // A board that has only just started recording holds a single
                // reading, and a one-point path draws nothing at all.
                val index = values.indexOfFirst { it != null }
                drawCircle(
                    color = color,
                    radius = 2.5.dp.toPx(),
                    center = Offset(xAt(index), yAt(values[index] ?: 0.0)),
                )
                continue
            }
            val path = Path()
            var started = false
            for (index in values.indices) {
                val value = values[index] ?: continue
                val pointX = xAt(index)
                val pointY = yAt(value)
                if (started) path.lineTo(pointX, pointY) else path.moveTo(pointX, pointY)
                started = true
            }
            drawPath(
                path = path,
                color = color,
                style = Stroke(
                    width = 1.75.dp.toPx(),
                    cap = StrokeCap.Round,
                    join = StrokeJoin.Round,
                ),
            )
        }

        // Day ticks, every seventh day plus the final one when it fits.
        val tickY = size.height - bottom + 4.dp.toPx()
        for (index in days.indices) {
            if (!UsageDetail.showTick(index, lastIndex)) continue
            val label = measurer.measure(UsageDetail.dayLabel(days[index]), axisStyle)
            val tickX = (xAt(index) - label.size.width / 2f)
                .coerceIn(0f, max(0f, size.width - label.size.width))
            drawText(textLayoutResult = label, topLeft = Offset(tickX, tickY))
        }
    }
}

// MARK: - Projects

@Composable
private fun ProjectRow(
    total: ProjectTotal,
    share: Float,
    percent: Int,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Row(modifier = Modifier.fillMaxWidth()) {
            Text(
                text = total.project,
                fontSize = 13.sp,
                color = Theme.textPrimary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier
                    .alignByBaseline()
                    .weight(1f)
                    .padding(end = 10.dp),
            )
            Text(
                text = UsageDetail.fmtTokens(total.tokens),
                fontSize = 12.sp,
                fontWeight = FontWeight.SemiBold,
                color = Theme.textPrimary,
                maxLines = 1,
                modifier = Modifier.alignByBaseline(),
            )
            Text(
                text = " $percent%",
                fontSize = 12.sp,
                color = Theme.textTertiary,
                maxLines = 1,
                modifier = Modifier.alignByBaseline(),
            )
        }
        Canvas(modifier = Modifier.fillMaxWidth().height(6.dp)) {
            val radius = CornerRadius(size.height / 2)
            drawRoundRect(color = Color.White.copy(alpha = 0.06f), cornerRadius = radius)
            if (share > 0f) {
                // A hairline keeps the smallest project visible next to the top one.
                val filled = max(size.width * share, 4.dp.toPx())
                drawRoundRect(
                    brush = Brush.horizontalGradient(
                        colors = listOf(Theme.planning, Color(0xFF7CC0FF)),
                        startX = 0f,
                        endX = filled,
                    ),
                    size = Size(filled, size.height),
                    cornerRadius = radius,
                )
            }
        }
    }
}

// MARK: - Loading

@Composable
private fun LoadingState() {
    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        CircularProgressIndicator(color = Theme.textSecondary)
    }
}
