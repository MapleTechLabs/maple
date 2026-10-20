import MapleAPI
import SwiftUI

/// A trace with its waterfall already laid out, so the layout runs once per
/// load, off the main thread, rather than on every render.
struct LaidOutTrace: Sendable {
	let trace: TraceDetail
	let rows: [WaterfallRow]
}

@MainActor
@Observable
final class TraceDetailModel {
	private(set) var loader: ScreenLoader<LaidOutTrace>!
	let traceID: String
	let generation: Int
	private let api: any MapleAPI

	init(traceID: String, api: any MapleAPI, session: SessionController) {
		self.traceID = traceID
		self.api = api
		self.generation = session.dataGeneration
		self.loader = ScreenLoader(session: session, screen: Screen.traceDetail) { [unowned self] in
			let trace = try await self.api.trace(id: self.traceID)
			let rows = await Task.detached(priority: .userInitiated) { WaterfallRow.layout(trace) }.value
			return LaidOutTrace(trace: trace, rows: rows)
		}
	}
}

/// `GET /v2/traces/{id}`, the read the web trace page draws. A vertical
/// waterfall: each span a full-width row with its bar indented by depth.
struct TraceDetailView: View {
	let traceID: String
	var initialSpanID: String? = nil

	@Environment(SessionController.self) private var session
	@State private var model: TraceDetailModel?
	@State private var selected: TraceSpan?

	var body: some View {
		ZStack {
			Token.background.ignoresSafeArea()
			LoadableView(
				loader: model?.loader,
				emptyTitle: "Trace not found",
				emptyMessage: "It may be outside retention.",
				skeleton: { DetailSkeleton(leadsWithHeadline: true) }
			) { laidOut in
				TraceContent(trace: laidOut.trace, rows: laidOut.rows, selected: $selected)
			}
		}
		.navigationTitle("Trace")
		.navigationBarTitleDisplayMode(.inline)
		.mapleScreen(Screen.traceDetail)
		.sheet(item: $selected) { span in
			SpanSheet(span: span)
				.presentationDetents([.medium, .large])
				.presentationBackground(Token.background)
		}
		.task(id: session.dataGeneration) {
			let model = model?.generation == session.dataGeneration
				? model! : TraceDetailModel(traceID: traceID, api: session.api, session: session)
			self.model = model
			await model.loader.loadIfNeeded()
			if let initialSpanID, selected == nil,
				let span = model.loader.state.value?.trace.spans.first(where: { $0.id == initialSpanID })
			{
				selected = span
			}
		}
	}
}

private struct TraceContent: View {
	let trace: TraceDetail
	let rows: [WaterfallRow]
	@Binding var selected: TraceSpan?

	private var root: TraceSpan? { rows.first?.span }
	private var errorCount: Int { trace.spans.filter { $0.statusCode == "Error" }.count }

	var body: some View {
		VStack(alignment: .leading, spacing: 20) {
			VStack(alignment: .leading, spacing: 6) {
				Text(root?.name ?? "Trace")
					.font(Typo.title)
					.foregroundStyle(Token.foreground)
					.lineLimit(2)
				Text(trace.id)
					.font(Typo.tiny)
					.foregroundStyle(Token.mutedForeground)
					.lineLimit(1)
					.truncationMode(.middle)
					.textSelection(.enabled)
			}
			.padding(.horizontal, 16)

			StatGrid(columns: 2) {
				StatTile(label: "Duration", value: Format.latency(trace.durationMs))
				StatTile(label: "Spans", value: Format.count(trace.spanCount))
				StatTile(label: "Services", value: Format.count(trace.serviceCount))
				StatTile(
					label: "Errors",
					value: "\(errorCount)",
					tint: errorCount > 0 ? Token.destructive : Token.foreground
				)
			}
			.padding(.horizontal, 16)

			VStack(alignment: .leading, spacing: 10) {
				HStack {
					SectionLabel("Waterfall")
					Spacer()
					if trace.truncated {
						Text("Truncated")
							.font(Typo.micro)
							.foregroundStyle(Token.severityWarn)
					}
				}
				.padding(.horizontal, 16)
				// Lazy: a 10,000-span trace built every row up front and hung for seconds.
				LazyVStack(spacing: 0) {
					ForEach(rows) { row in
						Button { selected = row.span } label: {
							WaterfallRowView(row: row, isSelected: selected?.id == row.id)
						}
						.buttonStyle(RowButtonStyle())
						Hairline()
					}
				}
			}
		}
		.padding(.top, 12)
		.padding(.bottom, 24)
	}
}

private struct WaterfallRowView: View {
	let row: WaterfallRow
	let isSelected: Bool

	/// Past six levels the indent stops growing; the bar still shows timing.
	private var indent: CGFloat { CGFloat(min(row.depth, 6)) * 10 }

	var body: some View {
		VStack(alignment: .leading, spacing: 6) {
			HStack(spacing: 6) {
				ServiceDot(serviceName: row.span.serviceName)
				Text(row.span.name)
					.font(Typo.smallMedium)
					.foregroundStyle(row.isError ? Token.destructive : Token.foreground)
					.lineLimit(1)
				Spacer(minLength: 8)
				Text(Format.latency(row.span.durationMs))
					.font(Typo.tiny)
					.tabularNumbers()
					.foregroundStyle(Token.mutedForeground)
			}
			Text(row.span.serviceName)
				.font(Typo.micro)
				.foregroundStyle(Token.mutedForeground.opacity(0.8))
				.lineLimit(1)
			GeometryReader { proxy in
				let width = proxy.size.width
				ZStack(alignment: .leading) {
					Rectangle().fill(Token.muted.opacity(0.5))
					RoundedRectangle(cornerRadius: 1.5)
						.fill(row.isError ? Token.destructive : ServiceColor.color(for: row.span.serviceName))
						.frame(width: max(width * row.width, 2))
						.offset(x: width * row.offset)
				}
			}
			.frame(height: 4)
		}
		.padding(.leading, 16 + indent)
		.padding(.trailing, 16)
		.padding(.vertical, 10)
		.background(isSelected ? Token.muted.opacity(0.4) : .clear)
		.contentShape(.rect)
	}
}

/// A span's attributes, resource and logs. The logs are the same
/// `searchLogs` read the Logs tab runs, filtered to this trace.
private struct SpanSheet: View {
	let span: TraceSpan

	@Environment(SessionController.self) private var session
	@State private var logs: [LogRecord]?
	@State private var logsFailed = false

	var body: some View {
		ScrollView {
			VStack(alignment: .leading, spacing: 20) {
				VStack(alignment: .leading, spacing: 6) {
					HStack(spacing: 6) {
						ServiceDot(serviceName: span.serviceName)
						Text(span.serviceName)
							.font(Typo.small)
							.foregroundStyle(Token.mutedForeground)
					}
					Text(span.name)
						.font(Typo.monoTitle)
						.foregroundStyle(Token.foreground)
					if let message = span.statusMessage, !message.isEmpty {
						Text(message)
							.font(Typo.small)
							.foregroundStyle(Token.destructive)
					}
				}

				VStack(spacing: 0) {
					DetailRow("Duration", Format.latency(span.durationMs))
					Hairline()
					DetailRow("Status", span.statusCode)
					Hairline()
					DetailRow("Kind", span.kind)
					Hairline()
					DetailRow("Span ID", span.id)
				}

				AttributeTable(title: "Attributes", values: span.attributes.additionalProperties)
				AttributeTable(title: "Resource", values: span.resourceAttributes.additionalProperties)

				VStack(alignment: .leading, spacing: 10) {
					SectionLabel("Logs")
					if logsFailed {
						HStack(spacing: 12) {
							Text("Couldn't load this span's logs.")
								.font(Typo.small)
								.foregroundStyle(Token.mutedForeground)
							Button("Try again") { Task { await loadLogs() } }
								.font(Typo.smallMedium)
								.foregroundStyle(Token.foreground)
						}
					} else if let logs {
						if logs.isEmpty {
							Text("No logs on this span.")
								.font(Typo.small)
								.foregroundStyle(Token.mutedForeground)
						} else {
							VStack(spacing: 0) {
								ForEach(logs, id: \.id) { log in
									LogRowView(log: log)
									Hairline()
								}
							}
						}
					} else {
						SkeletonList(rowHeight: 44, rows: 2)
					}
				}
			}
			.padding(16)
		}
		.task { await loadLogs() }
	}

	/// A failure is kept apart from "no logs", so a broken fetch never reads as an empty span.
	private func loadLogs() async {
		logsFailed = false
		logs = nil
		let window = ResolvedTimeWindow.parse(span.startTime).map {
			ResolvedTimeWindow(start: $0.addingTimeInterval(-300), end: $0.addingTimeInterval(900))
		} ?? TimeWindow.last24Hours.resolve()
		do {
			let page = try await session.api.searchLogs(
				LogSearch(window: window, traceId: span.traceId), limit: 100, cursor: nil
			)
			logs = page.items.filter { $0.spanId == nil || $0.spanId == span.id }
		} catch is CancellationError {
		} catch {
			logsFailed = true
		}
	}
}

/// Key/value pairs in a hairline table, keys sorted so the same span reads the
/// same way every time.
struct AttributeTable: View {
	let title: String
	let values: [String: String]

	var body: some View {
		if !values.isEmpty {
			VStack(alignment: .leading, spacing: 10) {
				SectionLabel(title)
				VStack(spacing: 0) {
					ForEach(values.keys.sorted(), id: \.self) { key in
						HStack(alignment: .firstTextBaseline, spacing: 12) {
							Text(key)
								.font(Typo.tiny)
								.foregroundStyle(Token.mutedForeground)
								.frame(width: 130, alignment: .leading)
								.lineLimit(2)
							Text(values[key] ?? "")
								.font(Typo.tiny)
								.foregroundStyle(Token.foreground)
								.frame(maxWidth: .infinity, alignment: .leading)
								.textSelection(.enabled)
						}
						.padding(.vertical, 8)
						Hairline()
					}
				}
			}
		}
	}
}
