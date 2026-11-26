import MapleAPI
import SwiftUI

/// The on-call overview behind one screen. Both on-call screens read the same
/// document through the same call; each owns a loader so each has its own
/// `screen.load` and its own pull to refresh.
@MainActor
@Observable
final class OnCallModel {
	private(set) var loader: ScreenLoader<OnCallOverview>!
	let generation: Int

	/// How old a handed-over overview may be before the screen reads again on arrival.
	private static let seedFreshFor: TimeInterval = 60

	init(
		api: any MapleAPI,
		session: SessionController,
		screen: String,
		isEmpty: @escaping @MainActor (OnCallOverview) -> Bool
	) {
		self.generation = session.dataGeneration
		self.loader = ScreenLoader(session: session, screen: screen, isEmpty: isEmpty) {
			try await api.onCallOverview()
		}
	}

	/// Paint the overview the previous screen handed over, and read again only
	/// when it has aged. Without one, load cold.
	func start(seed: OnCallOverview?) async {
		if !loader.state.hasContent, !loader.isLoading, let seed {
			loader.seed(seed)
			let age = ResolvedTimeWindow.parse(seed.generatedAt).map { Date().timeIntervalSince($0) }
			if (age ?? .infinity) > Self.seedFreshFor { await loader.load(.refresh) }
			return
		}
		await loader.loadIfNeeded()
	}
}

extension Format {
	/// `Mon 09:00`: a moment inside the coming week, in the device's time zone
	/// and the locale's own clock.
	static func weekdayTime(_ date: Date) -> String {
		"\(date.formatted(.dateTime.weekday(.abbreviated))) \(date.formatted(date: .omitted, time: .shortened))"
	}

	/// `Mon 30 Nov 09:00`, in the locale's own order.
	static func dayTime(_ date: Date) -> String {
		let day = date.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated))
		return "\(day) \(date.formatted(date: .omitted, time: .shortened))"
	}

	/// `Mon 09:00` while a weekday still names one day, then the date. `compact`
	/// drops the far form to `7 Dec`, for a table column.
	static func handoffTime(_ date: Date, now: Date, compact: Bool = false) -> String {
		if abs(date.timeIntervalSince(now)) < 6 * 86_400 { return weekdayTime(date) }
		return compact ? date.formatted(.dateTime.day().month(.abbreviated)) : dayTime(date)
	}
}

extension OnCallGapRow {
	/// "now to Sat 28 Nov 08:00", "Fri 4 Dec 08:00 to Sat 5 Dec 08:00".
	var range: String {
		if isOpenEnded { return isNow ? "now, no shift ahead" : "from \(Format.dayTime(start))" }
		return "\(isNow ? "now" : Format.dayTime(start)) to \(Format.dayTime(end))"
	}
}

/// The dot before "On call now".
struct OnCallDot: View {
	var tint: Color = Token.success

	var body: some View {
		Circle()
			.fill(tint)
			.frame(width: 8, height: 8)
			.accessibilityHidden(true)
	}
}

/// A person's mark on the schedule screens. The service palette, hashed from
/// the user id: categorical, and always beside the name.
struct PersonDot: View {
	let userId: String

	static func color(for userId: String) -> Color { ServiceColor.color(for: userId) }

	var body: some View {
		ServiceDot(serviceName: userId)
	}
}

/// A stretch nobody covers: when, and how long. Named by its schedule on the
/// On call screen, where gaps from every schedule share one list.
struct OnCallGapCard: View {
	let gap: OnCallGapRow
	var showsSchedule = true

	private var title: String {
		if showsSchedule { return "\(gap.scheduleName) · \(gap.range)" }
		return gap.range.prefix(1).uppercased() + gap.range.dropFirst()
	}

	var body: some View {
		VStack(alignment: .leading, spacing: 4) {
			Text(title)
				.font(Typo.small)
				.tabularNumbers()
				.foregroundStyle(Token.foreground)
				.fixedSize(horizontal: false, vertical: true)
			Text(gap.detail)
				.font(Typo.tiny)
				.tabularNumbers()
				.foregroundStyle(Token.mutedForeground)
		}
		.padding(.leading, 14)
		.padding(.trailing, 12)
		.padding(.vertical, 12)
		.severityRail(Token.severityWarn)
		.hairlineCard()
		.accessibilityElement(children: .combine)
	}
}

/// The chevron a row or card that opens a screen ends with.
struct OnCallChevron: View {
	var body: some View {
		PixelIcon.chevronRight.image
			.resizable()
			.frame(width: 12, height: 12)
			.foregroundStyle(Token.mutedForeground)
			.accessibilityHidden(true)
	}
}
