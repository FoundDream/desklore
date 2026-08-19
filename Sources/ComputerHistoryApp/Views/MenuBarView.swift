import AppKit
import SwiftUI

struct MenuBarView: View {
    @ObservedObject var engine: HistoryEngine
    let onOpenTimeline: () -> Void
    @State private var llmEnabled = false
    @State private var llmModel = ""
    @State private var llmEndpoint = ""
    @State private var llmAPIKey = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                statusIndicator
                VStack(alignment: .leading, spacing: 2) {
                    Text(statusTitle)
                        .font(.headline)
                    if let application = engine.activeApplication {
                        Text(application.name)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer()
            }

            if !engine.accessibilityGranted {
                Label(
                    "需要辅助功能权限才能读取窗口信息",
                    systemImage: "lock.trianglebadge.exclamationmark"
                )
                .font(.caption)
                .foregroundStyle(.orange)

                Button("授予辅助功能权限") {
                    engine.requestAccessibilityPermission()
                }
            }

            if let application = engine.activeApplication {
                if engine.isActiveApplicationAllowed() {
                    Button("停止观察 \(application.name)") {
                        engine.blockActiveApplication()
                    }
                } else {
                    Button("允许观察 \(application.name)") {
                        engine.allowActiveApplication()
                    }
                    .buttonStyle(.borderedProminent)
                }
            }

            if let domain = engine.activeDomain {
                if engine.isActiveDomainAllowed() {
                    Button("停止观察 \(domain)") {
                        engine.blockActiveDomain()
                    }
                } else {
                    Button("允许观察 \(domain)") {
                        engine.allowActiveDomain()
                    }
                }
            }

            DisclosureGroup("模型摘要") {
                VStack(alignment: .leading, spacing: 8) {
                    Toggle("启用 LLM 语义摘要", isOn: $llmEnabled)

                    TextField("模型", text: $llmModel)
                        .textFieldStyle(.roundedBorder)
                    TextField("Responses Endpoint", text: $llmEndpoint)
                        .textFieldStyle(.roundedBorder)
                    SecureField(
                        engine.llmAPIKeyConfigured ? "API Key（已配置）" : "API Key",
                        text: $llmAPIKey
                    )
                    .textFieldStyle(.roundedBorder)

                    HStack {
                        Button("保存") {
                            engine.configureLLM(
                                enabled: llmEnabled,
                                model: llmModel,
                                endpoint: llmEndpoint,
                                apiKey: llmAPIKey
                            )
                            llmAPIKey = ""
                        }
                        if engine.llmAPIKeyConfigured {
                            Button("移除密钥") {
                                engine.removeLLMAPIKey()
                                llmAPIKey = ""
                            }
                        }
                    }

                    Label(
                        llmStatusText,
                        systemImage: engine.llmEnabled && engine.llmAPIKeyConfigured
                            ? "sparkles"
                            : "arrow.triangle.branch"
                    )
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
                .padding(.top, 6)
            }

            DisclosureGroup("采集健康") {
                VStack(alignment: .leading, spacing: 6) {
                    healthRow(
                        "辅助功能",
                        healthy: engine.accessibilityGranted
                    )
                    healthRow(
                        "全局事件监听器",
                        healthy: engine.interactionMonitorActive
                    )
                    healthRow(
                        "AX 语义监听器",
                        healthy: engine.axObserverActive
                    )
                    Text(
                        "AX 订阅：文本 \(engine.axValueNotificationTargets) · 选择 \(engine.axSelectionNotificationTargets)"
                    )
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    Text(
                        "本次启动：Return \(engine.returnKeyEventCount) · 提交 \(engine.keyboardSubmitCount) · 快捷键 \(engine.keyboardShortcutCount)"
                    )
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    Text(
                        "文本变化 \(engine.textInputEventCount) · 选择变化 \(engine.selectionEventCount)"
                    )
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    Text(
                        "AX 树：\(engine.lastAXSnapshotNodeCount)/\(engine.lastAXVisitedNodeCount) 节点 · \(engine.lastAXCaptureDurationMilliseconds, format: .number.precision(.fractionLength(0))) ms"
                    )
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    Text(
                        "AX 队列 \(engine.axCaptureBacklog) · 慢采集 \(engine.axSlowCaptureCount) · 截断 \(engine.axTruncatedCaptureCount)"
                    )
                    .font(.caption)
                    .foregroundStyle(
                        engine.axCaptureBacklog > 2 ? Color.orange : Color.secondary
                    )
                    if let date = engine.lastKeyboardEventAt {
                        Text("最近键盘语义事件：\(date.formatted(date: .omitted, time: .standard))")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    } else {
                        Text("本次启动尚未收到 Return 或组合快捷键")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.top, 6)
            }

            Divider()

            Button("打开时间线") {
                onOpenTimeline()
            }
            .keyboardShortcut("t")

            if engine.state == .running {
                Button("暂停记录") { engine.pause() }
            } else {
                Button("继续记录") { engine.resume() }
            }

            Button("在 Finder 中显示数据") {
                engine.revealStorageInFinder()
            }

            if let error = engine.lastError {
                Divider()
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .lineLimit(3)
            }

            Divider()
            Button("退出") {
                NSApplication.shared.terminate(nil)
            }
            .keyboardShortcut("q")
        }
        .padding(14)
        .frame(width: 320)
        .onAppear {
            engine.refreshCapturePermissions()
            llmEnabled = engine.llmEnabled
            llmModel = engine.llmModel
            llmEndpoint = engine.llmEndpoint
        }
    }

    private var statusIndicator: some View {
        Circle()
            .fill(engine.state == .running ? Color.green : Color.orange)
            .frame(width: 10, height: 10)
    }

    private var statusTitle: String {
        switch engine.state {
        case .stopped: "尚未启动"
        case .running: "正在记录"
        case .paused: "已暂停"
        }
    }

    private var llmStatusText: String {
        if engine.llmEnabled && engine.llmAPIKeyConfigured {
            return "新时间段使用 \(engine.llmModel)，失败时自动规则降级"
        }
        if engine.llmEnabled {
            return "缺少 API Key，当前使用规则摘要"
        }
        return "当前使用规则摘要"
    }

    private func healthRow(_ title: String, healthy: Bool) -> some View {
        Label(
            "\(title)：\(healthy ? "正常" : "未就绪")",
            systemImage: healthy ? "checkmark.circle.fill" : "exclamationmark.circle"
        )
        .font(.caption)
        .foregroundStyle(healthy ? .green : .orange)
    }
}
