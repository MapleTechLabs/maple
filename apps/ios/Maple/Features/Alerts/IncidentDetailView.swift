import MapleAPI
import SwiftUI

/// Everything the "why" screen needs, gathered in one pass.
struct IncidentDetail {
	var incident: AlertIncident
	var rule: AlertRule?
	var display: SignalDisplay
	/// What the rule's own evaluator saw over the window, oldest first.
	var ruleSignal: RuleSignal
	/// The service the incident is about, when the rule names exactly one
	/// (or when the group key is a service name). Nil skips "what changed".
	var serviceName: String?
	var environment: String?
	var overview: ServiceOverview?
	var linkedIssue: ErrorIssueDetail?
	/// The busiest actionable issue in the window, when none is linked.
	var topIssue: ErrorIssue?
	var failingOperations: [BreakdownItem]
	var deliveries: [AlertDelivery]
}

/// The rule's evaluated signal: one value per evaluation bucket, each marked
/// breached or not, with the threshold it was judged against.
struct RuleSignal {
	struct Point: Identifiable {
		var id: Date { date }
		let date: Date
		let value: Double
		let breached: Bool
	}

	var points: [Point]
	var threshold: Double
	var upper: Double?
}

@MainActor
@Observable
final class IncidentDetailModel {
	private(set) var loader: ScreenLoader<IncidentDetail>!

	let incidentID: String
	let generation: Int
	private let api: any MapleAPI

	init(incidentID: String, api: any MapleAPI, session: SessionController) {
		self.incidentID = incidentID
		self.api = api
		self.generation = session.dataGeneration
		self.loader = ScreenLoader(session: session, screen: Screen.incidentDetail) { [unowned self] in try await self.fetch() }
	}

	var state: LoadState<IncidentDetail> { loader.state }

	private func fetch() async throws -> IncidentDetail {
		let incident = try await api.alertIncident(id: incidentID)
		let rule = try? await api.alertRule(id: incident.ruleId)
		let display = rule.map(SignalDisplay.init(rule:)) ?? SignalDisplay(signal: incident.signalType)

		// Half an hour of run-up, then until it resolved (or now), capped at
		// three hours so an old incident keeps its latest stretch in view.
		let opened = ResolvedTimeWindow.parse(incident.firstTriggeredAt) ?? Date()
		let closed = incident.resolvedAt.flatMap(ResolvedTimeWindow.parse) ?? Date()
		let end = min(closed.addingTimeInterval(10 * 60), Date())
		let start = max(opened.addingTimeInterval(-30 * 60), end.addingTimeInterval(-3 * 3600))
		let window = ResolvedTimeWindow(start: snapMinute(start), end: snapMinute(end))
		let serviceName = Self.serviceName(for: incident, rule: rule)

		async let signalTask = ruleSignal(incident: incident, rule: rule, window: window)
		async let deliveriesTask = api.alertDeliveries(incidentId: incident.id, limit: 50)
		async let linkedIssueTask: ErrorIssueDetail? = {
			guard let id = incident.errorIssueId else { return nil }
			return try? await api.issue(id: id)
		}()

		var overview: ServiceOverview?
		var topIssue: ErrorIssue?
		var failing: [BreakdownItem] = []
		if let serviceName {
			async let overviewTask = api.serviceOverview(ServiceOverviewRequest(serviceName: serviceName, window: window))
			async let breakdownTask = api.traceBreakdown(
				TraceBreakdownRequest(
					aggregation: .count, groupBy: .spanName, window: window, serviceName: serviceName, hasError: true,
					limit: 5
				)
			)
			// A linked issue already names the cause; only look for one without it.
			async let issuesTask: [ErrorIssue] = {
				guard incident.errorIssueId == nil else { return [] }
				let query = IssueQuery(serviceName: serviceName, actionableOnly: true, sort: .lastSeen)
				return (try? await api.issues(query: query, window: window, limit: 1, cursor: nil).items) ?? []
			}()
			overview = try? await overviewTask
			failing = (try? await breakdownTask.data) ?? []
			topIssue = await issuesTask.first
		}

		return IncidentDetail(
			incident: incident,
			rule: rule,
			display: display,
			ruleSignal: await signalTask,
			serviceName: serviceName,
			environment: rule?.environments.first ?? overview?.service.deploymentEnvironments.first,
			overview: overview,
			linkedIssue: await linkedIssueTask,
			topIssue: topIssue,
			failingOperations: failing,
			deliveries: (try? await deliveriesTask) ?? []
		)
	}

	/// The rule's preview over the window, the series the web incident page
	/// draws. Falls back to the rule's stored checks when the preview fails.
	private func ruleSignal(incident: AlertIncident, rule: AlertRule?, window: ResolvedTimeWindow) async -> RuleSignal {
		var signal = RuleSignal(points: [], threshold: incident.threshold, upper: incident.thresholdUpper)
		if let rule, let preview = try? await api.previewAlertRule(rule, window: window) {
			let group = incident.groupKey ?? "__total__"
			let series = preview.series.first { $0.groupKey == group }
				?? preview.series.first { $0.groupKey == "__total__" }
				?? preview.series.first
			signal.points = (series?.points ?? []).compactMap { point in
				guard let value = point.value, let date = ResolvedTimeWindow.parse(point.bucket) else { return nil }
				return RuleSignal.Point(date: date, value: value, breached: point.status == .breached)
			}
			if signal.points.count >= 2 { return signal }
		}
		let checks = (try? await api.alertRuleChecks(
			ruleId: incident.ruleId, groupKey: incident.groupKey, since: window.start, limit: 100
		)) ?? []
		signal.points = checks.compactMap { check in
			guard let value = check.observedValue, let date = ResolvedTimeWindow.parse(check.timestamp) else { return nil }
			return RuleSignal.Point(date: date, value: value, breached: check.status == .breached)
		}
		return signal
	}

	/// A grouped-by-service rule puts the service in the group key; a rule
	/// scoped to one service names it. Anything broader has no single service.
	private static func serviceName(for incident: AlertIncident, rule: AlertRule?) -> String? {
		if let rule, rule.serviceNames.count == 1 { return rule.serviceNames[0] }
		if let group = incident.groupKey, group != "__total__", let rule,
			rule.groupBy != nil, rule.serviceNames.isEmpty || rule.serviceNames.contains(group)
		{
			return group
		}
		return nil
	}

	private func snapMinute(_ date: Date) -> Date {
		Date(timeIntervalSince1970: (date.timeIntervalSince1970 / 60).rounded(.down) * 60)
	}
}

struct IncidentDetailView: View {
	let incidentID: String

	@Environment(SessionController.self) private var session
	@State private var model: IncidentDetailModel?

	var body: some View {
		ZStack {
			Token.background.ignoresSafeArea()
			LoadableView(
				loader: model?.loader,
				emptyTitle: "Not found",
				emptyMessage: "This incident no longer exists.",
				skeleton: { DetailSkeleton(leadsWithHeadline: true) }
			) { detail in
				IncidentDetailContent(detail: detail)
			}
		}
		.navigationTitle("")
		.navigationBarTitleDisplayMode(.inline)
		.mapleScreen(Screen.incidentDetail)
		.task(id: session.dataGeneration) {
			let model =
				if let model, model.generation == session.dataGeneration { model } else {
					IncidentDetailModel(incidentID: incidentID, api: session.api, session: session)
				}
			self.model = model
			await model.loader.loadIfNeeded()
		}
		// The first incident someone reads is the moment "tell me next time"
		// makes sense, so this is where the permission prompt lives, once.
		.task { await PushRegistrar.shared.promptIfNeeded() }
	}
}

private struct IncidentDetailContent: View {
	let detail: IncidentDetail

	var body: some View {
		VStack(alignment: .leading, spacing: 24) {
			IncidentHeader(detail: detail)
			RuleSignalSection(detail: detail)
			if detail.serviceName != nil {
				WhatChangedSection(detail: detail)
			}
			LikelyCauseSection(detail: detail)
			IncidentTimeline(detail: detail)
			IncidentActions(detail: detail)
		}
		.padding(.top, 4)
		.padding(.bottom, 24)
	}
}

private struct IncidentHeader: View {
	let detail: IncidentDetail

	private var incident: AlertIncident { detail.incident }
	private var isOpen: Bool { incident.status == .open }

	var body: some View {
		VStack(alignment: .leading, spacing: 8) {
			Text(incident.ruleName)
				.font(Typo.pageTitle)
				.tracking(-0.6)
				.foregroundStyle(Token.foreground)
				.fixedSize(horizontal: false, vertical: true)
				.accessibilityAddTraits(.isHeader)

			HStack(spacing: 8) {
				Text(
					Format.breach(
						observed: incident.lastObservedValue,
						comparator: incident.comparator,
						threshold: incident.threshold,
						upper: incident.thresholdUpper,
						unit: detail.display.unit
					)
				)
				.font(Typo.smallSemibold)
				.foregroundStyle(isOpen ? incident.severity.tint : Token.mutedForeground)
				Text(
					isOpen
						? "· open \(Format.duration(from: incident.firstTriggeredAt))"
						: "· lasted \(Format.duration(from: incident.firstTriggeredAt, to: incident.resolvedAt))"
				)
				.font(Typo.small)
				.foregroundStyle(Token.mutedForeground)
				.lineLimit(1)
				MapleBadge(text: incident.severity.label, tint: isOpen ? incident.severity.tint : Token.mutedForeground, outlined: true)
				if !isOpen {
					MapleBadge(text: "Resolved", tint: Token.success, outlined: true)
				}
			}
			.tabularNumbers()

			if let serviceName = detail.serviceName {
				NavigationLink(value: Route.service(name: serviceName, window: .lastHour)) {
					serviceLine(serviceName)
				}
				.buttonStyle(.plain)
			} else if let rule = detail.rule, !rule.serviceNames.isEmpty {
				Text(rule.serviceNames.joined(separator: ", "))
					.font(Typo.small)
					.foregroundStyle(Token.mutedForeground)
					.lineLimit(2)
			}
		}
		.padding(.horizontal, 16)
	}

	private func serviceLine(_ serviceName: String) -> some View {
		HStack(spacing: 6) {
			ServiceDot(serviceName: serviceName)
			Text(serviceName)
			if let environment = detail.environment {
				Text("· \(environment)")
			}
		}
		.font(Typo.small)
		.foregroundStyle(Token.mutedForeground)
		.lineLimit(1)
	}
}

/// Open the incident on the web, or share its link.
private struct IncidentActions: View {
	let detail: IncidentDetail

	private var url: URL { MapleWeb.incident(detail.incident.id) }

	var body: some View {
		HStack(spacing: 8) {
			Link(destination: url) {
				AlertActionLabel(title: "Web", icon: .externalLink)
			}
			.accessibilityLabel("Open on the web")
			ShareLink(item: url, message: Text(summary)) {
				AlertActionLabel(title: "Share", icon: .upload)
			}
			.accessibilityLabel("Share incident")
		}
		.buttonStyle(.plain)
		.padding(.horizontal, 16)
	}

	private var summary: String {
		let incident = detail.incident
		let breach = Format.breach(
			observed: incident.lastObservedValue,
			comparator: incident.comparator,
			threshold: incident.threshold,
			upper: incident.thresholdUpper,
			unit: detail.display.unit
		)
		let service = detail.serviceName.map { " on \($0)" } ?? ""
		let state = incident.status == .open ? "open \(Format.duration(from: incident.firstTriggeredAt))" : "resolved"
		return "\(incident.ruleName): \(detail.display.label) \(breach)\(service) · \(incident.severity.label), \(state)"
	}
}
