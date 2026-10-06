import { McpInvalidInputError, type McpToolRegistrar } from "./types"
import { Effect, Schema } from "effect"
import { UpdateAlertRuleOutput } from "@maple/domain/mcp-outputs"
import { toMcpHttpError } from "../lib/map-http-error"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import { AlertsService } from "@maple/backend/services/alerts/AlertsService"
import { AlertRulesService } from "@maple/backend/services/alerts/AlertRulesService"
import {
	AlertRuleUpsertRequest,
	QueryBuilderQueryDraftSchema,
	type AlertRuleDocument,
} from "@maple/domain/http"
import {
	ALERT_COMPARATORS,
	ALERT_REDUCERS,
	ALERT_SEVERITIES,
	ALERT_SIGNAL_TYPES,
	renderBulkRuleWrite,
	renderRuleWrite,
	ruleConfigWarnings,
	ruleNotFound,
	ruleNotFoundFromError,
	ruleWriteInputErrors,
	toAlertRuleRow,
} from "../lib/alert-rules"
import { firstEvaluation } from "../lib/alert-rule-evaluation"
import * as P from "../lib/params"

const decodeAlertRuleRequest = Schema.decodeUnknownEffect(AlertRuleUpsertRequest)

export const UpdateAlertRuleParameters = Schema.Struct({
	rule_id: P.optionalText("Alert rule ID to update (use list_alert_rules to find IDs)"),
	rule_ids: P.optionalList(
		'Apply the same change to several rules in one call instead of rule_id; ["*"] means every rule. name cannot be set in bulk.',
	),
	name: P.optionalText("New rule name"),
	severity: P.optionalOneOf(ALERT_SEVERITIES, "Alert severity"),
	threshold: P.optionalNumber("Threshold value. E.g. 0.05 for 5% error rate, 1000 for 1s latency"),
	window_minutes: P.optionalNumber("Evaluation window in minutes"),
	services: P.optionalList("Service scope (replaces the current one; an empty list means all services)"),
	environments: P.optionalList(
		"Deployment environments to scope the alert to (replaces the current scope; pass an empty list for all environments). Ignored for builder_query / raw_query.",
	),
	enabled: P.optionalFlag("Whether the rule is enabled"),
	destination_ids: P.optionalList(
		"Destination IDs to notify (replaces the current destinations; use list_alert_destinations to find IDs)",
	),
	add_destination_ids: P.optionalList("Destination IDs to add, keeping the current ones"),
	remove_destination_ids: P.optionalList("Destination IDs to remove, keeping the rest"),
	signal_type: P.optionalOneOf(
		ALERT_SIGNAL_TYPES,
		"What the rule measures. builder_query takes query_builder_draft, raw_query takes raw_query_sql.",
	),
	comparator: P.optionalOneOf(ALERT_COMPARATORS, "How the observed value is compared with threshold"),
	group_by: P.optionalList(
		"Dimensions to evaluate the alert per-group (replaces the current grouping; an empty list removes it). " +
			"Built-in tokens: service.name, span.name, status.code, http.method, severity. Attribute keys: attr.<key>.",
	),
	minimum_sample_count: P.optionalNumber(
		"Skip evaluation below this many samples in the window. For raw_query it sums the `samples` column; without one each returned row counts as 1.",
	),
	alert_on_no_data: P.optionalFlag(
		"Count a window with no data as a breach instead of skipping it. Not supported with group_by.",
	),
	consecutive_breaches: P.optionalNumber("Consecutive breaches before alerting"),
	consecutive_healthy: P.optionalNumber("Consecutive healthy evaluations before resolving"),
	renotify_interval_minutes: P.optionalNumber("Re-notification interval in minutes"),
	apdex_threshold_ms: P.optionalNumber("Apdex threshold in milliseconds (for signal_type=apdex)"),
	query_builder_draft: P.optionalJson(
		QueryBuilderQueryDraftSchema,
		"Query-builder draft, same shape as create_alert_rule (for signal_type=builder_query)",
	),
	raw_query_sql: P.optionalText(
		"ClickHouse SQL returning a numeric `value` column (for signal_type=raw_query). Must reference $__orgFilter and $__timeFilter(col).",
	),
	raw_query_reducer: P.optionalOneOf(
		ALERT_REDUCERS,
		"How to collapse raw_query result rows into one value.",
	),
	notification_title: P.optionalText(
		"Notification title template with {{ variable }} substitution; variables as in create_alert_rule",
	),
	notification_body: P.optionalText(
		"Notification body template (Markdown) with {{ variable }} and {{#if key}}...{{/if}}",
	),
})

/**
 * `AlertRuleUpsertRequest` is a full replacement, not a patch, so the request is seeded from the
 * rule's current config and overlaid with only the params the caller provided. The service's
 * `normalizeRule` validates the merged result.
 */
export function buildUpdatedRequest(
	current: AlertRuleDocument,
	params: typeof UpdateAlertRuleParameters.Type,
) {
	// Merge notification template fields onto the existing template (null-safe).
	const touchesTemplate = params.notification_title !== undefined || params.notification_body !== undefined
	const title = params.notification_title ?? current.notificationTemplate?.title ?? undefined
	const body = params.notification_body ?? current.notificationTemplate?.body ?? undefined
	const notificationTemplate = touchesTemplate
		? title === undefined && body === undefined
			? null
			: {
					...(title === undefined ? undefined : { title }),
					...(body === undefined ? undefined : { body }),
				}
		: current.notificationTemplate

	return {
		name: params.name ?? current.name,
		notes: current.notes,
		notificationTemplate,
		enabled: params.enabled ?? current.enabled,
		severity: params.severity ?? current.severity,
		serviceNames: [...(params.services ?? current.serviceNames)],
		excludeServiceNames: [...current.excludeServiceNames],
		environments: [...(params.environments ?? current.environments)],
		tags: [...current.tags],
		groupBy:
			params.group_by !== undefined
				? params.group_by.length > 0
					? [...params.group_by]
					: null
				: current.groupBy
					? [...current.groupBy]
					: null,
		signalType: params.signal_type ?? current.signalType,
		comparator: params.comparator ?? current.comparator,
		threshold: params.threshold ?? current.threshold,
		thresholdUpper: current.thresholdUpper,
		windowMinutes: params.window_minutes ?? current.windowMinutes,
		minimumSampleCount: params.minimum_sample_count ?? current.minimumSampleCount,
		consecutiveBreachesRequired: params.consecutive_breaches ?? current.consecutiveBreachesRequired,
		consecutiveHealthyRequired: params.consecutive_healthy ?? current.consecutiveHealthyRequired,
		renotifyIntervalMinutes: params.renotify_interval_minutes ?? current.renotifyIntervalMinutes,
		apdexThresholdMs: params.apdex_threshold_ms ?? current.apdexThresholdMs,
		queryBuilderDraft: params.query_builder_draft ?? current.queryBuilderDraft,
		rawQuerySql: params.raw_query_sql ?? current.rawQuerySql,
		rawQueryReducer: params.raw_query_reducer ?? current.rawQueryReducer,
		alertOnNoData: params.alert_on_no_data ?? current.noDataBehavior === "alert",
		destinationIds: mergeDestinations(current.destinationIds, params),
	}
}

/** `destination_ids` replaces; add/remove edit the current (or replaced) list in place. */
const mergeDestinations = (
	current: ReadonlyArray<string>,
	params: Pick<
		typeof UpdateAlertRuleParameters.Type,
		"destination_ids" | "add_destination_ids" | "remove_destination_ids"
	>,
): Array<string> => {
	const base = params.destination_ids ?? current
	const removed = new Set(params.remove_destination_ids ?? [])
	return [...new Set([...base, ...(params.add_destination_ids ?? [])])].filter((id) => !removed.has(id))
}

const noTargets = new McpInvalidInputError({
	message: "Pass rule_id, or rule_ids for several rules (list_alert_rules has the IDs).",
	parameter: "rule_id",
})

/** The rules a call targets: `rule_id` and/or `rule_ids`, where `"*"` is every rule. */
const resolveTargets = (
	rules: ReadonlyArray<AlertRuleDocument>,
	params: Pick<typeof UpdateAlertRuleParameters.Type, "rule_id" | "rule_ids">,
): Effect.Effect<ReadonlyArray<AlertRuleDocument>, McpInvalidInputError> => {
	const ids = [...(params.rule_id === undefined ? [] : [params.rule_id]), ...(params.rule_ids ?? [])]
	if (ids.length === 0) return Effect.fail(noTargets)
	if (ids.includes("*")) return rules.length > 0 ? Effect.succeed(rules) : Effect.fail(noTargets)
	const unique = [...new Set(ids)]
	const missing = unique.find((id) => !rules.some((r) => r.id === id))
	if (missing !== undefined) return Effect.fail(ruleNotFound(missing))
	return Effect.succeed(rules.filter((r) => unique.includes(r.id)))
}

export function registerUpdateAlertRuleTool(server: McpToolRegistrar) {
	server.define({
		name: "update_alert_rule",
		title: "Update Alert Rule",
		description:
			"Update an alert rule. Pass only the fields to change; the rest keep their current value (get_alert_rule shows it). " +
			'rule_ids applies one change to many rules (e.g. add_destination_ids on every rule with rule_ids=["*"]). ' +
			"Ids from list_alert_rules and list_alert_destinations.",
		parameters: UpdateAlertRuleParameters,
		aliases: { service_names: "services" },
		output: UpdateAlertRuleOutput,
		hints: { readOnly: false, destructive: false, idempotent: true },
		phrases: ["Updating an alert rule"],
		handler: Effect.fn("McpTool.updateAlertRule")(function* (params) {
			const tenant = yield* CurrentMcpTenant
			const alerts = yield* AlertsService
			const rules = yield* AlertRulesService

			const list = yield* rules
				.listRules(tenant.orgId)
				.pipe(Effect.mapError(toMcpHttpError("update_alert_rule")))

			const targets = yield* resolveTargets(list.rules, params)
			if (targets.length > 1 && params.name !== undefined) {
				return yield* new McpInvalidInputError({
					message: "name cannot be set on several rules at once; update them one by one.",
					parameter: "name",
				})
			}

			// Decode every merged request before writing any, so a bad overlay saves nothing.
			const requests = yield* Effect.forEach(targets, (current) =>
				decodeAlertRuleRequest(buildUpdatedRequest(current, params)).pipe(
					Effect.map((request) => ({ current, request })),
					Effect.mapError(
						(error) =>
							new McpInvalidInputError({
								message: `Invalid alert rule${targets.length > 1 ? ` "${current.name}"` : ""}: ${String(error)}`,
							}),
					),
				),
			)

			const saved = yield* Effect.forEach(requests, ({ current, request }) =>
				alerts.updateRule(tenant.orgId, tenant.userId, tenant.roles, current.id, request).pipe(
					Effect.catchTags(ruleWriteInputErrors),
					Effect.catchTags({
						"@maple/http/errors/AlertRuleNotFoundError": ruleNotFoundFromError,
						"@maple/http/errors/AlertForbiddenError": (error) =>
							Effect.fail(toMcpHttpError("update_alert_rule")(error)),
						"@maple/http/errors/AlertPersistenceError": (error) =>
							Effect.fail(toMcpHttpError("update_alert_rule")(error)),
						"@maple/http/errors/AlertRuleStoredConfigInvalidError": (error) =>
							Effect.fail(toMcpHttpError("update_alert_rule")(error)),
					}),
					Effect.map((rule) => ({ rule, request })),
				),
			)

			const head = saved[0]
			if (head === undefined) return yield* noTargets
			const bulk = saved.length > 1
			const configWarnings = saved.flatMap(({ rule }) =>
				ruleConfigWarnings(rule).map((w) => (bulk ? `${rule.name}: ${w}` : w)),
			)
			// One rule gets a first-evaluation preview; a bulk change would run one per rule.
			const evaluated = bulk ? undefined : yield* firstEvaluation(head.request, head.rule.enabled)
			const warnings = [...configWarnings, ...(evaluated?.warnings ?? [])]
			return {
				rule: toAlertRuleRow(head.rule),
				...(bulk ? { rules: saved.map(({ rule }) => toAlertRuleRow(rule)) } : undefined),
				...(warnings.length > 0 ? { warnings } : undefined),
				...(evaluated === undefined ? undefined : { evaluation: evaluated.evaluation }),
			}
		}),
		render: (output) =>
			output.rules === undefined
				? renderRuleWrite("Alert Rule Updated", output.rule, output.warnings, output.evaluation)
				: renderBulkRuleWrite(output.rules, output.warnings),
	})
}
