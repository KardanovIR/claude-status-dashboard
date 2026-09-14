package com.kardanov.agstatus

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The Focus copy is shared word for word with the web board (public/app.js)
 * and the iOS app, so it is pinned here rather than left to the composables.
 */
class FocusCopyTest {

    private val macId = "9f2c".padEnd(32, '0')
    private val pcId = "7c2e".padEnd(32, '1')
    private val strangerId = "abcd".padEnd(32, '2')

    /** When the tap happened, in epoch milliseconds. */
    private val TAP_AT = 1_752_096_000_000L

    private fun host(id: String = macId, name: String = "MacBook", app: String = "agterm") =
        SessionHost(HostMachine(id = id, name = name), HostApp(slug = app, name = app, kind = "terminal"))

    private fun online(id: String, name: String) =
        MachinePresence(id = id, name = name, online = true, since = 1_000L)

    private fun status(type: CommandType = CommandType.FOCUS) =
        FocusStatus(commandId = "cmd", type = type, machineName = "MacBook", appName = "agterm", startedAt = TAP_AT)

    private fun ack(result: String?, reason: String? = null) =
        CommandAck(id = "cmd", sessionId = "s", machineId = macId, type = "focus", result = result, reason = reason)

    // MARK: - Labels

    @Test
    fun `label prefers the listener's name over the hook's`() {
        val machines = mapOf(macId to online(macId, "Studio"))

        assertEquals("Studio", FocusCopy.machineLabel(host(name = "MacBook"), machines))
        assertEquals("MacBook", FocusCopy.machineLabel(host(name = "MacBook"), emptyMap()))
        assertEquals("Machine", FocusCopy.machineLabel(host(name = ""), emptyMap()))
    }

    @Test
    fun `label appends the id's last four hex when two online machines share a name`() {
        val machines = mapOf(macId to online(macId, "Mac"), pcId to online(pcId, "Mac"))

        assertEquals("Mac (0000)", FocusCopy.machineLabel(host(id = macId, name = "Mac"), machines))
        assertEquals("Mac (1111)", FocusCopy.machineLabel(host(id = pcId, name = "Mac"), machines))
    }

    @Test
    fun `an offline namesake does not force the suffix`() {
        val machines = mapOf(
            macId to online(macId, "Mac"),
            pcId to MachinePresence(id = pcId, name = "Mac", online = false, lastSeen = 5L),
        )

        assertEquals("Mac", FocusCopy.machineLabel(host(id = macId, name = "Mac"), machines))
    }

    @Test
    fun `online is exactly a present listener that says so`() {
        assertTrue(FocusCopy.isOnline(host(), mapOf(macId to online(macId, "MacBook"))))
        assertFalse(FocusCopy.isOnline(host(), emptyMap()))
        assertFalse(
            FocusCopy.isOnline(
                host(),
                mapOf(macId to MachinePresence(id = macId, name = "MacBook", online = false, lastSeen = 1L)),
            ),
        )
    }

    @Test
    fun `offline note says since when, or what is missing`() {
        val now = 10 * 60_000L
        val quiet = mapOf(macId to MachinePresence(id = macId, name = "MacBook", online = false, lastSeen = 5 * 60_000L))
        val mute = mapOf(macId to MachinePresence(id = macId, name = "MacBook", online = false))

        assertEquals("MacBook is offline (5m ago)", FocusCopy.offlineNote(host(), "MacBook", quiet, now))
        assertEquals("MacBook is offline", FocusCopy.offlineNote(host(), "MacBook", mute, now))
        assertEquals(
            "MacBook is offline — needs the AgStatus listener on that machine",
            FocusCopy.offlineNote(host(id = strangerId), "MacBook", quiet, now),
        )
    }

    // MARK: - Sending

    @Test
    fun `send copy`() {
        assertEquals("Sending…", FocusCopy.SENDING)
        assertEquals("Sent…", FocusCopy.sent("MacBook", delivered = true))
        assertEquals("Sent — MacBook is not connected", FocusCopy.sent("MacBook", delivered = false))
        assertEquals("No answer from MacBook — is it asleep?", FocusCopy.noAnswer("MacBook"))
    }

    @Test
    fun `the answer window counts from the tap, not from a reconnect`() {
        val timeout = 15_000L

        assertEquals(15_000L, status().ackWindowLeft(nowMillis = TAP_AT, timeoutMillis = timeout))
        assertEquals(5_000L, status().ackWindowLeft(nowMillis = TAP_AT + 10_000L, timeoutMillis = timeout))
        assertEquals(0L, status().ackWindowLeft(nowMillis = TAP_AT + 15_000L, timeoutMillis = timeout))
        assertEquals(-1_000L, status().ackWindowLeft(nowMillis = TAP_AT + 16_000L, timeoutMillis = timeout))
    }

    @Test
    fun `send failures map HTTP statuses onto the web board's copy`() {
        assertEquals("Couldn't reach the board", FocusCopy.sendFailed(0))
        assertEquals("Not allowed — this board needs the webhook secret", FocusCopy.sendFailed(401))
        assertEquals("Session gone", FocusCopy.sendFailed(404))
        assertEquals("No machine info for this session", FocusCopy.sendFailed(409))
        assertEquals("Too many taps — wait a moment", FocusCopy.sendFailed(429))
        assertEquals("Couldn't send (HTTP 503)", FocusCopy.sendFailed(503))
    }

    // MARK: - Acks

    @Test
    fun `successful results read by reach`() {
        assertEquals(
            FocusCopy.Outcome(FocusStatus.Phase.OK, "Brought to front on MacBook"),
            FocusCopy.outcome(status(), ack("focused")),
        )
        assertEquals(
            FocusCopy.Outcome(FocusStatus.Phase.OK, "Opened agterm on MacBook — couldn't find the exact window"),
            FocusCopy.outcome(status(), ack("activated")),
        )
        assertEquals(
            FocusCopy.Outcome(FocusStatus.Phase.OK, "Selected the pane on MacBook; the window stayed behind"),
            FocusCopy.outcome(status(), ack("selected")),
        )
        assertEquals(
            FocusCopy.Outcome(FocusStatus.Phase.OK, "Resumed on MacBook"),
            FocusCopy.outcome(status(CommandType.RESUME), ack("resumed")),
        )
    }

    @Test
    fun `not running offers Resume`() {
        assertEquals(
            FocusCopy.Outcome(FocusStatus.Phase.FAIL, "Not running on MacBook", offersResume = true),
            FocusCopy.outcome(status(), ack("failed", "not-running")),
        )
    }

    @Test
    fun `expired and superseded`() {
        assertEquals(
            FocusCopy.Outcome(FocusStatus.Phase.FAIL, "No answer from MacBook — is it asleep?"),
            FocusCopy.outcome(status(), ack("failed", "expired")),
        )
        assertEquals(
            FocusCopy.Outcome(FocusStatus.Phase.OK, "Replaced by a newer tap"),
            FocusCopy.outcome(status(), ack("failed", "superseded")),
        )
    }

    @Test
    fun `unsupported type only has special copy for Resume`() {
        assertEquals(
            FocusCopy.Outcome(FocusStatus.Phase.FAIL, "Resume isn't available yet"),
            FocusCopy.outcome(status(CommandType.RESUME), ack("failed", "unsupported-type")),
        )
        assertEquals(
            FocusCopy.Outcome(FocusStatus.Phase.FAIL, "Couldn't bring it to front (unsupported-type)"),
            FocusCopy.outcome(status(CommandType.FOCUS), ack("failed", "unsupported-type")),
        )
    }

    @Test
    fun `other failures quote the reason, even one this app predates`() {
        assertEquals(
            FocusCopy.Outcome(FocusStatus.Phase.FAIL, "Couldn't bring it to front (consent-needed)"),
            FocusCopy.outcome(status(), ack("failed", "consent-needed")),
        )
        assertEquals(
            FocusCopy.Outcome(FocusStatus.Phase.FAIL, "Couldn't bring it to front (gremlins)"),
            FocusCopy.outcome(status(), ack("failed", "gremlins")),
        )
        assertEquals(
            FocusCopy.Outcome(FocusStatus.Phase.FAIL, "Couldn't bring it to front (levitated)"),
            FocusCopy.outcome(status(), ack("levitated")),
        )
        assertEquals(
            FocusCopy.Outcome(FocusStatus.Phase.FAIL, "Couldn't bring it to front (unknown)"),
            FocusCopy.outcome(status(), ack(null)),
        )
    }
}
