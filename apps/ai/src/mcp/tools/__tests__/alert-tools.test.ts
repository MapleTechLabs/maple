/**
 * The alert tools through the registry: parameter vocabulary (aliases, enums, lists, JSON), the
 * typed output on `structuredContent`, the rendered text, and input errors naming the parameter.
 */
import { describe, expect, it } from "vitest"
import { Effect, Layer, Schema } from "effect"
import {
	AlertChecksListResponse,
	AlertDestinationsListResponse,
	AlertIncidentsListResponse,
	AlertRuleDocument,
	AlertRuleNotFoundError,
	AlertRulesListResponse,
	AlertRuleUpsertRequest,
	OrgId,
	UserId,
} from "@maple/domain/http"
import {
	GetAlertRuleOutput,
	ListAlertChecksOutput,
	ListAlertDestinationsOutput,
	ListAlertIncidentsOutput,
	ListAlertRulesOutput,
} from "@maple/domain/mcp-outputs"
import { AlertRulesService } from "@maple/backend/services/alerts/AlertRulesService"
import { AlertsService } from "@maple/backend/services/alerts/AlertsService"
import { AlertReadModelsService } from "@maple/backend/services/alerts/AlertReadModelsService"
import { CurrentMcpTenant } from "../../lib/query-warehouse"
import { executeRegisteredMcpToolUnscoped } from "../registry"
import type { McpToolResult } from "../types"

const RULE_ID = "7f1c2d3e-4b5a-4c6d-8e9f-0a1b2c3d4e5f"
const DEST_ID = "0e1d2c3b-4a59-4687-9a0b-1c2d3e4f5a6b"
const INCIDENT_ID = "11111111-2222-4333-8444-555555555555"
const NOW = "2026-09-24T10:00:00.000Z"

const rule = Schema.decodeUnknownSync(AlertRuleDocument)({
	id: RULE_ID,
	name: "Checkout errors",
	notes: null,
	notificationTemplate: { title: "{{ rule.name }}", body: null },
	enabled: true,
	severity: "critical",
	serviceNames: ["checkout"],
	excludeServiceNames: [],
	environments: ["production"],
	tags: [],
	groupBy: null,
	signalType: "error_rate",
	comparator: "gt",
	threshold: 0.05,
	thresholdUpper: null,
	windowMinutes: 5,
	minimumSampleCount: 0,
	consecutiveBreachesRequired: 1,
	consecutiveHealthyRequired: 1,
	renotifyIntervalMinutes: 60,
	apdexThresholdMs: null,
	queryBuilderDraft: null,
	rawQuerySql: null,
	rawQueryReducer: null,
	destinationIds: [DEST_ID],
	noDataBehavior: "skip",
	lastEvaluationError: "column Foo not found",
	lastEvaluatedAt: NOW,
	lastScheduledAt: NOW,
	createdAt: NOW,
	updatedAt: NOW,
	createdBy: "user_tools",
	updatedBy: "user_tools",
})

const incident = (overrides: Record<string, unknown>) => ({
	id: INCIDENT_ID,
	ruleId: RULE_ID,
	ruleName: "Checkout errors",
	groupKey: "checkout",
	signalType: "error_rate",
	severity: "critical",
	status: "open",
	comparator: "gt",
	threshold: 0.05,
	thresholdUpper: null,
	firstTriggeredAt: NOW,
	lastTriggeredAt: NOW,
	resolvedAt: null,
	lastObservedValue: 0.12,
	lastSampleCount: 100,
	dedupeKey: "k",
	lastDeliveredEventType: null,
	lastNotifiedAt: null,
	holdReason: null,
	heldSince: null,
	errorIssueId: null,
	...overrides,
})

interface Seen {
	created?: AlertRuleUpsertRequest
	updated?: AlertRuleUpsertRequest
	incidentOptions?: unknown
	checkOptions?: unknown
}

const layer = (seen: Seen) =>
	Layer.mergeAll(
		Layer.succeed(CurrentMcpTenant, {
			orgId: Schema.decodeUnknownSync(OrgId)("org_tools"),
			userId: Schema.decodeUnknownSync(UserId)("user_tools"),
			roles: [],
			authMode: "self_hosted",
		} as never),
		Layer.succeed(AlertRulesService, {
			listRules: () => Effect.succeed(new AlertRulesListResponse({ rules: [rule] })),
			createRule: (_org: unknown, _user: unknown, _roles: unknown, request: AlertRuleUpsertRequest) => {
				seen.created = request
				return Effect.succeed(rule)
			},
			deleteRule: (_org: unknown, _roles: unknown, id: string) =>
				id === RULE_ID
					? Effect.succeed({ id })
					: Effect.fail(
							new AlertRuleNotFoundError({
								message: "Alert rule not found",
								ruleId: id as never,
							}),
						),
		} as never),
		Layer.succeed(AlertsService, {
			updateRule: (
				_o: unknown,
				_u: unknown,
				_r: unknown,
				_id: unknown,
				request: AlertRuleUpsertRequest,
			) => {
				seen.updated = request
				return Effect.succeed(rule)
			},
			listDestinations: () =>
				Effect.succeed(
					Schema.decodeUnknownSync(AlertDestinationsListResponse)({
						destinations: [
							{
								id: DEST_ID,
								name: "On-call",
								type: "pagerduty",
								enabled: true,
								summary: "PagerDuty service",
								channelLabel: null,
								memberUserIds: null,
								lastTestedAt: null,
								lastTestError: null,
								createdAt: NOW,
								updatedAt: NOW,
							},
						],
					}),
				),
		} as never),
		Layer.succeed(AlertReadModelsService, {
			listIncidents: (_org: unknown, options: unknown) => {
				seen.incidentOptions = options
				return Effect.succeed(
					Schema.decodeUnknownSync(AlertIncidentsListResponse)({
						incidents: [
							incident({}),
							incident({ id: "22222222-2222-4333-8444-555555555555", severity: "warning" }),
						],
					}),
				)
			},
			listRuleChecks: (_org: unknown, _rule: unknown, options: unknown) => {
				seen.checkOptions = options
				return Effect.succeed(
					Schema.decodeUnknownSync(AlertChecksListResponse)({
						checks: [
							{
								timestamp: NOW,
								groupKey: "checkout",
								status: "error",
								signalType: "error_rate",
								comparator: "gt",
								threshold: 0.05,
								thresholdUpper: null,
								observedValue: null,
								sampleCount: 0,
								windowMinutes: 5,
								windowStart: NOW,
								windowEnd: NOW,
								consecutiveBreaches: 0,
								consecutiveHealthy: 0,
								incidentId: null,
								incidentTransition: "none",
								evaluationDurationMs: 12,
								errorMessage: "column Foo not found",
								errorCategory: "validation",
							},
						],
					}),
				)
			},
		} as never),
	)

interface RunFailure {
	readonly message: string
	readonly parameter?: string
}

const run = (name: string, params: unknown, seen: Seen = {}) =>
	Effect.runPromise(
		// The registry's requirement union names every tool's services; the alert tools reach only
		// the alert services `layer` provides.
		// oxlint-disable-next-line effecttsgo/missing-effect-context
		executeRegisteredMcpToolUnscoped(name, params, "mcp").pipe(
			Effect.provide(layer(seen)),
			Effect.result,
		) as Effect.Effect<
			{ _tag: "Success"; success: McpToolResult } | { _tag: "Failure"; failure: RunFailure }
		>,
	)

const ok = async (name: string, params: unknown, seen: Seen = {}) => {
	const result = await run(name, params, seen)
	if (result._tag !== "Success") throw new Error(`${name} failed: ${JSON.stringify(result.failure)}`)
	return result.success
}

const text = (result: McpToolResult) => result.content[0]?.text ?? ""

describe("alert tools", () => {
	it("list_alert_rules accepts service_names as a CSV alias and echoes the filter", async () => {
		const result = await ok("list_alert_rules", {
			service_names: "checkout, billing",
			severity: "critical",
		})
		const output = Schema.decodeUnknownSync(ListAlertRulesOutput)(result.structuredContent)
		expect(output.rules.map((r) => r.id)).toEqual([RULE_ID])
		expect(output.services).toEqual(["checkout", "billing"])
		expect(text(result)).toContain("## Alert Rules")
		expect(text(result)).toContain("Services: checkout, billing")
		expect(text(result)).toContain(RULE_ID)
		expect(text(result)).toContain(`\`get_alert_rule rule_id="${RULE_ID}"\``)
		expect(text(result)).not.toContain("__maple_ui")
	})

	it("list_alert_rules rejects an unknown severity against the parameter", async () => {
		const result = await run("list_alert_rules", { severity: "sev1" })
		expect(result._tag).toBe("Failure")
	})

	it("list_alert_destinations renders destinations with their IDs", async () => {
		const result = await ok("list_alert_destinations", { type: "pagerduty" })
		const output = Schema.decodeUnknownSync(ListAlertDestinationsOutput)(result.structuredContent)
		expect(output.destinations[0]?.id).toBe(DEST_ID)
		expect(text(result)).toContain("On-call")
	})

	it("get_alert_rule renders the full config, and a missing id is invalid input on rule_id", async () => {
		const result = await ok("get_alert_rule", { rule_id: RULE_ID })
		const output = Schema.decodeUnknownSync(GetAlertRuleOutput)(result.structuredContent)
		expect(output.rule.notificationTitle).toBe("{{ rule.name }}")
		expect(text(result)).toContain("## Alert Rule: Checkout errors")
		expect(text(result)).toContain("Condition: > 0.05")
		expect(text(result)).toContain("Last evaluation error: column Foo not found")
		expect(text(result)).toContain("### Message Template")

		const missing = await run("get_alert_rule", { rule_id: "nope" })
		expect(missing._tag).toBe("Failure")
		if (missing._tag === "Failure") {
			expect(missing.failure._tag).toBe("@maple/mcp/errors/McpInvalidInputError")
			expect(missing.failure.parameter).toBe("rule_id")
		}
	})

	it("list_alert_incidents pushes status down, filters severity, and counts", async () => {
		const seen: Seen = {}
		const result = await ok(
			"list_alert_incidents",
			{ status: "open", severity: "critical", limit: "10" },
			seen,
		)
		expect(seen.incidentOptions).toMatchObject({ status: "open" })
		const output = Schema.decodeUnknownSync(ListAlertIncidentsOutput)(result.structuredContent)
		expect(output.incidents).toHaveLength(1)
		expect(output.openCount).toBe(1)
		expect(text(result)).toContain("Total: 1 (1 open, 0 resolved)")
		expect(text(result)).toContain('`get_incident_timeline group_key="checkout"`')
	})

	it("get_incident_timeline filters by rule and rejects a malformed rule_id", async () => {
		const seen: Seen = {}
		const result = await ok("get_incident_timeline", { rule_id: RULE_ID, limit: 1 }, seen)
		expect(seen.incidentOptions).toMatchObject({ ruleId: RULE_ID, limit: 2 })
		expect(text(result)).toContain("### Checkout errors (open)")
		expect(text(result)).toContain(`Incident ID: ${INCIDENT_ID}`)
		expect(text(result)).toContain("Showing 1 incidents.")

		const bad = await run("get_incident_timeline", { rule_id: "not-a-uuid" })
		expect(bad._tag === "Failure" && bad.failure.parameter).toBe("rule_id")
	})

	it("list_alert_checks takes since/until as the window and a bad rule_id as invalid input", async () => {
		const seen: Seen = {}
		const result = await ok(
			"list_alert_checks",
			{ rule_id: RULE_ID, since: "2026-09-24 00:00:00", until: "2026-09-24 12:00:00", status: "error" },
			seen,
		)
		expect(seen.checkOptions).toMatchObject({
			since: "2026-09-24T00:00:00Z",
			until: "2026-09-24T12:00:00Z",
			status: "error",
			limit: 100,
		})
		const output = Schema.decodeUnknownSync(ListAlertChecksOutput)(result.structuredContent)
		expect(output.errored).toBe(1)
		expect(output.timeRange).toEqual({ start: "2026-09-24 00:00:00", end: "2026-09-24 12:00:00" })
		expect(text(result)).toContain("Time range: 2026-09-24 00:00:00 to 2026-09-24 12:00:00")
		expect(text(result)).toContain(`\`get_alert_rule rule_id="${RULE_ID}"\``)

		const bad = await run("list_alert_checks", { rule_id: "nope" })
		expect(bad._tag === "Failure" && bad.failure._tag).toBe("@maple/mcp/errors/McpInvalidInputError")
		expect(bad._tag === "Failure" && bad.failure.parameter).toBe("rule_id")
	})

	it("create_alert_rule builds the request from a template and list params", async () => {
		const seen: Seen = {}
		const result = await ok(
			"create_alert_rule",
			{
				name: "Errors",
				template: "high_error_rate",
				destination_ids: DEST_ID,
				environments: ["production"],
			},
			seen,
		)
		expect(seen.created).toMatchObject({
			signalType: "error_rate",
			comparator: "gt",
			threshold: 0.05,
			severity: "warning",
			destinationIds: [DEST_ID],
			environments: ["production"],
			groupBy: ["service.name"],
		})
		expect(text(result)).toContain("## Alert Rule Created")

		// An explicit service scope displaces the template's grouping.
		await ok(
			"create_alert_rule",
			{
				name: "Errors",
				template: "high_error_rate",
				destination_ids: [DEST_ID],
				service_names: "checkout",
			},
			seen,
		)
		expect(seen.created?.serviceNames).toEqual(["checkout"])
		expect(seen.created?.groupBy).toBeUndefined()
	})

	it("create_alert_rule decodes query_builder_draft JSON and names missing inputs", async () => {
		const seen: Seen = {}
		await ok(
			"create_alert_rule",
			{
				name: "Draft",
				destination_ids: "",
				signal_type: "builder_query",
				comparator: "gt",
				threshold: 1,
				query_builder_draft:
					'{"id":"a","name":"A","dataSource":"traces","aggregation":"error_rate","whereClause":"","groupBy":["none"]}',
			},
			seen,
		)
		expect(seen.created?.queryBuilderDraft).toMatchObject({
			dataSource: "traces",
			aggregation: "error_rate",
		})

		const missing = await run("create_alert_rule", {
			name: "X",
			destination_ids: [],
			signal_type: "apdex",
			comparator: "lt",
			threshold: 0.8,
		})
		expect(missing._tag === "Failure" && missing.failure.parameter).toBe("apdex_threshold_ms")

		const noDestinations = await run("create_alert_rule", { name: "X", template: "slow_p95" })
		// Required in the published schema, so its absence is a decode failure naming it.
		expect(noDestinations._tag === "Failure" && noDestinations.failure.message).toContain(
			"Missing required `destination_ids`",
		)
	})

	it("update_alert_rule overlays only the given fields", async () => {
		const seen: Seen = {}
		await ok(
			"update_alert_rule",
			{ rule_id: RULE_ID, threshold: 0.1, group_by: "service.name,attr.http.route" },
			seen,
		)
		expect(seen.updated).toMatchObject({
			threshold: 0.1,
			name: "Checkout errors",
			serviceNames: ["checkout"],
			groupBy: ["service.name", "attr.http.route"],
		})
	})

	it("delete_alert_rule requires confirm and maps not-found to rule_id", async () => {
		const unconfirmed = await run("delete_alert_rule", { rule_id: RULE_ID, confirm: false })
		expect(unconfirmed._tag === "Failure" && unconfirmed.failure.parameter).toBe("confirm")

		const deleted = await ok("delete_alert_rule", { rule_id: RULE_ID, confirm: "true" })
		expect(text(deleted)).toContain(`ID: ${RULE_ID}`)

		const missing = await run("delete_alert_rule", { rule_id: INCIDENT_ID, confirm: true })
		expect(missing._tag === "Failure" && missing.failure.parameter).toBe("rule_id")
	})
})
