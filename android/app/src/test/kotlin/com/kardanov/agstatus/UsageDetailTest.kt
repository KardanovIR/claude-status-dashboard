package com.kardanov.agstatus

import kotlinx.serialization.decodeFromString
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The arithmetic behind the usage detail screen. It has to match the web
 * dashboard's exactly — the two render the same numbers from the same payload,
 * so a drift here is a drift users would notice between their phone and their
 * browser.
 */
class UsageDetailTest {

    /** 2026-09-08T12:00:00Z. */
    private val noon = 1788868800000L

    // MARK: - dayRange

    @Test
    fun dayRangeEndsTodayAndRunsOldestFirst() {
        val days = UsageDetail.dayRange(30, noon)

        assertEquals(30, days.size)
        assertEquals("2026-08-10", days.first())
        assertEquals("2026-09-08", days.last())
        assertEquals(days.sorted(), days)
    }

    @Test
    fun dayRangeUsesUtcDaysNotLocalOnes() {
        // 23:30 UTC is already the 9th in Sydney and still the 8th in London;
        // both phones must draw the same grid, so the day is the UTC one.
        val lateEvening = 1788910200000L // 2026-09-08T23:30:00Z
        assertEquals("2026-09-08", UsageDetail.dayRange(1, lateEvening).single())
    }

    @Test
    fun dayRangeOfNothingIsEmpty() {
        assertTrue(UsageDetail.dayRange(0, noon).isEmpty())
        assertTrue(UsageDetail.dayRange(-5, noon).isEmpty())
    }

    // MARK: - sampleSeries

    @Test
    fun sampleSeriesStepsAndLeavesDaysBeforeTheSeriesNull() {
        val days = UsageDetail.dayRange(4, noon) // 09-05 .. 09-08
        val points = listOf(
            UsagePoint(at = UsageDetail.dayStartMillis("2026-09-06") + 3_600_000L, usedPct = 12.0),
            UsagePoint(at = UsageDetail.dayStartMillis("2026-09-06") + 7_200_000L, usedPct = 25.0),
            UsagePoint(at = UsageDetail.dayStartMillis("2026-09-08") + 3_600_000L, usedPct = 61.0),
        )

        val sampled = UsageDetail.sampleSeries(points, days)

        // Nothing recorded yet on the 5th; the 7th holds the 6th's last reading.
        assertEquals(listOf(null, 25.0, 25.0, 61.0), sampled)
    }

    @Test
    fun sampleSeriesReadsTheVeryLastSecondOfADay() {
        val days = listOf("2026-09-08")
        val atMidnightMinusOne = UsageDetail.dayEndMillis("2026-09-08")

        val sampled = UsageDetail.sampleSeries(
            listOf(UsagePoint(at = atMidnightMinusOne, usedPct = 99.0)),
            days,
        )

        assertEquals(listOf(99.0), sampled)
    }

    @Test
    fun aBrandNewBoardsSinglePointStillSamples() {
        val days = UsageDetail.dayRange(30, noon)
        val points = listOf(UsagePoint(at = noon, usedPct = 7.0))

        val sampled = UsageDetail.sampleSeries(points, days)

        assertEquals(1, sampled.count { it != null })
        assertNotNull(sampled.last())
        assertNull(sampled[28])
    }

    // MARK: - Tokens

    @Test
    fun tokensPerDayBucketsOneSourceOntoTheGrid() {
        val days = UsageDetail.dayRange(3, noon) // 09-06, 09-07, 09-08
        val rows = listOf(
            ProjectDay("claude", "api", "2026-09-06", 10),
            ProjectDay("claude", "web", "2026-09-06", 5),
            ProjectDay("codex", "docs", "2026-09-06", 1000),
            ProjectDay("claude", "api", "2026-09-08", 7),
            ProjectDay("claude", "api", "2026-07-01", 999), // outside the grid
        )

        assertEquals(listOf(15L, 0L, 7L), UsageDetail.tokensPerDay(rows, "claude", days))
        assertEquals(listOf(1000L, 0L, 0L), UsageDetail.tokensPerDay(rows, "codex", days))
        assertEquals(listOf(0L, 0L, 0L), UsageDetail.tokensPerDay(rows, "gemini", days))
    }

    @Test
    fun projectTotalsSumTheRangeLargestFirst() {
        val rows = listOf(
            ProjectDay("claude", "api", "2026-09-06", 10),
            ProjectDay("claude", "web", "2026-09-06", 40),
            ProjectDay("claude", "api", "2026-09-07", 60),
            ProjectDay("codex", "docs", "2026-09-07", 900),
        )

        val totals = UsageDetail.projectTotals(rows, "claude")

        assertEquals(listOf("api", "web"), totals.map { it.project })
        assertEquals(listOf(70L, 40L), totals.map { it.tokens })
        assertTrue(UsageDetail.projectTotals(rows, "gemini").isEmpty())
    }

    // MARK: - Formatting

    @Test
    fun fmtTokensClimbsThroughTheSameLadderAsTheWeb() {
        assertEquals("0", UsageDetail.fmtTokens(0))
        assertEquals("870", UsageDetail.fmtTokens(870))
        assertEquals("12K", UsageDetail.fmtTokens(12_000))
        assertEquals("3.4M", UsageDetail.fmtTokens(3_400_000))
        assertEquals("1.2B", UsageDetail.fmtTokens(1_234_000_000))
    }

    @Test
    fun ticksEverySeventhDayAndOnTheLastWhenItWouldNotCollide() {
        val shown = (0..29).filter { UsageDetail.showTick(it, 29) }

        // 29 % 7 == 1, so the last day sits too close to day 28 to earn a tick.
        assertEquals(listOf(0, 7, 14, 21, 28), shown)
        // 31 days: the last day is 3 clear of day 28.
        assertTrue(UsageDetail.showTick(31, 31))
    }

    // MARK: - Wire format

    @Test
    fun usageHistoryDecodesTheServerPayload() {
        val json = """
            {"days":30,
             "history":[{"source":"claude","windowId":"week",
                         "points":[{"at":1788800000000,"usedPct":54}]}],
             "projects":[{"source":"claude","project":"jobsearch",
                          "day":"2026-09-07","tokens":87600000}]}
        """.trimIndent()

        val history = AgStatusJson.decodeFromString<UsageHistory>(json)

        assertEquals(30, history.days)
        assertEquals("week", history.history.single().windowId)
        assertEquals(1788800000000L, history.history.single().points.single().at)
        assertEquals(54.0, history.history.single().points.single().usedPct, 0.0001)
        assertEquals(87_600_000L, history.projects.single().tokens)
        assertEquals("2026-09-07", history.projects.single().day)
    }

    @Test
    fun usageHistoryToleratesAnEmptyOrPartialAnswer() {
        val empty = AgStatusJson.decodeFromString<UsageHistory>("""{"days":7}""")

        assertEquals(7, empty.days)
        assertTrue(empty.history.isEmpty())
        assertTrue(empty.projects.isEmpty())

        val partial = AgStatusJson.decodeFromString<UsageHistory>(
            """{"days":30,"history":[{"source":"codex"}],"projects":[{"source":"codex"}]}"""
        )

        assertTrue(partial.history.single().points.isEmpty())
        assertEquals(0L, partial.projects.single().tokens)
    }

    // MARK: - Demo mode

    @Test
    fun demoHistoryCoversBothAgentsWithAscendingPoints() {
        val demo = DemoData.usageHistory(UsageDetail.DEFAULT_DAYS, noon)
        val days = UsageDetail.dayRange(demo.days, noon)

        assertEquals(setOf("claude", "codex"), demo.history.map { it.source }.toSet())
        assertEquals(setOf("claude", "codex"), demo.projects.map { it.source }.toSet())

        for (series in demo.history) {
            assertTrue(series.points.isNotEmpty())
            assertEquals(series.points.sortedBy { it.at }, series.points)
            assertTrue(series.points.all { it.usedPct in 0.0..100.0 })
            // Every series must land on today, or the chart's last day is blank.
            assertNotNull(UsageDetail.sampleSeries(series.points, days).last())
        }
        for (row in demo.projects) {
            assertTrue(row.day in days)
            assertTrue(row.tokens > 0L)
        }
        assertTrue(UsageDetail.tokensPerDay(demo.projects, "claude", days).sum() > 0L)
        assertTrue(UsageDetail.projectTotals(demo.projects, "codex").isNotEmpty())
    }

    @Test
    fun demoHistoryIsDeterministic() {
        assertEquals(DemoData.usageHistory(30, noon), DemoData.usageHistory(30, noon))
    }
}
