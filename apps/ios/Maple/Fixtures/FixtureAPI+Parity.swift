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
		return LogVolume(series: [
			.init(severity: "ERROR", values: totals.map { ($0 / 3).rounded() }),
			.init(severity: "WARN", values: totals.map { ($0 * 2 / 3).rounded() }),
		])
	}

	func previewAlertRule(_ rule: AlertRule, window: ResolvedTimeWindow) async throws -> AlertRulePreview {
		let checks = try await alertRuleChecks(ruleId: rule.id, groupKey: nil, since: window.start, limit: 30)
		let points = checks.map { check in
			AlertRulePreviewPoint(
				bucket: check.timestamp,
				sampleCount: 120,
				status: check.status == .breached ? .breached : .healthy,
				value: check.observedValue
			)
		}
		return AlertRulePreview(
			bucketSeconds: 60,
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
