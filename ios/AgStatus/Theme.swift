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
    /// The tint is not decoration — it is what lets you sort the board by
    /// colour before reading a word. 10% is not a guess either: text contrast
    /// was solved against every tinted surface, and at 10% (14% for blocked)
    /// with `textTertiary` lifted to 64.5% lightness the worst ratio anywhere
    /// is 4.53:1, still WCAG AA. At 6% the meta line fell to 4.01:1 and failed.
    ///
    /// What this deliberately is NOT: a coloured stripe down the card's edge.
    /// That is the most overused device in dashboard UI and never reads as
    /// intentional, whatever colour or corner radius it is given.
    static func cardSurface(for status: AgentStatus) -> Color {
        mix(card, color(for: status), amount: status == .blocked ? 0.14 : 0.10)
    }

    /// A card's border, tinted the same way. Blocked gets a brighter edge,
    /// because it is the one state that means a human is required.
    static func cardEdge(for status: AgentStatus) -> Color {
        status == .blocked
            ? color(for: .blocked).opacity(0.42)
            : mix(cardBorder, color(for: status), amount: 0.38)
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

    /// Mixes two colours in linear sRGB, which is close enough to the web's
    /// `color-mix(in oklab, …)` at these small amounts that the two platforms
    /// land on the same surface. Doing it here rather than writing six more
    /// literals keeps the tint derived from the state, the way the stylesheet
    /// does — the palette this replaces carried twelve hand-typed tints that
    /// had already drifted from the colours they came from.
    private static func mix(_ base: Color, _ other: Color, amount: Double) -> Color {
        let b = components(base), o = components(other)
        func lin(_ c: Double) -> Double { c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4) }
        func srgb(_ c: Double) -> Double { c <= 0.0031308 ? c * 12.92 : 1.055 * pow(c, 1 / 2.4) - 0.055 }
        let r = srgb(lin(b.0) * (1 - amount) + lin(o.0) * amount)
        let g = srgb(lin(b.1) * (1 - amount) + lin(o.1) * amount)
        let bl = srgb(lin(b.2) * (1 - amount) + lin(o.2) * amount)
        return Color(red: r, green: g, blue: bl)
    }

    private static func components(_ color: Color) -> (Double, Double, Double) {
        #if canImport(UIKit)
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        UIColor(color).getRed(&r, green: &g, blue: &b, alpha: &a)
        return (Double(r), Double(g), Double(b))
        #else
        return (0, 0, 0)
        #endif
    }

    private static func rgb(_ hex: UInt32) -> Color {
        Color(red: Double((hex >> 16) & 0xFF) / 255,
              green: Double((hex >> 8) & 0xFF) / 255,
              blue: Double(hex & 0xFF) / 255)
    }
}
