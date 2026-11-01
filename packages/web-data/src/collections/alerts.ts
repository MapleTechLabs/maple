import {
	AlertComparator,
	AlertDestinationDocument,
	AlertDestinationId,
	AlertDestinationType,
	AlertEvaluationErrorKind,
	AlertEvaluationIntervalMinutes,
	AlertEventType,
	AlertGroupBy,
	AlertIncidentDocument,
	AlertIncidentHoldReason,
	AlertIncidentStatus,
	AlertNotificationTemplate,
	AlertRuleDocument,
	AlertRuleId,
	AlertSeverity,
	AlertSignalType,
	AlertThresholds,
	ChatConnectorId,
	ChatWorkspaceId,
	ErrorIssueId,
	IsoDateTimeString,
	QueryBuilderQueryDraftSchema,
	UserId,
	alertThresholdLegacyFields,
	legacyAlertThreshold,
	sortAlertThresholds,
} from "@maple/domain/http"
import { QueryEngineAlertReducer, QueryEngineNoDataBehavior } from "@maple/domain/query-engine"
import { Array as Arr, Option, Schema } from "effect"

const decodeIso = Schema.decodeUnknownSync(IsoDateTimeString)
const asAlertRuleId = Schema.decodeUnknownSync(AlertRuleId)
const asAlertIncidentId = Schema.decodeUnknownSync(AlertIncidentDocument.fields.id)
const asUserId = Schema.decodeUnknownSync(UserId)
const asErrorIssueId = Schema.decodeUnknownSync(ErrorIssueId)
const decodeDestinationId = Schema.decodeUnknownSync(AlertDestinationId)

const asDestinationType = Schema.decodeUnknownSync(AlertDestinationType)

const asSeverity = Schema.decodeUnknownSync(AlertSeverity)
const asSignalType = Schema.decodeUnknownSync(AlertSignalType)
const asComparator = Schema.decodeUnknownSync(AlertComparator)
const asEvaluationInterval = Schema.decodeUnknownSync(Schema.NullOr(AlertEvaluationIntervalMinutes))
const decodeErrorKind = Schema.decodeUnknownOption(AlertEvaluationErrorKind)
const asIncidentStatus = Schema.decodeUnknownSync(AlertIncidentStatus)
const asHoldReason = Schema.decodeUnknownSync(AlertIncidentHoldReason)
const asEventType = Schema.decodeUnknownSync(AlertEventType)
const asReducer = Schema.decodeUnknownSync(QueryEngineAlertReducer)
// Lenient: a behavior added by a newer server reads as skip rather than breaking the alerts list.
const decodeNoDataBehavior = Schema.decodeUnknownOption(QueryEngineNoDataBehavior)

const decodeNotificationTemplate = Schema.decodeUnknownOption(AlertNotificationTemplate)
const decodeQueryBuilderDraft = Schema.decodeUnknownOption(QueryBuilderQueryDraftSchema)
const decodeThresholds = Schema.decodeUnknownOption(AlertThresholds)
const decodeStringArray = Schema.decodeUnknownOption(Schema.Array(Schema.String))
// The stored `group_by` column is a JSON-encoded string array (mirrors the
// server's `Schema.fromJsonString(AlertGroupBy)`).
const decodeGroupByFromJson = Schema.decodeUnknownSync(Schema.fromJsonString(AlertGroupBy))

/**
 * `safeParseStringArray` mirrors AlertsService: use the value when it decodes to
 * an array of strings, else fall back to `[]`. Row json columns arrive as parsed
 * arrays via the @electric-sql/client default parser.
 */
const safeParseStringArray = (value: unknown): ReadonlyArray<string> =>
	Option.getOrElse(decodeStringArray(value), () => [] as ReadonlyArray<string>)

// alert_rules

/**
 * Identity row schema for `alert_rules` — mirrors the pgTable columns (snake_case)
 * so a post-deploy column drift surfaces as a SchemaValidationError (→ self-heal),
 * not as silently-dropped fields. Timestamp columns stay `Schema.String` (the
 * timestamptz parser has already normalized them to ISO).
 */
export const AlertRuleRowSchema = Schema.Struct({
	id: Schema.String,
	org_id: Schema.String,
	name: Schema.String,
	notes: Schema.NullOr(Schema.String),
	notification_template_json: Schema.NullOr(Schema.Unknown),
	enabled: Schema.Boolean,
	severity: Schema.String,
	service_names_json: Schema.NullOr(Schema.Unknown),
	exclude_service_names_json: Schema.NullOr(Schema.Unknown),
	environments_json: Schema.NullOr(Schema.Unknown),
	tags_json: Schema.NullOr(Schema.Unknown),
	signal_type: Schema.String,
	comparator: Schema.String,
	threshold: Schema.Number,
	threshold_upper: Schema.NullOr(Schema.Number),
	// Optional: rows synced before the column existed omit it.
	thresholds_json: Schema.optionalKey(Schema.NullOr(Schema.Unknown)),
	window_minutes: Schema.Number,
	evaluation_interval_minutes: Schema.optionalKey(Schema.NullOr(Schema.Number)),
	minimum_sample_count: Schema.Number,
	consecutive_breaches_required: Schema.Number,
	breaches_out_of: Schema.optionalKey(Schema.NullOr(Schema.Number)),
	consecutive_healthy_required: Schema.Number,
	renotify_interval_minutes: Schema.Number,
	apdex_threshold_ms: Schema.NullOr(Schema.Number),
	query_builder_draft_json: Schema.NullOr(Schema.Unknown),
	raw_query_sql: Schema.NullOr(Schema.String),
	reducer: Schema.String,
	group_by: Schema.NullOr(Schema.String),
	destination_ids_json: Schema.Unknown,
	query_spec_json: Schema.NullOr(Schema.Unknown),
	sample_count_strategy: Schema.NullOr(Schema.String),
	no_data_behavior: Schema.String,
	last_scheduled_at: Schema.NullOr(Schema.String),
	slowed_interval_minutes: Schema.optionalKey(Schema.NullOr(Schema.Number)),
	slowed_at: Schema.optionalKey(Schema.NullOr(Schema.String)),
	created_at: Schema.String,
	updated_at: Schema.String,
	created_by: Schema.String,
	updated_by: Schema.String,
})
export type AlertRuleRow = typeof AlertRuleRowSchema.Type

// alert_rule_states

export const AlertRuleStateRowSchema = Schema.Struct({
	org_id: Schema.String,
	rule_id: Schema.String,
	group_key: Schema.String,
	consecutive_breaches: Schema.Number,
	consecutive_healthy: Schema.Number,
	history_json: Schema.optionalKey(Schema.NullOr(Schema.Unknown)),
	last_status: Schema.NullOr(Schema.String),
	last_value: Schema.NullOr(Schema.Number),
	last_sample_count: Schema.NullOr(Schema.Number),
	last_evaluated_at: Schema.NullOr(Schema.String),
	last_error: Schema.NullOr(Schema.String),
	last_error_kind: Schema.optionalKey(Schema.NullOr(Schema.String)),
	updated_at: Schema.String,
})
export type AlertRuleStateRow = typeof AlertRuleStateRowSchema.Type

// alert_incidents

export const AlertIncidentRowSchema = Schema.Struct({
	id: Schema.String,
	org_id: Schema.String,
	rule_id: Schema.String,
	incident_key: Schema.String,
	rule_name: Schema.String,
	group_key: Schema.NullOr(Schema.String),
	signal_type: Schema.String,
	severity: Schema.String,
	peak_severity: Schema.optionalKey(Schema.NullOr(Schema.String)),
	status: Schema.String,
	comparator: Schema.String,
	threshold: Schema.Number,
	threshold_upper: Schema.NullOr(Schema.Number),
	first_triggered_at: Schema.String,
	last_triggered_at: Schema.String,
	resolved_at: Schema.NullOr(Schema.String),
	last_observed_value: Schema.NullOr(Schema.Number),
	last_sample_count: Schema.NullOr(Schema.Number),
	last_evaluated_at: Schema.NullOr(Schema.String),
	dedupe_key: Schema.String,
	last_delivered_event_type: Schema.NullOr(Schema.String),
	last_notified_at: Schema.NullOr(Schema.String),
	hold_reason: Schema.NullOr(Schema.String),
	held_since: Schema.NullOr(Schema.String),
	error_issue_id: Schema.NullOr(Schema.String),
	created_at: Schema.String,
	updated_at: Schema.String,
})
export type AlertIncidentRow = typeof AlertIncidentRowSchema.Type

// Mappers (mirror the server row→document mappers in AlertsService.ts)

/**
 * Most recent evaluation error/timestamp for a rule, aggregated across its group
 * states — mirrors the server's `RuleEvaluationState` join. The map is keyed by
 * rule id and prefers the state row that carries a non-null `last_error`.
 */
export const buildRuleStatesByRuleId = (
	states: ReadonlyArray<AlertRuleStateRow>,
): Map<string, AlertRuleStateRow> => {
	const map = new Map<string, AlertRuleStateRow>()
	for (const state of states) {
		const existing = map.get(state.rule_id)
		// Prefer a row that has an error; otherwise keep any (the first seen).
		if (!existing || (state.last_error != null && existing.last_error == null)) {
			map.set(state.rule_id, state)
		}
	}
	return map
}

/**
 * Decodes a raw `alert_rules` row into the domain {@link AlertRuleDocument},
 * mirroring `rowToRuleDocument` in AlertsService.ts. The joined evaluation state
 * (from the `alert_rule_states` collection) supplies `lastEvaluationError` /
 * `lastEvaluatedAt`.
 */
export const rowToAlertRuleDocument = (
	row: AlertRuleRow,
	statesByRuleId: Map<string, AlertRuleStateRow>,
): AlertRuleDocument => {
	const state = statesByRuleId.get(row.id)
	const destinationIds = safeParseStringArray(row.destination_ids_json).map((id) => decodeDestinationId(id))
	// Rows written before tiers carry none: they are one tier from the legacy columns.
	const legacyTier = legacyAlertThreshold({
		severity: asSeverity(row.severity),
		threshold: row.threshold,
		thresholdUpper: row.threshold_upper,
		destinationIds,
	})
	const thresholds = sortAlertThresholds(
		Option.getOrElse(decodeThresholds(row.thresholds_json), () => Arr.of(legacyTier)),
	)
	const legacy = alertThresholdLegacyFields(thresholds)
	return new AlertRuleDocument({
		id: asAlertRuleId(row.id),
		name: row.name,
		notes: row.notes ?? null,
		notificationTemplate:
			row.notification_template_json == null
				? null
				: Option.getOrElse(decodeNotificationTemplate(row.notification_template_json), () => null),
		enabled: row.enabled,
		severity: legacy.severity,
		thresholds,
		serviceNames: [...safeParseStringArray(row.service_names_json)],
		excludeServiceNames: [...safeParseStringArray(row.exclude_service_names_json)],
		environments: [...safeParseStringArray(row.environments_json)],
		tags: [...safeParseStringArray(row.tags_json)],
		groupBy: row.group_by == null ? null : decodeGroupByFromJson(row.group_by),
		signalType: asSignalType(row.signal_type),
		comparator: asComparator(row.comparator),
		threshold: legacy.threshold,
		thresholdUpper: legacy.thresholdUpper,
		windowMinutes: row.window_minutes,
		evaluationIntervalMinutes: asEvaluationInterval(row.evaluation_interval_minutes ?? null),
		minimumSampleCount: row.minimum_sample_count,
		consecutiveBreachesRequired: row.consecutive_breaches_required,
		breachesOutOf: row.breaches_out_of ?? null,
		consecutiveHealthyRequired: row.consecutive_healthy_required,
		renotifyIntervalMinutes: row.renotify_interval_minutes,
		apdexThresholdMs: row.apdex_threshold_ms,
		queryBuilderDraft:
			row.query_builder_draft_json == null
				? null
				: Option.getOrElse(decodeQueryBuilderDraft(row.query_builder_draft_json), () => null),
		rawQuerySql: row.raw_query_sql ?? null,
		rawQueryReducer: row.signal_type === "raw_query" ? asReducer(row.reducer) : null,
		destinationIds: legacy.destinationIds,
		noDataBehavior: Option.getOrElse(decodeNoDataBehavior(row.no_data_behavior), () => "skip" as const),
		lastEvaluationError: state?.last_error ?? null,
		lastEvaluationErrorKind: Option.getOrNull(decodeErrorKind(state?.last_error_kind)),
		slowedIntervalMinutes: asEvaluationInterval(row.slowed_interval_minutes ?? null),
		slowedAt: row.slowed_at != null ? decodeIso(row.slowed_at) : null,
		lastEvaluatedAt: state?.last_evaluated_at != null ? decodeIso(state.last_evaluated_at) : null,
		lastScheduledAt: row.last_scheduled_at != null ? decodeIso(row.last_scheduled_at) : null,
		createdAt: decodeIso(row.created_at),
		updatedAt: decodeIso(row.updated_at),
		createdBy: asUserId(row.created_by),
		updatedBy: asUserId(row.updated_by),
	})
}

/**
 * Decodes a raw `alert_incidents` row into the domain {@link AlertIncidentDocument},
 * mirroring `rowToIncidentDocument` in AlertsService.ts.
 */
export const rowToAlertIncidentDocument = (row: AlertIncidentRow): AlertIncidentDocument =>
	new AlertIncidentDocument({
		id: asAlertIncidentId(row.id),
		ruleId: asAlertRuleId(row.rule_id),
		ruleName: row.rule_name,
		groupKey: row.group_key,
		signalType: asSignalType(row.signal_type),
		severity: asSeverity(row.severity),
		peakSeverity: row.peak_severity == null ? null : asSeverity(row.peak_severity),
		status: asIncidentStatus(row.status),
		comparator: asComparator(row.comparator),
		threshold: row.threshold,
		thresholdUpper: row.threshold_upper,
		firstTriggeredAt: decodeIso(row.first_triggered_at),
		lastTriggeredAt: decodeIso(row.last_triggered_at),
		resolvedAt: row.resolved_at != null ? decodeIso(row.resolved_at) : null,
		lastObservedValue: row.last_observed_value,
		lastSampleCount: row.last_sample_count,
		dedupeKey: row.dedupe_key,
		lastDeliveredEventType:
			row.last_delivered_event_type != null ? asEventType(row.last_delivered_event_type) : null,
		lastNotifiedAt: row.last_notified_at != null ? decodeIso(row.last_notified_at) : null,
		holdReason: row.hold_reason != null ? asHoldReason(row.hold_reason) : null,
		heldSince: row.held_since != null ? decodeIso(row.held_since) : null,
		errorIssueId: row.error_issue_id != null ? asErrorIssueId(row.error_issue_id) : null,
	})

// alert_destinations

/**
 * Identity row schema for the `alert_destinations_v2` shape. The shape is
 * column-restricted server-side (the encrypted `secret_*` columns are dropped —
 * see the proxy whitelist), so this struct intentionally lists only the synced
 * columns. `config_json` carries ONLY public config (summary / channel label /
 * chat workspace); the webhook secrets live in the excluded encrypted columns.
 */
export const AlertDestinationRowSchema = Schema.Struct({
	id: Schema.String,
	org_id: Schema.String,
	name: Schema.String,
	type: Schema.String,
	enabled: Schema.Boolean,
	config_json: Schema.Unknown,
	last_tested_at: Schema.NullOr(Schema.String),
	last_test_error: Schema.NullOr(Schema.String),
	disabled_at: Schema.NullOr(Schema.String),
	disabled_reason: Schema.NullOr(Schema.String),
	created_at: Schema.String,
	updated_at: Schema.String,
})
export type AlertDestinationRow = typeof AlertDestinationRowSchema.Type

/**
 * The public projection of a destination's `config_json` the browser renders —
 * mirrors the server's `DestinationPublicConfigSchema`. The server stringifies the
 * jsonb before decoding; Electric's default parser already gives us the parsed
 * object, so we decode it directly.
 */
const AlertDestinationPublicConfig = Schema.Struct({
	summary: Schema.String,
	channelLabel: Schema.NullOr(Schema.String),
	memberUserIds: Schema.optionalKey(Schema.Array(Schema.String)),
	chatConnector: Schema.optionalKey(ChatConnectorId),
	chatWorkspaceId: Schema.optionalKey(ChatWorkspaceId),
	linearTeamId: Schema.optionalKey(Schema.String),
})
const decodeDestinationPublicConfig = Schema.decodeUnknownOption(AlertDestinationPublicConfig)

/**
 * Decodes a raw `alert_destinations` row into the domain
 * {@link AlertDestinationDocument}, mirroring `rowToDestinationDocument` +
 * `safeParsePublicConfig` in AlertsService.ts (invalid config → the same
 * "Invalid destination config" fallback the server uses).
 */
export const rowToAlertDestinationDocument = (row: AlertDestinationRow): AlertDestinationDocument => {
	const publicConfig = Option.getOrElse(
		decodeDestinationPublicConfig(row.config_json),
		(): Schema.Schema.Type<typeof AlertDestinationPublicConfig> => ({
			summary: "Invalid destination config",
			channelLabel: null,
		}),
	)
	return new AlertDestinationDocument({
		id: decodeDestinationId(row.id),
		name: row.name,
		type: asDestinationType(row.type),
		enabled: row.enabled,
		summary: publicConfig.summary,
		channelLabel: publicConfig.channelLabel,
		memberUserIds: publicConfig.memberUserIds != null ? [...publicConfig.memberUserIds] : null,
		...(publicConfig.chatConnector === undefined
			? undefined
			: { chatConnector: publicConfig.chatConnector }),
		...(publicConfig.chatWorkspaceId === undefined
			? undefined
			: { chatWorkspaceId: publicConfig.chatWorkspaceId }),
		...(publicConfig.linearTeamId === undefined
			? undefined
			: { linearTeamId: publicConfig.linearTeamId }),
		lastTestedAt: row.last_tested_at != null ? decodeIso(row.last_tested_at) : null,
		lastTestError: row.last_test_error,
		disabledAt: row.disabled_at != null ? decodeIso(row.disabled_at) : null,
		disabledReason: row.disabled_reason,
		createdAt: decodeIso(row.created_at),
		updatedAt: decodeIso(row.updated_at),
	})
}
