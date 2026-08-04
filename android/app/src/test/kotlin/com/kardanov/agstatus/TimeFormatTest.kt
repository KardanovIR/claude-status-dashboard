package com.kardanov.agstatus

import org.junit.Assert.assertEquals
import org.junit.Test

class TimeFormatTest {

    private val now = 1_700_000_000_000L

    private fun agoSeconds(seconds: Long): String =
        TimeFormat.relative(now - seconds * 1000, now)

    @Test
    fun `same instant reads as just now`() {
        assertEquals("just now", TimeFormat.relative(now, now))
    }

    @Test
    fun `future timestamps clamp to just now`() {
        assertEquals("just now", TimeFormat.relative(now + 90_000, now))
    }

    @Test
    fun `sub-minute stays just now up to 45 seconds`() {
        assertEquals("just now", agoSeconds(44))
    }

    @Test
    fun `45 seconds rounds up to one minute`() {
        assertEquals("1m ago", agoSeconds(45))
        assertEquals("1m ago", agoSeconds(59))
    }

    @Test
    fun `minutes floor within the hour`() {
        assertEquals("1m ago", agoSeconds(60))
        assertEquals("5m ago", agoSeconds(5 * 60))
        assertEquals("59m ago", agoSeconds(3599))
    }

    @Test
    fun `hours start at exactly one hour`() {
        assertEquals("1h ago", agoSeconds(3600))
        assertEquals("3h ago", agoSeconds(3 * 3600 + 59 * 60))
        assertEquals("23h ago", agoSeconds(86_399))
    }

    @Test
    fun `days start at exactly one day`() {
        assertEquals("1d ago", agoSeconds(86_400))
        assertEquals("2d ago", agoSeconds(2 * 86_400 + 3600))
        assertEquals("30d ago", agoSeconds(30 * 86_400))
    }

    @Test
    fun `sub-second remainders truncate rather than round`() {
        assertEquals("just now", TimeFormat.relative(now - 44_999, now))
        assertEquals("1m ago", TimeFormat.relative(now - 45_001, now))
    }
}
