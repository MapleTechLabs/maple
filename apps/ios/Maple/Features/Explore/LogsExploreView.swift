import MapleAPI
import SwiftUI

/// The severity chip's floors, as OTel severity numbers.
enum LogLevelFilter: Int, CaseIterable, Identifiable {
	case all = 0
	case warn = 13
	case error = 17

	var id: Int { rawValue }

	var title: String {
		switch self {
		case .all: "All levels"
		case .warn: "Warn and above"
		case .error: "Error and above"
		}
	}

	/// The chip's value after `severity >=`; nil when unfiltered.
	var chipValue: String? {
		switch self {
		case .all: nil
		case .warn: "warn"
		case .error: "error"
		}
	}

	var tint: Color {
		switch self {
		case .all: Token.foreground
		case .warn: Token.severityWarn
		case .error: Token.severityError
		}
	}
}

struct LogsSnapshot: Sendable {
	var logs: [LogRecord]
	/// Nil when the volume read failed; the list still shows.
	var volume: LogsVolumeBands?
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
			// The list and its histogram share one filter; the histogram is the
			// web Logs page's severity-grouped timeseries.
			async let logs = self.api.searchLogs(search, limit: 100, cursor: nil)
			async let volume = self.api.logVolumeBySeverity(search, targetPoints: 40)
			return LogsSnapshot(logs: try await logs.items, volume: (try? await volume).map(LogsVolumeBands.init))
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

	/// `412 logs`: the histogram's total when it loaded, else the rows on screen.
	var countLabel: String? {
		guard let snapshot = loader.state.value else { return loader.state.hasContent ? "0 logs" : nil }
		let total = snapshot.volume.map(\.total).flatMap { $0 > 0 ? $0 : nil } ?? Double(snapshot.logs.count)
		return "\(Format.count(total)) logs"
	}
}

struct LogsExploreView: View {
	@Environment(SessionController.self) private var session
	@Environment(EnvironmentController.self) private var environments
	@State private var model: LogsExploreModel?

	var body: some View {
		VStack(spacing: 0) {
			if let model {
				@Bindable var model = model
				ExploreFilterBar(prompt: "Search log body", text: $model.text, count: model.countLabel) {
					Task { await model.loader.load(.replace) }
				} chips: {
					ExploreWindowChip(window: $model.window)
					ExploreServiceChip(service: $model.service, services: model.services.names)
					ExploreChip(
						key: model.level == .all ? "severity" : "severity >=",
						value: model.level.chipValue,
						valueTint: model.level.tint,
						clear: { model.level = .all }
					) {
						EmptyView()
					} options: {
						Picker("Severity", selection: $model.level) {
							ForEach(LogLevelFilter.allCases) { Text($0.title).tag($0) }
						}
					}
				}
				.padding(.top, 12)
				LoadableView(
					loader: model.loader,
					emptyTitle: "No logs",
					emptyMessage: "Nothing matches these filters in \(model.window.phrase).",
					skeletonRowHeight: 64
				) { snapshot in
					VStack(alignment: .leading, spacing: 0) {
						if let volume = snapshot.volume, !volume.isEmpty {
							LogsVolumeHistogram(bands: volume)
								.padding(.horizontal, 16)
								.padding(.top, 16)
						}
						Hairline()
							.padding(.top, 16)
						LazyVStack(spacing: 0) {
							ForEach(snapshot.logs) { log in
								LogsListRow(log: log)
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
		.mapleScreen(Screen.logs)
		.task {
			if model == nil {
				model = LogsExploreModel(api: session.api.scoped(toEnvironment: environments.selected), session: session)
			}
		}
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
