package com.kardanov.agstatus

/**
 * Focus: an explicit control on a card brings the session's terminal to the
 * front on the machine running it (docs/design/focus-protocol.md §7,
 * docs/api.md "Focus commands"). This file holds what one card is saying
 * about its latest command, and the copy — kept out of the composables so it
 * can be tested and stays identical to the web board's (public/app.js).
 */

// MARK: - FocusStatus

/**
 * One card's latest Focus command: the id its ack has to match, and the
 * copy on screen. Only the current command is honoured — an ack for an older
 * one a re-tap replaced has nothing to say to the viewer.
 */
data class FocusStatus(
    val commandId: String,
    val type: CommandType,
    /** The label the copy was minted with, so a rename mid-flight keeps the sentence whole. */
    val machineName: String,
    val appName: String,
    /** Epoch milliseconds of the tap; the answer window counts from here, not from any reconnect. */
    val startedAt: Long,
    val phase: Phase = Phase.PENDING,
    val text: String = FocusCopy.SENDING,
    /** After `failed / not-running`: offer a Resume control. */
    val offersResume: Boolean = false,
    /**
     * Set on the outcomes this side *guessed* — a deadline we called, or a POST
     * whose answer was lost — as opposed to one the machine or the server
     * actually reported. A later ack still overrides a guess; nothing overrides
     * an answer. Matches `inferred` on the web board (public/app.js) and
     * `provisional` on iOS (SessionStore.swift).
     */
    val provisional: Boolean = false,
) {
    /** Pending until the ack (or the watchdog); successes fade, failures stay until the next tap. */
    enum class Phase { PENDING, OK, FAIL }

    val done: Boolean get() = phase != Phase.PENDING

    /** Still worth an ack: either nothing has landed yet, or what landed was a guess. */
    val awaitsAck: Boolean get() = !done || provisional

    /**
     * What is left, at [nowMillis], of a [timeoutMillis] answer window that
     * opened at the tap — zero or less once it has run out.
     */
    fun ackWindowLeft(nowMillis: Long, timeoutMillis: Long): Long = timeoutMillis - (nowMillis - startedAt)
}

// MARK: - FocusCopy

object FocusCopy {

    const val SENDING = "Sending…"

    /** The final outcome an ack reads as. */
    data class Outcome(
        val phase: FocusStatus.Phase,
        val text: String,
        val offersResume: Boolean = false,
    )

    /** Whether the session's machine has a listener connected right now. */
    fun isOnline(host: SessionHost, machines: Map<String, MachinePresence>): Boolean =
        machines[host.machine.id]?.online == true

    /**
     * The listener's label (falling back to the hook's), plus the id's last
     * four hex when two online machines share it — the default names ("Mac",
     * "PC") make that likely.
     */
    fun machineLabel(host: SessionHost, machines: Map<String, MachinePresence>): String {
        val name = machines[host.machine.id]?.name?.ifBlank { null } ?: host.machine.displayName
        val same = machines.values.count { it.online && it.name == name }
        return if (same > 1) "$name (${host.machine.id.takeLast(4)})" else name
    }

    /**
     * Why the control is disabled. A machine the board has never seen gets
     * the hint about the listener; one that went quiet gets when.
     */
    fun offlineNote(
        host: SessionHost,
        name: String,
        machines: Map<String, MachinePresence>,
        nowMillis: Long,
    ): String {
        val presence = machines[host.machine.id]
            ?: return "$name is offline — needs the AgStatus listener on that machine"
        val lastSeen = presence.lastSeen ?: return "$name is offline"
        return "$name is offline (${TimeFormat.relative(lastSeen, nowMillis)})"
    }

    fun sent(name: String, delivered: Boolean): String =
        if (delivered) "Sent…" else "Sent — $name is not connected"

    /** No ack within the watchdog, or the server's own `expired`. */
    fun noAnswer(name: String): String = "No answer from $name — is it asleep?"

    /** The POST itself failed: [status] is the HTTP code, or 0 when nothing answered. */
    fun sendFailed(status: Int): String = when (status) {
        0 -> "Couldn't reach the board"
        401 -> "Not allowed — this board needs the webhook secret"
        404 -> "Session gone"
        409 -> "No machine info for this session"
        429 -> "Too many taps — wait a moment"
        else -> "Couldn't send (HTTP $status)"
    }

    /** What [ack] means for [status] — the same ladder as the web board's handleAck. */
    fun outcome(status: FocusStatus, ack: CommandAck): Outcome {
        val name = status.machineName
        when (CommandResult.fromWire(ack.result)) {
            CommandResult.FOCUSED -> return ok("Brought to front on $name")
            CommandResult.ACTIVATED ->
                return ok("Opened ${status.appName} on $name — couldn't find the exact window")
            CommandResult.SELECTED -> return ok("Selected the pane on $name; the window stayed behind")
            CommandResult.RESUMED -> return ok("Resumed on $name")
            CommandResult.FAILED, null -> Unit
        }
        when (CommandReason.fromWire(ack.reason)) {
            CommandReason.SUPERSEDED -> return ok("Replaced by a newer tap")
            CommandReason.NOT_RUNNING -> return fail("Not running on $name", offersResume = true)
            CommandReason.EXPIRED -> return fail(noAnswer(name))
            CommandReason.UNSUPPORTED_TYPE ->
                if (status.type == CommandType.RESUME) return fail("Resume isn't available yet")
            else -> Unit
        }
        val detail = ack.reason?.ifBlank { null } ?: ack.result?.ifBlank { null } ?: "unknown"
        return fail("Couldn't bring it to front ($detail)")
    }

    private fun ok(text: String) = Outcome(FocusStatus.Phase.OK, text)

    private fun fail(text: String, offersResume: Boolean = false) =
        Outcome(FocusStatus.Phase.FAIL, text, offersResume)
}
