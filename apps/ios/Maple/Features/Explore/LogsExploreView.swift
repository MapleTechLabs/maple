import MapleAPI
import SwiftUI

/// The minimum-severity chips, as OTel severity numbers.
enum LogLevelFilter: Int, CaseIterable, Identifiable {
	case all = 0
	case warn = 13
	case error = 17

	var id: Int { rawValue }

	var title: String {
		switch self {
		case .all: "All levels"
		case .warn: "Warn+"
		case .error: "Error+"
		}
	}
}

struct LogsSnapshot: Sendable {
	var logs: [LogRecord]
	var volume: [Double]
}

@MainActor
@Observable
final class LogsExploreModel {
	var window: TimeWindow = .lastHour
	var service: String?
	var level: LogLevelFilter = .all
	var text = ""
	let services = ServiceOptions()
	private(set) var loader: ScreenLoader<LogsSnapshot>!
	let api: any MapleAPI

	init(api: any MapleAPI, session: SessionController) {
		self.api = api
		loader = ScreenLoader(session: session, screen: Screen.logs, isEmpty: { $0.logs.isEmpty }) { [unowned self] in
			let search = self.search
			// The list and its volume chart share one filter, as on the web Logs page.
			async let logs = self.api.searchLogs(search, limit: 100, cursor: nil)
			async let volume = self.api.logVolume(search, targetPoints: 40)
			return LogsSnapshot(logs: try await logs.items, volume: (try? await volume) ?? [])
		}
	}

	var search: LogSearch {
		LogSearch(
			window: window.resolve(),
			serviceName: service,
			minimumSeverity: level == .all ? nil : level.rawValue,
			bodySearch: text.trimmingCharacters(in: .whitespaces)
		)
	}

	var queryKey: String { "\(window.rawValue)|\(service ?? "")|\(level.rawValue)" }
}

struct LogsExploreView: View {
	@Environment(SessionController.self) private var session
	@Environment(EnvironmentController.self) private var environments
	@State private var model: LogsExploreModel?

	var body: some View {
		VStack(spacing: 10) {
			if let model {
				@Bindable var model = model
				ExploreSearchField(prompt: "Search log body", text: $model.text) {
					Task { await model.loader.load(.replace) }
				}
				ExploreChipRow(window: $model.window, service: $model.service, services: model.services.names) {
					Menu {
						Picker("Level", selection: $model.level) {
							ForEach(LogLevelFilter.allCases) { Text($0.title).tag($0) }
						}
					} label: {
						FilterChip(label: model.level.title, isOn: model.level != .all, showsMenuIndicator: true)
					}
				}
				Hairline()
				LoadableView(
					loader: model.loader,
					emptyTitle: "No logs",
					emptyMessage: "Nothing matches these filters in \(model.window.phrase).",
					skeletonRowHeight: 52
				) { snapshot in
					VStack(alignment: .leading, spacing: 0) {
						if !snapshot.volume.isEmpty {
							VStack(alignment: .leading, spacing: 8) {
								HStack {
									SectionLabel("Volume")
									Spacer()
									Text("\(Format.count(snapshot.volume.reduce(0, +))) logs")
										.font(Typo.tiny)
										.tabularNumbers()
										.foregroundStyle(Token.mutedForeground)
								}
								VolumeBars(values: snapshot.volume)
									.frame(height: 44)
							}
							.padding(16)
							Hairline()
						}
						LazyVStack(spacing: 0) {
							ForEach(snapshot.logs) { log in
								ExpandableLogRow(log: log)
								Hairline()
							}
						}
					}
				}
				.task(id: model.queryKey) {
					await model.loader.load(model.loader.state.hasContent ? .replace : .initial)
				}
				.task(id: model.window) { await model.services.load(api: model.api, window: model.window) }
			}
		}
		.padding(.top, 10)
		.mapleScreen(Screen.logs)
		.task {
			if model == nil {
				model = LogsExploreModel(api: session.api.scoped(toEnvironment: environments.selected), session: session)
			}
		}
	}
}

/// Volume as bars, the web Logs histogram at phone width.
struct VolumeBars: View {
	let values: [Double]
	var tint: Color = Token.mutedForeground.opacity(0.55)

	var body: some View {
		GeometryReader { proxy in
			let peak = max(values.max() ?? 1, 1)
			HStack(alignment: .bottom, spacing: 2) {
				ForEach(Array(values.enumerated()), id: \.offset) { _, value in
					RoundedRectangle(cornerRadius: 1)
						.fill(tint)
						.frame(height: max(proxy.size.height * value / peak, value > 0 ? 1 : 0))
						.frame(maxWidth: .infinity)
				}
			}
			.frame(maxHeight: .infinity, alignment: .bottom)
		}
		.accessibilityHidden(true)
	}
}

extension LogRecord {
	/// The severity strip colour: the web log table's level tones.
	var severityTint: Color {
		switch Int(severityNumber) {
		case 17...: Token.severityError
		case 13..<17: Token.severityWarn
		case 9..<13: Token.mutedForeground.opacity(0.6)
		default: Token.mutedForeground.opacity(0.3)
		}
	}
}

/// One log line: severity strip, time, service, body.
struct LogRowView: View {
	let log: LogRecord
	var lineLimit: Int? = 2

	var body: some View {
		HStack(alignment: .top, spacing: 10) {
			Rectangle()
				.fill(log.severityTint)
				.frame(width: 2)
			VStack(alignment: .leading, spacing: 4) {
				HStack(spacing: 6) {
					Text(log.severityText.isEmpty ? "LOG" : log.severityText.uppercased())
						.font(Typo.microMedium)
						.foregroundStyle(log.severityTint)
					ServiceDot(serviceName: log.serviceName, size: 6)
					Text(log.serviceName)
						.font(Typo.micro)
						.foregroundStyle(Token.mutedForeground)
						.lineLimit(1)
					Spacer(minLength: 4)
					Text(timeLabel)
						.font(Typo.micro)
						.tabularNumbers()
						.foregroundStyle(Token.mutedForeground.opacity(0.8))
				}
				Text(log.body)
					.font(Typo.small)
					.foregroundStyle(Token.foreground)
					.lineLimit(lineLimit)
					.frame(maxWidth: .infinity, alignment: .leading)
			}
		}
		.padding(.vertical, 8)
		.contentShape(.rect)
	}

	private var timeLabel: String {
		guard let date = ResolvedTimeWindow.parse(log.timestamp) else { return "" }
		return date.formatted(.dateTime.hour().minute().second())
	}
}

/// Tap to expand: the whole body, attributes, and a jump to its trace.
private struct ExpandableLogRow: View {
	let log: LogRecord
	@State private var expanded = false

	var body: some View {
		VStack(alignment: .leading, spacing: 10) {
			Button {
				withAnimation(.snappy(duration: 0.2)) { expanded.toggle() }
			} label: {
				LogRowView(log: log, lineLimit: expanded ? nil : 2)
			}
			.buttonStyle(.plain)

			if expanded {
				VStack(alignment: .leading, spacing: 12) {
					if let traceId = log.traceId {
						NavigationLink(value: Route.trace(id: traceId, spanId: log.spanId)) {
							HStack(spacing: 4) {
								Text("View trace")
								Image(systemName: "arrow.right")
									.font(.system(size: 10, weight: .semibold))
							}
							.font(Typo.smallMedium)
							.foregroundStyle(Token.foreground)
						}
					}
					AttributeTable(title: "Attributes", values: log.logAttributes.additionalProperties)
					AttributeTable(title: "Resource", values: log.resourceAttributes.additionalProperties)
				}
				.padding(.leading, 12)
				.padding(.bottom, 10)
			}
		}
		.padding(.horizontal, 16)
	}
}
