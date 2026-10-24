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
		VStack(spacing: 0) {
			if let model {
				@Bindable var model = model
				ExploreFilterBar(prompt: "Search span name", text: $model.spanName, count: countLabel(model)) {
					Task { await model.loader.load(.replace) }
				} chips: {
					ExploreWindowChip(window: $model.window)
					ExploreServiceChip(service: $model.service, services: model.services.names)
					ExploreToggleChip(label: "errors only", isOn: $model.errorsOnly)
					ExploreToggleChip(label: "duration > 1s", isOn: $model.slowOnly)
				}
				.padding(.top, 12)
				Hairline()
					.padding(.top, 16)
				LoadableView(
					loader: model.loader,
					emptyTitle: "No traces",
					emptyMessage: "Nothing matches these filters in \(model.window.phrase).",
					skeletonRowHeight: 60
				) { traces in
					LazyVStack(spacing: 0) {
						ForEach(traces) { trace in
							NavigationLink(value: Route.trace(id: trace.id)) {
								TracesListRow(trace: trace)
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
		.mapleScreen(Screen.traces)
		.task {
			if model == nil {
				model = TracesExploreModel(api: session.api.scoped(toEnvironment: environments.selected), session: session)
			}
		}
	}

	/// `50 traces`, the page on screen; nil until something has loaded.
	private func countLabel(_ model: TracesExploreModel) -> String? {
		guard model.loader.state.hasContent else { return nil }
		let count = model.loader.state.value?.count ?? 0
		return "\(count) traces"
	}
}

/// One trace: the logs row's vocabulary. Error strip, service swatch and root
/// span, duration in its latency tone, then `trace id · age` and the status.
private struct TracesListRow: View {
	let trace: TraceSummary

	var body: some View {
		VStack(alignment: .leading, spacing: 4) {
			HStack(spacing: 8) {
				ServiceDot(serviceName: trace.rootServiceName)
				Text(trace.rootSpanName)
					.font(Typo.small)
					.foregroundStyle(Token.foreground)
					.lineLimit(1)
				Spacer(minLength: 8)
				Text(Format.latency(trace.durationMs))
					.font(Typo.smallMedium)
					.tabularNumbers()
					.foregroundStyle(Tone.latency(trace.durationMs, scale: .p95))
			}
			HStack(spacing: 8) {
				Text("\(trace.id.prefix(8)) · \(Format.ago(trace.startTime))")
					.foregroundStyle(Token.mutedForeground)
					.lineLimit(1)
				Spacer(minLength: 8)
				if let status = statusLabel {
					Text(status)
						.foregroundStyle(trace.rootHasError ? Token.severityError : Token.mutedForeground)
				}
			}
			.font(Typo.tiny)
			.tabularNumbers()
		}
		.padding(.horizontal, 16)
		.padding(.vertical, 10)
		.severityRail(trace.rootHasError ? Token.severityError : nil)
		.contentShape(.rect)
	}

	/// The HTTP status when there is one, else `error` for a failed root.
	private var statusLabel: String? {
		if let status = trace.httpStatusCode, !status.isEmpty { return status }
		return trace.rootHasError ? "error" : nil
	}
}
