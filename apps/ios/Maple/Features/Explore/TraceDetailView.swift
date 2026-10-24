import MapleAPI
import SwiftUI
import UIKit

/// A trace with its waterfall already laid out, so the layout runs once per
/// load, off the main thread, rather than on every render.
struct LaidOutTrace: Sendable {
	let trace: TraceDetail
	let rows: [WaterfallRow]
	/// Descendant count per row; a row's subtree is the next `n` rows.
	let subtreeSizes: [Int]
	/// Services in order of first appearance, for the legend.
	let services: [String]

	init(trace: TraceDetail) {
		self.trace = trace
		rows = WaterfallRow.layout(trace)
		subtreeSizes = Self.subtreeSizes(rows)
		var seen = Set<String>()
		services = rows.map(\.span.serviceName).filter { seen.insert($0).inserted }
	}

	/// Rows are depth-first, so a subtree is contiguous: it ends at the first
	/// later row no deeper than its root. One pass with a stack.
	private static func subtreeSizes(_ rows: [WaterfallRow]) -> [Int] {
		var sizes = Array(repeating: 0, count: rows.count)
		var stack: [Int] = []
		for (index, row) in rows.enumerated() {
			while let top = stack.last, rows[top].depth >= row.depth {
				sizes[top] = index - top - 1
				stack.removeLast()
			}
			stack.append(index)
		}
		for top in stack { sizes[top] = rows.count - top - 1 }
		return sizes
	}
}

@MainActor
@Observable
final class TraceDetailModel {
	private(set) var loader: ScreenLoader<LaidOutTrace>!
	let traceID: String
	let generation: Int
	private let api: any MapleAPI

	init(traceID: String, api: any MapleAPI, session: SessionController) {
		self.traceID = traceID
		self.api = api
		self.generation = session.dataGeneration
		self.loader = ScreenLoader(session: session, screen: Screen.traceDetail) { [unowned self] in
			let trace = try await self.api.trace(id: self.traceID)
			return await Task.detached(priority: .userInitiated) { LaidOutTrace(trace: trace) }.value
		}
	}
}

/// `GET /v2/traces/{id}`, the read the web trace page draws: a header, then a
/// vertical waterfall with each span a row indented by depth.
struct TraceDetailView: View {
	let traceID: String
	var initialSpanID: String? = nil

	@Environment(SessionController.self) private var session
	@Environment(\.openURL) private var openURL
	@State private var model: TraceDetailModel?
	@State private var selected: WaterfallRow?

	var body: some View {
		ZStack {
			Token.background.ignoresSafeArea()
			LoadableView(
				loader: model?.loader,
				emptyTitle: "Trace not found",
				emptyMessage: "It may be outside retention.",
				skeleton: { DetailSkeleton(leadsWithHeadline: true) }
			) { laidOut in
				TraceContent(laidOut: laidOut, selected: $selected)
			}
		}
		.navigationTitle("Trace")
		.navigationBarTitleDisplayMode(.inline)
		.toolbar {
			ToolbarItem(placement: .topBarTrailing) {
				Menu {
					Button("Copy trace ID", systemImage: "doc.on.doc") {
						UIPasteboard.general.string = traceID
					}
					Button("Open on web", systemImage: "safari") { openURL(MapleWeb.trace(traceID)) }
				} label: {
					PixelIcon.dotsVertical.image
						.resizable()
						.frame(width: 16, height: 16)
						.foregroundStyle(Token.mutedForeground)
				}
				.accessibilityLabel("More")
			}
		}
		.mapleScreen(Screen.traceDetail)
		.sheet(item: $selected) { row in
			TraceSpanSheet(row: row, traceDurationMs: model?.loader.state.value?.trace.durationMs ?? 0)
				.presentationDetents([.medium, .large])
				.presentationDragIndicator(.visible)
				.presentationBackground(Token.card)
		}
		.task(id: session.dataGeneration) {
			let model = model?.generation == session.dataGeneration
				? model! : TraceDetailModel(traceID: traceID, api: session.api, session: session)
			self.model = model
			await model.loader.loadIfNeeded()
			if let initialSpanID, selected == nil,
				let row = model.loader.state.value?.rows.first(where: { $0.id == initialSpanID })
			{
				selected = row
			}
		}
	}
}

private struct TraceContent: View {
	let laidOut: LaidOutTrace
	@Binding var selected: WaterfallRow?
	/// Span ids whose subtree is folded away.
	@State private var collapsed: Set<String> = []

	private var trace: TraceDetail { laidOut.trace }
	private var hasError: Bool { laidOut.rows.contains(where: \.isError) }

	/// Indices of the rows on screen: a collapsed row skips its subtree.
	private var visible: [Int] {
		var result: [Int] = []
		var index = 0
		while index < laidOut.rows.count {
			result.append(index)
			index += collapsed.contains(laidOut.rows[index].id) ? laidOut.subtreeSizes[index] + 1 : 1
		}
		return result
	}

	var body: some View {
		VStack(alignment: .leading, spacing: 16) {
			header
				.padding(.horizontal, 16)

			VStack(alignment: .leading, spacing: 8) {
				HStack(spacing: 12) {
					SectionLabel("Waterfall")
						.accessibilityAddTraits(.isHeader)
					if trace.truncated {
						Text("Truncated")
							.font(Typo.micro)
							.foregroundStyle(Token.severityWarn)
					}
					Spacer(minLength: 8)
					Text("0 ms")
					Text(Format.latency(trace.durationMs))
				}
				.font(Typo.micro)
				.tabularNumbers()
				.foregroundStyle(Token.mutedForeground)

				// Lazy: a 10,000-span trace built every row up front and hung for seconds.
				LazyVStack(spacing: 0) {
					ForEach(visible, id: \.self) { index in
						row(at: index)
					}
				}
				.background(Token.card, in: .rect(cornerRadius: Token.Radius.lg))
				.clipShape(.rect(cornerRadius: Token.Radius.lg))
				.overlay(
					RoundedRectangle(cornerRadius: Token.Radius.lg)
						.stroke(Token.border, lineWidth: Token.hairline)
				)
			}
			.padding(.horizontal, 16)
		}
		.padding(.top, 8)
		.padding(.bottom, 24)
	}

	private var header: some View {
		VStack(alignment: .leading, spacing: 8) {
			Text(laidOut.rows.first?.span.name ?? "Trace")
				.font(Typo.title)
				.tracking(-0.5)
				.foregroundStyle(Token.foreground)
				.lineLimit(2)
				.accessibilityAddTraits(.isHeader)
			HStack(spacing: 8) {
				if hasError {
					Text("Error")
						.font(Typo.micro)
						.foregroundStyle(Token.destructive)
						.padding(.horizontal, 6)
						.padding(.vertical, 1)
						.overlay(
							RoundedRectangle(cornerRadius: Token.Radius.sm)
								.stroke(Token.destructive, lineWidth: 1)
						)
				}
				(Text(Format.latency(trace.durationMs)).foregroundStyle(Token.foreground)
					+ Text(" · \(countLabel(trace.spanCount, "span")) · \(countLabel(trace.serviceCount, "service"))")
					.foregroundStyle(Token.mutedForeground))
					.font(Typo.small)
					.tabularNumbers()
					.lineLimit(1)
			}
			Text("trace \(Self.shortID(trace.id))")
				.font(Typo.tiny)
				.foregroundStyle(Token.mutedForeground)
				.lineLimit(1)
				.textSelection(.enabled)
				.accessibilityLabel("Trace \(trace.id)")
			WrappingLegendLayout(spacing: 12, lineSpacing: 4) {
				ForEach(laidOut.services, id: \.self) { service in
					HStack(spacing: 6) {
						ServiceDot(serviceName: service)
						Text(service)
							.font(Typo.tiny)
							.foregroundStyle(Token.mutedForeground)
							.lineLimit(1)
					}
				}
			}
			.padding(.top, 4)
		}
	}

	@ViewBuilder private func row(at index: Int) -> some View {
		let row = laidOut.rows[index]
		let children = laidOut.subtreeSizes[index]
		let isCollapsed = collapsed.contains(row.id)
		Button { selected = row } label: {
			TraceWaterfallRow(
				row: row,
				hiddenChildren: isCollapsed ? children : 0,
				isSelected: selected?.id == row.id,
				expand: { collapsed.remove(row.id) }
			)
		}
		.buttonStyle(RowButtonStyle())
		.contextMenu {
			if children > 0 {
				if isCollapsed {
					Button("Expand", systemImage: "chevron.down") { collapsed.remove(row.id) }
				} else {
					Button("Collapse \(countLabel(Double(children), "span"))", systemImage: "chevron.up") {
						collapsed.insert(row.id)
					}
				}
			}
		}
		.accessibilityAction(named: isCollapsed ? "Expand" : "Collapse") {
			guard children > 0 else { return }
			if isCollapsed { collapsed.remove(row.id) } else { collapsed.insert(row.id) }
		}
		if index != laidOut.rows.indices.last { Hairline() }
	}

	/// `4bf92f3577b34da6a3ce…4736`: enough to recognise, short enough for one line.
	private static func shortID(_ id: String) -> String {
		guard id.count > 26 else { return id }
		return "\(id.prefix(20))…\(id.suffix(4))"
	}
}

private func countLabel(_ value: Double, _ noun: String) -> String {
	let count = Int(value.rounded())
	return "\(Format.count(value)) \(noun)\(count == 1 ? "" : "s")"
}

/// One span: tree guides per level, swatch, name, collapsed-children chip and
/// duration, then a bar placed by start offset across the whole trace.
private struct TraceWaterfallRow: View {
	let row: WaterfallRow
	let hiddenChildren: Int
	let isSelected: Bool
	let expand: () -> Void

	/// Past eight levels the indent stops growing; the bar still shows timing.
	private var level: Int { min(row.depth, 8) }
	private static let step: CGFloat = 14
	private static let inset: CGFloat = 12

	private var tint: Color { row.isError ? Token.destructive : ServiceColor.color(for: row.span.serviceName) }

	var body: some View {
		VStack(alignment: .leading, spacing: 6) {
			HStack(spacing: 6) {
				ServiceDot(serviceName: row.span.serviceName)
				Text(row.span.name)
					.font(Typo.small)
					.foregroundStyle(row.isError ? Token.destructive : Token.foreground)
					.lineLimit(1)
					.truncationMode(.middle)
				if hiddenChildren > 0 {
					Button(action: expand) {
						Text("+\(hiddenChildren)")
							.font(Typo.micro)
							.tabularNumbers()
							.foregroundStyle(Token.mutedForeground)
							.padding(.horizontal, 4)
							.background(Token.muted, in: .rect(cornerRadius: Token.Radius.sm))
					}
					.buttonStyle(.plain)
					.accessibilityLabel("Show hidden \(countLabel(Double(hiddenChildren), "span"))")
				}
				Spacer(minLength: 8)
				Text(Format.latency(row.span.durationMs))
					.font(Typo.tiny)
					.tabularNumbers()
					.foregroundStyle(Token.mutedForeground)
			}
			GeometryReader { proxy in
				let width = proxy.size.width
				ZStack(alignment: .leading) {
					Capsule().fill(Token.muted)
					Capsule()
						.fill(tint)
						.frame(width: max(width * row.width, 3))
						.offset(x: min(width * row.offset, max(width - 3, 0)))
				}
			}
			.frame(height: 4)
		}
		.padding(.leading, Self.inset + CGFloat(level) * Self.step)
		.padding(.trailing, 12)
		.frame(minHeight: 42)
		.background(alignment: .leading) {
			ZStack(alignment: .leading) {
				ForEach(0..<level, id: \.self) { depth in
					Rectangle()
						.fill(Token.input)
						.frame(width: 1)
						.offset(x: Self.inset + CGFloat(depth) * Self.step + 6)
				}
			}
		}
		.background(isSelected ? Token.muted : .clear)
		.overlay(alignment: .leading) {
			if isSelected {
				Rectangle()
					.fill(row.isError ? Token.destructive : Token.primary)
					.frame(width: 2)
			}
		}
		.contentShape(.rect)
		.accessibilityElement(children: .combine)
		.accessibilityAddTraits(isSelected ? [.isSelected] : [])
	}
}

/// Key/value pairs in a hairline table, keys sorted so the same span reads the
/// same way every time.
struct AttributeTable: View {
	let title: String
	let values: [String: String]

	var body: some View {
		if !values.isEmpty {
			VStack(alignment: .leading, spacing: 10) {
				SectionLabel(title)
				VStack(spacing: 0) {
					ForEach(values.keys.sorted(), id: \.self) { key in
						HStack(alignment: .firstTextBaseline, spacing: 12) {
							Text(key)
								.font(Typo.tiny)
								.foregroundStyle(Token.mutedForeground)
								.frame(width: 130, alignment: .leading)
								.lineLimit(2)
							Text(values[key] ?? "")
								.font(Typo.tiny)
								.foregroundStyle(Token.foreground)
								.frame(maxWidth: .infinity, alignment: .leading)
								.textSelection(.enabled)
						}
						.padding(.vertical, 8)
						Hairline()
					}
				}
			}
		}
	}
}
