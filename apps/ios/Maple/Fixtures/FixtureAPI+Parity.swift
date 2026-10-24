import Foundation
import MapleAPI

extension FixtureAPI {
	func serviceHealth(window: ResolvedTimeWindow, comparing previous: ResolvedTimeWindow?) async throws
		-> ServiceHealthSnapshot
	{
		let current = try await services(window: window, limit: 50).items
		let entries = current.map { Self.healthEntry($0, scale: 1) }
		return ServiceHealthSnapshot(
			services: entries,
			previous: previous.map { _ in current.map { Self.healthEntry($0, scale: 0.92) } }
		)
	}

	private static func healthEntry(_ service: Service, scale: Double) -> ServiceHealthEntry {
		let requests = (service.throughput * 3600 * scale).rounded()
		return ServiceHealthEntry(
			deploymentEnvironment: "production",
			errorCount: (requests * service.errorRate).rounded(),
			errorRate: service.errorRate,
			object: .serviceHealth_service,
			p95LatencyMs: service.p95LatencyMs * (2 - scale),
			requestCount: requests,
			serviceName: service.name,
			throughput: service.throughput * scale
		)
	}

	func logVolumeBySeverity(_ search: LogSearch, targetPoints: Int) async throws -> LogVolume {
		let totals = try await logVolume(search, targetPoints: targetPoints)
		let severe: [LogVolume.Series] = [
			.init(severity: "ERROR", values: totals.map { ($0 / 6).rounded() }),
			.init(severity: "WARN", values: totals.map { ($0 / 3).rounded() }),
		]
		// Lower severities only when the search lets them through, as the server does.
		guard (search.minimumSeverity ?? 0) < 13 else { return LogVolume(series: severe) }
		return LogVolume(series: severe + [.init(severity: "INFO", values: totals.map { ($0 / 2).rounded() })])
	}

	func previewAlertRule(_ rule: AlertRule, window: ResolvedTimeWindow) async throws -> AlertRulePreview {
		try await pause()
		// 20 bars over the window: calm, a ramp that crosses the threshold at the
		// window's incident's first trigger, a plateau, then calm once resolved.
		let open = incidents.first { incident in
			guard incident.ruleId == rule.id, let at = ResolvedTimeWindow.parse(incident.firstTriggeredAt) else { return false }
			return at >= window.start && at <= window.end
		}
		let trigger = open.flatMap { ResolvedTimeWindow.parse($0.firstTriggeredAt) }
		let resolved = open?.resolvedAt.flatMap(ResolvedTimeWindow.parse) ?? .distantFuture
		let bucket = max(60, (window.end.timeIntervalSince(window.start) / 20 / 60).rounded() * 60)
		let count = max(2, Int(window.end.timeIntervalSince(window.start) / bucket))
		let calm = rule.threshold * 0.3
		let peak = max(open?.lastObservedValue ?? rule.threshold * 0.6, rule.threshold * 1.2)
		let points = (0..<count).map { index in
			let at = window.start.addingTimeInterval(bucket * Double(index))
			let wobble = 1 + 0.08 * sin(Double(index) * 1.7)
			let value: Double
			if let trigger, at < resolved {
				// -1 at 10 minutes before the trigger, 0 at the trigger, 1 at 10 after.
				let phase = at.timeIntervalSince(trigger) / 600
				let ramp = min(1, max(0, (phase + 1) / 2))
				let crossing = rule.threshold * 1.15
				value = (phase < 0 ? calm + (crossing - calm) * ramp * ramp : crossing + (peak - crossing) * min(1, phase)) * wobble
			} else {
				value = calm * wobble
			}
			return AlertRulePreviewPoint(
				bucket: ResolvedTimeWindow.format(at),
				sampleCount: 120,
				status: value > rule.threshold ? .breached : .healthy,
				value: value
			)
		}
		return AlertRulePreview(
			bucketSeconds: bucket,
			comparator: rule.comparator,
			object: .alertRule_preview,
			series: [.init(groupKey: "__total__", points: points)],
			threshold: rule.threshold,
			thresholds: rule.thresholds,
			windowMinutes: Double(rule.windowMinutes),
			wouldFire: []
		)
	}
}
