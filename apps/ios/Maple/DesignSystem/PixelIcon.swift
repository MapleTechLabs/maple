import SwiftUI

/// The Nucleo pixel glyphs the web dashboard uses, as template vectors in
/// `Assets.xcassets/Pixel`. Tint with `foregroundStyle`.
enum PixelIcon: String, CaseIterable {
	case house
	case layers
	case bell
	case chartLine = "chart-line"
	case magnifier
	case chevronDown = "chevron-down"
	case chevronRight = "chevron-right"
	case externalLink = "external-link"
	case dotsVertical = "dots-vertical"
	case circleCheck = "circle-check"
	case user
	case chatBubbleSparkle = "chat-bubble-sparkle"
	case upload
	case xmark
	case arrowLeft = "arrow-left"
	case copy

	var assetName: String { "Pixel/\(rawValue)" }

	var image: Image { Image(assetName) }
}
