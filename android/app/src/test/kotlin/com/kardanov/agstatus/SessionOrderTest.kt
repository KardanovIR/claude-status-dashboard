package com.kardanov.agstatus

import org.junit.Assert.assertEquals
import org.junit.Test

class SessionOrderTest {

    private fun session(id: String, updatedAt: Long, message: String = "") =
        Session(id = id, message = message, updatedAt = updatedAt)

    private fun ids(sessions: List<Session>) = sessions.map { it.id }

    @Test
    fun `sortedByUpdate orders newest first`() {
        val sorted = SessionStore.sortedByUpdate(
            listOf(session("a", 1), session("b", 3), session("c", 2)),
        )
        assertEquals(listOf("b", "c", "a"), ids(sorted))
    }

    @Test
    fun `stableOrder with nothing on screen is a newest-first sort`() {
        val result = SessionStore.stableOrder(
            current = emptyList(),
            incoming = listOf(session("a", 1), session("b", 3), session("c", 2)),
        )
        assertEquals(listOf("b", "c", "a"), ids(result))
    }

    @Test
    fun `stableOrder keeps on-screen order even when updates invert recency`() {
        val current = listOf(session("a", 3), session("b", 2), session("c", 1))
        val incoming = listOf(session("c", 9), session("b", 8), session("a", 7))
        assertEquals(listOf("a", "b", "c"), ids(SessionStore.stableOrder(current, incoming)))
    }

    @Test
    fun `stableOrder carries fresh data for kept sessions`() {
        val current = listOf(session("a", 1, message = "old"))
        val incoming = listOf(session("a", 5, message = "new"))
        assertEquals("new", SessionStore.stableOrder(current, incoming).single().message)
    }

    @Test
    fun `stableOrder drops sessions absent from incoming`() {
        val current = listOf(session("a", 2), session("b", 1))
        val incoming = listOf(session("b", 3))
        assertEquals(listOf("b"), ids(SessionStore.stableOrder(current, incoming)))
    }

    @Test
    fun `stableOrder puts unseen sessions on top newest first above kept rows`() {
        val current = listOf(session("a", 5), session("b", 4))
        val incoming = listOf(
            session("b", 9),
            session("new1", 6),
            session("a", 8),
            session("new2", 7),
        )
        assertEquals(
            listOf("new2", "new1", "a", "b"),
            ids(SessionStore.stableOrder(current, incoming)),
        )
    }
}
