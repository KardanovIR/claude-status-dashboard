# Gamification: streaks, and the idea of minimising blocked time

**Status: proposal, nothing built.** Written 2026-09-18 in response to: *"I want
to have streaks, maybe also gamification/visualisation to minimize idle/blocked
time."*

## The short answer

Two requests arrived together and they have opposite answers.

**A streak is buildable, cheaply, and mostly harmless — if it counts days you
were active and ships its rest days on day one.** Ninety days of day-keyed token
spend already exist in `usage_project_days`, so "which UTC days had any activity"
needs no new table.

**A score for minimising blocked time should not be built at all.** `blocked`
means an agent stopped to ask a human for permission. The cheapest way to win
that game is to approve without reading, which is the single outcome this
product cannot survive. That isn't a hunch about our users; it is the documented
failure mode of every response-latency metric that has been shipped, and the
tooling in that category now ships the workaround *as a feature*.

The useful half of the second request survives intact, though: **make waiting
visible without making it a number that goes up.**

---

## Part 1 — What our data can actually support

Design first, storage second is the wrong order here, because the storage
answers most of the design questions before they are asked.

### There is no user

Identity is `bearer token → workspace → sessions`. `workspace.id` is
`sha256(token)`; there is no account, no login, no person. A board tolerates up
to 10 SSE viewers and 10 push devices simultaneously and cannot tell them apart.

**Consequence.** A streak can only belong to *the board*. Anyone who pairs a
phone inherits it; anyone who loses the token loses it permanently; and on a
shared board it is the team's streak whether or not that is what anyone wanted.
If the streak is meant to be a *person's*, that person has to be invented first
— which is a much larger change than the streak itself.

### Blocked time is not recoverable after the fact

- Status transitions **are** recorded, with timestamps, in `session_events`.
- They are capped at 100 per session.
- They are dropped when the session is dropped — dismiss, cap eviction, or the
  24-hour TTL.
- The only query is per session: `GET /api/sessions/:id/history`. There is no
  cross-session or cross-time query anywhere.

So `nextEvent.at − blockedEvent.at` is computable **today, for a session still on
the board**, and is gone forever a day later. Nothing can reconstruct it — the
rows are soft-deleted and no code path can read them again.

**Consequence.** "You unblocked 12 agents this week" cannot be computed
retroactively, ever. It would have to be computed *at transition time*, inside
`upsertSession`, where both the previous status and the previous timestamp are
already in hand, and written to a durable aggregate that does not yet exist.

### We cannot tell a human apart from an agent that moved on

This one I checked myself in `cli/assets/agstatus-hook.js` and `docs/hooks.md`,
because the whole idea rests on it:

| Event | Status | Is it a human? |
| --- | --- | --- |
| `Notification` / `PermissionRequest` | `blocked` | no — the agent is asking |
| `UserPromptSubmit` | `planning` | **yes, unambiguously** |
| `PreToolUse` | `coding` / `testing` / `planning` | no |
| `Stop` | `done` | no |

**There is no hook event for "the user approved a permission prompt."** When you
click approve, the next thing the board hears is the *next* `PreToolUse` — which
is indistinguishable from an agent that was never blocked. And `UserPromptSubmit`
reaches the server as `status: 'planning'` with its provenance discarded at the
wire.

**Consequence.** A naive "response time" metric would silently count agents that
unblocked themselves, and would time the agent's next tool call rather than the
human's decision. Measuring this properly requires a new flag on the webhook,
not just new arithmetic.

### What is already durable

| Series | Window | Day-keyed | Usable for a streak? |
| --- | --- | --- | --- |
| `usage_project_days` | 90 days | yes (UTC) | **yes, today, no schema change** |
| `usage_history` (limits) | 90 days | no | no |
| `usage_session_totals` | 7 days | no | no |
| `session_events` | dies with session (~24h) | no | no |
| commands (focus/resume taps) | memory only, ≤12 min | no | no |

Two traps in that first row. Every day key in the system is **UTC**, and no
timezone is stored for anyone — a streak shown in local time will break or
double-count at UTC midnight for most of the world. And a workspace is deleted
after **60 days idle**, while project-days load for 90, so a "365-day streak"
cannot outlive numbers we currently enforce.

---

## Part 2 — What the evidence says

Sources were gathered in a dedicated research pass and are cited below. **I have
not opened these URLs myself**; where that pass flagged a source as weak,
secondary or unverified, it is marked here too. The three findings I'd actually
stake the design on are the ones with primary sources.

### Streaks: the wins belong to the forgiveness, not the counter

Every *published* Duolingo streak result is a result for the mechanism that
protects the streak, not the streak itself — the Streak Wager (+14% D7
retention) and the Weekend Amulet (+4% return, −5% streak loss). Duolingo's own
conclusion: *"by giving learners the option to take a break, they're actually
more likely to do more in the long run."* Apple shipped Activity rings in 2015
and only added pausing "for a day, week, month, or more — without affecting
their award streak" in 2024. Nine years of unforgiving streaks before the
correction.

### GitHub already ran this experiment, on our exact users

This is the strongest evidence in the whole file, and it is about developers.

GitHub removed its contribution streak counters in May 2016, after an issue
arguing they *"motivate me to work in my weekends as well, and not take
breaks."* Moldon, Strohmaier & Wachs (arXiv 2006.02371, 2020) measured the
natural experiment:

- Long streaks (≥14 days) were **more than twice as likely to exceed 100 days**
  before removal than after (4.4% vs 2.0%).
- **Weekend contributions fell 0.28–0.34pp** among developers with 20+ and 30+
  day streaks (p < .001) once the counters were gone.
- **Over 40% of days in 60+ day streaks had exactly one contribution** — the
  minimum that kept the number alive.

Their conclusion: *"gamification can steer the behavior of software developers
in unexpected and unwanted directions."*

The green-square calendar heatmap is, separately, our owner's own named
anti-reference and the weakest perceptual encoding available.

### Rewards corrode motivation that was already there

Deci, Koestner & Ryan (1999), 128 experiments: engagement-contingent rewards
**d = −0.40** on free-choice intrinsic motivation, completion-contingent −0.36,
performance-contingent −0.28. Verbal praise and informational feedback go the
other way, **+0.33**.

Unblocking your own agent is already intrinsically motivated — you want your
work to proceed. That places it squarely in the zone where undermining is
strongest, and in the exact reward shape (expected, salient, contingent on an
action you already want to take) that produces the most negative effect.
Informational feedback — *"this one has been waiting 40 minutes"* — is the
format the evidence supports. A score you can lose is the format it warns
against.

### Latency metrics are gamed, and the vendors ship the workaround

- incident.io: *"acknowledgment can be gamed. A responder who taps the
  acknowledge button from their lock screen without actively engaging produces
  an excellent MTTA figure while the incident continues unaddressed."*
- Zendesk's docs: reply-time metrics *"are fulfilled if you set up a trigger to
  autoreply with a public comment."* Freshdesk documents the equivalent webhook.
- Beck & Orosz's rule from the Uber and Facebook cases: *"The earlier in the
  cycle you measure, the easier it is to measure. And also the more likely that
  you introduce unintended consequences."* Acknowledgement latency is the
  earliest, most gameable point in the cycle.

### RescueTime is the precedent worth copying

It ships the measurement and publicly refuses the target, in the product:
*"the productivity score doesn't tell you anything about what you actually
produce… Don't think of it as a judgement… Downtime is good and healthy. No one
should be expected to be 100% productive all the time."*

---

## Part 3 — The central risk, stated precisely

If we reward shrinking blocked time, the fastest way to win is to approve
without reading.

**What is well established** (30 years, four independent domains):

- People click through approval prompts at scale already, with no speed
  incentive at all — Chrome SSL warnings at **70.2%** click-through (Akhawe &
  Felt, USENIX Security 2013).
- Repetition habituates the brain to the prompt *neurally* — visual-processing
  activity *"decreases precipitously with repeated exposures"*, and a warning
  that **changes its appearance resists this** (Anderson et al., JMIS 2016).
- Automation complacency appears first as **reduced verification sampling**,
  before any error is visible; it occurs specifically **under multi-task load**
  — which is precisely our product's premise, several agents at once — and
  **cannot be trained away** (Parasuraman & Manzey, *Human Factors* 2010).
- Review quality degrades measurably with speed in software specifically
  (SmartBear/Cisco: defect density drops above 500 LOC/hour).

**What is not established, and I won't overclaim:** no study measures whether
adding a latency reward specifically increases *wrong* approvals in an agent
workflow. That research does not exist. One adjacent experiment (Rosbach et al.
2024, pathology) even found time pressure *weakened* AI-induced confirmation
bias — a single small study in another domain, pointing the other way.

**The best-supported countermeasure is the interesting part:** Skitka et al.
found that making people **accountable for decision accuracy** reduced
automation bias. Not speed. Accuracy. If we ever gamify anything here, that is
the variable with evidence behind it.

---

## Part 4 — What I'd build, in order

### 1. Age-in-state on the card — a diagnostic, not a score

The triage question is already the product's stated purpose: *does anything need
me?* The missing fact is **how long has this one been waiting**, and it needs no
storage at all — `updatedAt` is on every card.

Show the wait on `blocked` and `done` cards, and let the card **change form** as
it ages rather than merely deepening in colour. That is the same finding from
two directions: Anderson et al. say a prompt that changes resists habituation
while a static one becomes *"literal wallpaper"*; ProKanban call an
age-coloured aging-WIP board *"a smoke alarm: you can see which items are
quietly getting stuck."* It also fits the existing design principles — state
carried by shape, position and weight rather than hue alone, motion reserved for
genuine news.

Cost: a view change. No schema, no endpoint, no retention question.

### 2. A days-active streak, with rest days from the first commit

Buildable today on `usage_project_days` — *"which UTC days in the last 90 had
any token spend"* — with no new table.

Non-negotiable, on the evidence:

- **Rest days ship in v1, not v2.** Apple took nine years to learn this and
  Duolingo's only published wins are the forgiveness mechanisms. A streak
  without a freeze is the version GitHub deleted.
- **It counts days you were active. Never a latency, never a response time.**
- **Ceiling of 90 days**, because that is what the data supports — do not
  display a number the storage cannot back.
- Decide UTC-vs-local explicitly and write it down; today everything is UTC and
  nobody's timezone is stored.
- Be honest in the UI that it belongs to *the board*, not to a person.

### 3. If any aggregate waiting time is ever shown, show the worst case

The VOID (~2,000 incidents, 660 organisations) found durations positively skewed
with **no correlation between duration and severity**, so a mean is unreliable
by construction. A mean blocked-time would hide the one session that has been
stuck for three hours — the only one that mattered.

---

## Part 5 — What I'd refuse to build

- **A blocked-time score, streak, or leaderboard.** Part 3.
- **A contribution-graph calendar heatmap.** Weakest perceptual encoding
  (~8% of men have a colour-vision deficiency), and the owner's own
  anti-reference.
- **Any cross-user comparison.** There are no users to compare, and on a shared
  board it would rank teammates by a number that measures being at the desk.
- **Per-session "time to respond" on the card**, until the hook can distinguish
  a human approval from an agent proceeding. Today it cannot, and a number that
  is quietly wrong is worse than no number.

---

## Open questions

1. Does a streak belong to a board, or do we invent a user? Everything about
   ownership follows from this and nothing else can be decided first.
2. Is a 90-day ceiling acceptable, or do the retention windows move?
3. Should the hook mark `UserPromptSubmit`-driven transitions as
   human-originated on the wire? It is the one change that would make
   responsiveness genuinely measurable — and it is worth deciding *whether we
   want it measurable* before making it so.
