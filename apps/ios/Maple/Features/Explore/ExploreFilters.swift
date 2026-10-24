import MapleAPI
import SwiftUI

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

extension TimeWindow {
	/// The window chip's compact label: `Last 1h`.
	var chipTitle: String {
		switch self {
		case .lastHour: "Last 1h"
		case .last6Hours: "Last 6h"
		case .last24Hours: "Last 24h"
		case .last7Days: "Last 7d"
		}
	}
}

/// The query card above a segment's chips: magnifier, search text, result count.
struct ExploreQueryBar: View {
	let prompt: String
	@Binding var text: String
	/// `412 logs`; nil while nothing has loaded.
	let count: String?
	let submit: () -> Void

	var body: some View {
		HStack(spacing: 8) {
			PixelIcon.magnifier.image
				.resizable()
				.frame(width: 16, height: 16)
				.foregroundStyle(Token.mutedForeground)
				.accessibilityHidden(true)
			TextField(prompt, text: $text)
				.font(Typo.bodyQuery)
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
					PixelIcon.xmark.image
						.resizable()
						.frame(width: 12, height: 12)
						.foregroundStyle(Token.mutedForeground)
						.frame(width: 24, height: 24)
				}
				.accessibilityLabel("Clear search")
			}
			if let count {
				Text(count)
					.font(Typo.tiny)
					.tabularNumbers()
					.foregroundStyle(Token.mutedForeground)
					.lineLimit(1)
			}
		}
		.padding(.horizontal, 12)
		.frame(height: 40)
		.background(Token.card, in: .rect(cornerRadius: Token.Radius.lg))
		.overlay(
			RoundedRectangle(cornerRadius: Token.Radius.lg)
				.stroke(Token.input, lineWidth: Token.hairline)
		)
	}
}

private extension Typo {
	/// The query text: Geist Mono at 13, between body and small.
	static let bodyQuery = Font.custom(Typo.bodyFamily, size: 13)
}

/// A filter chip. Unset it reads `key ⌄` and opens its menu; set it reads
/// `key value ×`, filled one tonal step, and the cross clears it.
struct ExploreChip<Leading: View, Options: View>: View {
	let key: String
	var value: String? = nil
	var valueTint: Color = Token.foreground
	/// Clears the filter; nil for chips that are always set (the time window).
	var clear: (() -> Void)? = nil
	@ViewBuilder var leading: Leading
	@ViewBuilder var options: Options

	var body: some View {
		HStack(spacing: 6) {
			Menu {
				options
			} label: {
				HStack(spacing: 6) {
					leading
					Text(key)
						.foregroundStyle(clear == nil ? Token.foreground : Token.mutedForeground)
					if let value {
						Text(value).foregroundStyle(valueTint)
					}
					if clear == nil || value == nil {
						PixelIcon.chevronDown.image
							.resizable()
							.frame(width: 12, height: 12)
							.foregroundStyle(Token.mutedForeground)
					}
				}
				.font(Typo.tiny)
				.lineLimit(1)
			}
			if let clear, value != nil {
				Button(action: clear) {
					PixelIcon.xmark.image
						.resizable()
						.frame(width: 12, height: 12)
						.foregroundStyle(Token.mutedForeground)
						.frame(width: 20, height: 28)
						.contentShape(.rect)
				}
				.accessibilityLabel("Clear \(key) filter")
			}
		}
		.padding(.leading, 10)
		.padding(.trailing, clear != nil && value != nil ? 2 : 10)
		.frame(height: 28)
		.background(isSet ? Token.muted : .clear, in: .rect(cornerRadius: Token.Radius.md))
		.overlay(
			RoundedRectangle(cornerRadius: Token.Radius.md)
				.stroke(isSet ? Token.border : Token.input, lineWidth: Token.hairline)
		)
		.fixedSize()
	}

	private var isSet: Bool { clear != nil && value != nil }
}

/// The time window chip every Explore segment leads with.
struct ExploreWindowChip: View {
	@Binding var window: TimeWindow

	var body: some View {
		ExploreChip(key: window.chipTitle) {
			EmptyView()
		} options: {
			Picker("Time range", selection: $window) {
				ForEach(TimeWindow.allCases) { Text($0.title).tag($0) }
			}
		}
		.accessibilityLabel("Time range, \(window.title)")
	}
}

/// `service checkout ×`: the picked service's swatch and name, or `service ⌄` to pick one.
struct ExploreServiceChip: View {
	@Binding var service: String?
	let services: [String]

	var body: some View {
		ExploreChip(key: "service", value: service, clear: { service = nil }) {
			if let service { ServiceDot(serviceName: service) }
		} options: {
			Button("All services") { service = nil }
			Divider()
			ForEach(services, id: \.self) { name in
				Button(name) { service = name }
			}
		}
	}
}

/// A boolean chip (`errors only`): tap toggles, filled while on.
struct ExploreToggleChip: View {
	let label: String
	@Binding var isOn: Bool

	var body: some View {
		Button {
			isOn.toggle()
		} label: {
			HStack(spacing: 6) {
				Text(label)
					.font(Typo.tiny)
					.foregroundStyle(isOn ? Token.foreground : Token.mutedForeground)
				if isOn {
					PixelIcon.xmark.image
						.resizable()
						.frame(width: 12, height: 12)
						.foregroundStyle(Token.mutedForeground)
				}
			}
			.padding(.horizontal, 10)
			.frame(height: 28)
			.background(isOn ? Token.muted : .clear, in: .rect(cornerRadius: Token.Radius.md))
			.overlay(
				RoundedRectangle(cornerRadius: Token.Radius.md)
					.stroke(isOn ? Token.border : Token.input, lineWidth: Token.hairline)
			)
			.fixedSize()
		}
		.buttonStyle(.plain)
		.accessibilityAddTraits(isOn ? .isSelected : [])
	}
}

/// The query bar and its chips, which wrap to a second line when full.
struct ExploreFilterBar<Chips: View>: View {
	let prompt: String
	@Binding var text: String
	let count: String?
	let submit: () -> Void
	@ViewBuilder let chips: Chips

	var body: some View {
		VStack(alignment: .leading, spacing: 8) {
			ExploreQueryBar(prompt: prompt, text: $text, count: count, submit: submit)
			WrappingLegendLayout(spacing: 6, lineSpacing: 6) {
				chips
			}
			.frame(maxWidth: .infinity, alignment: .leading)
		}
		.padding(.horizontal, 16)
	}
}
