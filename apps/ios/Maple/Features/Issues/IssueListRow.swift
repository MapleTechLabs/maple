import MapleAPI
import SwiftUI
import UIKit

/// One row of the triage Errors card: exception type with a `New` badge,
/// the message on one line, then service, event count and age.
struct IssueListRow: View {
	let issue: ErrorIssue

	var body: some View {
		VStack(alignment: .leading, spacing: 5) {
			HStack(spacing: 8) {
				Text(issue.displayTitle)
					.font(Typo.bodyMedium)
					.foregroundStyle(Token.foreground)
					.lineLimit(1)
				if issue.isNew {
					MapleBadge(text: "New", tint: Token.severityWarn, outlined: true)
				}
				Spacer(minLength: 0)
			}

			if let subtitle = issue.displaySubtitle {
				Text(subtitle)
					.font(Typo.small)
					.foregroundStyle(Token.mutedForeground)
					.lineLimit(1)
			}

			HStack(spacing: 6) {
				ServiceDot(serviceName: issue.serviceName)
				Text(issue.serviceName)
					.lineLimit(1)
				Text("·")
				Text(Format.count(issue.occurrenceCount))
					.fixedSize()
				Text("·")
				Text(IssueFormat.ago(issue.lastSeenAt))
					.fixedSize()
				if issue.hasOpenIncident {
					Text("·")
					Text("Incident")
						.foregroundStyle(Token.destructive)
						.fixedSize()
				}
				Spacer(minLength: 0)
			}
			.font(Typo.tiny)
			.tabularNumbers()
			.foregroundStyle(Token.mutedForeground)
		}
		.padding(.horizontal, 14)
		.padding(.vertical, 12)
		.frame(maxWidth: .infinity, minHeight: 84, alignment: .leading)
		.contentShape(.rect)
		.accessibilityElement(children: .combine)
	}
}

extension ErrorIssue {
	/// First seen within the last 24 hours.
	var isNew: Bool {
		guard let first = ResolvedTimeWindow.parse(firstSeenAt) else { return false }
		return Date().timeIntervalSince(first) < 86_400
	}
}

enum IssueFormat {
	/// `just now`, `14m ago`, `3h ago`; dates past a week stay bare.
	static func ago(_ timestamp: String) -> String {
		let terse = Format.lastSeen(timestamp)
		if terse == "now" { return "just now" }
		guard let unit = terse.last, "mhd".contains(unit), terse.dropLast().allSatisfy(\.isNumber) else {
			return terse
		}
		return "\(terse) ago"
	}
}

// MARK: - Swipe actions

/// One action revealed by swiping a `SwipeActionRow` left.
struct SwipeAction: Identifiable {
	let id: String
	let title: String
	let icon: PixelIcon
	let fill: Color
	let tint: Color
	let perform: () -> Void
}

/// A row that reveals trailing actions on a horizontal swipe, inside a plain
/// `ScrollView` where `.swipeActions` (List-only) does not apply. The pan only
/// begins on a mostly horizontal drag, so vertical scrolling is untouched.
struct SwipeActionRow<Content: View>: View {
	let id: String
	@Binding var openID: String?
	let actions: [SwipeAction]
	@ViewBuilder let content: Content

	@State private var dragOffset: CGFloat = 0
	@State private var isDragging = false

	private let actionWidth: CGFloat = 72
	private var revealWidth: CGFloat { actionWidth * CGFloat(actions.count) }
	private var restingOffset: CGFloat { openID == id ? -revealWidth : 0 }
	private var offset: CGFloat {
		isDragging ? min(0, max(-revealWidth * 1.15, restingOffset + dragOffset)) : restingOffset
	}

	var body: some View {
		content
			.background(Token.card)
			.offset(x: offset)
			.background(alignment: .trailing) {
				HStack(spacing: 0) {
					ForEach(actions) { action in
						Button {
							withAnimation(.snappy(duration: 0.25)) { openID = nil }
							action.perform()
						} label: {
							VStack(spacing: 8) {
								action.icon.image
									.resizable()
									.frame(width: 16, height: 16)
								Text(action.title)
									.font(Typo.tinyMedium)
							}
							.foregroundStyle(action.tint)
							.frame(width: actionWidth)
							.frame(maxHeight: .infinity)
							.background(action.fill)
							.overlay(alignment: .leading) {
								Rectangle().fill(Token.border).frame(width: Token.hairline)
							}
						}
						.buttonStyle(.plain)
					}
				}
				.frame(width: max(revealWidth, -offset), alignment: .trailing)
				.opacity(offset < 0 ? 1 : 0)
				// The rotor's custom actions below stand in for the hidden panel.
				.accessibilityHidden(true)
			}
			.clipped()
			.gesture(
				HorizontalPan { phase, translation in
					switch phase {
					case .changed:
						if !isDragging, openID != id {
							withAnimation(.snappy(duration: 0.2)) { openID = nil }
						}
						isDragging = true
						dragOffset = translation
					case .ended:
						let final = restingOffset + translation
						withAnimation(.snappy(duration: 0.25)) {
							isDragging = false
							dragOffset = 0
							openID = final < -actionWidth ? id : (openID == id ? nil : openID)
						}
					}
				}
			)
			.accessibilityActions {
				ForEach(actions) { action in
					Button(action.title, action: action.perform)
				}
			}
	}
}

/// A pan that starts only when the drag is more horizontal than vertical.
private struct HorizontalPan: UIGestureRecognizerRepresentable {
	enum Phase { case changed, ended }
	let onChange: (Phase, CGFloat) -> Void

	init(_ onChange: @escaping (Phase, CGFloat) -> Void) {
		self.onChange = onChange
	}

	func makeCoordinator(converter: CoordinateSpaceConverter) -> Coordinator { Coordinator() }

	func makeUIGestureRecognizer(context: Context) -> UIPanGestureRecognizer {
		let recognizer = UIPanGestureRecognizer()
		recognizer.delegate = context.coordinator
		return recognizer
	}

	func handleUIGestureRecognizerAction(_ recognizer: UIPanGestureRecognizer, context: Context) {
		let translation = recognizer.translation(in: recognizer.view).x
		switch recognizer.state {
		case .changed: onChange(.changed, translation)
		case .ended, .cancelled, .failed: onChange(.ended, translation)
		default: break
		}
	}

	final class Coordinator: NSObject, UIGestureRecognizerDelegate {
		func gestureRecognizerShouldBegin(_ recognizer: UIGestureRecognizer) -> Bool {
			guard let pan = recognizer as? UIPanGestureRecognizer else { return false }
			let velocity = pan.velocity(in: pan.view)
			return abs(velocity.x) > abs(velocity.y) * 1.2
		}
	}
}
