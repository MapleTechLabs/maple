import SwiftUI

/// A pill filter chip: `Unresolved`, `Open`. Filled while on.
struct FilterChip: View {
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

/// The row of `FilterChip`s under a list screen's tabs.
struct FilterChipBar<Content: View>: View {
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

/// A list screen's list: `TITLE 3` label with a trailing column note, over
/// one hairline card holding the rows.
struct ListCard<Content: View>: View {
	let title: String
	let count: String
	var trailing: String? = nil
	@ViewBuilder let content: Content

	var body: some View {
		VStack(alignment: .leading, spacing: 10) {
			SectionHeader(title: title, count: count, note: trailing)
			LazyVStack(spacing: 0) {
				content
			}
			.hairlineCard()
		}
		.padding(.horizontal, 16)
		.padding(.top, 4)
		.padding(.bottom, 24)
	}
}
