//
//  BoardKeychain.swift
//  AgStatus
//
//  The workspace token is a secret, so the Board is persisted in the iOS
//  Keychain (generic password, JSON-encoded) rather than UserDefaults.
//  Plain Security framework calls, no wrappers.
//

import Foundation
import Security

enum BoardKeychain {

    private static let service = "com.kardanov.agstatus"
    private static let account = "board"

    static func load() -> Board? {
        var query = baseQuery()
        query[kSecReturnData as String] = kCFBooleanTrue as Any
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess, let data = result as? Data else {
            return nil
        }
        return try? JSONDecoder().decode(Board.self, from: data)
    }

    static func save(_ board: Board) {
        guard let data = try? JSONEncoder().encode(board) else { return }

        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock as String,
        ]

        let updateStatus = SecItemUpdate(baseQuery() as CFDictionary,
                                         attributes as CFDictionary)
        guard updateStatus == errSecItemNotFound else { return }

        var addQuery = baseQuery()
        addQuery.merge(attributes) { _, new in new }
        SecItemAdd(addQuery as CFDictionary, nil)
    }

    static func clear() {
        SecItemDelete(baseQuery() as CFDictionary)
    }

    private static func baseQuery() -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }
}
