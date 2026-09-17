# AgStatus

Live status board for coding agents: Claude Code and Codex sessions report to a
board (web, iOS, Android) so you can see what each agent is doing, when one needs
approval, and — since 1.4 — tap a session to bring its terminal to the front on the
machine running it.

Engineering conventions live in the code's own comments and in `docs/design/`.
The section below governs anything visual.

## Design Context

## Users

One developer, or a small team, running several Claude Code and Codex sessions at
once across their machines. They are not *reading* this board; they are **checking**
it. Three contexts, confirmed by the owner:

- **Phone, glancing.** Away from the desk. Seconds at a time, one thumb. "Does
  anything need me?"
- **Second monitor, ambient.** Open all day beside the editor, read peripherally.
  A change has to be noticeable without being looked at directly.
- **Late night, dark room.** Long sessions after hours, tired eyes. Glare is the
  enemy; so is anything that pulses for no reason.

Nobody sits and studies this board. The job to be done is *triage*: which of my
agents is stuck, which is burning tokens, which needs approval — and then, since
1.4, tap the one that needs me and have its terminal come to the front.

## Brand personality

**Exact. Unlit. Engineered.**

An instrument panel, chosen deliberately over a dashboard. The distinction that
matters: a real instrument is read in a fraction of a second, from the corner of the
eye, by a person doing something else. That is achieved through *hierarchy* — one
value legible across the room, precision available underneath when you lean in — not
through density. Density without hierarchy is a trading terminal, which is an
explicit anti-reference.

Confidence comes from accuracy: exact values, honest units, no decoration that is
not data. Nothing glows. Nothing pulses unless something actually changed.

## Aesthetic direction

Dark, and dark for a reason — late-night and ambient use, not because dark looks
cool. Low-glare surfaces rather than high-contrast black; light type on dark reads
lighter, so leading is looser than a light theme would use.

**Anti-references, chosen by the owner:**

- **Generic AI dashboard** — cyan-on-dark, purple→blue gradients, glowing accents,
  identical rounded cards, sparklines as decoration. *This is what the board
  currently is:* every status colour is an unmodified Tailwind default
  (`blue-500`, `purple-500`, `amber-500`, `red-500`, `emerald-500`, `gray-500`) on
  a near-black `#0b0d12`, with `Inter` in the stack. The redesign replaces the
  basis of the palette, not its shade.
- **Enterprise admin panel** — grey tables, blue primary buttons, status pills
  everywhere.
- **Crypto trading terminal** — neon, maximal density, glow, ticker energy.

Not ruled out, and therefore fair game where it genuinely serves: the restrained
product-UI conventions of Linear/Vercel. Use them as grammar, never as a look.

## Design principles

1. **One reading per card.** Each card answers "does this need me?" at a glance and
   holds its precision for the lean-in. If two things compete to be the loudest
   element, the card has failed.
2. **State is never carried by hue alone.** Peripheral vision is poor at colour and
   the owner reads this board out of the corner of their eye. Shape, position,
   weight and motion carry state alongside colour — which also serves colour-blind
   readers and the three badges that currently fail WCAG AA.
3. **Motion means something changed.** No ambient animation, no decorative
   transitions. A card that moves has news. `prefers-reduced-motion` is honoured —
   the board honours it nowhere today.
4. **Numbers are exact and honestly labelled.** Tokens and plan-limit percentages
   are different measures and do not convert. The existing UI says so; the redesign
   must not blur them into one figure. Never invent a denominator.
5. **Every token is derived, not hand-written.** Status tints today are 12
   hand-typed rgba literals that drift from the colours they came from. Palette in
   OKLCH, tints computed from the base, neutrals tinted toward the brand hue.

The full version, and the reasoning behind it, lives in `.impeccable.md` at the repo root.
