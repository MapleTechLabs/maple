import SwiftUI

/// An uppercase section label with an optional trailing note, over its content.
/// The incident and anomaly screens' one section shape.
struct AlertSection<Content: View>: View {
	let title: String
	var trailing: String? = nil
	@ViewBuilder let content: Content

	var body: some View {
		VStack(alignment: .leading, spacing: 8) {
			HStack(alignment: .firstTextBaseline) {
				SectionLabel(title).accessibilityAddTraits(.isHeader)
				Spacer(minLength: 8)
				if let trailing {
					Text(trailing)
						.font(Typo.tiny)
						.tabularNumbers()
						.foregroundStyle(Token.mutedForeground)
						.lineLimit(1)
				}
			}
			content
		}
		.padding(.horizontal, 16)
	}
}

extension View {
	/// The hairline card the alert screens sit their sections and lists in.
	func alertCard() -> some View {
		background(Token.card, in: .rect(cornerRadius: Token.Radius.lg))
			.clipShape(.rect(cornerRadius: Token.Radius.lg))
			.overlay(
				RoundedRectangle(cornerRadius: Token.Radius.lg)
					.stroke(Token.border, lineWidth: Token.hairline)
			)
	}
}

/// A bordered badge with no fill: `Critical`, `Resolved`.
struct AlertOutlineBadge: View {
	let text: String
	let tint: Color

	var body: some View {
		Text(text)
			.font(Typo.micro)
			.foregroundStyle(tint)
			.padding(.horizontal, 6)
			.frame(height: 18)
			.overlay(
				RoundedRectangle(cornerRadius: Token.Radius.sm)
					.stroke(tint, lineWidth: 1)
			)
			.fixedSize()
	}
}

/// A pill filter chip, the same shape as the Errors segment's filters.
struct TriageFilterChip: View {
	let title: String
	let isOn: Bool
	let action: () -> Void

	var body: some View {
		Button(action: action) {
			Text(title)
				.font(Typo.small)
				.foregroundStyle(isOn ? Token.foreground : Token.mutedForeground)
				.padding(.horizontal, 12)
				.frame(height: 28)
				.background(isOn ? Token.muted : .clear, in: .capsule)
				.overlay(Capsule().stroke(isOn ? Token.input : Token.border, lineWidth: 1))
				.contentShape(.capsule)
		}
		.buttonStyle(.plain)
		.accessibilityAddTraits(isOn ? [.isSelected] : [])
	}
}

/// A list row inside an `alertCard`, with a 2pt severity rail on its leading
/// edge while the thing it describes is still open.
struct SeverityRailRow<Content: View>: View {
	let tint: Color?
	@ViewBuilder let content: Content

	var body: some View {
		content
			.padding(.horizontal, 14)
			.padding(.vertical, 12)
			.frame(maxWidth: .infinity, alignment: .leading)
			.overlay(alignment: .leading) {
				if let tint {
					Rectangle().fill(tint).frame(width: 2)
				}
			}
			.contentShape(.rect)
	}
}

/// A bordered, equal-width action button: `Web`, `Share`.
struct AlertActionLabel: View {
	let title: String
	let icon: PixelIcon

	var body: some View {
		HStack(spacing: 6) {
			icon.image.resizable().frame(width: 14, height: 14)
			Text(title).font(Typo.small)
		}
		.foregroundStyle(Token.foreground)
		.frame(maxWidth: .infinity)
		.frame(height: 40)
		.overlay(
			RoundedRectangle(cornerRadius: Token.Radius.lg)
				.stroke(Token.input, lineWidth: 1)
		)
		.contentShape(.rect)
	}
}

/// The filter chip row under the triage tabs, spaced like the Errors segment's.
struct TriageFilterBar<Content: View>: View {
	@ViewBuilder let content: Content

	var body: some View {
		HStack(spacing: 8) {
			content
			Spacer(minLength: 0)
		}
		.padding(.horizontal, 16)
		.padding(.vertical, 14)
	}
}

/// A triage segment's list: `TITLE 3` label with a trailing column note, over
/// one hairline card holding the rows.
struct TriageListCard<Content: View>: View {
	let title: String
	let count: String
	var trailing: String? = nil
	@ViewBuilder let content: Content

	var body: some View {
		VStack(alignment: .leading, spacing: 10) {
			HStack(alignment: .firstTextBaseline) {
				(Text(title) + Text(" \(count)"))
					.sectionLabelStyle()
					.tabularNumbers()
					.accessibilityAddTraits(.isHeader)
				Spacer()
				if let trailing {
					Text(trailing)
						.font(Typo.tiny)
						.foregroundStyle(Token.mutedForeground)
				}
			}
			LazyVStack(spacing: 0) {
				content
			}
			.alertCard()
		}
		.padding(.horizontal, 16)
		.padding(.top, 4)
		.padding(.bottom, 24)
	}
}
