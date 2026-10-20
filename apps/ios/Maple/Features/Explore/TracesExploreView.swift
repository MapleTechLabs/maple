import MapleAPI
import SwiftUI

@MainActor
@Observable
final class TracesExploreModel {
	var window: TimeWindow = .lastHour
	var service: String?
	var errorsOnly = false
	var slowOnly = false
	var spanName = ""
	let services = ServiceOptions()
	private(set) var loader: ScreenLoader<[TraceSummary]>!
	let api: any MapleAPI

	/// The "Slow" chip's floor. One second is where the web's latency tone turns warn.
	static let slowThresholdMs = 1000.0

	init(api: any MapleAPI, session: SessionController) {
		self.api = api
		loader = ScreenLoader(session: session, screen: Screen.traces, isEmpty: { $0.isEmpty }) { [unowned self] in
			try await self.api.searchTraces(self.search, limit: 50, cursor: nil).items
		}
	}

	/// `POST /v2/traces/search` with root spans only, the web Traces page's default.
	var search: TraceSearch {
		TraceSearch(
			window: window.resolve(),
			serviceName: service,
			errorsOnly: errorsOnly,
			minDurationMs: slowOnly ? Self.slowThresholdMs : nil,
			spanName: spanName.trimmingCharacters(in: .whitespaces)
		)
	}

	/// Changes that alter the query, so the view reloads on any of them.
	var queryKey: String { "\(window.rawValue)|\(service ?? "")|\(errorsOnly)|\(slowOnly)" }
}

struct TracesExploreView: View {
	@Environment(SessionController.self) private var session
	@Environment(EnvironmentController.self) private var environments
	@State private var model: TracesExploreModel?

	var body: some View {
		VStack(spacing: 10) {
			if let model {
				@Bindable var model = model
				ExploreSearchField(prompt: "Span name", text: $model.spanName) {
					Task { await model.loader.load(.replace) }
				}
				ExploreChipRow(window: $model.window, service: $model.service, services: model.services.names) {
					Button { model.errorsOnly.toggle() } label: { FilterChip(label: "Errors", isOn: model.errorsOnly) }
						.buttonStyle(.plain)
					Button { model.slowOnly.toggle() } label: { FilterChip(label: "Slow > 1s", isOn: model.slowOnly) }
						.buttonStyle(.plain)
				}
				Hairline()
				LoadableView(
					loader: model.loader,
					emptyTitle: "No traces",
					emptyMessage: "Nothing matches these filters in \(model.window.phrase).",
					skeletonRowHeight: 56
				) { traces in
					LazyVStack(spacing: 0) {
						ForEach(traces) { trace in
							NavigationLink(value: Route.trace(id: trace.id)) {
								TraceRow(trace: trace)
							}
							.buttonStyle(RowButtonStyle())
							Hairline()
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
		.mapleScreen(Screen.traces)
		.task {
			if model == nil {
				model = TracesExploreModel(api: session.api.scoped(toEnvironment: environments.selected), session: session)
			}
		}
	}
}

private struct TraceRow: View {
	let trace: TraceSummary

	var body: some View {
		HStack(spacing: 12) {
			Rectangle()
				.fill(trace.rootHasError ? Token.destructive : .clear)
				.frame(width: 2)
			VStack(alignment: .leading, spacing: 4) {
				HStack(spacing: 6) {
					ServiceDot(serviceName: trace.rootServiceName)
					Text(trace.rootSpanName)
						.font(Typo.smallMedium)
						.foregroundStyle(Token.foreground)
						.lineLimit(1)
				}
				HStack(spacing: 8) {
					Text(trace.rootServiceName)
					if let status = trace.httpStatusCode {
						Text(status)
							.foregroundStyle(trace.rootHasError ? Token.destructive : Token.mutedForeground)
					}
					Text(Format.lastSeen(trace.startTime))
				}
				.font(Typo.tiny)
				.tabularNumbers()
				.foregroundStyle(Token.mutedForeground)
				.lineLimit(1)
			}
			Spacer(minLength: 8)
			Text(Format.latency(trace.durationMs))
				.font(Typo.smallSemibold)
				.tabularNumbers()
				.foregroundStyle(Tone.latency(trace.durationMs, scale: .p95))
		}
		.padding(.trailing, 16)
		.frame(minHeight: 56)
		.contentShape(.rect)
	}
}
