import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import {
	AlertDeliveryEventId,
	AlertDestinationDocument,
	AlertDestinationId,
	AlertIncidentId,
	AlertRuleId,
	ChatWorkspaceId,
} from "@maple/domain/http"
import {
	buildDestinationCreateParamsV2,
	buildDestinationUpdateParamsV2,
	buildRuleCreateParamsV2,
	chatDestinationForm,
	defaultDestinationForm,
	defaultRuleForm,
	ruleFormIsGrouped,
	deriveRuleQueryIssues,
	domainThresholdToForm,
	formThresholdToDomain,
	formatSignalValue,
	normalizeRuleQueryDraft,
	pickDefaultDestination,
	suggestedDestinationName,
	rawSqlHasValueColumn,
	v2CheckToDocument,
	v2DeliveryToDocument,
	v2PreviewToResponse,
} from "./form-utils"
import { formatErrorRate } from "@maple/ui/lib/format"

describe("rule notes", () => {
	it("carries a trimmed note onto the create params", () => {
		const params = buildRuleCreateParamsV2({
			...defaultRuleForm(),
			name: "Error rate",
			notes: "  See runbook: https://wiki/incidents  ",
		})

		expect(params.notes).toBe("See runbook: https://wiki/incidents")
	})

	it("sends null when the note is blank or whitespace-only", () => {
		expect(buildRuleCreateParamsV2({ ...defaultRuleForm(), name: "A", notes: "" }).notes).toBeNull()
		expect(buildRuleCreateParamsV2({ ...defaultRuleForm(), name: "A", notes: "   " }).notes).toBeNull()
	})
})

describe("check interval", () => {
	it("sends the picked interval, and null for the window's own", () => {
		const form = { ...defaultRuleForm(), name: "A", windowMinutes: "30" }
		expect(
			buildRuleCreateParamsV2({ ...form, evaluationIntervalMinutes: "10" }).evaluation_interval_minutes,
		).toBe(10)
		expect(buildRuleCreateParamsV2(form).evaluation_interval_minutes).toBeNull()
		// Not one of the intervals a rule can pick.
		expect(
			buildRuleCreateParamsV2({ ...form, evaluationIntervalMinutes: "7" }).evaluation_interval_minutes,
		).toBeNull()
	})
})

describe("threshold unit conversion", () => {
	it("converts error_rate thresholds between percent (form) and ratio (domain)", () => {
		// User enters 5 (%), domain stores 0.05 (ratio) — the unit the query
		// engine emits and AlertsService compares against.
		expect(formThresholdToDomain({ signalType: "error_rate" }, "5")).toBe(0.05)
		expect(formThresholdToDomain({ signalType: "error_rate" }, "50")).toBe(0.5)
		expect(domainThresholdToForm({ signalType: "error_rate" }, 0.05)).toBe("5")
		expect(domainThresholdToForm({ signalType: "error_rate" }, 0.5)).toBe("50")
	})

	it("drops float noise when converting error_rate ratios to percent", () => {
		expect(domainThresholdToForm({ signalType: "error_rate" }, 0.07)).toBe("7")
		expect(domainThresholdToForm({ signalType: "error_rate" }, 0.29)).toBe("29")
	})

	it("round-trips a percent the form read back to the stored ratio", () => {
		for (const ratio of [0.007, 0.011, 0.0029, 0.333]) {
			const form = domainThresholdToForm({ signalType: "error_rate" }, ratio)
			expect(formThresholdToDomain({ signalType: "error_rate" }, form)).toBe(ratio)
		}
	})

	it("keeps precision for error rates below 0.01%", () => {
		expect(formatSignalValue("error_rate", 0.00005)).toBe("0.0050%")
		expect(formatSignalValue("error_rate", 0.05)).toBe(formatErrorRate(0.05))
		expect(formatSignalValue("error_rate", 0)).toBe("0%")
	})

	it("passes non-error_rate thresholds through unchanged", () => {
		expect(formThresholdToDomain({ signalType: "p95_latency" }, "500")).toBe(500)
		expect(domainThresholdToForm({ signalType: "p95_latency" }, 500)).toBe("500")
		expect(formThresholdToDomain({ signalType: "throughput" }, "1000")).toBe(1000)
	})

	it("stores error_rate threshold as a ratio on the create params", () => {
		// The default form threshold "5" must round-trip to the 0.05 ratio the
		// MCP tool also uses — so a default error-rate alert can actually fire.
		const params = buildRuleCreateParamsV2({
			...defaultRuleForm(),
			name: "Error rate",
			signalType: "error_rate",
		})
		expect(params.threshold).toBe(0.05)
	})

	it("keeps latency thresholds in their native units on the create params", () => {
		const params = buildRuleCreateParamsV2({
			...defaultRuleForm(),
			name: "P95",
			signalType: "p95_latency",
			threshold: "500",
		})
		expect(params.threshold).toBe(500)
	})
})

describe("buildRuleCreateParamsV2", () => {
	it("dedupes destination ids", () => {
		const a = AlertDestinationId.make("00000000-0000-4000-8000-0000000000a1")
		const b = AlertDestinationId.make("00000000-0000-4000-8000-0000000000b2")
		const params = buildRuleCreateParamsV2({ ...defaultRuleForm(), name: "A", destinationIds: [a, b, a] })
		expect(params.destination_ids).toEqual([a, b])
	})

	it("empties the rule-level scope for query-owned signals", () => {
		const params = buildRuleCreateParamsV2({
			...defaultRuleForm(),
			name: "Builder",
			signalType: "builder_query",
			serviceNames: ["checkout"],
			excludeServiceNames: ["internal"],
			environments: ["production"],
			groupBy: ["service.name"],
		})
		expect(params.service_names).toEqual([])
		expect(params.exclude_service_names).toEqual([])
		expect(params.environments).toEqual([])
		expect(params.group_by).toBeNull()
		expect(params.query_builder_draft).not.toBeNull()
	})

	it("submits the environment scope for built-in signals", () => {
		const params = buildRuleCreateParamsV2({
			...defaultRuleForm(),
			name: "Prod error rate",
			signalType: "error_rate",
			environments: ["production", "  ", "staging"],
		})
		expect(params.environments).toEqual(["production", "staging"])
	})

	it("normalizes and submits one query-builder draft", () => {
		const queryBuilderDraft = normalizeRuleQueryDraft({
			id: "A",
			name: "A",
			dataSource: "metrics",
			aggregation: "rate",
			metricName: "http.requests",
			metricType: "sum",
		})
		const params = buildRuleCreateParamsV2({
			...defaultRuleForm(),
			name: "Request rate",
			signalType: "builder_query",
			queryBuilderDraft,
		})

		expect(queryBuilderDraft).toMatchObject({
			dataSource: "metrics",
			whereClause: "",
			groupBy: ["service.name"],
			metricName: "http.requests",
			metricType: "sum",
			isMonotonic: true,
		})
		expect(params.query_builder_draft).toEqual(queryBuilderDraft)
	})

	it("keeps query-builder warnings non-fatal", () => {
		const form = {
			...defaultRuleForm(),
			name: "Requests by method",
			signalType: "builder_query" as const,
			queryBuilderDraft: normalizeRuleQueryDraft({
				id: "A",
				name: "A",
				dataSource: "metrics",
				aggregation: "avg",
				metricName: "http.server.request.duration",
				metricType: "histogram",
				addOns: { groupBy: true, having: false, orderBy: false, limit: false, legend: false },
				groupBy: ["attr.http.method", "attr.http.route"],
			}),
		}

		expect(deriveRuleQueryIssues(form)).toEqual([])
		expect(buildRuleCreateParamsV2(form).query_builder_draft).toEqual(form.queryBuilderDraft)
	})
})

describe("telegram destination params", () => {
	it("builds create params with a trimmed token and chat id", () => {
		const params = buildDestinationCreateParamsV2({
			...defaultDestinationForm("telegram"),
			name: "  On-call  ",
			telegramBotToken: "  123456789:AAtoken  ",
			telegramChatId: "  -1001234567890  ",
		})
		expect(params).toEqual({
			type: "telegram",
			name: "On-call",
			enabled: true,
			bot_token: "123456789:AAtoken",
			chat_id: "-1001234567890",
		})
	})

	/**
	 * The chat id comes back on edit (via `channel_label`) but the token never
	 * does — so a rename must not blank the stored token.
	 */
	it("keeps the stored token on update when the field is left blank", () => {
		const params = buildDestinationUpdateParamsV2({
			...defaultDestinationForm("telegram"),
			name: "Renamed",
			telegramBotToken: "",
			telegramChatId: "-1001234567890",
		})
		expect(params).toEqual({
			type: "telegram",
			enabled: true,
			name: "Renamed",
			chat_id: "-1001234567890",
		})
	})
})

describe("chat destination params", () => {
	const WORKSPACE = Schema.decodeUnknownSync(ChatWorkspaceId)("11111111-1111-4111-8111-111111111111")

	it("names the linked workspace and the picked channel, never the connector or a name", () => {
		const params = buildDestinationCreateParamsV2({
			...defaultDestinationForm("chat"),
			name: " Incidents ",
			chatWorkspaceId: WORKSPACE,
			chatConnector: "testchat",
			chatChannelId: "channel-1",
			chatChannelName: "incidents",
		})
		expect(params).toEqual({
			type: "chat",
			name: "Incidents",
			enabled: true,
			workspace_id: WORKSPACE,
			channel_id: "channel-1",
		})
	})

	it("keeps the stored channel on update until another is picked", () => {
		const params = buildDestinationUpdateParamsV2({
			...defaultDestinationForm("chat"),
			name: "Renamed",
			chatWorkspaceId: WORKSPACE,
			chatChannelName: "incidents",
		})
		expect(params).toEqual({ type: "chat", enabled: true, name: "Renamed" })
	})
})

describe("raw SQL alert query validation", () => {
	it("recognizes explicit value aliases and value columns", () => {
		expect(rawSqlHasValueColumn("SELECT count() AS value FROM traces WHERE $__orgFilter")).toBe(true)
		expect(rawSqlHasValueColumn('SELECT "value" FROM traces WHERE $__orgFilter')).toBe(true)
		expect(rawSqlHasValueColumn("SELECT group, value FROM traces WHERE $__orgFilter")).toBe(true)
	})

	it("flags chart-shaped SQL without an alert value column", () => {
		const sql =
			"SELECT toStartOfInterval(Timestamp, INTERVAL $__interval_s SECOND) AS bucket, count() AS errors FROM traces WHERE $__orgFilter GROUP BY bucket"

		expect(rawSqlHasValueColumn(sql)).toBe(false)
		expect(
			deriveRuleQueryIssues({
				...defaultRuleForm(),
				signalType: "raw_query",
				rawQuerySql: sql,
			}),
		).toEqual(["SQL value column"])
	})
})

describe("v2 response mappers", () => {
	it("maps a v2 preview result onto the camelCase domain response", () => {
		const response = v2PreviewToResponse({
			object: "alert_rule.preview",
			bucket_seconds: 300,
			window_minutes: 5,
			threshold: 0.05,
			threshold_upper: null,
			thresholds: [
				{ severity: "warning", value: 0.05, upper: null, recovery_value: 0.03, destination_ids: [] },
			],
			comparator: "gt",
			truncated_to_start: "2026-07-15T00:00:00.000Z",
			series: [
				{
					group_key: "__total__",
					points: [
						{
							bucket: "2026-07-15T09:10:00.000Z",
							value: 0.09,
							sample_count: 132,
							status: "breached",
							provisional: true,
						},
					],
				},
			],
			would_fire: [
				{
					group_key: "__total__",
					start: "2026-07-15T09:10:00.000Z",
					end: "2026-07-15T09:40:00.000Z",
					severity: "warning",
				},
			],
		})

		expect(response.thresholds).toEqual([
			{ severity: "warning", value: 0.05, upper: null, recoveryValue: 0.03, destinationIds: [] },
		])
		expect(response.bucketSeconds).toBe(300)
		expect(response.windowMinutes).toBe(5)
		expect(response.truncatedToStart).toBe("2026-07-15T00:00:00.000Z")
		expect(response.series[0]?.groupKey).toBe("__total__")
		expect(response.series[0]?.points[0]).toMatchObject({
			bucket: "2026-07-15T09:10:00.000Z",
			value: 0.09,
			sampleCount: 132,
			status: "breached",
			provisional: true,
		})
		expect(response.wouldFire[0]).toMatchObject({
			groupKey: "__total__",
			start: "2026-07-15T09:10:00.000Z",
			end: "2026-07-15T09:40:00.000Z",
			severity: "warning",
		})
		expect(response.queryTiming).toBeUndefined()
	})

	it("carries a raw SQL preview's query timing", () => {
		const response = v2PreviewToResponse({
			object: "alert_rule.preview",
			bucket_seconds: 300,
			window_minutes: 5,
			threshold: 10,
			threshold_upper: null,
			thresholds: [
				{ severity: "warning", value: 10, upper: null, recovery_value: null, destination_ids: [] },
			],
			comparator: "gt",
			truncated_to_start: null,
			series: [],
			would_fire: [],
			series_failure: "query_too_slow",
			query_timing: {
				elapsed_ms: 7_800,
				failure: null,
				probe_limit_ms: 25_000,
				interval_minutes: 1,
				limit_ms: 5_000,
				fits_interval_minutes: [5, 10, 15, 30, 60],
			},
		})
		expect(response.seriesFailure).toBe("query_too_slow")
		expect(response.queryTiming && { ...response.queryTiming }).toEqual({
			elapsedMs: 7_800,
			failure: null,
			probeLimitMs: 25_000,
			intervalMinutes: 1,
			limitMs: 5_000,
			fitsIntervalMinutes: [5, 10, 15, 30, 60],
		})
	})

	it("maps a v2 check onto the camelCase domain document", () => {
		const document = v2CheckToDocument({
			object: "alert_check",
			timestamp: "2026-07-15T09:10:00.000Z",
			group_key: "__total__",
			status: "breached",
			skip_reason: null,
			signal_type: "error_rate",
			comparator: "gt",
			threshold: 0.05,
			threshold_upper: null,
			observed_value: 0.09,
			sample_count: 132,
			window_minutes: 5,
			window_start: "2026-07-15T09:05:00.000Z",
			window_end: "2026-07-15T09:10:00.000Z",
			consecutive_breaches: 2,
			consecutive_healthy: 0,
			incident_id: null,
			incident_transition: "opened",
			level: "warning",
			evaluation_duration_ms: 412,
			error_message: null,
			error_category: null,
		})

		expect(document).toMatchObject({
			timestamp: "2026-07-15T09:10:00.000Z",
			groupKey: "__total__",
			status: "breached",
			signalType: "error_rate",
			observedValue: 0.09,
			sampleCount: 132,
			windowStart: "2026-07-15T09:05:00.000Z",
			windowEnd: "2026-07-15T09:10:00.000Z",
			consecutiveBreaches: 2,
			consecutiveHealthy: 0,
			incidentId: null,
			incidentTransition: "opened",
			evaluationDurationMs: 412,
		})
	})

	it("maps a v2 delivery onto the camelCase domain document", () => {
		const document = v2DeliveryToDocument({
			id: AlertDeliveryEventId.make("00000000-0000-4000-8000-000000000101"),
			object: "alert_delivery",
			incident_id: AlertIncidentId.make("00000000-0000-4000-8000-000000000102"),
			rule_id: AlertRuleId.make("00000000-0000-4000-8000-000000000103"),
			destination_id: AlertDestinationId.make("00000000-0000-4000-8000-000000000104"),
			destination_name: "On-call",
			destination_type: "webhook",
			delivery_key: "delivery-1",
			event_type: "trigger",
			attempt_number: 1,
			status: "success",
			scheduled_at: "2026-07-15T09:10:00.000Z",
			attempted_at: "2026-07-15T09:10:01.000Z",
			provider_message: "ok",
			provider_reference: "ref-1",
			response_code: 200,
			error_message: null,
		})

		expect(document).toMatchObject({
			destinationName: "On-call",
			destinationType: "webhook",
			deliveryKey: "delivery-1",
			eventType: "trigger",
			status: "success",
			responseCode: 200,
		})
	})
})

describe("alert on no data", () => {
	it("is sent only for rules that are not grouped", () => {
		const form = { ...defaultRuleForm(), name: "A", alertOnNoData: true }
		expect(buildRuleCreateParamsV2(form).alert_on_no_data).toBe(true)
		const grouped = { ...form, serviceNames: [], groupBy: ["service.name"] }
		expect(ruleFormIsGrouped(grouped)).toBe(true)
		expect(buildRuleCreateParamsV2(grouped).alert_on_no_data).toBe(false)
		expect(ruleFormIsGrouped({ ...grouped, signalType: "raw_query" })).toBe(false)
	})
})

describe("suggestedDestinationName", () => {
	it("names a destination after where it delivers", () => {
		const workspace = Schema.decodeUnknownSync(ChatWorkspaceId)("11111111-1111-4111-8111-111111111111")
		expect(
			suggestedDestinationName({
				...chatDestinationForm("slack", workspace),
				chatChannelName: "alerts",
			}),
		).toBe("#alerts")
		expect(suggestedDestinationName(chatDestinationForm("slack", workspace))).toBe("")
		expect(
			suggestedDestinationName({
				...defaultDestinationForm("webhook"),
				url: "https://hooks.example.com/x",
			}),
		).toBe("hooks.example.com")
		expect(suggestedDestinationName({ ...defaultDestinationForm("webhook"), url: "not a url" })).toBe(
			"Webhook",
		)
		expect(suggestedDestinationName(defaultDestinationForm("pagerduty"))).toBe("PagerDuty")
	})
})

describe("pickDefaultDestination", () => {
	const a = AlertDestinationId.make("00000000-0000-4000-8000-0000000000a1")
	const b = AlertDestinationId.make("00000000-0000-4000-8000-0000000000b2")
	const c = AlertDestinationId.make("00000000-0000-4000-8000-0000000000c3")
	const live = (id: typeof a) => ({ id, enabled: true, disabledAt: null })

	it("picks the only usable destination even when no rule uses it", () => {
		expect(pickDefaultDestination([live(a), { id: b, enabled: false, disabledAt: null }], [])).toBe(a)
	})

	it("picks the usable destination the most rules notify", () => {
		const rules = [{ destinationIds: [a, b] }, { destinationIds: [b] }, { destinationIds: [c] }]
		expect(pickDefaultDestination([live(a), live(b), live(c)], rules)).toBe(b)
	})

	it("skips auto-disabled destinations and picks nothing when none is in use", () => {
		const disabledAt = Schema.decodeUnknownSync(AlertDestinationDocument.fields.createdAt)(
			"2026-10-06T00:00:00.000Z",
		)
		const disabled = { id: b, enabled: true, disabledAt }
		expect(pickDefaultDestination([live(a), disabled], [{ destinationIds: [b] }])).toBe(a)
		expect(pickDefaultDestination([live(a), live(c)], [])).toBeNull()
	})
})
