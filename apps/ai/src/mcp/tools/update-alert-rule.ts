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
	renderRuleWrite,
	ruleNotFound,
	ruleNotFoundFromError,
	ruleWriteInputErrors,
	toAlertRuleRow,
} from "../lib/alert-rules"
import * as P from "../lib/params"

const decodeAlertRuleRequest = Schema.decodeUnknownEffect(AlertRuleUpsertRequest)

const Parameters = Schema.Struct({
	rule_id: P.text("Alert rule ID to update (use list_alert_rules to find IDs)"),
	name: P.optionalText("New rule name"),
	severity: P.optionalOneOf(ALERT_SEVERITIES, "Alert severity"),
	threshold: P.optionalNumber("Threshold value. E.g. 0.05 for 5% error rate, 1000 for 1s latency"),
	window_minutes: P.optionalNumber("Evaluation window in minutes"),
	services: P.optionalList("Service names to scope the alert to (replaces the current scope)"),
	environments: P.optionalList(
		"Deployment environments to scope the alert to (replaces the current scope; pass an empty list for all environments). Ignored for builder_query / raw_query.",
	),
	enabled: P.optionalFlag("Whether the rule is enabled"),
	destination_ids: P.optionalList(
		"Destination IDs to notify (replaces the current destinations; use list_alert_destinations to find IDs)",
	),
	signal_type: P.optionalOneOf(
		ALERT_SIGNAL_TYPES,
		"Signal type. Use builder_query with a metrics draft for custom metrics.",
	),
	comparator: P.optionalOneOf(
		ALERT_COMPARATORS,
		"Comparison operator: gt (>), gte (>=), lt (<), lte (<=), eq, neq",
	),
	group_by: P.optionalList(
		"Dimensions to evaluate the alert per-group (replaces the current grouping; an empty list removes it). " +
			"Built-in tokens: service.name, span.name, status.code, http.method, severity. Attribute keys: attr.<key>.",
	),
	minimum_sample_count: P.optionalNumber("Minimum sample count before evaluating"),
	consecutive_breaches: P.optionalNumber("Consecutive breaches before alerting"),
	consecutive_healthy: P.optionalNumber("Consecutive healthy evaluations before resolving"),
	renotify_interval_minutes: P.optionalNumber("Re-notification interval in minutes"),
	apdex_threshold_ms: P.optionalNumber("Apdex threshold in milliseconds (for signal_type=apdex)"),
	query_builder_draft: P.optionalJson(
		QueryBuilderQueryDraftSchema,
		"A query-builder draft, as an object or its JSON text (for signal_type=builder_query).",
	),
	raw_query_sql: P.optionalText(
		"ClickHouse SQL returning a numeric `value` column (for signal_type=raw_query). Must reference $__orgFilter and $__timeFilter(col).",
	),
	raw_query_reducer: P.optionalOneOf(
		ALERT_REDUCERS,
		"How to collapse raw_query result rows into one value.",
	),
	notification_title: P.optionalText(
		"Custom notification title template. Supports {{ variable }} substitution.",
	),
	notification_body: P.optionalText(
		"Custom notification body template (Markdown). Supports {{ variable }} substitution.",
	),
})

/**
 * `AlertRuleUpsertRequest` is a full replacement, not a patch, so the request is seeded from the
 * rule's current config and overlaid with only the params the caller provided. The service's
 * `normalizeRule` validates the merged result.
 */
function buildUpdatedRequest(current: AlertRuleDocument, params: typeof Parameters.Type) {
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
		destinationIds: [...(params.destination_ids ?? current.destinationIds)],
	}
}

export function registerUpdateAlertRuleTool(server: McpToolRegistrar) {
	server.define({
		name: "update_alert_rule",
		description:
			"Update an existing alert rule. Only provide the fields you want to change: every other field keeps its current value. " +
			"Use list_alert_rules to find rule IDs and list_alert_destinations for destination IDs, or get_alert_rule to inspect the current config first.",
		parameters: Parameters,
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

			const current = list.rules.find((r) => r.id === params.rule_id)
			if (!current) return yield* ruleNotFound(params.rule_id)

			const decoded = yield* decodeAlertRuleRequest(buildUpdatedRequest(current, params)).pipe(
				Effect.mapError(
					(error) => new McpInvalidInputError({ message: `Invalid alert rule: ${String(error)}` }),
				),
			)

			const rule = yield* alerts
				.updateRule(tenant.orgId, tenant.userId, tenant.roles, current.id, decoded)
				.pipe(
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
				)

			return { rule: toAlertRuleRow(rule) }
		}),
		render: (output) => renderRuleWrite("Alert Rule Updated", output.rule),
	})
}
