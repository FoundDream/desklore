import AppKit
import ComputerHistoryCore
import SwiftUI

struct TimelineView: View {
    @ObservedObject var engine: HistoryEngine

    var body: some View {
        NavigationStack {
            Group {
                if engine.documents.isEmpty {
                    ContentUnavailableView(
                        "还没有时间线",
                        systemImage: "clock.arrow.circlepath",
                        description: Text("记录默认已开启；首个有活动的完整 10 分钟分段会出现在这里。")
                    )
                } else {
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 0) {
                            ForEach(Array(engine.documents.enumerated()), id: \.element.id) {
                                index, document in
                                TimelineRow(
                                    document: document,
                                    isLast: index == engine.documents.count - 1,
                                    onOpen: { engine.openMarkdown(document) },
                                    onDelete: { engine.delete(document) }
                                )
                            }
                        }
                        .frame(maxWidth: 1_260, alignment: .leading)
                        .padding(.horizontal, 16)
                        .padding(.top, 18)
                        .padding(.bottom, 36)
                    }
                    .background(Color(nsColor: .textBackgroundColor))
                }
            }
            .navigationTitle("Computer History")
            .toolbar {
                ToolbarItem {
                    Button {
                        engine.revealStorageInFinder()
                    } label: {
                        Label("显示 Markdown", systemImage: "folder")
                    }
                    .help("在 Finder 中显示 Markdown 时间线")
                }
            }
        }
        .frame(minWidth: 760, minHeight: 560)
    }
}

private struct TimelineRow: View {
    private enum Metrics {
        static let timeWidth: CGFloat = 88
        static let railWidth: CGFloat = 28
        static let dotSize: CGFloat = 8
        static let topAnchor: CGFloat = 10
        static let bottomSpacing: CGFloat = 58
    }

    let document: TimelineDocument
    let isLast: Bool
    let onOpen: () -> Void
    let onDelete: () -> Void

    @State private var isHovering = false
    @State private var isConfirmingDelete = false

    var body: some View {
        ZStack(alignment: .topLeading) {
            timelineRail

            HStack(alignment: .top, spacing: 0) {
                Text(document.startedAt.formatted(date: .omitted, time: .shortened))
                    .font(.system(size: 15, weight: .regular, design: .default))
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
                    .frame(width: Metrics.timeWidth, alignment: .trailing)
                    .padding(.top, 1)

                Color.clear
                    .frame(width: Metrics.railWidth)

                VStack(alignment: .leading, spacing: 0) {
                    titleRow

                    Text(document.description)
                        .font(.system(size: 16, weight: .regular))
                        .foregroundStyle(Color(nsColor: .secondaryLabelColor))
                        .lineSpacing(5)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, 11)

                    if !document.applications.isEmpty {
                        ApplicationIconStrip(applications: document.applications)
                            .padding(.top, 17)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.trailing, 24)
                .padding(.bottom, Metrics.bottomSpacing)
            }
        }
        .contentShape(Rectangle())
        .onHover { isHovering = $0 }
        .contextMenu {
            Button("打开 Markdown", action: onOpen)
            Button("删除", role: .destructive) {
                isConfirmingDelete = true
            }
        }
        .confirmationDialog(
            "删除这条时间线？",
            isPresented: $isConfirmingDelete,
            titleVisibility: .visible
        ) {
            Button("删除", role: .destructive, action: onDelete)
            Button("取消", role: .cancel) {}
        } message: {
            Text("这会删除对应的 Markdown 文件，无法撤销。")
        }
    }

    private var titleRow: some View {
        HStack(alignment: .center, spacing: 10) {
            Text(document.title)
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(.primary)
                .lineLimit(2)

            HStack(spacing: 3) {
                TimelineActionButton(
                    title: "打开 Markdown",
                    systemImage: "doc.text",
                    action: onOpen
                )
                TimelineActionButton(
                    title: "删除",
                    systemImage: "trash"
                ) {
                    isConfirmingDelete = true
                }
            }
            .frame(width: 58, alignment: .leading)
            .opacity(isHovering ? 1 : 0)
            .accessibilityHidden(!isHovering)

            Spacer(minLength: 0)
        }
        .frame(minHeight: 24, alignment: .leading)
    }

    private var timelineRail: some View {
        GeometryReader { proxy in
            Canvas { context, size in
                let centerX = Metrics.timeWidth + Metrics.railWidth / 2
                let dotCenterY = Metrics.topAnchor

                if !isLast {
                    var line = Path()
                    line.move(to: CGPoint(x: centerX, y: dotCenterY))
                    line.addLine(to: CGPoint(x: centerX, y: size.height))
                    context.stroke(
                        line,
                        with: .color(Color(nsColor: .separatorColor).opacity(0.72)),
                        lineWidth: 1
                    )
                }

                let dotRect = CGRect(
                    x: centerX - Metrics.dotSize / 2,
                    y: dotCenterY - Metrics.dotSize / 2,
                    width: Metrics.dotSize,
                    height: Metrics.dotSize
                )
                context.fill(
                    Path(ellipseIn: dotRect),
                    with: .color(Color(nsColor: .tertiaryLabelColor))
                )
            }
            .frame(width: proxy.size.width, height: proxy.size.height)
        }
        .allowsHitTesting(false)
    }
}

private struct TimelineActionButton: View {
    let title: String
    let systemImage: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 13, weight: .medium))
                .frame(width: 26, height: 26)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .background {
            RoundedRectangle(cornerRadius: 7, style: .continuous)
                .fill(Color(nsColor: .controlBackgroundColor).opacity(0.82))
        }
        .help(title)
        .accessibilityLabel(title)
    }
}

private struct ApplicationIconStrip: View {
    let applications: [HistoryEvent.Application]

    var body: some View {
        HStack(spacing: 10) {
            ForEach(applications, id: \.bundleIdentifier) { application in
                ApplicationIcon(application: application)
            }
        }
    }
}

private struct ApplicationIcon: View {
    let application: HistoryEvent.Application

    var body: some View {
        Group {
            if let image = applicationIcon {
                Image(nsImage: image)
                    .resizable()
                    .interpolation(.high)
                    .scaledToFit()
            } else {
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .fill(Color(nsColor: .controlBackgroundColor))
                    .overlay {
                        Text(String(application.name.prefix(1)).uppercased())
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(.secondary)
                    }
            }
        }
        .frame(width: 24, height: 24)
        .help(application.name)
        .accessibilityLabel(application.name)
    }

    private var applicationIcon: NSImage? {
        guard let url = NSWorkspace.shared.urlForApplication(
            withBundleIdentifier: application.bundleIdentifier
        ) else {
            return nil
        }
        return NSWorkspace.shared.icon(forFile: url.path)
    }
}
