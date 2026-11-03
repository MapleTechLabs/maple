import SwiftUI

/// The environment pill opposite the organization pill on every tab root.
/// Hidden when the organization reports fewer than two environments: a control
/// with one option is not a choice.
struct EnvironmentPickerView: View {
	@Environment(EnvironmentController.self) private var environments

	var body: some View {
		if environments.canSwitch {
			Menu {
				Picker("Environment", selection: selection) {
					// The whole organization, and the state an install starts
					// in. First so it is where the thumb lands when backing out
					// of a filter.
					Text("All environments").tag(String?.none)
					ForEach(environments.available, id: \.self) { environment in
						Text(environment).tag(String?.some(environment))
					}
				}
			} label: {
				HStack(spacing: 6) {
					Circle()
						.fill(environments.selected == nil ? Token.mutedForeground : Token.success)
						.frame(width: 6, height: 6)
					Text(environments.selected ?? "All envs")
						.font(Typo.small)
						.foregroundStyle(Token.mutedForeground)
						.lineLimit(1)
						.truncationMode(.tail)
					PixelIcon.chevronDown.image
						.resizable()
						.frame(width: 12, height: 12)
						.foregroundStyle(Token.mutedForeground)
				}
				.padding(.horizontal, 12)
				.frame(height: 36)
				.overlay(RoundedRectangle(cornerRadius: Token.Radius.lg).stroke(Token.border, lineWidth: Token.hairline))
				.frame(maxWidth: 150, alignment: .trailing)
			}
			.accessibilityLabel("Filter by environment")
			.accessibilityValue(environments.selected ?? "All environments")
		}
	}

	/// Writes through the controller rather than binding to its property: the
	/// selection has to be persisted and published to the widgets, and a plain
	/// binding would set the value and do neither.
	private var selection: Binding<String?> {
		Binding(
			get: { environments.selected },
			set: { environments.select($0) }
		)
	}
}
