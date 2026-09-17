//
//  Theme.swift
//  AgStatus
//
//  The board's design tokens, ported from public/tokens.css. The reasoning
//  lives in .impeccable.md at the repo root; the short version is here, because
//  the *why* is what stops a palette drifting back into defaults.
//
//  WHY THESE VALUES. They are authored in OKLCH on the web, where lightness is
//  perceptually uniform and a tint can be derived from a base rather than typed
//  by hand. SwiftUI has no OKLCH, so each one is converted to sRGB once, here,
//  and the OKLCH original is written beside it: that is the source of truth, and
//  a change on either platform has to start from it.
//
//  WHY GREEN. An earlier pass was warm — amber accent, warm-tinted neutrals —
//  on the argument that aviation instruments are lit warm at night to protect
//  dark adaptation. The owner rejected it: amber IS the caution convention, and
//  the accent also coloured the most common state, so the board spent all day
//  implying a warning. Every neutral is now tinted toward hue 155 at chroma
//  under 0.012 — imperceptible as colour, but it stops the ground reading as
//  the cold blue-black of every other agent dashboard.
//

import SwiftUI

enum Theme {

    // MARK: - Surfaces
    //
    // Low-glare on purpose: the card sits at 20.5% lightness, not black. This
    // board is read in a dark room, late, and a bright card in a dark room is
    // the glare the design exists to avoid.

    /// oklch(16.5% 0.008 155)
    static let background = rgb(0x0C0F0D)
    /// oklch(20.5% 0.009 155)
    static let card = rgb(0x141815)
    /// oklch(24.5% 0.010 155) — raised: tracks, pressed states
    static let raised = rgb(0x1D221E)
    /// oklch(30% 0.011 155)
    static let cardBorder = rgb(0x2A302B)
    /// oklch(38% 0.012 155)
    static let hairlineStrong = rgb(0x3E4440)

    // MARK: - Text
    //
    // All three clear WCAG AA on `card`, and on every state-tinted card. The
    // palette this replaces used a tertiary at 2.90:1 for the project name and
    // the timestamp — the two things you most need to read at a glance.

    /// oklch(94% 0.010 155)
    static let textPrimary = rgb(0xE6EDE8)
    /// oklch(74% 0.012 155)
    static let textSecondary = rgb(0xA5ADA7)
    /// oklch(64.5% 0.012 155) — lifted from 60% to survive the card tint below
    static let textTertiary = rgb(0x88908A)

    // MARK: - State
    //
    // Grouped by WHO IS WAITING, not by lifecycle stage — that is the only
    // question this board exists to answer.
    //
    //   YOUR TURN, carrying the chroma:
    //     blocked  the agent stopped and needs approval or input
    //     done     the agent finished its turn (the hook's `Stop`)
    //   THE AGENT IS WORKING, receding:
    //     planning / coding / testing — nothing is required of you
    //
    // An earlier pass ranked these by stage, which put the brightest colour on
    // `coding` (the most COMMON state) and the dimmest on the states that
    // actually need you. Backwards for a board read at a glance: the accent
    // belongs on the important state, not the frequent one.
    //
    // `idle` is now rare — only SessionStart emits it — so it is quiet.

    static func color(for status: AgentStatus) -> Color {
        switch status {
        case .idle: rgb(0x89968D)      // oklch(66% 0.020 155)
        case .planning: rgb(0x9F9ED2)  // oklch(72% 0.075 285)
        case .coding: rgb(0x78B2DB)    // oklch(74% 0.085 240)
        case .testing: rgb(0x69BABF)   // oklch(74% 0.080 200)
        case .blocked: rgb(0xF75E51)   // oklch(68% 0.190 28)
        case .done: rgb(0x69C88E)      // oklch(76% 0.125 155) — the accent
        }
    }

    /// The board's accent: the colour of "ready for you".
    static let accent = color(for: .done)

    /// A card's own surface, tinted by its state.
    ///
    /// These are PRECOMPUTED from the web's `color-mix(in oklab, card 90%,
    /// state)` — 86% for blocked — rather than mixed here at run time.
    ///
    /// The first cut mixed in linear sRGB and looked nothing like the web: a
    /// bright colour dominates a linear blend, so "10%" landed three to four
    /// times heavier than intended and the cards came out as saturated slabs
    /// of blue, teal and red. `blocked` rendered 0x672A24, a strong red, where
    /// the web's own mix gives 0x30231D — a warmth you have to look for.
    /// Perceptual and linear blending are not interchangeable at these
    /// lightnesses, and the tint is subtle enough that being wrong by 3x is
    /// the difference between a design and a mess.
    ///
    /// Baking them also means the two platforms cannot drift: change a state
    /// colour and both tables are regenerated from the same oklab maths.
    static func cardSurface(for status: AgentStatus) -> Color {
        switch status {
        case .idle: rgb(0x1E231F)
        case .planning: rgb(0x202425)
        case .coding: rgb(0x1D2525)
        case .testing: rgb(0x1C2623)
        case .blocked: rgb(0x30231D)
        case .done: rgb(0x1C271F)
        }
    }

    /// A card's border, from the same mix against `cardBorder`. Blocked keeps a
    /// brighter edge, because it is the one state that means a human is needed.
    static func cardEdge(for status: AgentStatus) -> Color {
        switch status {
        case .idle: rgb(0x4C544E)
        case .planning: rgb(0x535866)
        case .coding: rgb(0x475E69)
        case .testing: rgb(0x43615F)
        case .done: rgb(0x43664F)
        case .blocked: color(for: .blocked).opacity(0.42)
        }
    }

    /// The SF Symbol for a status.
    ///
    /// Shape first, colour second: peripheral vision resolves form long before
    /// hue, and roughly 1 in 12 men cannot separate the red and green states by
    /// colour at all. These mirror the web board's icons exactly, and being SF
    /// Symbols they scale with Dynamic Type and carry their own accessibility
    /// descriptions, which hand-drawn shapes would not.
    static func symbol(for status: AgentStatus) -> String {
        switch status {
        case .idle: "clock"
        case .planning: "list.bullet"
        case .coding: "chevron.left.forwardslash.chevron.right"
        case .testing: "testtube.2"
        case .blocked: "exclamationmark.circle.fill"
        case .done: "checkmark.circle"
        }
    }

    // MARK: - Chart
    //
    // Token spend is not a state, so it takes the accent rather than borrowing
    // a status colour — an earlier version drew the chart in `planning` blue,
    // which made a chart of tokens look like a chart of planning.

    static let seriesColors: [Color] = [
        color(for: .done),
        color(for: .coding),
        color(for: .testing),
        color(for: .planning),
        color(for: .idle),
        color(for: .blocked),
    ]

    /// The nth series colour, wrapping around for boards with many windows.
    static func seriesColor(_ index: Int) -> Color {
        seriesColors[((index % seriesColors.count) + seriesColors.count) % seriesColors.count]
    }

    // MARK: - Space
    //
    // A 4pt scale with semantic names, matching the web's. 8pt is too coarse:
    // 12pt between two related values is a spacing you want often and cannot
    // express on an 8pt scale.

    enum Space {
        static let xxs: CGFloat = 4
        static let xs: CGFloat = 8
        static let sm: CGFloat = 12
        static let md: CGFloat = 16
        static let lg: CGFloat = 24
        static let xl: CGFloat = 32
    }

    enum Radius {
        static let sm: CGFloat = 4
        static let md: CGFloat = 8
        static let lg: CGFloat = 12
    }

    // MARK: - Conversion

    private static func rgb(_ hex: UInt32) -> Color {
        Color(red: Double((hex >> 16) & 0xFF) / 255,
              green: Double((hex >> 8) & 0xFF) / 255,
              blue: Double(hex & 0xFF) / 255)
    }
}
