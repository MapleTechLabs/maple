import SwiftUI

/// Lays children left to right and wraps to a new line when the row is full:
/// the service legend under a trace header and a chart widget's legend.
struct WrappingLegendLayout: Layout {
	var spacing: CGFloat = 12
	var lineSpacing: CGFloat = 4

	func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
		let rows = lines(width: proposal.width ?? .infinity, subviews: subviews)
		let width = rows.map(\.width).max() ?? 0
		let height = rows.map(\.height).reduce(0, +) + lineSpacing * CGFloat(max(rows.count - 1, 0))
		return CGSize(width: width, height: height)
	}

	func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
		var y = bounds.minY
		for line in lines(width: bounds.width, subviews: subviews) {
			var x = bounds.minX
			for index in line.indices {
				let size = subviews[index].sizeThatFits(.unspecified)
				subviews[index].place(
					at: CGPoint(x: x, y: y + (line.height - size.height) / 2),
					proposal: ProposedViewSize(size)
				)
				x += size.width + spacing
			}
			y += line.height + lineSpacing
		}
	}

	private struct Line {
		var indices: [Int] = []
		var width: CGFloat = 0
		var height: CGFloat = 0
	}

	private func lines(width: CGFloat, subviews: Subviews) -> [Line] {
		var lines: [Line] = []
		var current = Line()
		for index in subviews.indices {
			let size = subviews[index].sizeThatFits(.unspecified)
			let needed = current.indices.isEmpty ? size.width : current.width + spacing + size.width
			if needed > width, !current.indices.isEmpty {
				lines.append(current)
				current = Line()
			}
			current.width = current.indices.isEmpty ? size.width : current.width + spacing + size.width
			current.height = max(current.height, size.height)
			current.indices.append(index)
		}
		if !current.indices.isEmpty { lines.append(current) }
		return lines
	}
}
