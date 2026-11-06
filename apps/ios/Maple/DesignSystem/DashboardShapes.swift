import SwiftUI

// Shapes ported from the web dashboard so a phone screen and its web
// counterpart share one vocabulary. See REWORK.md, "Shared shapes".

// MARK: - Underline tabs

/// The web's `Overview · Setup · Settings` tabs: text labels over a hairline,
/// the selected one underlined in foreground. Scrolls when it overflows.
struct UnderlineTabs<Option: Hashable>: View {
	let options: [(Option, String)]
	@Binding var selection: Option
	/// An optional count beside a label, such as `Errors 12`. Nil draws none.
	var badge: (Option) -> UnderlineTabBadge? = { _ in nil }

	var body: some View {
		ScrollView(.horizontal, showsIndicators: false) {
			HStack(spacing: 20) {
				ForEach(options, id: \.0) { option, label in
					let selected = option == selection
					Button {
						selection = option
					} label: {
						VStack(spacing: 8) {
							HStack(alignment: .firstTextBaseline, spacing: 6) {
								Text(label)
									.font(selected ? Typo.smallMedium : Typo.small)
									.foregroundStyle(selected ? Token.foreground : Token.mutedForeground)
								if let badge = badge(option) {
									Text(badge.text)
										.font(Typo.tiny)
										.tabularNumbers()
										.foregroundStyle(badge.tint)
								}
							}
							Rectangle()
								.fill(selected ? Token.foreground : .clear)
								.frame(height: 1.5)
						}
						.fixedSize()
						.contentShape(.rect)
					}
					.buttonStyle(.plain)
					.accessibilityAddTraits(selected ? [.isSelected] : [])
				}
			}
			.padding(.horizontal, 16)
		}
		.background(alignment: .bottom) { Hairline() }
		.animation(.easeOut(duration: 0.15), value: selection)
	}
}

/// The count an `UnderlineTabs` label can carry, in its own tint.
struct UnderlineTabBadge {
	let text: String
	var tint: Color = Token.mutedForeground
}

// MARK: - Percentiles

/// `p50 24ms  p95 118ms  p99 402ms` in the chart palette, the same colours the
/// web services table and latency charts use.
struct PercentileTriplet: View {
	let p50: Double
	let p95: Double
	let p99: Double
	var font: Font = Typo.tiny
	/// False drops the `p50`/`p95`/`p99` captions when a header names them.
	var showsLabels = true

	var body: some View {
		HStack(spacing: showsLabels ? 10 : 12) {
			item("p50", p50, Token.chartP50)
			item("p95", p95, Token.chartP95)
			item("p99", p99, Token.chartP99)
		}
		.accessibilityElement(children: .combine)
	}

	private func item(_ label: String, _ ms: Double, _ tint: Color) -> some View {
		HStack(spacing: 3) {
			if showsLabels {
				Text(label)
					.foregroundStyle(Token.mutedForeground.opacity(0.7))
			}
			Text(Format.latency(ms))
				.foregroundStyle(tint)
		}
		.font(font)
		.tabularNumbers()
		.lineLimit(1)
	}
}

// MARK: - Table card

/// The web table at phone width: hairline-bordered card, uppercase header row,
/// hairline dividers between rows. Rows supply their own content.
struct TableCard<Content: View>: View {
	/// Header labels; the first is leading-aligned, the rest trailing.
	let columns: [String]
	/// A widget-style title row above the header. Nil draws none.
	var title: String? = nil
	@ViewBuilder let content: Content

	var body: some View {
		VStack(spacing: 0) {
			if let title {
				Text(title)
					.font(Typo.small)
					.foregroundStyle(Token.foreground)
					.lineLimit(1)
					.frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
					.padding(.horizontal, 12)
					.accessibilityAddTraits(.isHeader)
				Hairline()
			}
			HStack(spacing: 12) {
				ForEach(Array(columns.enumerated()), id: \.offset) { index, column in
					if index == 0 {
						Text(column).sectionLabelStyle()
						Spacer(minLength: 8)
					} else {
						Text(column).sectionLabelStyle()
							.frame(minWidth: 56, alignment: .trailing)
					}
				}
			}
			.padding(.horizontal, 12)
			.frame(height: 32)
			.background(Token.muted.opacity(0.4))
			Hairline()
			Group(subviews: content) { rows in
				ForEach(rows) { row in
					row
					if row.id != rows.last?.id { Hairline() }
				}
			}
		}
		.hairlineCard()
	}
}

/// One table row: leading content, then trailing numeric cells.
struct TableRow<Leading: View, Trailing: View>: View {
	@ViewBuilder let leading: Leading
	@ViewBuilder let trailing: Trailing

	var body: some View {
		HStack(spacing: 12) {
			leading
				.frame(maxWidth: .infinity, alignment: .leading)
			trailing
		}
		.padding(.horizontal, 12)
		.frame(minHeight: 44)
		.contentShape(.rect)
	}
}

/// A trailing numeric cell sized to line up under a `TableCard` header.
struct TableCell: View {
	let text: String
	var tint: Color = Token.foreground

	var body: some View {
		Text(text)
			.font(Typo.small)
			.tabularNumbers()
			.foregroundStyle(tint)
			.lineLimit(1)
			.frame(minWidth: 56, alignment: .trailing)
	}
}

// MARK: - Stat delta

/// The `+6.2% vs prev hour` line under a stat tile's value.
struct StatDelta: Hashable {
	enum Style: Hashable {
		/// Relative change: `+6.2%`.
		case percent
		/// A ratio's change in percentage points: `+0.12 pts` (values are 0-1).
		case points
		/// A latency's absolute change: `-18 ms`.
		case milliseconds
	}

	let current: Double
	let previous: Double
	let style: Style
	/// Whether an increase is good (throughput) or bad (errors, latency).
	let higherIsBetter: Bool
	let comparison: String

	/// Nil when there is no usable previous value to compare against.
	init?(
		current: Double,
		previous: Double?,
		higherIsBetter: Bool,
		style: Style = .percent,
		comparison: String = "vs prev hour"
	) {
		guard let previous, current.isFinite, previous.isFinite else { return nil }
		if style == .percent, previous <= 0 { return nil }
		self.current = current
		self.previous = previous
		self.style = style
		self.higherIsBetter = higherIsBetter
		self.comparison = comparison
	}

	private var change: Double { current - previous }

	/// Relative size of the move, for deciding whether it is noise.
	private var relativeChange: Double {
		previous == 0 ? (current == 0 ? 0 : 1) : change / previous
	}

	var text: String {
		guard !rendersAsZero else { return "no change \(comparison)" }
		let sign = change >= 0 ? "+" : "\u{2212}"
		return "\(sign)\(magnitude) \(comparison)"
	}

	/// The unsigned move at the precision it is shown: `6.2%`, `0.12 pts`, `18ms`.
	private var magnitude: String {
		switch style {
		case .percent:
			let percent = abs(relativeChange) * 100
			return (percent >= 10 ? String(format: "%.0f", percent) : String(format: "%.1f", percent)) + "%"
		case .points:
			return String(format: "%.2f", abs(change) * 100) + " pts"
		case .milliseconds:
			return Format.latency(abs(change))
		}
	}

	/// The move rounds to zero at the shown precision, so `-0.00 pts` never renders.
	private var rendersAsZero: Bool {
		!magnitude.contains { $0.isNumber && $0 != "0" }
	}

	/// Green when the move is good, red when bad, muted when it is noise.
	var tint: Color {
		if abs(relativeChange) < 0.02 { return Token.mutedForeground }
		return (change > 0) == higherIsBetter ? Token.severityInfo : Token.severityError
	}
}
