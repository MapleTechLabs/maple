import SwiftUI

// MARK: - Shimmer

/// The one loading pulse. Driven by wall-clock time rather than a per-view
/// `@State`, so every skeleton on screen — and the skeleton that replaces
/// another skeleton a frame later — breathes in the same phase instead of
/// restarting. Honors Reduce Motion by holding still.
private struct Shimmering: ViewModifier {
	@Environment(\.accessibilityReduceMotion) private var reduceMotion

	func body(content: Content) -> some View {
		if reduceMotion {
			content.opacity(0.75)
		} else {
			TimelineView(.animation(minimumInterval: 1.0 / 30)) { context in
				let t = context.date.timeIntervalSinceReferenceDate
				// 1.1s per half-cycle, easing between 0.55 and 1 — the same
				// numbers the old `repeatForever` animation used.
				let phase = (sin(t / 1.1 * .pi) + 1) / 2
				content.opacity(0.55 + 0.45 * phase)
			}
		}
	}
}

extension View {
	func shimmering() -> some View {
		modifier(Shimmering())
	}
}

// MARK: - Blocks

/// A muted rounded rectangle standing in for a run of text or a control.
struct SkeletonBlock: View {
	var width: CGFloat? = nil
	var height: CGFloat = 12
	var emphasis: Double = 1
	var radius: CGFloat = Token.Radius.sm

	var body: some View {
		RoundedRectangle(cornerRadius: radius)
			.fill(Token.muted.opacity(emphasis))
			.frame(width: width, height: height)
	}
}

/// Two lines of text — the title and its caption — at the row's left edge.
private struct SkeletonLines: View {
	let index: Int
	var titleWidth: CGFloat = 120
	var captionWidth: CGFloat = 190

	var body: some View {
		VStack(alignment: .leading, spacing: 8) {
			SkeletonBlock(width: titleWidth + CGFloat((index * 37) % 90), height: 12)
			SkeletonBlock(width: captionWidth + CGFloat((index * 53) % 70), height: 10, emphasis: 0.6)
		}
	}
}

// MARK: - Lists

/// Placeholder rows that match the real row rhythm. `rowHeight` must be the
/// screen's real `minHeight`, or the content shoves the page when it lands.
struct SkeletonList: View {
	var rowHeight: CGFloat = 64
	var rows: Int = 7

	var body: some View {
		VStack(spacing: 0) {
			ForEach(0..<rows, id: \.self) { index in
				SkeletonLines(index: index)
					.frame(maxWidth: .infinity, minHeight: rowHeight, alignment: .leading)
					.padding(.horizontal, 16)
				Hairline()
			}
		}
		.shimmering()
		.accessibilityLabel("Loading")
	}
}

// MARK: - Home

/// Home's shape before Home's data: the four stat tiles, two alert cards and
/// the attention table, at the same paddings as `HomeContent`, so arriving
/// data replaces rather than rearranges.
struct HomeSkeleton: View {
	var body: some View {
		VStack(alignment: .leading, spacing: 28) {
			StatGrid(columns: 2) {
				ForEach(0..<4, id: \.self) { index in
					VStack(alignment: .leading, spacing: 10) {
						SkeletonBlock(width: 64, height: 8, emphasis: 0.6)
						SkeletonBlock(width: 72 + CGFloat(index % 2) * 16, height: 20)
						SkeletonBlock(width: 110, height: 8, emphasis: 0.5)
					}
					.padding(12)
					.frame(maxWidth: .infinity, alignment: .leading)
					.background(Token.card, in: .rect(cornerRadius: Token.Radius.lg))
					.overlay(
						RoundedRectangle(cornerRadius: Token.Radius.lg)
							.stroke(Token.border, lineWidth: Token.hairline)
					)
				}
			}

			section(labelWidth: 96) {
				VStack(spacing: 8) {
					ForEach(0..<2, id: \.self) { index in
						card(index: index)
					}
				}
			}

			section(labelWidth: 120) {
				VStack(spacing: 0) {
					ForEach(0..<3, id: \.self) { index in
						if index > 0 { Hairline() }
						HStack(spacing: 8) {
							RoundedRectangle(cornerRadius: 3).fill(Token.muted).frame(width: 8, height: 8)
							SkeletonBlock(width: 96 + CGFloat((index * 41) % 60), height: 12)
							Spacer(minLength: 8)
							SkeletonBlock(width: 44, height: 12)
							SkeletonBlock(width: 52, height: 12)
						}
						.padding(.horizontal, 12)
						.frame(minHeight: 44)
					}
				}
				.background(Token.card, in: .rect(cornerRadius: Token.Radius.lg))
				.overlay(
					RoundedRectangle(cornerRadius: Token.Radius.lg)
						.stroke(Token.border, lineWidth: Token.hairline)
				)
			}
		}
		.padding(.horizontal, 16)
		.padding(.top, 20)
		.padding(.bottom, 24)
		.shimmering()
		.accessibilityLabel("Loading")
	}

	private func section<Content: View>(labelWidth: CGFloat, @ViewBuilder content: () -> Content) -> some View {
		VStack(alignment: .leading, spacing: 12) {
			SkeletonBlock(width: labelWidth, height: 10, emphasis: 0.6)
			content()
		}
	}

	/// The `IncidentCardView` outline: rail, title + age, service line, breach
	/// beside a sparkline-sized block.
	private func card(index: Int) -> some View {
		VStack(alignment: .leading, spacing: 10) {
			HStack {
				SkeletonBlock(width: 140 + CGFloat(index * 30), height: 12)
				Spacer(minLength: 4)
				SkeletonBlock(width: 28, height: 10, emphasis: 0.6)
			}
			SkeletonBlock(width: 150, height: 14, emphasis: 0.6)
			HStack(alignment: .bottom, spacing: 12) {
				VStack(alignment: .leading, spacing: 4) {
					SkeletonBlock(width: 56, height: 8, emphasis: 0.6)
					SkeletonBlock(width: 96, height: 12)
				}
				Spacer(minLength: 0)
				SkeletonBlock(width: 96, height: 28, emphasis: 0.5)
			}
		}
		.padding(.leading, 16)
		.padding(.trailing, 14)
		.padding(.vertical, 14)
		.background(Token.card)
		.overlay(alignment: .leading) {
			Rectangle().fill(Token.muted).frame(width: 2)
		}
		.clipShape(.rect(cornerRadius: Token.Radius.lg))
		.overlay(
			RoundedRectangle(cornerRadius: Token.Radius.lg)
				.stroke(Token.border, lineWidth: Token.hairline)
		)
	}
}

// MARK: - Detail

/// A detail screen's shape: a section of three stat tiles, then two sections
/// of rows. Used by service, incident, issue, and anomaly detail — they differ
/// in content, not in silhouette.
struct DetailSkeleton: View {
	/// A headline block above the tiles, for screens that lead with one
	/// (incident and anomaly detail).
	var leadsWithHeadline = false
	/// A full-width chart card under the headline (service detail).
	var leadsWithChart = false

	var body: some View {
		VStack(alignment: .leading, spacing: 24) {
			if leadsWithHeadline {
				VStack(alignment: .leading, spacing: 8) {
					SkeletonBlock(width: 200, height: 20)
					SkeletonBlock(width: 260, height: 10, emphasis: 0.6)
				}
				.padding(.horizontal, 16)
			}

			if leadsWithChart {
				VStack(alignment: .leading, spacing: 12) {
					HStack(spacing: 6) {
						ForEach(0..<3, id: \.self) { _ in
							SkeletonBlock(width: 72, height: 24, emphasis: 0.6, radius: 12)
						}
					}
					SkeletonBlock(width: 96, height: 24)
					SkeletonBlock(height: 160, emphasis: 0.4)
				}
				.padding(12)
				.background(Token.card, in: .rect(cornerRadius: Token.Radius.lg))
				.overlay(
					RoundedRectangle(cornerRadius: Token.Radius.lg)
						.stroke(Token.border, lineWidth: Token.hairline)
				)
				.padding(.horizontal, 16)
			}

			VStack(alignment: .leading, spacing: 10) {
				SkeletonBlock(width: 96, height: 10, emphasis: 0.6)
					.padding(.horizontal, 16)
				StatGrid(columns: 3) {
					ForEach(0..<3, id: \.self) { _ in
						VStack(alignment: .leading, spacing: 8) {
							SkeletonBlock(width: 40, height: 10, emphasis: 0.6)
							SkeletonBlock(width: 60, height: 24)
							SkeletonBlock(height: 28, emphasis: 0.5)
						}
						.frame(maxWidth: .infinity, alignment: .leading)
						.padding(.horizontal, 16)
						.padding(.vertical, 14)
						.background(Token.card)
					}
				}
				.padding(.horizontal, 16)
			}

			ForEach(0..<2, id: \.self) { section in
				VStack(alignment: .leading, spacing: 10) {
					SkeletonBlock(width: section == 0 ? 80 : 120, height: 10, emphasis: 0.6)
						.padding(.horizontal, 16)
					VStack(spacing: 0) {
						ForEach(0..<3, id: \.self) { index in
							SkeletonLines(index: index + section * 3, titleWidth: 140, captionWidth: 100)
								.frame(maxWidth: .infinity, minHeight: 56, alignment: .leading)
								.padding(.horizontal, 16)
							Hairline()
						}
					}
				}
			}
		}
		.padding(.vertical, 16)
		.shimmering()
		.accessibilityLabel("Loading")
	}
}
