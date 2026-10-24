import MapleAPI
import SwiftUI

/// One row of the Logs list. Tap expands it in place: the whole body, its
/// attributes, and a jump to the trace that wrote it.
struct LogsListRow: View {
	let log: LogRecord
	@State private var expanded = false

	var body: some View {
		VStack(alignment: .leading, spacing: expanded ? 8 : 4) {
			Button {
				withAnimation(.snappy(duration: 0.2)) { expanded.toggle() }
			} label: {
				VStack(alignment: .leading, spacing: expanded ? 8 : 4) {
					meta
					Text(log.body)
						.font(Typo.small)
						.lineSpacing(3)
						.foregroundStyle(Token.foreground)
						.lineLimit(expanded ? nil : 3)
						.frame(maxWidth: .infinity, alignment: .leading)
				}
				.contentShape(.rect)
			}
			.buttonStyle(.plain)
			.accessibilityHint(expanded ? "Collapses the log" : "Shows attributes")

			if expanded {
				LogsAttributeCard(values: attributes)
					.padding(.top, 4)
				actions
					.padding(.top, 4)
			}
		}
		.padding(.horizontal, 16)
		.padding(.vertical, 10)
		.severityRail(log.severityTint)
		.background(expanded ? Token.card : .clear)
	}

	private var meta: some View {
		HStack(spacing: 8) {
			Text(LogsTimestamp.label(log.timestamp))
				.font(Typo.tiny)
				.tabularNumbers()
				.foregroundStyle(Token.mutedForeground)
			Text(log.severityText.isEmpty ? "LOG" : log.severityText.uppercased())
				.font(Typo.microMedium)
				.foregroundStyle(log.severityTint)
			Spacer(minLength: 8)
			ServiceDot(serviceName: log.serviceName)
			Text(log.serviceName)
				.font(Typo.tiny)
				.foregroundStyle(Token.mutedForeground)
				.lineLimit(1)
		}
	}

	@ViewBuilder private var actions: some View {
		HStack {
			if let traceId = log.traceId, !traceId.isEmpty {
				NavigationLink(value: Route.trace(id: traceId, spanId: log.spanId)) {
					Text("View trace \(traceId.prefix(8))")
						.font(Typo.smallMedium)
						.foregroundStyle(Token.primary)
				}
				.buttonStyle(.plain)
			}
			Spacer()
			Button("Copy") {
				UIPasteboard.general.string = log.body
			}
			.font(Typo.small)
			.foregroundStyle(Token.mutedForeground)
			.buttonStyle(.plain)
			.accessibilityLabel("Copy log body")
		}
	}

	/// Log attributes first, then the resource's, each sorted by key.
	private var attributes: [(key: String, value: String)] {
		let own = log.logAttributes.additionalProperties
		let resource = log.resourceAttributes.additionalProperties.filter { own[$0.key] == nil }
		return own.sorted { $0.key < $1.key } + resource.sorted { $0.key < $1.key }
	}
}

/// The expanded row's key / value table.
private struct LogsAttributeCard: View {
	let values: [(key: String, value: String)]

	var body: some View {
		if !values.isEmpty {
			VStack(spacing: 0) {
				ForEach(Array(values.enumerated()), id: \.offset) { index, entry in
					HStack(alignment: .firstTextBaseline, spacing: 8) {
						Text(entry.key)
							.foregroundStyle(Token.mutedForeground)
							.frame(width: 112, alignment: .leading)
							.lineLimit(2)
						Text(entry.value)
							.foregroundStyle(Token.foreground)
							.frame(maxWidth: .infinity, alignment: .leading)
							.textSelection(.enabled)
					}
					.font(Typo.tiny)
					.padding(.horizontal, 10)
					.padding(.vertical, 8)
					.frame(minHeight: 32)
					if index < values.count - 1 { Hairline() }
				}
			}
			.overlay(
				RoundedRectangle(cornerRadius: Token.Radius.md)
					.stroke(Token.border, lineWidth: Token.hairline)
			)
		}
	}
}

/// `09:41:12.384`: wall-clock time to the millisecond, 24-hour.
enum LogsTimestamp {
	private static let formatter: DateFormatter = {
		let formatter = DateFormatter()
		formatter.locale = Locale(identifier: "en_US_POSIX")
		formatter.dateFormat = "HH:mm:ss.SSS"
		return formatter
	}()

	static func label(_ timestamp: String) -> String {
		guard let date = ResolvedTimeWindow.parse(timestamp) else { return "" }
		return formatter.string(from: date)
	}
}
