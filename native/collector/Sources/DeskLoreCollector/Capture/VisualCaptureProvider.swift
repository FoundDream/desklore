import AppKit
import DeskLoreNativeCore
import CoreGraphics
import Foundation
import ImageIO
@preconcurrency import ScreenCaptureKit
import UniformTypeIdentifiers
@preconcurrency import Vision

struct VisualCaptureIntent: Sendable {
    let requestID: String
    let eventID: String
    let bundleIdentifier: String
    let windowRuntimeIdentifier: UInt32?
    let windowTitle: String?
    let url: String?
    let isPrivateBrowsing: Bool
    let expiresAt: Date
    let includeImage: Bool
}

typealias VisualCapturePolicyCheck = @MainActor @Sendable (String?) -> Bool

struct VisualCaptureResult: Encodable, Sendable {
    enum Status: String, Encodable, Sendable {
        case captured
        case unavailable
        case blocked
        case failed
    }

    let status: Status
    let reason: String?
    let provider: String
    let capturedAt: Date?
    let windowRuntimeIdentifier: UInt32?
    let width: Int?
    let height: Int?
    let ocrText: String?
    let imageBase64: String?
}

final class VisualCaptureProvider: @unchecked Sendable {
    private let blockedBundleIdentifiers: Set<String> = [
        "com.apple.loginwindow",
        "com.apple.SecurityAgent",
        "com.apple.ScreenSaver.Engine",
        "com.desklore.desktop",
        "com.desklore.collector",
    ]

    var isScreenCaptureGranted: Bool {
        CGPreflightScreenCaptureAccess()
    }

    @MainActor
    func requestScreenCapturePermission() -> Bool {
        CGRequestScreenCaptureAccess()
    }

    func capture(
        _ intent: VisualCaptureIntent,
        policyCheck: VisualCapturePolicyCheck
    ) async -> VisualCaptureResult {
        guard !blockedBundleIdentifiers.contains(intent.bundleIdentifier) else {
            return result(.blocked, reason: "policy_excluded")
        }
        guard await policyCheck(intent.windowTitle) else {
            return result(.blocked, reason: "policy_excluded")
        }
        guard Date() <= intent.expiresAt else {
            return result(.unavailable, reason: "request_expired")
        }
        guard isScreenCaptureGranted else {
            return result(.unavailable, reason: "permission_denied")
        }
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(
                true,
                onScreenWindowsOnly: true
            )
            guard let window = matchingWindow(in: content.windows, intent: intent) else {
                return result(.unavailable, reason: "target_window_unavailable")
            }
            guard await policyCheck(window.title) else {
                return result(.blocked, reason: "policy_excluded")
            }
            guard Date() <= intent.expiresAt else {
                return result(.unavailable, reason: "request_expired")
            }
            let filter = SCContentFilter(desktopIndependentWindow: window)
            let configuration = SCStreamConfiguration()
            let scale = max(Double(filter.pointPixelScale), 1)
            let originalWidth = max(Int(window.frame.width * scale), 1)
            let originalHeight = max(Int(window.frame.height * scale), 1)
            let maximumDimension = 1_920.0
            let downscale = min(1, maximumDimension / Double(max(originalWidth, originalHeight)))
            configuration.width = max(Int(Double(originalWidth) * downscale), 1)
            configuration.height = max(Int(Double(originalHeight) * downscale), 1)
            configuration.scalesToFit = true
            configuration.preservesAspectRatio = true
            configuration.showsCursor = false
            let image = try await SCScreenshotManager.captureImage(
                contentFilter: filter,
                configuration: configuration
            )
            let processed = try process(image)
            let imageBase64 = intent.includeImage
                ? try pngData(from: processed.image).base64EncodedString()
                : nil
            return VisualCaptureResult(
                status: .captured,
                reason: nil,
                provider: "macos-screencapturekit",
                capturedAt: Date(),
                windowRuntimeIdentifier: window.windowID,
                width: processed.image.width,
                height: processed.image.height,
                ocrText: processed.ocrText,
                imageBase64: imageBase64
            )
        } catch {
            return result(.failed, reason: normalizedError(error))
        }
    }

    private func matchingWindow(
        in windows: [SCWindow],
        intent: VisualCaptureIntent
    ) -> SCWindow? {
        let owned = windows.filter {
            $0.owningApplication?.bundleIdentifier == intent.bundleIdentifier
                && $0.isOnScreen
        }
        if let identifier = intent.windowRuntimeIdentifier,
           let exact = owned.first(where: { $0.windowID == identifier }) {
            return exact
        }
        if let title = intent.windowTitle {
            let titled = owned.filter { $0.title == title }
            if titled.count == 1 { return titled[0] }
            if titled.count > 1 { return nil }
        }
        let normalWindows = owned.filter { $0.windowLayer == 0 }
        guard normalWindows.count == 1 else { return nil }
        return normalWindows[0]
    }

    private func process(_ image: CGImage) throws -> (image: CGImage, ocrText: String) {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = true
        let handler = VNImageRequestHandler(cgImage: image, options: [:])
        try handler.perform([request])
        let observations = request.results ?? []
        let recognized = observations.compactMap { observation -> (String, CGRect)? in
            guard let text = observation.topCandidates(1).first?.string,
                  !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                return nil
            }
            return (text, observation.boundingBox)
        }
        let cleanedText = recognized.compactMap { text, _ in
            PrivacySanitizer.clean(text, limit: 4_096)
        }.joined(separator: "\n")
        let sensitiveBoxes = recognized.compactMap { text, box -> CGRect? in
            guard PrivacySanitizer.clean(text, limit: 4_096) != text else { return nil }
            return box
        }
        guard !sensitiveBoxes.isEmpty else { return (image, cleanedText) }
        guard let context = CGContext(
            data: nil,
            width: image.width,
            height: image.height,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else {
            throw VisualCaptureError.imageProcessingFailed
        }
        let imageRect = CGRect(x: 0, y: 0, width: image.width, height: image.height)
        context.draw(image, in: imageRect)
        context.setFillColor(NSColor.black.cgColor)
        for box in sensitiveBoxes {
            let pixelBox = CGRect(
                x: box.minX * Double(image.width),
                y: box.minY * Double(image.height),
                width: box.width * Double(image.width),
                height: box.height * Double(image.height)
            ).insetBy(dx: -4, dy: -4)
            context.fill(pixelBox)
        }
        guard let redacted = context.makeImage() else {
            throw VisualCaptureError.imageProcessingFailed
        }
        return (redacted, cleanedText)
    }

    private func pngData(from image: CGImage) throws -> Data {
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(
            data,
            UTType.png.identifier as CFString,
            1,
            nil
        ) else {
            throw VisualCaptureError.imageEncodingFailed
        }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else {
            throw VisualCaptureError.imageEncodingFailed
        }
        return data as Data
    }

    private func result(
        _ status: VisualCaptureResult.Status,
        reason: String
    ) -> VisualCaptureResult {
        VisualCaptureResult(
            status: status,
            reason: reason,
            provider: "macos-screencapturekit",
            capturedAt: nil,
            windowRuntimeIdentifier: nil,
            width: nil,
            height: nil,
            ocrText: nil,
            imageBase64: nil
        )
    }

    private func normalizedError(_ error: Error) -> String {
        let value = String(describing: error)
            .lowercased()
            .replacingOccurrences(of: "[^a-z0-9]+", with: "_", options: .regularExpression)
            .trimmingCharacters(in: CharacterSet(charactersIn: "_"))
        return String(value.prefix(160)).isEmpty ? "capture_failed" : String(value.prefix(160))
    }
}

private enum VisualCaptureError: Error {
    case imageProcessingFailed
    case imageEncodingFailed
}
