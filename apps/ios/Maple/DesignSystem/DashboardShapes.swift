import SwiftUI

// Shapes ported from the web dashboard so a phone screen and its web
// counterpart share one vocabulary. See REWORK.md, "Shared shapes".

// MARK: - Underline tabs

/// The web's `Overview · Setup · Settings` tabs: text labels over a hairline,
/// the selected one underlined in foreground. Scrolls when it overflows.
struct UnderlineTabs<Option: Hashable>: View {
	let options: [(Option, String)]
	@Binding var selection: Option

	var body: some View {
		ScrollView(.horizontal, showsIndicators: false) {
			HStack(spacing: 20) {
				ForEach(options, id: \.0) { option, label in
					let selected = option == selection
					Button {
						selection = option
					} label: {
						VStack(spacing: 8) {
							Text(label)
								.font(selected ? Typo.smallMedium : Typo.small)
								.foregroundStyle(selected ? Token.foreground : Token.mutedForeground)
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

// MARK: - Percentiles

/// `p50 24ms  p95 118ms  p99 402ms` in the chart palette, the same colours the
/// web services table and latency charts use.
struct PercentileTriplet: View {
	let p50: Double
	let p95: Double
	let p99: Double
	var font: Font = Typo.tiny

	var body: some View {
		HStack(spacing: 10) {
			item("p50", p50, Token.chartP50)
			item("p95", p95, Token.chartP95)
			item("p99", p99, Token.chartP99)
		}
		.accessibilityElement(children: .combine)
	}

	private func item(_ label: String, _ ms: Double, _ tint: Color) -> some View {
		HStack(spacing: 3) {
			Text(label)
				.foregroundStyle(Token.mutedForeground.opacity(0.7))
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
	@ViewBuilder let content: Content

	var body: some View {
		VStack(spacing: 0) {
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
		.background(Token.card, in: .rect(cornerRadius: Token.Radius.lg))
		.clipShape(.rect(cornerRadius: Token.Radius.lg))
		.overlay(
			RoundedRectangle(cornerRadius: Token.Radius.lg)
				.stroke(Token.border, lineWidth: Token.hairline)
		)
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

/// The `+6.2% vs previous hour` line under a stat tile's value.
struct StatDelta: Hashable {
	/// Fractional change, `0.062` for +6.2%.
	let change: Double
	/// Whether an increase is good (throughput) or bad (errors, latency).
	let higherIsBetter: Bool
	let comparison: String

	/// Nil when there is no usable previous value to compare against.
	init?(current: Double, previous: Double?, higherIsBetter: Bool, comparison: String = "vs previous hour") {
		guard let previous, previous > 0, current.isFinite else { return nil }
		self.change = (current - previous) / previous
		self.higherIsBetter = higherIsBetter
		self.comparison = comparison
	}

	var text: String {
		let percent = abs(change) * 100
		let sign = change >= 0 ? "+" : "-"
		let value = percent >= 10 ? String(format: "%.0f", percent) : String(format: "%.1f", percent)
		return "\(sign)\(value)% \(comparison)"
	}

	/// Green when the move is good, red when bad, muted when it is noise.
	var tint: Color {
		if abs(change) < 0.02 { return Token.mutedForeground }
		return (change > 0) == higherIsBetter ? Token.success : Token.destructive
	}
}
