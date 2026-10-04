# Codex approvals: which escalations actually need you

**Status: fixed in the hook.** Diagnosed 2026-10-05, after being diagnosed and
then lost once already — which is why this file exists. Nothing in the repo
recorded it, so the second investigation started from zero.

## The symptom

Cards went red and pushed notifications for Codex sessions that were not
waiting on anything. The owner's report, twice: *"I get a notification that a
task needs my approve/attention when it actually does not need anything."*

## What was happening

`cli/assets/agstatus-hook.js` mapped Codex's `PermissionRequest` event straight
to `blocked`, which is the board's push trigger:

```js
} else if (event === 'Notification' || event === 'PermissionRequest') {
  // Claude Code fires Notification; Codex fires PermissionRequest before
  // approval prompts. Both mean "a human needs to look at this".
  status = 'blocked';
```

The comment is the bug. Claude Code's `Notification` does mean a human is being
asked. Codex's `PermissionRequest` means **the model asked to escalate** —
whoever ends up answering. Codex answers most of them itself.

Caught live in a project called `perf-ads`: Codex fired `PermissionRequest`,
the hook marked the card `blocked` and fired a push, and Codex continued to
`testing` on its own. No human was ever asked.

## The discriminator

`approvals_reviewer`, in the `turn_context` record Codex writes into its
rollout log. `user` means you; `auto_review` means Codex answered itself.

Counted across `~/.codex/sessions` on the machine this was diagnosed on:

```
$ grep -rhoE '"approvals_reviewer": *"[a-z_]*"' ~/.codex/sessions/ | sort | uniq -c | sort -rn
   1418 "approvals_reviewer":"auto_review"
    679 "approvals_reviewer":"user"
```

**68% of escalations answer themselves.** Roughly two notifications in three
were for nothing.

## Why `approval_policy` is the wrong field

It is the obvious guess — it is the setting a *user* thinks of as "do I get
asked?" — and it is wrong in both directions. Cross-tabulating the same logs:

| `approval_policy` | `approvals_reviewer` | turns |
| --- | --- | ---: |
| `on-request` | `auto_review` | 441 |
| `never` | `user` | 433 |
| `never` | `auto_review` | 396 |

- The captured false alarm was `on-request` + `auto_review`, so a gate on
  `policy !== "never"` would **not have caught it**.
- 433 turns were `never` + `user`, so a gate on `policy === "never"` would have
  **silenced 433 requests a human was genuinely waiting on**.

The second is much the worse failure. A notification that should not have come
is noise; a notification that never comes defeats the product. Note also that
`on-request` + `user` does not appear at all in this data — whatever
`approval_policy` records in `turn_context`, it is not "will a human be asked".

## Three traps in reading the log

Each of these was a wrong answer before it was a right one.

### 1. The rollout file is not named by the payload's `session_id`

Files live at `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<timestamp>-<id>.jsonl`,
and that `<id>` is the **thread id** — `session_meta.payload.id` — not the
`session_id` the hook payload carries. They coincide sometimes and usually do
not:

```
filename id == internal session_id :  45
mismatched                         : 181   (of 226 rollouts)
```

`findCodexRollouts()` had been matching the payload's `session_id` against the
filename, so it found the session's own log about one time in five. The other
four it fell through to its sibling list and got the right file anyway, because
the newest sibling usually *is* the session's own log. That accident is
harmless for account-wide rate limits and useless for anything that has to be
about **this** session — a sibling's `turn_context` belongs to a different
conversation, and reading `auto_review` out of one would silence a real
request.

**The payload carries `transcript_path`.** Use it. The hook now does, for the
approval check and for the usage path, which had the same latent bug.

### 2. `turn_context` is written once, at the start of a turn

Not appended per event. The record sequence at the top of a turn:

```
  4  21:44:16  event_msg      task_started      turn=01a108df…
  8  21:44:17  turn_context                     turn=01a108df…  reviewer=auto_review
```

Two consequences:

- It is **already on disk** when a mid-turn `PermissionRequest` fires. That is
  what makes this readable at all.
- Taking the last record in the file is wrong once a turn has ended: the next
  turn writes its own. In the captured case the context sitting at the end of
  the log was stamped **73 seconds later** and belonged to a different turn.

The payload carries `turn_id`; match on it. Where it is absent the hook falls
back to the newest record, which is correct while a turn is in flight — and
that fallback is commented as the approximation it is.

- It can also be **far from the end**. Unlike `rate_limits`, which is appended
  after every turn, a turn with many tool calls buries its context: measured
  across these rollouts the last one sits a median of 94 KB from EOF and as far
  as **1.37 MB**. The 1 MB tail used for rate limits would have missed it, so
  the reader widens — 256 KB, then 1 MB, then 4 MB — and stops at the first
  record it finds.

### 3. Unknown has to mean `blocked`

If the log is missing, unattributable, or has no `turn_context`, the hook
reports `blocked` exactly as before. Only a positive `auto_review` suppresses
anything. Every uncertainty resolves towards telling you.

## What the fix changed

`cli/assets/agstatus-hook.js` (and its synced copy at
`plugin/scripts/agstatus-hook.js`):

- `Notification` and `PermissionRequest` are separate branches; the shared one
  carried the false premise in its comment.
- `codexApprovalReviewer()` reads `approvals_reviewer` from the session's own
  rollout log, found by `transcript_path` and matched by `turn_id`.
- An auto-approved escalation posts **no status at all**. It is not a state
  change, so the card keeps what it had. The usage and per-project reports still
  run — the event is a fine moment to refresh the bars.
- A genuinely blocked card now shows `tool_input.description`, the model's own
  written-out question ("May I run the readiness tests in a fresh disposable
  PostgreSQL cluster?"), which was already on stdin and beats "Needs approval".
  `--minimal` still collapses it to the generic label.

Covered by `cli/test/codex-approval.test.ts`, including a case for each of the
441 and 433 rows above so the `approval_policy` gate cannot be reintroduced.

## If you need to re-measure

```bash
# the auto/human split
grep -rhoE '"approvals_reviewer": *"[a-z_]*"' ~/.codex/sessions/ | sort | uniq -c | sort -rn

# the cross-tab that rules out approval_policy
python3 - <<'EOF'
import json, glob, collections
pairs = collections.Counter()
for f in glob.glob('~/.codex/sessions/**/rollout-*.jsonl', recursive=True):
    for line in open(f, errors='ignore'):
        if 'approvals_reviewer' not in line: continue
        try: tc = json.loads(line).get('payload', {})
        except Exception: continue
        if isinstance(tc, dict) and 'approvals_reviewer' in tc:
            pairs[(tc.get('approval_policy'), tc.get('approvals_reviewer'))] += 1
for k, n in pairs.most_common(): print(n, k)
EOF
```
