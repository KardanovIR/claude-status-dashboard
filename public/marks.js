/*
 * AgStatus — the marks.
 *
 * One definition, two pages. The board (public/app.js) and the landing page
 * (public/landing.html) both draw session cards, and the landing page used to
 * draw its own: its own card, its own badge, its own tints, no icons at all.
 * It had already drifted a whole design system behind. Anything both pages
 * render lives in one file now — the card's CSS in card.css, its marks here.
 *
 * Attached to `window` rather than exported, because both consumers are plain
 * classic scripts and a module would mean changing how the board loads.
 */
(() => {
  'use strict';

  // ---- Icons ----------------------------------------------------------------
  //
  // Inline SVG on a 16-unit grid, sized by CSS and drawn in `currentColor`, so
  // a status mark inherits --state from its own card and costs no request.
  //
  // Shape first, colour second: peripheral vision resolves form long before hue,
  // and roughly one man in twelve cannot separate the red and green states by
  // colour at all. The board's second design principle — state is never carried
  // by hue alone — had no second channel on the web before these.
  //
  // These are the same six marks iOS draws with SF Symbols. Theme.symbol's
  // comment has said they "mirror the web board's icons exactly" since 1.5,
  // which was false the whole time: the web board had no icons to mirror.
  //
  // The agent marks are deliberately NOT the Anthropic or OpenAI logos. This
  // board is self-hosted by other people, and redistributing someone's
  // trademark inside it is a different thing from naming their tool.

  const stroked = (cls, body) =>
    `<svg class="${cls}" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor"`
    + ` stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

  // A filled disc with the glyph punched out of it. evenodd counts crossings,
  // so an inner subpath is a hole whichever way it winds.
  const punched = (cls, body) =>
    `<svg class="${cls}" viewBox="0 0 16 16" aria-hidden="true" fill="currentColor"`
    + ` fill-rule="evenodd">${body}</svg>`;

  const DISC = 'M8 1.25a6.75 6.75 0 1 0 0 13.5 6.75 6.75 0 0 0 0-13.5Z';

  // Quiet outlines for the four states that need nothing from you; `blocked` is
  // the only solid one, because it is the only state that means a human is
  // required, and weight is a channel that survives being seen sideways.
  const STATE_MARK = {
    idle: stroked('state-mark', '<circle cx="8" cy="8" r="6"/><path d="M8 4.6V8l2.6 1.5"/>'),
    planning: stroked('state-mark',
      '<path d="M6.5 4.3h7M6.5 8h7M6.5 11.7h7"/>'
      + '<circle cx="3" cy="4.3" r="1" fill="currentColor" stroke="none"/>'
      + '<circle cx="3" cy="8" r="1" fill="currentColor" stroke="none"/>'
      + '<circle cx="3" cy="11.7" r="1" fill="currentColor" stroke="none"/>'),
    coding: stroked('state-mark', '<path d="M5.6 4.4 2.2 8l3.4 3.6M10.4 4.4 13.8 8l-3.4 3.6M9.4 3.4 6.6 12.6"/>'),
    testing: stroked('state-mark', '<path d="M4.6 2.2h6.8M6.2 2.2v8.3a1.8 1.8 0 0 0 3.6 0V2.2M6.2 8.2h3.6"/>'),
    blocked: punched('state-mark',
      `<path d="${DISC}M8.9 4.35v4.8a.9.9 0 0 1-1.8 0V4.35a.9.9 0 0 1 1.8 0ZM8 12.3a1.05 1.05 0 1 1 0-2.1 1.05 1.05 0 0 1 0 2.1Z"/>`),
    done: stroked('state-mark', '<circle cx="8" cy="8" r="6"/><path d="M5.3 8.2 7.2 10.1 10.8 5.9"/>'),
  };

  const ICON = {
    claude: stroked('', '<path d="M8 2.4v11.2M3.15 5.2l9.7 5.6M3.15 10.8l9.7-5.6"/>'),
    codex: stroked('', '<path d="M8 1.9 13.3 4.95v6.1L8 14.1 2.7 11.05v-6.1Z"/>'),
    // Two overlapping windows. The one behind is drawn only where the front one
    // does not cover it, so the two never cross at 15px.
    focus: stroked('',
      '<path d="M6 9.5H2.4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1H9a1 1 0 0 1 1 1v2.5"/>'
      + '<path d="M6.9 6.5h6.7a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H6.9a1 1 0 0 1-1-1V7.5a1 1 0 0 1 1-1Z"/>'),
    resume: punched('', `<path d="${DISC}M6.3 5.2 11 8l-4.7 2.8Z"/>`),
  };

  window.AGSTATUS_MARKS = { STATE_MARK, ICON };
})();
