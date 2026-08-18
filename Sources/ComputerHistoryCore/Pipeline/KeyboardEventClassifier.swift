import Foundation

public enum KeyboardEventClassifier {
    public static func classify(
        keyEquivalent: String?,
        modifiers: [String]?,
        target: HistoryEvent.Target?
    ) -> HistoryEvent.Kind {
        let key = keyEquivalent?.lowercased() ?? ""
        guard key == "return" || key == "enter" || key == "numpad-enter" else {
            return .keyboardShortcut
        }

        let modifiers = Set(modifiers ?? [])
        if !modifiers.intersection(["cmd", "ctrl"]).isEmpty {
            return .keyboardSubmit
        }

        let role = target?.role ?? ""
        if ["AXTextField", "AXSearchField", "AXComboBox"].contains(role) {
            return .keyboardSubmit
        }

        let label = [
            target?.identifier,
            target?.title,
            target?.description,
            target?.placeholder,
        ]
            .compactMap { $0 }
            .joined(separator: " ")
            .lowercased()
        let submitMarkers = [
            "message", "chat", "prompt", "reply", "send", "ask",
            "消息", "聊天", "提问", "发送", "回复", "输入问题",
        ]
        if submitMarkers.contains(where: label.contains) {
            return .keyboardSubmit
        }

        return .keyboardShortcut
    }
}
