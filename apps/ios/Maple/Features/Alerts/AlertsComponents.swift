import SwiftUI

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
