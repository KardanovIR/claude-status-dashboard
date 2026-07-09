//
//  Theme.swift
//  AgStatus
//
//  Dark design tokens matching the web dashboard: background #0b0d12,
//  cards #141822, subtle white borders, and the six status colors.
//

import SwiftUI

enum Theme {
    static let background = rgb(0x0B0D12)
    static let card = rgb(0x141822)
    static let cardBorder = Color.white.opacity(0.08)
    static let textPrimary = rgb(0xE9EDF5)
    static let textSecondary = rgb(0x8B93A7)

    static func color(for status: AgentStatus) -> Color {
        switch status {
        case .idle: rgb(0x8B93A7)
        case .planning: rgb(0x4D9FFF)
        case .coding: rgb(0xB17AFF)
        case .testing: rgb(0xFFB02E)
        case .blocked: rgb(0xFF5C5C)
        case .done: rgb(0x3ECF8E)
        }
    }

    private static func rgb(_ hex: UInt32) -> Color {
        Color(red: Double((hex >> 16) & 0xFF) / 255,
              green: Double((hex >> 8) & 0xFF) / 255,
              blue: Double(hex & 0xFF) / 255)
    }
}
