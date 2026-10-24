import MapleAPI
import SwiftUI

/// Formatting the Services screens share, kept local so the app-wide `Format`
/// (which mirrors the web exactly) stays untouched.
enum ServicesFormat {
	/// `1h`, `6h`, `24h`, `7d`: the chip labels and the status line's window.
	static func window(_ window: TimeWindow) -> String {
		switch window {
		case .lastHour: "1h"
		case .last6Hours: "6h"
		case .last24Hours: "24h"
		case .last7Days: "7d"
		}
	}

	/// `41.7 rps`: the design spells throughput out rather than `/s`.
	static func rps(_ perSecond: Double) -> String {
		let text = Format.throughput(perSecond)
		return text.hasSuffix("/s") ? String(text.dropLast(2)) + " rps" : text
	}
}

/// The window chips every Services screen carries: `1h 6h 24h 7d`.
struct WindowChips: View {
	@Binding var window: TimeWindow

	var body: some View {
		SegmentChips(
			options: TimeWindow.allCases.map { ($0, ServicesFormat.window($0)) },
			selection: $window,
			style: .framed
		)
	}
}

/// A local filter field: magnifier glyph, hairline input card.
struct FilterField: View {
	let prompt: String
	@Binding var text: String

	var body: some View {
		HStack(spacing: 8) {
			PixelIcon.magnifier.image
				.resizable()
				.frame(width: 14, height: 14)
				.foregroundStyle(Token.mutedForeground)
			TextField(
				"",
				text: $text,
				prompt: Text(prompt).foregroundStyle(Token.mutedForeground)
			)
			.font(Typo.body)
			.foregroundStyle(Token.foreground)
			.textInputAutocapitalization(.never)
			.autocorrectionDisabled()
			.submitLabel(.search)
			if !text.isEmpty {
				Button {
					text = ""
				} label: {
					PixelIcon.xmark.image
						.resizable()
						.frame(width: 12, height: 12)
						.foregroundStyle(Token.mutedForeground)
				}
				.buttonStyle(.plain)
				.accessibilityLabel("Clear filter")
			}
		}
		.padding(.horizontal, 12)
		.frame(height: 36)
		.background(Token.card, in: .rect(cornerRadius: Token.Radius.lg))
		.overlay(
			RoundedRectangle(cornerRadius: Token.Radius.lg)
				.stroke(Token.input, lineWidth: Token.hairline)
		)
	}
}

/// An open alert on the service: severity rail, rule name, severity and age,
/// the breach against its threshold, a chevron.
struct ServiceIncidentRow: View {
	let card: IncidentCard

	private var incident: AlertIncident { card.incident }

	var body: some View {
		HStack(spacing: 12) {
			VStack(alignment: .leading, spacing: 2) {
				Text(incident.ruleName)
					.font(Typo.bodyMedium)
					.foregroundStyle(Token.foreground)
					.lineLimit(1)
				Text("\(incident.severity.label) · open \(Format.duration(from: incident.firstTriggeredAt))")
					.font(Typo.tiny)
					.tabularNumbers()
					.foregroundStyle(Token.mutedForeground)
					.lineLimit(1)
			}
			.frame(maxWidth: .infinity, alignment: .leading)
			Text(incident.breach(unit: card.display.unit))
				.font(Typo.smallSemibold)
				.tabularNumbers()
				.foregroundStyle(incident.severity.tint)
				.lineLimit(1)
			PixelIcon.chevronRight.image
				.resizable()
				.frame(width: 14, height: 14)
				.foregroundStyle(Token.mutedForeground)
		}
		.padding(.horizontal, 12)
		.padding(.vertical, 10)
		.severityRail(incident.severity.tint)
		.hairlineCard()
		.contentShape(.rect)
		.accessibilityElement(children: .combine)
	}
}
