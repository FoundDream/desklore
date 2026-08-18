import Foundation

public struct HistoryEvent: Codable, Equatable, Identifiable, Sendable {
    public enum Kind: String, Codable, CaseIterable, Sendable {
        case windowChanged = "window.changed"
        case mouseClick = "mouse.click"
        case mouseContextMenu = "mouse.context_menu"
        case mouseDrag = "mouse.drag"
        case keyboardTextInput = "keyboard.text_input"
        case keyboardShortcut = "keyboard.shortcut"
        case keyboardSubmit = "keyboard.submit"
        case selectionChanged = "selection.changed"
    }

    public struct Application: Codable, Equatable, Hashable, Sendable {
        public let bundleIdentifier: String
        public let name: String

        public init(bundleIdentifier: String, name: String) {
            self.bundleIdentifier = bundleIdentifier
            self.name = name
        }
    }

    public struct Window: Codable, Equatable, Sendable {
        public let title: String?
        public let url: String?
        public let isPrivateBrowsing: Bool

        public init(
            title: String? = nil,
            url: String? = nil,
            isPrivateBrowsing: Bool = false
        ) {
            self.title = title
            self.url = url
            self.isPrivateBrowsing = isPrivateBrowsing
        }
    }

    public struct Target: Codable, Equatable, Sendable {
        public let role: String?
        public let subrole: String?
        public let identifier: String?
        public let title: String?
        public let description: String?
        public let placeholder: String?
        public let value: String?

        public init(
            role: String? = nil,
            subrole: String? = nil,
            identifier: String? = nil,
            title: String? = nil,
            description: String? = nil,
            placeholder: String? = nil,
            value: String? = nil
        ) {
            self.role = role
            self.subrole = subrole
            self.identifier = identifier
            self.title = title
            self.description = description
            self.placeholder = placeholder
            self.value = value
        }

        public var isSecureInput: Bool {
            role == "AXSecureTextField"
        }
    }

    public struct Interaction: Codable, Equatable, Sendable {
        public struct Point: Codable, Equatable, Sendable {
            public let x: Double
            public let y: Double

            public init(x: Double, y: Double) {
                self.x = x
                self.y = y
            }
        }

        public let text: String?
        public let selectedText: String?
        public let keyEquivalent: String?
        public let modifiers: [String]?
        public let mouseButton: String?
        public let clickCount: Int?
        public let mouseOrigin: Point?
        public let mouseDestination: Point?

        public init(
            text: String? = nil,
            selectedText: String? = nil,
            keyEquivalent: String? = nil,
            modifiers: [String]? = nil,
            mouseButton: String? = nil,
            clickCount: Int? = nil,
            mouseOrigin: Point? = nil,
            mouseDestination: Point? = nil
        ) {
            self.text = text
            self.selectedText = selectedText
            self.keyEquivalent = keyEquivalent
            self.modifiers = modifiers
            self.mouseButton = mouseButton
            self.clickCount = clickCount
            self.mouseOrigin = mouseOrigin
            self.mouseDestination = mouseDestination
        }
    }

    public struct AccessibilityContext: Codable, Equatable, Sendable {
        public enum Mode: String, Codable, Sendable {
            case fullTree
            case diffFromPrevious
        }

        public let mode: Mode
        public let text: String

        public init(mode: Mode, text: String) {
            self.mode = mode
            self.text = text
        }
    }

    public let id: UUID
    public let timestamp: Date
    public let kind: Kind
    public let occurrenceCount: Int?
    public let application: Application
    public let window: Window?
    public let target: Target?
    public let interaction: Interaction?
    public let accessibility: AccessibilityContext?

    public init(
        id: UUID = UUID(),
        timestamp: Date,
        kind: Kind,
        occurrenceCount: Int? = nil,
        application: Application,
        window: Window? = nil,
        target: Target? = nil,
        interaction: Interaction? = nil,
        accessibility: AccessibilityContext? = nil
    ) {
        self.id = id
        self.timestamp = timestamp
        self.kind = kind
        self.occurrenceCount = occurrenceCount
        self.application = application
        self.window = window
        self.target = target
        self.interaction = interaction
        self.accessibility = accessibility
    }
}
