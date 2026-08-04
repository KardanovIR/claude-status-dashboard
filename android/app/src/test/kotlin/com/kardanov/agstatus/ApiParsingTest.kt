package com.kardanov.agstatus

import kotlinx.serialization.decodeFromString
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Wire-format tests for the decoder the REST and SSE clients share. The point
 * is tolerance: a board must survive an older or newer server, not crash on it.
 */
class ApiParsingTest {

    // MARK: - Session

    @Test
    fun sessionDecodesFromIdAlone() {
        val session = AgStatusJson.decodeFromString<Session>("""{"id":"sess-1"}""")

        assertEquals("sess-1", session.id)
        assertEquals("", session.name)
        assertEquals(AgentStatus.IDLE, session.status)
        assertEquals("", session.message)
        assertEquals("", session.project)
        assertEquals("claude", session.source)
        assertEquals(0L, session.createdAt)
        assertEquals(0L, session.updatedAt)
        assertEquals("sess-1", session.displayName)
    }

    @Test
    fun sessionDecodesEveryField() {
        val json = """
            {"id":"sess-abc","name":"Refactor auth","status":"coding",
             "message":"Editing server.ts","project":"my-repo","source":"codex",
             "createdAt":1752096000000,"updatedAt":1752096030000}
        """.trimIndent()

        val session = AgStatusJson.decodeFromString<Session>(json)

        assertEquals("Refactor auth", session.displayName)
        assertEquals(AgentStatus.CODING, session.status)
        assertTrue(session.status.isActive)
        assertEquals("codex", session.source)
        assertEquals(1752096030000L, session.updatedAt)
    }

    @Test
    fun unknownStatusDegradesToIdle() {
        val session = AgStatusJson.decodeFromString<Session>("""{"id":"s","status":"vibing"}""")

        assertEquals(AgentStatus.IDLE, session.status)
    }

    @Test
    fun unknownKeysAreIgnored() {
        val json = """
            {"id":"s","status":"blocked","priority":"high",
             "labels":["a","b"],"nested":{"deep":{"deeper":1}}}
        """.trimIndent()

        val session = AgStatusJson.decodeFromString<Session>(json)

        assertEquals(AgentStatus.BLOCKED, session.status)
    }

    @Test
    fun sessionListDecodes() {
        val json = """[{"id":"a","status":"done"},{"id":"b","status":"testing"}]"""

        val sessions = AgStatusJson.decodeFromString<List<Session>>(json)

        assertEquals(listOf("a", "b"), sessions.map { it.id })
        assertEquals(AgentStatus.DONE, sessions[0].status)
        assertEquals(AgentStatus.TESTING, sessions[1].status)
    }

    // MARK: - Usage

    @Test
    fun usageWindowClampsOutOfRangePercentages() {
        val windows = AgStatusJson.decodeFromString<List<UsageWindow>>(
            """[{"id":"a","usedPct":142.5},{"id":"b","usedPct":-20},{"id":"c","usedPct":42}]"""
        )

        assertEquals(1.0f, windows[0].fraction, 0.0001f)
        assertEquals(0.0f, windows[1].fraction, 0.0001f)
        assertEquals(0.42f, windows[2].fraction, 0.0001f)
    }

    @Test
    fun usageWindowFallsBackToItsId() {
        val window = AgStatusJson.decodeFromString<UsageWindow>("""{"id":"week"}""")

        assertEquals("week", window.displayLabel)
        assertEquals(0.0f, window.fraction, 0.0001f)
        assertNull(window.resetsAt)
    }

    @Test
    fun usageInfoDecodesWindowsAndNamesSources() {
        val json = """
            [{"source":"claude","updatedAt":1752096030000,"windows":[
                {"id":"session","label":"Current session","usedPct":42,"resetsAt":1752100000000},
                {"id":"week","label":"Weekly (all models)","usedPct":61.5,"resetsAt":null}]},
             {"source":"codex","windows":[]},
             {"source":"gemini"}]
        """.trimIndent()

        val usage = AgStatusJson.decodeFromString<List<UsageInfo>>(json)

        assertEquals("Claude", usage[0].displayName)
        assertEquals(2, usage[0].windows.size)
        assertEquals("Current session", usage[0].windows[0].displayLabel)
        assertEquals(1752100000000L, usage[0].windows[0].resetsAt)
        assertEquals(0.615f, usage[0].windows[1].fraction, 0.0001f)
        assertNull(usage[0].windows[1].resetsAt)
        assertEquals("Codex", usage[1].displayName)
        assertEquals("Gemini", usage[2].displayName)
        assertEquals(emptyList<UsageWindow>(), usage[2].windows)
    }

    // MARK: - History

    @Test
    fun historyDecodesTimeline() {
        val json = """
            [{"seq":2,"status":"testing","message":"npm test","at":1752096030000},
             {"seq":1,"status":"coding","message":"Editing server.ts","at":1752096010000},
             {"seq":0,"status":"idle","message":"Session started","at":1752096000000}]
        """.trimIndent()

        val history = AgStatusJson.decodeFromString<List<HistoryEvent>>(json)

        assertEquals(listOf(2L, 1L, 0L), history.map { it.seq })
        assertEquals(AgentStatus.TESTING, history[0].status)
        assertEquals("npm test", history[0].message)
        assertEquals(1752096000000L, history[2].at)
    }

    @Test
    fun historyEventToleratesMissingFields() {
        val event = AgStatusJson.decodeFromString<HistoryEvent>("""{"seq":7,"status":"soaring"}""")

        assertEquals(7L, event.seq)
        assertEquals(AgentStatus.IDLE, event.status)
        assertEquals("", event.message)
        assertEquals(0L, event.at)
    }

    // MARK: - Board.parse

    @Test
    fun parsesWorkspaceUrl() {
        val board = Board.parse("https://agstatus.online/w/$TOKEN")

        assertEquals("https://agstatus.online", board?.baseUrl)
        assertEquals(TOKEN, board?.token)
        assertEquals("https://agstatus.online/w/$TOKEN", board?.boardUrl)
        assertEquals("https://agstatus.online/w/$TOKEN/webhook", board?.webhookUrl)
        assertTrue(board!!.isDefaultServer)
    }

    @Test
    fun parsesWorkspaceUrlWithTrailingSlashOrWebhookSuffix() {
        val expected = Board("https://agstatus.online", TOKEN)

        assertEquals(expected, Board.parse("https://agstatus.online/w/$TOKEN/"))
        assertEquals(expected, Board.parse("https://agstatus.online/w/$TOKEN/webhook"))
        assertEquals(expected, Board.parse("https://agstatus.online/w/$TOKEN/webhook/"))
        assertEquals(expected, Board.parse("  https://agstatus.online/w/$TOKEN  "))
    }

    @Test
    fun parsesLegacyOrigins() {
        assertEquals(Board("https://board.example.com", null), Board.parse("https://board.example.com"))
        assertEquals(Board("https://board.example.com", null), Board.parse("https://board.example.com/"))
        assertEquals(Board("https://board.example.com", null), Board.parse("https://board.example.com/webhook"))
        assertEquals(Board("http://192.168.1.10:8080", null), Board.parse("http://192.168.1.10:8080/"))
    }

    @Test
    fun legacyBoardServesItselfAsTheBoard() {
        val board = Board.parse("http://agstatus.local:4000")!!

        assertNull(board.token)
        assertEquals("http://agstatus.local:4000", board.boardUrl)
        assertEquals("http://agstatus.local:4000/webhook", board.webhookUrl)
        assertFalse(board.isDefaultServer)
    }

    @Test
    fun rejectsUrlsThatArentBoards() {
        val rejected = listOf(
            "agstatus.online/w/$TOKEN",              // no scheme
            "ftp://agstatus.online/w/$TOKEN",        // wrong scheme
            "https://",                              // no host
            "https:///w/$TOKEN",                     // no host
            "https://agstatus.online/w/ags_short",   // token too short
            "https://agstatus.online/w/$TOKEN!",     // token has an illegal character
            "https://agstatus.online/x/$TOKEN",      // wrong path prefix
            "https://agstatus.online/w/$TOKEN/extra",
            "https://agstatus.online/dashboard",
            "",
        )

        rejected.forEach { assertNull("expected null for $it", Board.parse(it)) }
    }

    private companion object {
        // Built rather than written out, matching the server tests: a literal
        // 32-character token has enough entropy to trip secret scanners.
        val TOKEN = "ags_" + "a".repeat(32)
    }
}
