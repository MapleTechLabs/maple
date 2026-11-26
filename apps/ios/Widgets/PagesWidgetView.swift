import AppIntents
import MapleWidgetData
import SwiftUI
import WidgetKit

/// The Pages widget, in every family it supports.
///
/// One glance has to answer "is anything waiting on me": so the order is the
/// state, the incident, the number, then who is paged next and the button. The
/// amber appears once, on the Acknowledge that answers the first page.
struct PagesWidgetView: View {
	let entry: PagesEntry

	@Environment(\.widgetFamily) private var family

	var body: some View {
		switch family {
		case .accessoryInline: InlinePagesView(entry: entry)
		case .accessoryRectangular: RectangularPagesView(entry: entry)
		case .systemSmall: SmallPagesView(entry: entry)
		default: MediumPagesView(entry: entry)
		}
	}
}

// MARK: - Home Screen

private struct SmallPagesView: View {
	let entry: PagesEntry

	var body: some View {
		PagesFrame(entry: entry) { snapshot in
			if let page = snapshot.waiting.first {
				VStack(alignment: .leading, spacing: 0) {
					PagesHeader(title: "Paging you", tint: Token.destructive)
					Text(page.ruleName)
						.font(Typo.smallMedium)
						.foregroundStyle(Token.foreground)
						.lineLimit(1)
						.padding(.top, 8)
					BreachLine(page: page)
						.padding(.top, 2)
					Spacer(minLength: 4)
					NextPageLine(page: page, now: entry.date, extra: snapshot.waiting.count - 1)
						.padding(.bottom, 6)
					PageAction(page: page, entry: entry, isPrimary: true, fillsWidth: true)
				}
			} else {
				QuietPagesView(snapshot: snapshot, now: entry.date, needsApp: entry.needsApp)
			}
		}
		.widgetURL(PagesWidgetKind.incidentsListURL(organizationId: entry.organizationId))
	}
}

private struct MediumPagesView: View {
	let entry: PagesEntry

	var body: some View {
		PagesFrame(entry: entry) { snapshot in
			let waiting = snapshot.waiting
			if waiting.count == 1, let page = waiting.first {
				single(page, snapshot: snapshot)
			} else if !waiting.isEmpty {
				several(waiting, snapshot: snapshot)
			} else {
				QuietPagesView(snapshot: snapshot, now: entry.date, needsApp: entry.needsApp)
			}
		}
		.widgetURL(PagesWidgetKind.incidentsListURL(organizationId: entry.organizationId))
	}

	/// One page gets the room: the incident and its number, then the answer.
	private func single(_ page: PagesSnapshot.Page, snapshot: PagesSnapshot) -> some View {
		VStack(alignment: .leading, spacing: 0) {
			HStack(alignment: .firstTextBaseline) {
				PagesHeader(title: "Paging you", tint: Token.destructive)
				Spacer()
				Text(snapshot.waitingLabel)
					.font(Typo.micro)
					.foregroundStyle(Token.mutedForeground)
			}
			Link(destination: incidentURL(page)) {
				HStack(alignment: .top) {
					VStack(alignment: .leading, spacing: 3) {
						Text(page.ruleName)
							.font(Typo.bodyMedium)
							.foregroundStyle(Token.foreground)
							.lineLimit(1)
						Text(page.group ?? "All services")
							.font(Typo.tiny)
							.foregroundStyle(Token.mutedForeground)
							.lineLimit(1)
					}
					Spacer(minLength: 8)
					VStack(alignment: .trailing, spacing: 3) {
						Text(page.value)
							.font(Typo.statValue)
							.tabularNumbers()
							.foregroundStyle(page.tint)
							.lineLimit(1)
						Text(page.threshold)
							.font(Typo.micro)
							.tabularNumbers()
							.foregroundStyle(Token.mutedForeground)
					}
				}
			}
			.padding(.top, 10)
			Spacer(minLength: 6)
			HStack(alignment: .center) {
				NextPageLine(page: page, now: entry.date, extra: 0, stacks: true)
				Spacer(minLength: 8)
				PageAction(page: page, entry: entry, isPrimary: true)
			}
		}
	}

	/// Two rows, each with its own button; the rest is the count in the header.
	private func several(_ waiting: [PagesSnapshot.Page], snapshot: PagesSnapshot) -> some View {
		VStack(alignment: .leading, spacing: 0) {
			HStack(alignment: .firstTextBaseline) {
				PagesHeader(title: "Paging you", tint: Token.destructive)
				Spacer()
				Text(snapshot.waitingLabel)
					.font(Typo.micro)
					.foregroundStyle(Token.mutedForeground)
			}
			.padding(.bottom, 8)
			ForEach(Array(waiting.prefix(2).enumerated()), id: \.element.id) { index, page in
				if index > 0 {
					Divider().overlay(Token.border).padding(.vertical, 7)
				}
				HStack(alignment: .center) {
					Link(destination: incidentURL(page)) {
						VStack(alignment: .leading, spacing: 3) {
							Text(page.ruleName)
								.font(Typo.smallMedium)
								.foregroundStyle(Token.foreground)
								.lineLimit(1)
							HStack(spacing: 5) {
								BreachLine(page: page)
								if let at = page.upcomingPage(at: entry.date) {
									Text("· \(Text(timerInterval: entry.date...at, countsDown: true))")
										.font(Typo.micro)
										.monospacedDigit()
										.foregroundStyle(Token.mutedForeground)
										.lineLimit(1)
								}
							}
						}
					}
					Spacer(minLength: 8)
					// The amber answers the page that has waited longest; the second is outlined.
					PageAction(page: page, entry: entry, isPrimary: index == 0)
				}
			}
			Spacer(minLength: 0)
		}
	}

	private func incidentURL(_ page: PagesSnapshot.Page) -> URL {
		PagesWidgetKind.incidentURL(id: page.id, organizationId: entry.organizationId) ?? fallbackURL
	}

	/// Only reachable if the scheme itself failed to parse, which it cannot.
	private var fallbackURL: URL { URL(string: "\(WidgetDeepLink.scheme)://incidents")! }
}

// MARK: - Lock Screen

private struct RectangularPagesView: View {
	let entry: PagesEntry

	var body: some View {
		PagesFrame(entry: entry, isAccessory: true) { snapshot in
			VStack(alignment: .leading, spacing: 2) {
				if let page = snapshot.waiting.first {
					Text(snapshot.waiting.count == 1 ? "1 page" : "\(snapshot.waiting.count) pages")
						.font(.headline)
						.widgetAccentable()
					Text(page.ruleName)
						.font(.caption)
						.lineLimit(1)
					if let at = page.upcomingPage(at: entry.date) {
						Text("\(page.nextPagePeople ?? "Next step") in \(Text(timerInterval: entry.date...at, countsDown: true))")
							.font(.caption2)
							.monospacedDigit()
							.foregroundStyle(.secondary)
							.lineLimit(1)
					} else {
						Text("\(page.value) \(page.threshold)")
							.font(.caption2)
							.foregroundStyle(.secondary)
					}
				} else {
					Text("No pages")
						.font(.headline)
						.widgetAccentable()
					Text(snapshot.pages.first?.acknowledgedLine ?? "Nothing is paging you")
						.font(.caption)
						.lineLimit(1)
				}
			}
			.frame(maxWidth: .infinity, alignment: .leading)
		}
		.widgetURL(PagesWidgetKind.incidentsListURL(organizationId: entry.organizationId))
	}
}

private struct InlinePagesView: View {
	let entry: PagesEntry

	var body: some View {
		if let snapshot = entry.snapshot, let page = snapshot.waiting.first {
			Text(snapshot.waiting.count == 1 ? "1 page · \(page.ruleName)" : "\(snapshot.waiting.count) pages")
		} else {
			Text(entry.snapshot == nil ? "Open Maple" : "No pages")
		}
	}
}

// MARK: - Pieces

/// The widget's two outer states: something to draw, or a pointer to the app.
private struct PagesFrame<Content: View>: View {
	let entry: PagesEntry
	var isAccessory = false
	@ViewBuilder let content: (PagesSnapshot) -> Content

	var body: some View {
		Group {
			if let snapshot = entry.snapshot {
				content(snapshot)
			} else {
				VStack(alignment: .leading, spacing: 4) {
					if !isAccessory { PagesHeader(title: "Pages", tint: Token.mutedForeground) }
					Text("Open Maple")
						.font(isAccessory ? .headline : Typo.bodyMedium)
						.foregroundStyle(isAccessory ? Color.primary : Token.foreground)
					Text(entry.organizationId == nil ? "Sign in to see what pages you." : "Nothing has been read yet.")
						.font(isAccessory ? .caption2 : Typo.tiny)
						.foregroundStyle(isAccessory ? Color.secondary : Token.mutedForeground)
					if !isAccessory { Spacer(minLength: 0) }
				}
				.frame(maxWidth: .infinity, alignment: .leading)
			}
		}
		.redacted(reason: entry.isPlaceholder ? .placeholder : [])
	}
}

private struct PagesHeader: View {
	let title: String
	let tint: Color

	var body: some View {
		HStack(spacing: 5) {
			Circle()
				.fill(tint)
				.frame(width: 6, height: 6)
			Text(title)
				.font(Typo.microMedium)
				.textCase(.uppercase)
				.tracking(1.1)
				.foregroundStyle(Token.foreground)
				.lineLimit(1)
		}
	}
}

/// `9.1% > 5%`, in the severity's colour.
private struct BreachLine: View {
	let page: PagesSnapshot.Page

	var body: some View {
		Text("\(page.value) \(page.threshold)")
			.font(Typo.tinyMedium)
			.tabularNumbers()
			.foregroundStyle(page.tint)
			.lineLimit(1)
	}
}

/// Who is paged next and the time left, while it is still ahead.
private struct NextPageLine: View {
	let page: PagesSnapshot.Page
	let now: Date
	/// Other pages waiting that this family has no room to draw.
	let extra: Int
	/// Two lines, where there is the width for a label above the countdown.
	var stacks = false

	var body: some View {
		VStack(alignment: .leading, spacing: 2) {
			if let at = page.upcomingPage(at: now) {
				let timer = Text(timerInterval: now...at, countsDown: true)
				if stacks {
					Text(page.nextPagePeople.map { "Pages \($0)" } ?? "Escalates")
						.font(Typo.micro)
						.foregroundStyle(Token.mutedForeground)
						.lineLimit(1)
					Text("in \(timer)")
						.font(Typo.tiny)
						.monospacedDigit()
						.foregroundStyle(Token.foreground)
				} else {
					(page.nextPagePeople.map { Text("\($0) in \(timer)") } ?? Text("Escalates in \(timer)"))
						.font(Typo.micro)
						.monospacedDigit()
						.foregroundStyle(Token.mutedForeground)
						.lineLimit(1)
				}
			} else {
				Text("Unacknowledged")
					.font(Typo.micro)
					.foregroundStyle(Token.mutedForeground)
			}
			if extra > 0 {
				Text("+\(extra) more")
					.font(Typo.micro)
					.foregroundStyle(Token.mutedForeground)
			}
		}
	}
}

/// The answer to one page: the Acknowledge intent when this phone's credential
/// may send it, and otherwise the way into the incident.
private struct PageAction: View {
	let page: PagesSnapshot.Page
	let entry: PagesEntry
	let isPrimary: Bool
	var fillsWidth = false

	private var tapDidNotLand: Bool { entry.snapshot?.unansweredTap == page.id }

	var body: some View {
		if entry.canAcknowledge, let organizationId = entry.organizationId, !tapDidNotLand {
			Button(intent: AcknowledgePageIntent(incidentId: page.id, organizationId: organizationId)) {
				label("Acknowledge")
			}
			.buttonStyle(.plain)
		} else if let url = PagesWidgetKind.incidentURL(id: page.id, organizationId: entry.organizationId) {
			// A tap that was refused, or a phone that cannot acknowledge from here yet.
			Link(destination: url) { label(tapDidNotLand ? "Open to answer" : "Open") }
		}
	}

	private func label(_ title: String) -> some View {
		Text(title)
			.font(Typo.tinyMedium)
			.foregroundStyle(isPrimary ? Token.primaryForeground : Token.foreground)
			.lineLimit(1)
			.padding(.horizontal, 12)
			.frame(maxWidth: fillsWidth ? .infinity : nil)
			.frame(height: 30)
			.background(isPrimary ? Token.primary : Color.clear, in: .rect(cornerRadius: Token.Radius.md))
			.overlay {
				if !isPrimary {
					RoundedRectangle(cornerRadius: Token.Radius.md).stroke(Token.input, lineWidth: 1)
				}
			}
	}
}

/// Nothing waiting on an answer: who has what paged you, or that nothing is.
private struct QuietPagesView: View {
	let snapshot: PagesSnapshot
	let now: Date
	let needsApp: Bool

	var body: some View {
		VStack(alignment: .leading, spacing: 0) {
			if let page = snapshot.pages.first, let line = page.acknowledgedLine {
				PagesHeader(title: "Acknowledged", tint: Token.mutedForeground)
				Text(page.ruleName)
					.font(Typo.bodyMedium)
					.foregroundStyle(Token.foreground)
					.lineLimit(1)
					.padding(.top, 8)
				BreachLine(page: page)
					.padding(.top, 2)
				Text(line)
					.font(Typo.tiny)
					.foregroundStyle(Token.mutedForeground)
					.lineLimit(1)
					.padding(.top, 6)
			} else {
				PagesHeader(title: "Pages", tint: Token.success)
				Text("Nothing is paging you")
					.font(Typo.bodyMedium)
					.foregroundStyle(Token.foreground)
					.lineLimit(2)
					.padding(.top, 8)
				if let name = snapshot.organizationName {
					Text(name)
						.font(Typo.tiny)
						.foregroundStyle(Token.mutedForeground)
						.lineLimit(1)
						.padding(.top, 3)
				}
			}
			Spacer(minLength: 0)
			Text(needsApp ? "Open Maple to refresh" : "Updated \(WidgetTime.lastSeen(snapshot.generatedAt, now: now))")
				.font(Typo.micro)
				.foregroundStyle(Token.mutedForeground)
				.lineLimit(1)
		}
		.frame(maxWidth: .infinity, alignment: .leading)
	}
}

extension PagesSnapshot.Page {
	/// Red for a critical incident, the warning amber otherwise. Always beside
	/// the number it colours, never alone.
	fileprivate var tint: Color { isCritical ? Token.destructive : Token.severityWarn }
}
