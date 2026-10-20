import MapleAPI
import SwiftUI

/// A filter chip: hairline pill, filled one tonal step when on.
struct FilterChip: View {
	let label: String
	var isOn: Bool = false
	var showsMenuIndicator: Bool = false

	var body: some View {
		HStack(spacing: 4) {
			Text(label)
				.font(isOn ? Typo.smallMedium : Typo.small)
				.lineLimit(1)
			if showsMenuIndicator {
				Image(systemName: "chevron.down")
					.font(.system(size: 8, weight: .semibold))
			}
		}
		.foregroundStyle(isOn ? Token.foreground : Token.mutedForeground)
		.padding(.horizontal, 10)
		.frame(height: 28)
		.background(isOn ? Token.muted : Token.card, in: .rect(cornerRadius: Token.Radius.md))
		.overlay(
			RoundedRectangle(cornerRadius: Token.Radius.md)
				.stroke(Token.border, lineWidth: Token.hairline)
		)
		.fixedSize()
	}
}

/// The service names a filter can pick from: the same `listServices` read the
/// Services tab runs, over the filter's window.
@MainActor
@Observable
final class ServiceOptions {
	private(set) var names: [String] = []
	private var loadedFor: TimeWindow?

	/// Once per window: switching to a longer window offers the services only it saw.
	func load(api: any MapleAPI, window: TimeWindow) async {
		guard loadedFor != window else { return }
		guard let page = try? await api.services(window: window.resolve(), limit: 100) else { return }
		names = page.items.map(\.name).sorted()
		loadedFor = window
	}
}

/// One horizontally scrolling row: window, service, then the segment's own chips.
struct ExploreChipRow<Extra: View>: View {
	@Binding var window: TimeWindow
	@Binding var service: String?
	let services: [String]
	@ViewBuilder let extra: Extra

	var body: some View {
		ScrollView(.horizontal, showsIndicators: false) {
			HStack(spacing: 6) {
				Menu {
					Picker("Time range", selection: $window) {
						ForEach(TimeWindow.allCases) { Text($0.title).tag($0) }
					}
				} label: {
					FilterChip(label: window.title, isOn: true, showsMenuIndicator: true)
				}
				Menu {
					Button("All services") { service = nil }
					Divider()
					ForEach(services, id: \.self) { name in
						Button(name) { service = name }
					}
				} label: {
					FilterChip(label: service ?? "Service", isOn: service != nil, showsMenuIndicator: true)
				}
				extra
			}
			.padding(.horizontal, 16)
		}
	}
}

/// The search field above a segment's chips.
struct ExploreSearchField: View {
	let prompt: String
	@Binding var text: String
	let submit: () -> Void

	var body: some View {
		HStack(spacing: 8) {
			Image(systemName: "magnifyingglass")
				.font(.system(size: 12, weight: .medium))
				.foregroundStyle(Token.mutedForeground)
			TextField(prompt, text: $text)
				.font(Typo.small)
				.foregroundStyle(Token.foreground)
				.textInputAutocapitalization(.never)
				.autocorrectionDisabled()
				.submitLabel(.search)
				.onSubmit(submit)
			if !text.isEmpty {
				Button {
					text = ""
					submit()
				} label: {
					Image(systemName: "xmark.circle.fill")
						.font(.system(size: 13))
						.foregroundStyle(Token.mutedForeground.opacity(0.7))
				}
				.accessibilityLabel("Clear search")
			}
		}
		.padding(.horizontal, 10)
		.frame(height: 36)
		.background(Token.card, in: .rect(cornerRadius: Token.Radius.md))
		.overlay(
			RoundedRectangle(cornerRadius: Token.Radius.md)
				.stroke(Token.input, lineWidth: Token.hairline)
		)
		.padding(.horizontal, 16)
	}
}
