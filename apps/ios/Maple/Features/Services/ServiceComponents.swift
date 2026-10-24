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

/// The dashboard page for a service, for the open-on-web button.
enum ServiceWebLink {
	/// `app.maple.dev` unless the API is pointed elsewhere, in which case the
	/// dashboard host is the API host with its `api` label swapped for `app`.
	static func url(serviceName: String) -> URL? {
		var components = URLComponents()
		components.scheme = "https"
		components.host = "app.maple.dev"
		if let api = AppConfig.apiBaseURL, let host = api.host, host.hasPrefix("api") {
			components.scheme = api.scheme
			components.host = "app" + host.dropFirst(3)
			components.port = api.port
		}
		components.path = "/services/\(serviceName)"
		return components.url
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

/// `OPEN ALERTS 1` / `OPERATIONS 24`: a section label with a muted count and
/// an optional trailing accessory.
struct ServiceSectionHeader<Trailing: View>: View {
	let title: String
	var count: Int? = nil
	@ViewBuilder var trailing: Trailing

	var body: some View {
		HStack(spacing: 6) {
			SectionLabel(title)
				.accessibilityAddTraits(.isHeader)
			if let count {
				Text("\(count)")
					.font(Typo.micro)
					.tabularNumbers()
					.foregroundStyle(Token.mutedForeground)
			}
			Spacer(minLength: 8)
			trailing
		}
	}
}

extension ServiceSectionHeader where Trailing == EmptyView {
	init(title: String, count: Int? = nil) {
		self.init(title: title, count: count) { EmptyView() }
	}
}

/// An open alert on the service: severity rail, rule name, severity and age,
/// the breach against its threshold, a chevron.
struct ServiceIncidentRow: View {
	let card: IncidentCard

	private var incident: AlertIncident { card.incident }

	var body: some View {
		HStack(spacing: 0) {
			Rectangle()
				.fill(incident.severity.tint)
				.frame(width: 2)
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
				Text(
					Format.breach(
						observed: incident.lastObservedValue,
						comparator: incident.comparator,
						threshold: incident.threshold,
						upper: incident.thresholdUpper,
						unit: card.display.unit
					)
				)
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
		}
		.fixedSize(horizontal: false, vertical: true)
		.background(Token.card)
		.clipShape(.rect(cornerRadius: Token.Radius.lg))
		.overlay(
			RoundedRectangle(cornerRadius: Token.Radius.lg)
				.stroke(Token.border, lineWidth: Token.hairline)
		)
		.contentShape(.rect)
		.accessibilityElement(children: .combine)
	}
}
