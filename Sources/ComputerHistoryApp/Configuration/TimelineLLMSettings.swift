import ComputerHistoryCore
import Foundation

struct TimelineLLMSettings: Equatable {
    var enabled: Bool
    var model: String
    var endpoint: String

    static func load(defaults: UserDefaults = .standard) -> TimelineLLMSettings {
        TimelineLLMSettings(
            enabled: defaults.bool(forKey: enabledKey),
            model: defaults.string(forKey: modelKey) ?? "gpt-5.6-luna",
            endpoint: defaults.string(forKey: endpointKey)
                ?? "https://api.openai.com/v1/responses"
        )
    }

    func save(defaults: UserDefaults = .standard) {
        defaults.set(enabled, forKey: Self.enabledKey)
        defaults.set(model, forKey: Self.modelKey)
        defaults.set(endpoint, forKey: Self.endpointKey)
    }

    func makeSummarizer(apiKey: String?) -> any TimelineSummarizer {
        guard enabled,
              let apiKey,
              !apiKey.isEmpty,
              let endpointURL = URL(string: endpoint) else {
            return RuleBasedTimelineSummarizer()
        }
        let primary = OpenAIResponsesTimelineSummarizer(
            configuration: TimelineLLMConfiguration(
                endpoint: endpointURL,
                apiKey: apiKey,
                model: model
            )
        )
        return FallbackTimelineSummarizer(primary: primary)
    }

    static func resolvedAPIKey() -> String? {
        KeychainSecretStore.loadAPIKey()
            ?? ProcessInfo.processInfo.environment["OPENAI_API_KEY"]
    }

    static func validate(endpoint: String, model: String) -> Bool {
        guard !model.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let url = URL(string: endpoint),
              let scheme = url.scheme?.lowercased(),
              url.host != nil else {
            return false
        }
        if scheme == "https" { return true }
        return scheme == "http" && ["localhost", "127.0.0.1", "::1"].contains(url.host)
    }

    private static let enabledKey = "timeline-llm-enabled-v1"
    private static let modelKey = "timeline-llm-model-v1"
    private static let endpointKey = "timeline-llm-endpoint-v1"
}
