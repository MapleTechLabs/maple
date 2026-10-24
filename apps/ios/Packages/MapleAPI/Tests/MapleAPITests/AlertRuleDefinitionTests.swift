import Foundation
import Testing

@testable import MapleAPI

@Suite("Alert rule preview definition")
struct AlertRuleDefinitionTests {
	/// The spec's own `AlertRule` example, so the test moves with the contract.
	static let ruleJSON = #"{"alert_on_no_data": false, "apdex_threshold_ms": null, "breaches_out_of": null, "comparator": "gt", "consecutive_breaches_required": 2, "consecutive_healthy_required": 3, "created_at": "2026-07-01T12:00:00.000Z", "created_by": "user_2Nk8mXqPfR3yZ1aB4cD5eF6g", "destination_ids": ["dest_oybbpTBhtSFGShMjjLiCrh"], "enabled": true, "environments": ["production"], "evaluation_interval_minutes": null, "exclude_service_names": [], "group_by": null, "id": "alrt_gU26thvJECdQvu54Ad9jiz", "last_evaluated_at": "2026-07-15T09:10:00.000Z", "last_evaluation_error": null, "last_evaluation_error_kind": null, "last_scheduled_at": "2026-07-15T09:10:00.000Z", "minimum_sample_count": 50, "name": "Checkout error rate", "no_data_behavior": "skip", "notes": null, "notification_template": null, "object": "alert_rule", "query_builder_draft": null, "raw_query_reducer": null, "raw_query_sql": null, "renotify_interval_minutes": 60, "service_names": ["checkout"], "severity": "critical", "signal_type": "error_rate", "slowed_at": null, "slowed_interval_minutes": null, "tags": ["payments"], "threshold": 0.05, "threshold_upper": null, "thresholds": [{"destination_ids": ["dest_oybbpTBhtSFGShMjjLiCrh"], "recovery_value": null, "severity": "critical", "upper": null, "value": 0.05}], "updated_at": "2026-07-14T08:30:00.000Z", "updated_by": "user_2Nk8mXqPfR3yZ1aB4cD5eF6g", "window_minutes": 5}"#

	static func rule(_ edit: (inout [String: Any]) -> Void = { _ in }) throws -> AlertRule {
		var fields = try #require(
			try JSONSerialization.jsonObject(with: Data(ruleJSON.utf8)) as? [String: Any]
		)
		edit(&fields)
		return try JSONDecoder().decode(AlertRule.self, from: JSONSerialization.data(withJSONObject: fields))
	}

	@Test("A saved rule becomes create params that keep its definition")
	func keepsDefinition() throws {
		let params = try AlertRuleDefinition.createParams(from: Self.rule())
		#expect(params.name == "Checkout error rate")
		#expect(params.signalType == .errorRate)
		#expect(params.windowMinutes == 5)
		#expect(params.serviceNames == ["checkout"])
		#expect(params.environments == ["production"])
		#expect(params.thresholds?.first?.value == 0.05)
	}

	@Test("Tiered rules drop the single-threshold fields the tiers replace")
	func dropsDerivedThresholdFields() throws {
		let params = try AlertRuleDefinition.createParams(from: Self.rule())
		#expect(params.severity == nil)
		#expect(params.threshold == nil)
		#expect(params.destinationIds == nil)
	}

	@Test("An empty group_by is left out rather than sent as an invalid empty list")
	func dropsEmptyGroupBy() throws {
		let params = try AlertRuleDefinition.createParams(from: Self.rule { $0["group_by"] = [String]() })
		#expect(params.groupBy == nil)
	}
}
