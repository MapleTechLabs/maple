import {
	AlertDestinationDocument,
	AlertDestinationType,
	AlertEvaluationErrorKind,
	AlertIncidentDocument,
	AlertIncidentAckSource,
	AlertIncidentLabels,
	AlertNotificationTemplate,
	AlertRuleDocument,
	AlertThresholds,
	AnomalyIncidentId,
	AnomalySignalType,
	ChatConnectorId,
	ChatWorkspaceId,
	QueryBuilderQueryDraftSchema,
	UserId,
	alertThresholdLegacyFields,
	sortAlertThresholds,
} from "@maple/domain/http"
import { QueryEngineNoDataBehavior } from "@maple/domain/query-engine"
import { Array as Arr, Option, Schema } from "effect"
import { liveRowDecoder, liveValueDecoder } from "./live-row"

// Each mapper hands its row to one whole-document decode (`live-row.ts`): a value this build
// does not know (a signal type, severity or status added by a newer server) drops that row
// and reports it, instead of throwing inside the live query and taking the page down.
const decodeRule = liveRowDecoder("alert_rules", AlertRuleDocument)
const decodeRuleThresholds = liveValueDecoder("alert_rules", AlertThresholds)
const decodeIncident = liveRowDecoder("alert_incidents", AlertIncidentDocument)
const decodeDestination = liveRowDecoder("alert_destinations", AlertDestinationDocument)

const decodeDestinationType = Schema.decodeUnknownOption(AlertDestinationType)

// Lenient fields: these degrade to a default instead of dropping the row.
const decodeErrorKind = Schema.decodeUnknownOption(AlertEvaluationErrorKind)
const decodeAckSource = Schema.decodeUnknownOption(AlertIncidentAckSource)
const decodeUserId = Schema.decodeUnknownOption(UserId)
const decodeNoDataBehavior = Schema.decodeUnknownOption(QueryEngineNoDataBehavior)
const decodeNotificationTemplate = Schema.decodeUnknownOption(AlertNotificationTemplate)
const decodeQueryBuilderDraft = Schema.decodeUnknownOption(QueryBuilderQueryDraftSchema)
const decodeStringArray = Schema.decodeUnknownOption(Schema.Array(Schema.String))
const decodeAnomalySignals = Schema.decodeUnknownOption(Schema.Array(AnomalySignalType))
const decodeAnomalyIncidentId = Schema.decodeUnknownOption(AnomalyIncidentId)
const decodeIncidentLabels = Schema.decodeUnknownOption(AlertIncidentLabels)
// `group_by` is a JSON-encoded array; an unparseable one stays a string and fails the rule decode.
const parseJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

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
	anomaly_signals_json: Schema.optionalKey(Schema.NullOr(Schema.Unknown)),
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
	acknowledged_at: Schema.optionalKey(Schema.NullOr(Schema.String)),
	acknowledged_by_user_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
	acknowledged_by_name: Schema.optionalKey(Schema.NullOr(Schema.String)),
	acknowledged_via: Schema.optionalKey(Schema.NullOr(Schema.String)),
	error_issue_id: Schema.NullOr(Schema.String),
	anomaly_incident_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
	group_label: Schema.optionalKey(Schema.NullOr(Schema.String)),
	labels_json: Schema.optionalKey(Schema.NullOr(Schema.Unknown)),
	silence_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
	silenced_at: Schema.optionalKey(Schema.NullOr(Schema.String)),
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
 * `lastEvaluatedAt`. `None` for a row this build cannot read.
 */
export const rowToAlertRuleDocument = (
	row: AlertRuleRow,
	statesByRuleId: Map<string, AlertRuleStateRow>,
): Option.Option<AlertRuleDocument> =>
	Option.flatMap(ruleThresholds(row), (thresholds) =>
		ruleDocument(row, statesByRuleId.get(row.id), sortAlertThresholds(thresholds)),
	)

/** The live rules as documents, without rows this build cannot read. */
export const rowsToAlertRuleDocuments = (
	rows: ReadonlyArray<AlertRuleRow>,
	statesByRuleId: Map<string, AlertRuleStateRow>,
): ReadonlyArray<AlertRuleDocument> =>
	Arr.getSomes(Arr.map(rows, (row) => rowToAlertRuleDocument(row, statesByRuleId)))

// Rows written before tiers carry none: they are one tier from the legacy columns
// (`legacyAlertThreshold`, before its severity is known to be readable). Stored tiers this build
// cannot read drop the rule: a legacy stand-in would overwrite the real tiers on save.
const ruleThresholds = (row: AlertRuleRow): Option.Option<AlertThresholds> =>
	row.thresholds_json != null
		? decodeRuleThresholds(row.id, row.thresholds_json)
		: decodeRuleThresholds(row.id, [
				{
					severity: row.severity,
					value: row.threshold,
					upper: row.threshold_upper,
					recoveryValue: null,
					destinationIds: safeParseStringArray(row.destination_ids_json),
				},
			])

const ruleDocument = (
	row: AlertRuleRow,
	state: AlertRuleStateRow | undefined,
	thresholds: AlertThresholds,
): Option.Option<AlertRuleDocument> => {
	const legacy = alertThresholdLegacyFields(thresholds)
	return decodeRule(row.id, {
		id: row.id,
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
		...(row.signal_type === "anomaly"
			? {
					anomalySignals: [
						...Option.getOrElse(decodeAnomalySignals(row.anomaly_signals_json ?? []), () => []),
					],
				}
			: undefined),
		tags: [...safeParseStringArray(row.tags_json)],
		groupBy: row.group_by == null ? null : Option.getOrElse(parseJson(row.group_by), () => row.group_by),
		signalType: row.signal_type,
		comparator: row.comparator,
		threshold: legacy.threshold,
		thresholdUpper: legacy.thresholdUpper,
		windowMinutes: row.window_minutes,
		evaluationIntervalMinutes: row.evaluation_interval_minutes ?? null,
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
		rawQueryReducer: row.signal_type === "raw_query" ? row.reducer : null,
		destinationIds: legacy.destinationIds,
		noDataBehavior: Option.getOrElse(decodeNoDataBehavior(row.no_data_behavior), () => "skip" as const),
		lastEvaluationError: state?.last_error ?? null,
		lastEvaluationErrorKind: Option.getOrNull(decodeErrorKind(state?.last_error_kind)),
		slowedIntervalMinutes: row.slowed_interval_minutes ?? null,
		slowedAt: row.slowed_at ?? null,
		lastEvaluatedAt: state?.last_evaluated_at ?? null,
		lastScheduledAt: row.last_scheduled_at,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		createdBy: row.created_by,
		updatedBy: row.updated_by,
	})
}

/**
 * Decodes a raw `alert_incidents` row into the domain {@link AlertIncidentDocument},
 * mirroring `rowToIncidentDocument` in AlertsService.ts. `None` for a row this build
 * cannot read (e.g. a signal type added after it was built).
 */
export const rowToAlertIncidentDocument = (row: AlertIncidentRow): Option.Option<AlertIncidentDocument> =>
	decodeIncident(row.id, {
		id: row.id,
		ruleId: row.rule_id,
		ruleName: row.rule_name,
		groupKey: row.group_key,
		signalType: row.signal_type,
		severity: row.severity,
		peakSeverity: row.peak_severity ?? null,
		status: row.status,
		comparator: row.comparator,
		threshold: row.threshold,
		thresholdUpper: row.threshold_upper,
		firstTriggeredAt: row.first_triggered_at,
		lastTriggeredAt: row.last_triggered_at,
		resolvedAt: row.resolved_at,
		lastObservedValue: row.last_observed_value,
		lastSampleCount: row.last_sample_count,
		dedupeKey: row.dedupe_key,
		lastDeliveredEventType: row.last_delivered_event_type,
		lastNotifiedAt: row.last_notified_at,
		holdReason: row.hold_reason,
		heldSince: row.held_since,
		acknowledgedAt: row.acknowledged_at ?? null,
		acknowledgedByUserId:
			row.acknowledged_by_user_id != null
				? Option.getOrNull(decodeUserId(row.acknowledged_by_user_id))
				: null,
		acknowledgedByName: row.acknowledged_by_name ?? null,
		acknowledgedVia:
			row.acknowledged_via != null ? Option.getOrNull(decodeAckSource(row.acknowledged_via)) : null,
		errorIssueId: row.error_issue_id,
		...(row.signal_type === "anomaly"
			? {
					anomalyIncidentId:
						row.anomaly_incident_id == null
							? null
							: Option.getOrNull(decodeAnomalyIncidentId(row.anomaly_incident_id)),
				}
			: undefined),
		...(row.group_label == null ? undefined : { groupLabel: row.group_label }),
		// Lenient: an unreadable labels value drops the labels, not the incident.
		...Option.match(row.labels_json == null ? Option.none() : decodeIncidentLabels(row.labels_json), {
			onNone: () => undefined,
			onSome: (labels) => ({ labels }),
		}),
		silenceId: row.silence_id ?? null,
		silencedAt: row.silenced_at ?? null,
	})

/** The live incidents as documents, without rows this build cannot read. */
export const rowsToAlertIncidentDocuments = (
	rows: ReadonlyArray<AlertIncidentRow>,
): ReadonlyArray<AlertIncidentDocument> => Arr.getSomes(Arr.map(rows, rowToAlertIncidentDocument))

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
 * "Invalid destination config" fallback the server uses). `None` for a type
 * this build does not know (a retired provider's leftover row): it is dropped,
 * never a crash.
 */
export const rowToAlertDestinationDocument = (
	row: AlertDestinationRow,
): Option.Option<AlertDestinationDocument> =>
	Option.flatMap(decodeDestinationType(row.type), (type) => destinationDocument(row, type))

/** The live rows as documents, without rows of an unknown type. */
export const rowsToAlertDestinationDocuments = (
	rows: ReadonlyArray<AlertDestinationRow>,
): ReadonlyArray<AlertDestinationDocument> => Arr.getSomes(Arr.map(rows, rowToAlertDestinationDocument))

const destinationDocument = (
	row: AlertDestinationRow,
	type: AlertDestinationType,
): Option.Option<AlertDestinationDocument> => {
	const publicConfig = Option.getOrElse(
		decodeDestinationPublicConfig(row.config_json),
		(): Schema.Schema.Type<typeof AlertDestinationPublicConfig> => ({
			summary: "Invalid destination config",
			channelLabel: null,
		}),
	)
	return decodeDestination(row.id, {
		id: row.id,
		name: row.name,
		type,
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
		lastTestedAt: row.last_tested_at,
		lastTestError: row.last_test_error,
		disabledAt: row.disabled_at,
		disabledReason: row.disabled_reason,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	})
}
