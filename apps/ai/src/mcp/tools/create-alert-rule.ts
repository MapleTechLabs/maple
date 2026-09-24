import { McpInvalidInputError, type McpToolRegistrar } from "./types"
import { Effect, Schema } from "effect"
import { CreateAlertRuleOutput } from "@maple/domain/mcp-outputs"
import { toMcpHttpError } from "../lib/map-http-error"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import { AlertRulesService } from "@maple/backend/services/alerts/AlertRulesService"
import {
	AlertRuleUpsertRequest,
	QueryBuilderQueryDraftSchema,
	type AlertComparator,
	type AlertSignalType,
} from "@maple/domain/http"
import {
	ALERT_COMPARATORS,
	ALERT_REDUCERS,
	ALERT_SEVERITIES,
	ALERT_SIGNAL_TYPES,
	renderRuleWrite,
	ruleWriteInputErrors,
	toAlertRuleRow,
} from "../lib/alert-rules"
import * as P from "../lib/params"

const decodeAlertRuleRequest = Schema.decodeUnknownEffect(AlertRuleUpsertRequest)

// Template definitions

interface AlertTemplate {
	readonly signalType: AlertSignalType
	readonly comparator: AlertComparator
	readonly defaultThreshold: number
	readonly groupBy?: ReadonlyArray<string>
	readonly apdexThresholdMs?: number
}

const TEMPLATE_NAMES = [
	"high_error_rate",
	"slow_p95",
	"slow_p99",
	"low_apdex",
	"throughput_drop",
	"custom",
] as const
type TemplateName = Exclude<(typeof TEMPLATE_NAMES)[number], "custom">

const ALERT_TEMPLATES = {
	high_error_rate: {
		signalType: "error_rate",
		comparator: "gt",
		defaultThreshold: 0.05,
		// Group per service by default. Ungrouped, the rule evaluates one org-wide
		// ratio whose denominator is every root span in the org — a service can be
		// failing outright and still not move a 5% threshold.
		groupBy: ["service.name"],
	},
	slow_p95: { signalType: "p95_latency", comparator: "gt", defaultThreshold: 1000 },
	slow_p99: { signalType: "p99_latency", comparator: "gt", defaultThreshold: 2000 },
	low_apdex: { signalType: "apdex", comparator: "lt", defaultThreshold: 0.8, apdexThresholdMs: 500 },
	throughput_drop: { signalType: "throughput", comparator: "lt", defaultThreshold: 100 },
} satisfies Record<TemplateName, AlertTemplate>

const Parameters = Schema.Struct({
	name: P.text("Rule name"),
	destination_ids: P.list(
		"Destination IDs to notify (use list_alert_destinations to find IDs). Pass an empty list for none.",
	),
	template: P.optionalOneOf(
		TEMPLATE_NAMES,
		"Template to auto-fill signal_type, comparator, and threshold. " +
			"high_error_rate: error_rate > 0.05 (5%). slow_p95: p95_latency > 1s. slow_p99: p99_latency > 2s. " +
			"low_apdex: apdex < 0.8. throughput_drop: throughput < 100rpm. " +
			"Use 'custom' for full control over signal_type/comparator/threshold. Default: custom.",
	),
	severity: P.optionalOneOf(ALERT_SEVERITIES, "Alert severity (default: warning)"),
	threshold: P.optionalNumber(
		"Threshold value (overrides template default). E.g. 0.05 for 5% error rate, 1000 for 1s latency",
	),
	window_minutes: P.optionalNumber("Evaluation window in minutes (default: 5)"),
	services: P.optionalList("Service names to scope the alert to"),
	environments: P.optionalList(
		"Deployment environments to scope the alert to (e.g. 'production'). Omit for all environments. Ignored for builder_query / raw_query, which filter inside their own query.",
	),
	enabled: P.optionalFlag("Whether the rule is enabled (default: true)"),
	// Custom-mode params (used when template is 'custom' or omitted)
	signal_type: P.optionalOneOf(
		ALERT_SIGNAL_TYPES,
		"Signal type (for custom). Use builder_query with a metrics draft for custom metrics. " +
			// Load-bearing caveat, not filler: without it an agent will happily create a
			// rule that can never fire. Compressed, not dropped.
			"NOTE: all except builder_query/raw_query are computed over ROOT spans only, so a service that fails on child spans but returns success from its entry point " +
			"(common in cron jobs and workers: audit_setup STAT-04 lists them) reads as healthy at any threshold. Use raw_query there, or rely on error-issue notifications.",
	),
	comparator: P.optionalOneOf(
		ALERT_COMPARATORS,
		"Comparison operator (for custom): gt (>), gte (>=), lt (<), lte (<=), eq, neq",
	),
	group_by: P.optionalList(
		"Dimensions to evaluate the alert per-group. Built-in tokens: service.name, span.name, status.code, http.method, severity. Attribute keys (traces/metrics): attr.<key>. Examples: ['service.name'], ['service.name', 'attr.http.route'].",
	),
	minimum_sample_count: P.optionalNumber("Minimum sample count before evaluating (default: 0)"),
	consecutive_breaches: P.optionalNumber("Consecutive breaches before alerting (default: 1)"),
	consecutive_healthy: P.optionalNumber("Consecutive healthy evaluations before resolving (default: 1)"),
	renotify_interval_minutes: P.optionalNumber("Re-notification interval in minutes (default: 60)"),
	apdex_threshold_ms: P.optionalNumber("Apdex threshold in milliseconds (required when signal_type=apdex)"),
	query_builder_draft: P.optionalJson(
		QueryBuilderQueryDraftSchema,
		"A query-builder draft, as an object or its JSON text (required when signal_type=builder_query). Same shape as dashboard custom-query widgets: { id, name, dataSource, aggregation, whereClause, groupBy, ... }.",
	),
	raw_query_sql: P.optionalText(
		"ClickHouse SQL returning a numeric `value` column, optional `group`/`samples` columns (required when signal_type=raw_query). Must reference $__orgFilter and $__timeFilter(col); supports $__startTime, $__endTime, and $__interval_s.",
	),
	raw_query_reducer: P.optionalOneOf(
		ALERT_REDUCERS,
		"How to collapse raw_query result rows into one value (default: identity).",
	),
	notification_title: P.optionalText(
		"Custom notification title template. Supports {{ variable }} substitution, e.g. " +
			'"{{ event.emoji }} {{ rule.name }}: {{ event.label }}". Omit for the built-in format. ' +
			"Variables: rule.name, severity, signal.label, comparator.label, threshold, value, observed.summary, group, window, links.app, links.chat.",
	),
	notification_body: P.optionalText(
		"Custom notification body template (Markdown). Supports {{ variable }} substitution and " +
			'{{#if key}}…{{/if}} blocks, e.g. "*Severity:* {{ severity }}\\n*Observed:* {{ observed.summary }}". Omit for the built-in format.',
	),
})

const invalid = (message: string, parameter: string, example?: string) =>
	Effect.fail(
		new McpInvalidInputError({
			message,
			parameter,
			...(example === undefined ? undefined : { example }),
		}),
	)

/** The upsert request the params describe, before the domain schema checks it. */
const buildAlertRuleRequest = Effect.fnUntraced(function* (params: typeof Parameters.Type) {
	const template: AlertTemplate | undefined =
		params.template === undefined || params.template === "custom"
			? undefined
			: ALERT_TEMPLATES[params.template]
	const signalType = template?.signalType ?? params.signal_type
	const comparator = template?.comparator ?? params.comparator
	const threshold = params.threshold ?? template?.defaultThreshold

	if (signalType === undefined) {
		return yield* invalid(
			"signal_type is required (or use a template).",
			"signal_type",
			'signal_type="error_rate" comparator="gt" threshold=0.05, or template="high_error_rate"',
		)
	}
	if (comparator === undefined) {
		return yield* invalid(
			"comparator is required (or use a template). Values: gt (>), gte (>=), lt (<), lte (<=).",
			"comparator",
			'comparator="gt" threshold=0.05',
		)
	}
	if (threshold === undefined) {
		return yield* invalid(
			"threshold is required (or use a template).",
			"threshold",
			"threshold=0.05 (for 5% error rate)",
		)
	}

	const apdexThresholdMs = params.apdex_threshold_ms ?? template?.apdexThresholdMs
	if (signalType === "apdex" && !apdexThresholdMs) {
		return yield* invalid(
			"signal_type=apdex requires apdex_threshold_ms (milliseconds defining satisfactory response time).",
			"apdex_threshold_ms",
			'signal_type="apdex" apdex_threshold_ms=500 comparator="lt" threshold=0.8',
		)
	}
	if (signalType === "builder_query" && params.query_builder_draft === undefined) {
		return yield* invalid(
			"signal_type=builder_query requires query_builder_draft: a query-builder draft (the same shape dashboard custom-query widgets use).",
			"query_builder_draft",
			'{"id":"a","name":"A","dataSource":"traces","aggregation":"error_rate","whereClause":"","groupBy":["none"]}',
		)
	}
	if (signalType === "raw_query") {
		if (params.raw_query_sql === undefined) {
			return yield* invalid(
				"signal_type=raw_query requires raw_query_sql: ClickHouse SQL returning a numeric `value` column (optional `group`, `samples` columns). Must reference $__orgFilter and $__timeFilter(col); may also use $__startTime, $__endTime, and $__interval_s.",
				"raw_query_sql",
			)
		}
		if (!params.raw_query_sql.includes("$__orgFilter")) {
			return yield* invalid(
				"raw_query_sql must reference $__orgFilter for org scoping",
				"raw_query_sql",
			)
		}
		if (!params.raw_query_sql.includes("$__timeFilter(")) {
			return yield* invalid(
				"raw_query_sql must reference $__timeFilter(...) to bound alert reads",
				"raw_query_sql",
			)
		}
	}

	const services = params.services !== undefined && params.services.length > 0 ? params.services : undefined
	const groupBy = params.group_by !== undefined && params.group_by.length > 0 ? params.group_by : undefined
	// A template's groupBy is a default, not an assertion. Grouping and an explicit
	// service scope are mutually exclusive, so an inherited groupBy must step aside
	// for a caller-supplied service; an explicit group_by is left to be rejected on its own terms.
	const effectiveGroupBy = groupBy ?? (services === undefined ? template?.groupBy : undefined)

	return {
		name: params.name,
		severity: params.severity ?? "warning",
		signalType,
		comparator,
		threshold,
		windowMinutes: params.window_minutes ?? 5,
		destinationIds: params.destination_ids,
		...(params.enabled === undefined ? undefined : { enabled: params.enabled }),
		...(services === undefined ? undefined : { serviceNames: services }),
		...(params.environments === undefined || params.environments.length === 0
			? undefined
			: { environments: params.environments }),
		...(effectiveGroupBy === undefined ? undefined : { groupBy: effectiveGroupBy }),
		...(params.minimum_sample_count === undefined
			? undefined
			: { minimumSampleCount: params.minimum_sample_count }),
		...(params.consecutive_breaches === undefined
			? undefined
			: { consecutiveBreachesRequired: params.consecutive_breaches }),
		...(params.consecutive_healthy === undefined
			? undefined
			: { consecutiveHealthyRequired: params.consecutive_healthy }),
		...(params.renotify_interval_minutes === undefined
			? undefined
			: { renotifyIntervalMinutes: params.renotify_interval_minutes }),
		...(apdexThresholdMs === undefined ? undefined : { apdexThresholdMs }),
		...(params.query_builder_draft === undefined
			? undefined
			: { queryBuilderDraft: params.query_builder_draft }),
		...(params.raw_query_sql === undefined ? undefined : { rawQuerySql: params.raw_query_sql }),
		...(params.raw_query_reducer === undefined
			? undefined
			: { rawQueryReducer: params.raw_query_reducer }),
		// {{ variable }} substitution; omit both for the built-in format.
		...(params.notification_title === undefined && params.notification_body === undefined
			? undefined
			: {
					notificationTemplate: {
						...(params.notification_title === undefined
							? undefined
							: { title: params.notification_title }),
						...(params.notification_body === undefined
							? undefined
							: { body: params.notification_body }),
					},
				}),
	}
})

export function registerCreateAlertRuleTool(server: McpToolRegistrar) {
	server.define({
		name: "create_alert_rule",
		// The template names live on the `template` parameter, with their thresholds;
		// repeating them here cost tokens twice for one fact.
		description:
			"Create an alert rule: from a `template` for common cases, or template='custom' for full control. " +
			"Use list_alert_destinations to find destination_ids.",
		parameters: Parameters,
		aliases: { service_names: "services" },
		output: CreateAlertRuleOutput,
		hints: { readOnly: false, destructive: false, idempotent: false },
		phrases: ["Creating an alert rule"],
		handler: Effect.fn("McpTool.createAlertRule")(function* (params) {
			const request = yield* buildAlertRuleRequest(params)
			const decoded = yield* decodeAlertRuleRequest(request).pipe(
				Effect.mapError(
					(error) => new McpInvalidInputError({ message: `Invalid alert rule: ${String(error)}` }),
				),
			)

			const tenant = yield* CurrentMcpTenant
			const alerts = yield* AlertRulesService

			const rule = yield* alerts.createRule(tenant.orgId, tenant.userId, tenant.roles, decoded).pipe(
				Effect.catchTags(ruleWriteInputErrors),
				Effect.catchTags({
					"@maple/http/errors/AlertForbiddenError": (error) =>
						Effect.fail(toMcpHttpError("create_alert_rule")(error)),
					"@maple/http/errors/AlertPersistenceError": (error) =>
						Effect.fail(toMcpHttpError("create_alert_rule")(error)),
				}),
			)

			return { rule: toAlertRuleRow(rule) }
		}),
		render: (output) => renderRuleWrite("Alert Rule Created", output.rule),
	})
}
