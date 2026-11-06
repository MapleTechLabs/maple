import MapleAPI
import SwiftUI

/// A span's attributes, resource and logs, in a sheet over the waterfall. The
/// logs are the same `searchLogs` read the Logs tab runs, filtered to this span.
struct TraceSpanSheet: View {
	let row: WaterfallRow
	let traceDurationMs: Double

	private enum Tab: Hashable { case attributes, resource, logs }

	@Environment(SessionController.self) private var session
	@State private var tab: Tab = .attributes
	@State private var logs: [LogRecord]?
	@State private var logsFailed = false

	private var span: TraceSpan { row.span }

	var body: some View {
		ScrollView {
			VStack(alignment: .leading, spacing: 0) {
				VStack(alignment: .leading, spacing: 4) {
					HStack(spacing: 8) {
						ServiceDot(serviceName: span.serviceName)
						Text(span.name)
							.font(Typo.bodyMedium)
							.foregroundStyle(row.isError ? Token.destructive : Token.foreground)
							.lineLimit(2)
							.accessibilityAddTraits(.isHeader)
						Spacer(minLength: 8)
						Text(Format.latency(span.durationMs))
							.font(Typo.small)
							.tabularNumbers()
							.foregroundStyle(Token.foreground)
					}
					Text(meta)
						.font(Typo.tiny)
						.tabularNumbers()
						.foregroundStyle(Token.mutedForeground)
						.lineLimit(1)
				}
				.padding(.horizontal, 16)
				.padding(.top, 20)

				UnderlineTabs(options: tabs, selection: $tab)
					.padding(.top, 12)

				Group {
					switch tab {
					case .attributes: KeyValueList(rows: attributeRows)
					case .resource: KeyValueList(rows: span.resourceAttributes.additionalProperties.sorted { $0.key < $1.key }.map {
						KeyValue(key: $0.key, value: $0.value)
					})
					case .logs: logsList
					}
				}
				.padding(.horizontal, 16)
			}
			.padding(.bottom, 24)
		}
		.task { await loadLogs() }
	}

	/// `checkout · client · starts at +1.20s`.
	private var meta: String {
		let start = row.offset * traceDurationMs
		return [span.serviceName, span.kind.lowercased(), "starts at +\(Format.latency(start))"]
			.filter { !$0.isEmpty }
			.joined(separator: " · ")
	}

	private var tabs: [(Tab, String)] {
		[
			(.attributes, "Attributes"),
			(.resource, "Resource"),
			(.logs, logs.map { "Logs \($0.count)" } ?? "Logs"),
		]
	}

	/// Status and identity first, then the span's own attributes by key.
	private var attributeRows: [KeyValue] {
		var rows = [KeyValue(key: "status", value: span.statusCode, isError: row.isError)]
		if let message = span.statusMessage, !message.isEmpty {
			rows.append(KeyValue(key: "status.message", value: message, isError: row.isError))
		}
		rows.append(KeyValue(key: "span.id", value: span.id))
		rows += span.attributes.additionalProperties.sorted { $0.key < $1.key }.map { key, value in
			KeyValue(
				key: key,
				value: value,
				isError: row.isError && (key.hasPrefix("error.") || key.hasPrefix("exception."))
			)
		}
		return rows
	}

	@ViewBuilder private var logsList: some View {
		if logsFailed {
			HStack(spacing: 12) {
				Text("Couldn't load this span's logs.")
					.font(Typo.small)
					.foregroundStyle(Token.mutedForeground)
				Button("Try again") { Task { await loadLogs() } }
					.font(Typo.smallMedium)
					.foregroundStyle(Token.foreground)
			}
			.padding(.vertical, 12)
		} else if let logs {
			if logs.isEmpty {
				Text("No logs on this span.")
					.font(Typo.small)
					.foregroundStyle(Token.mutedForeground)
					.padding(.vertical, 12)
			} else {
				LazyVStack(spacing: 0) {
					ForEach(logs, id: \.id) { log in
						LogsListRow(log: log, showsTrace: false)
						Hairline()
					}
				}
				// Rows bleed to the sheet's edges, as on the Logs list.
				.padding(.horizontal, -16)
			}
		} else {
			SkeletonList(rowHeight: 44, rows: 2)
		}
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

private struct KeyValue: Identifiable {
	let key: String
	let value: String
	var isError = false
	var id: String { key }
}

/// Key muted on the left, value on the right, hairline under each row.
private struct KeyValueList: View {
	let rows: [KeyValue]

	var body: some View {
		if rows.isEmpty {
			Text("Nothing recorded.")
				.font(Typo.small)
				.foregroundStyle(Token.mutedForeground)
				.padding(.vertical, 12)
		} else {
			LazyVStack(spacing: 0) {
				ForEach(rows) { row in
					HStack(alignment: .firstTextBaseline, spacing: 12) {
						Text(row.key)
							.foregroundStyle(Token.mutedForeground)
							.lineLimit(2)
						Spacer(minLength: 8)
						Text(row.value)
							.foregroundStyle(row.isError ? Token.destructive : Token.foreground)
							.multilineTextAlignment(.trailing)
							.lineLimit(4)
							.textSelection(.enabled)
					}
					.font(Typo.small)
					.padding(.vertical, 8)
					.frame(minHeight: 32)
					.accessibilityElement(children: .combine)
					Hairline()
				}
			}
		}
	}
}
