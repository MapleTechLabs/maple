import {
	alertQueryLimits,
	alertRuleIntervalMinutes,
	alertWindowBucketSeconds,
	CompiledAlertQueryPlan,
	QueryEngineAlertReducer,
	QueryEngineNoDataBehavior,
	type QueryEngineSampleCountStrategy,
	QuerySpec,
} from "@maple/query-engine"
import { buildTimeseriesQuerySpec, resolveGroupBy } from "@maple/query-engine/query-builder"
import { prepareRawSql, type AlertBucketSource } from "@maple/query-engine/runtime"
import {
	AlertComparator as AlertComparatorSchema,
	AlertDestinationDocument,
	type AlertEvaluationErrorKind,
	AlertEvaluationIntervalMinutes,
	AlertGroupBy as AlertGroupBySchema,
	AlertNotificationTemplate,
	AlertRuleDocument,
	AlertRuleStoredConfigInvalidError,
	AlertSeverity as AlertSeveritySchema,
	AlertSignalType as AlertSignalTypeSchema,
	AlertThresholds as AlertThresholdsSchema,
	AlertValidationError,
	alertThresholdLegacyFields,
	legacyAlertThreshold,
	sortAlertThresholds,
	QueryBuilderQueryDraftSchema,
	UNGROUPED_GROUP_KEY,
	UserId,
	type AlertComparator,
	type AlertDestinationId,
	type AlertGroupBy,
	type AlertRuleId,
	type AlertRuleUpsertRequest,
	type AlertSeverity,
	type AlertSignalType,
	type AlertThresholds,
	type QueryBuilderQueryDraftPayload,
	type OrgId,
} from "@maple/domain/http"
import * as PG from "@maple-dev/effect-orm/postgres"
import { AlertRules, type AlertRuleRow } from "@maple/db/tables"
import { Array as Arr, Effect, Match, Result, Schema } from "effect"
import type { AlertRuntimeApi } from "./AlertRuntime"
import type { QueryBuilderDataSource } from "@maple/query-model"
import { validateBreachWindow, validateThresholds } from "./alert-thresholds"

const StringArraySchema = Schema.Array(Schema.String)

type StoredJsonColumn =
	| "serviceNamesJson"
	| "excludeServiceNamesJson"
	| "environmentsJson"
	| "tagsJson"
	| "destinationIdsJson"
	| "thresholdsJson"

/**
 * An `alert_rules` row with its schema-typed jsonb columns read as `unknown`. The model
 * decodes them itself, so a malformed stored value is `AlertRuleStoredConfigInvalidError`.
 */
export type StoredAlertRuleRow = Omit<AlertRuleRow, StoredJsonColumn> & {
	readonly [K in StoredJsonColumn]: unknown
}

/** Every `alert_rules` column as a `StoredAlertRuleRow`; add a `where` to it. */
export const selectStoredAlertRules = () =>
	PG.from(AlertRules).select(($) => ({
		...$,
		serviceNamesJson: PG.undecoded($.serviceNamesJson),
		excludeServiceNamesJson: PG.undecoded($.excludeServiceNamesJson),
		environmentsJson: PG.undecoded($.environmentsJson),
		tagsJson: PG.undecoded($.tagsJson),
		destinationIdsJson: PG.undecoded($.destinationIdsJson),
		thresholdsJson: PG.undecoded($.thresholdsJson),
	}))
const DestinationIdArraySchema = Schema.Array(AlertDestinationDocument.fields.id)
const AlertGroupByFromJson = Schema.fromJsonString(AlertGroupBySchema)

const decodeAlertRuleIdSync = Schema.decodeUnknownSync(AlertRuleDocument.fields.id)
const decodeQuerySpecSync = Schema.decodeUnknownSync(QuerySpec)
const decodeIsoDateTimeStringSync = Schema.decodeUnknownSync(AlertDestinationDocument.fields.createdAt)
const decodeAlertSignalTypeSync = Schema.decodeUnknownSync(AlertSignalTypeSchema)
const decodeAlertComparatorSync = Schema.decodeUnknownSync(AlertComparatorSchema)
const decodeQueryEngineAlertReducerSync = Schema.decodeUnknownSync(QueryEngineAlertReducer)
const decodeNoDataBehaviorSync = Schema.decodeUnknownSync(QueryEngineNoDataBehavior)
const decodeUserIdSync = Schema.decodeUnknownSync(UserId)
const decodeEvaluationIntervalSync = Schema.decodeUnknownSync(Schema.NullOr(AlertEvaluationIntervalMinutes))

export interface NormalizedRule {
	readonly id: AlertRuleId
	readonly name: string
	readonly notificationTemplate: AlertNotificationTemplate | null
	readonly enabled: boolean
	/** Severity tiers, lowest first. The four single-threshold fields below derive from them. */
	readonly thresholds: AlertThresholds
	/** Highest tier's severity. */
	readonly severity: AlertSeverity
	readonly serviceName: string | null
	readonly serviceNames: ReadonlyArray<string>
	readonly excludeServiceNames: ReadonlyArray<string>
	readonly environments: ReadonlyArray<string>
	readonly tags: ReadonlyArray<string>
	readonly groupBy: AlertGroupBy | null
	readonly signalType: AlertSignalType
	readonly comparator: AlertComparator
	readonly threshold: number
	readonly thresholdUpper: number | null
	readonly windowMinutes: number
	/** The author's check interval; null derives it from the window. */
	readonly evaluationIntervalMinutes: AlertEvaluationIntervalMinutes | null
	/** The scheduler's slowdown after repeated query timeouts; null until then, cleared by an edit. */
	readonly slowedIntervalMinutes: AlertEvaluationIntervalMinutes | null
	readonly minimumSampleCount: number
	readonly consecutiveBreachesRequired: number
	/** M in "N of the last M checks"; null is N in a row. */
	readonly breachesOutOf: number | null
	readonly consecutiveHealthyRequired: number
	readonly renotifyIntervalMinutes: number
	readonly apdexThresholdMs: number | null
	readonly queryBuilderDraft: QueryBuilderQueryDraftPayload | null
	readonly rawQuerySql: string | null
	readonly rawQueryReducer: QueryEngineAlertReducer | null
	readonly alertOnNoData: boolean
	readonly destinationIds: ReadonlyArray<AlertDestinationId>
	readonly compiledPlan: Schema.Schema.Type<typeof CompiledAlertQueryPlan>
	readonly createdAt: number
	readonly updatedAt: number
}

export interface RuleEvaluationState {
	readonly error: string | null
	readonly errorKind: AlertEvaluationErrorKind | null
	readonly evaluatedAt: number | null
}

export const normalizedRuleToDocument = (
	rule: NormalizedRule,
	options: {
		readonly notes: string | null
		readonly userId: Schema.Schema.Type<typeof UserId>
		readonly timestamp: number
		readonly txid?: AlertRuleDocument["txid"]
	},
): AlertRuleDocument => {
	const timestamp = decodeIsoDateTimeStringSync(new Date(options.timestamp).toISOString())
	return new AlertRuleDocument({
		id: rule.id,
		name: rule.name,
		notes: options.notes,
		notificationTemplate: rule.notificationTemplate,
		enabled: rule.enabled,
		severity: rule.severity,
		thresholds: rule.thresholds,
		serviceNames: [...rule.serviceNames],
		excludeServiceNames: [...rule.excludeServiceNames],
		environments: [...rule.environments],
		tags: [...rule.tags],
		groupBy: rule.groupBy,
		signalType: rule.signalType,
		comparator: rule.comparator,
		threshold: rule.threshold,
		thresholdUpper: rule.thresholdUpper,
		windowMinutes: rule.windowMinutes,
		evaluationIntervalMinutes: rule.evaluationIntervalMinutes,
		minimumSampleCount: rule.minimumSampleCount,
		consecutiveBreachesRequired: rule.consecutiveBreachesRequired,
		breachesOutOf: rule.breachesOutOf,
		consecutiveHealthyRequired: rule.consecutiveHealthyRequired,
		renotifyIntervalMinutes: rule.renotifyIntervalMinutes,
		apdexThresholdMs: rule.apdexThresholdMs,
		queryBuilderDraft: rule.queryBuilderDraft,
		rawQuerySql: rule.rawQuerySql,
		rawQueryReducer: rule.rawQueryReducer,
		destinationIds: [...rule.destinationIds],
		noDataBehavior: rule.compiledPlan.noDataBehavior,
		lastEvaluationError: null,
		lastEvaluationErrorKind: null,
		slowedIntervalMinutes: rule.slowedIntervalMinutes,
		slowedAt: null,
		lastEvaluatedAt: null,
		lastScheduledAt: null,
		createdAt: timestamp,
		updatedAt: timestamp,
		createdBy: options.userId,
		updatedBy: options.userId,
		...(!(options.txid === undefined) ? { txid: options.txid } : undefined),
	})
}

export const normalizeOptionalString = (value: string | null | undefined) => {
	const trimmed = value?.trim()
	return trimmed && trimmed.length > 0 ? trimmed : null
}

export const makeAlertValidationError = (
	message: string,
	details: ReadonlyArray<string> = [],
	cause?: unknown,
) =>
	new AlertValidationError({
		message,
		details,
		...(!(cause === undefined) ? { cause } : undefined),
	})

// The details ride in the message too: public HTTP errors expose `message`, not `details`.
const invalidRuleError = (details: ReadonlyArray<string>) =>
	makeAlertValidationError(`Invalid alert rule: ${details.join("; ")}`, details)

const normalizeTags = (tags: ReadonlyArray<string> | undefined): ReadonlyArray<string> => {
	if (!tags || tags.length === 0) return []
	return Arr.dedupe(
		Arr.filter(
			Arr.map(tags, (tag) => tag.trim().toLowerCase()),
			(tag) => tag.length > 0,
		),
	)
}

const planGroupingTokens = (
	plan: Schema.Schema.Type<typeof CompiledAlertQueryPlan>,
): ReadonlyArray<string> | null => {
	if (plan.kind !== "spec" || plan.query == null || plan.query.kind !== "timeseries") return null
	const groupBy = plan.query.groupBy
	if (groupBy == null || groupBy.length === 0 || groupBy.includes("none")) return null
	return groupBy
}

/** Why the generic rule APIs refuse an `uptime` rule. */
export const UPTIME_RULE_MANAGED_MESSAGE =
	"uptime rules belong to an uptime monitor; create, edit or delete the monitor instead"

/** The stored plan of every `uptime` rule: no query, the evaluator reads the monitor's state. */
export const UPTIME_RULE_PLAN = new CompiledAlertQueryPlan({
	kind: "spec",
	query: null,
	rawSql: null,
	reducer: "identity",
	sampleCountStrategy: null,
	noDataBehavior: "skip",
})

/**
 * The `alert_rules` columns of a monitor's backing rule: down (1) breaches, one check opens
 * and one healthy check resolves. Scoped to the monitor's service so links follow it.
 */
export const uptimeRuleFields = (monitor: {
	readonly name: string
	readonly serviceName: string | null
	readonly enabled: boolean
	readonly destinationIds: ReadonlyArray<AlertDestinationId>
}) => {
	const thresholds: AlertThresholds = [
		{
			severity: "critical",
			value: 1,
			upper: null,
			recoveryValue: null,
			destinationIds: [...monitor.destinationIds],
		},
	]
	return {
		name: monitor.name,
		notes: null,
		notificationTemplateJson: null,
		enabled: monitor.enabled,
		severity: "critical",
		serviceNamesJson: monitor.serviceName === null ? null : [monitor.serviceName],
		excludeServiceNamesJson: null,
		environmentsJson: null,
		tagsJson: null,
		groupBy: null,
		signalType: "uptime",
		comparator: "gte",
		threshold: 1,
		thresholdUpper: null,
		thresholdsJson: thresholds,
		windowMinutes: 1,
		evaluationIntervalMinutes: 1,
		slowedIntervalMinutes: null,
		slowedAt: null,
		minimumSampleCount: 0,
		consecutiveBreachesRequired: 1,
		breachesOutOf: null,
		consecutiveHealthyRequired: 1,
		renotifyIntervalMinutes: 30,
		apdexThresholdMs: null,
		queryBuilderDraftJson: null,
		rawQuerySql: null,
		destinationIdsJson: [...monitor.destinationIds],
		querySpecJson: null,
		reducer: UPTIME_RULE_PLAN.reducer,
		sampleCountStrategy: null,
		noDataBehavior: UPTIME_RULE_PLAN.noDataBehavior,
	} as const
}

export const isGroupedPlan = (plan: Schema.Schema.Type<typeof CompiledAlertQueryPlan>): boolean =>
	plan.kind === "raw_sql" || planGroupingTokens(plan) != null

/**
 * Translate a group key from the query engine's vocabulary into storage's.
 *
 * The engine emits a generic `"all"` for an ungrouped result; storage, the wire
 * and the UI all spell that `UNGROUPED_GROUP_KEY` (`"__total__"`). The two must
 * not be conflated — an `alert_rule_states` row keyed `"all"` is invisible to
 * every reader — and the translation was previously open-coded at each of the
 * three sites that needed it (scheduler evaluation, preview series, preview's
 * empty-range seed), which is exactly the shape of bug that survives review.
 *
 * `evaluateRule` and `previewRule` are the only boundaries; everything
 * downstream of them is already in storage vocabulary.
 */
export const toStorageGroupKey = (
	plan: Schema.Schema.Type<typeof CompiledAlertQueryPlan>,
	engineGroupKey: string,
): string => (isGroupedPlan(plan) ? engineGroupKey : UNGROUPED_GROUP_KEY)

/** The scheduler lane a rule runs in: `long_query` for raw SQL allowed more than the 1-minute time limit. */
export type AlertSchedulerLane = "standard" | "long_query"

export const alertSchedulerLaneOf = (
	row: Pick<
		StoredAlertRuleRow,
		"signalType" | "windowMinutes" | "evaluationIntervalMinutes" | "slowedIntervalMinutes"
	>,
): AlertSchedulerLane =>
	row.signalType === "raw_query" &&
	alertQueryLimits(alertRuleIntervalMinutes(row)).timeSeconds > alertQueryLimits(1).timeSeconds
		? "long_query"
		: "standard"

export const planEvaluateSource = (
	plan: Schema.Schema.Type<typeof CompiledAlertQueryPlan>,
	rule: Parameters<typeof alertRuleIntervalMinutes>[0],
): Effect.Effect<AlertBucketSource, AlertValidationError> => {
	if (plan.kind === "raw_sql") {
		if (plan.rawSql == null) {
			return Effect.fail(makeAlertValidationError("Compiled alert plan is missing its SQL query"))
		}
		return Effect.succeed({
			kind: "raw_sql",
			sql: plan.rawSql,
			windowMinutes: rule.windowMinutes,
			intervalMinutes: alertRuleIntervalMinutes(rule),
		})
	}
	if (plan.query == null || plan.sampleCountStrategy == null) {
		return Effect.fail(makeAlertValidationError("Compiled alert plan is missing its query spec"))
	}
	return Effect.succeed({ kind: "spec", query: plan.query })
}

/**
 * A multi-service rule is N independent single-service rules that happen to
 * share a threshold and a destination list: the scheduler evaluates each
 * service on its own and keys the results by service name.
 *
 * That explosion was open-coded three times — the scheduler tick, `testRule`
 * and `previewRule` — each re-deriving the per-service plan the same way and
 * each free to drift. The preview's whole promise is that it shows what the
 * scheduler will do, so it must not be *mirroring* the scheduler's rule shape;
 * it must be building the same one.
 *
 * Returns one entry per service in `serviceNames`, each already carrying its
 * own compiled plan and the group key its outcomes are stored under. Callers
 * keep their own concurrency for the evaluation itself — compiling is pure.
 */
export const perServiceRules = (
	rule: NormalizedRule,
): Effect.Effect<
	ReadonlyArray<{ readonly groupKey: string; readonly rule: NormalizedRule }>,
	AlertValidationError
> =>
	Effect.forEach(rule.serviceNames, (serviceName) =>
		compileRulePlan({ ...rule, serviceName }).pipe(
			Effect.map((compiledPlan) => ({
				groupKey: serviceName,
				rule: { ...rule, serviceName, compiledPlan },
			})),
		),
	)

export const compileRulePlan = Effect.fn("AlertsService.compileRulePlan")(function* (rule: {
	readonly signalType: AlertSignalType
	readonly serviceName: string | null
	readonly environments: ReadonlyArray<string>
	readonly apdexThresholdMs: number | null
	readonly queryBuilderDraft: QueryBuilderQueryDraftPayload | null
	readonly rawQuerySql: string | null
	readonly rawQueryReducer: QueryEngineAlertReducer | null
	readonly comparator: AlertComparator
	readonly windowMinutes: number
	readonly groupBy: AlertGroupBy | null
	readonly alertOnNoData: boolean
}): Effect.fn.Return<Schema.Schema.Type<typeof CompiledAlertQueryPlan>, AlertValidationError> {
	const bucketSeconds = alertWindowBucketSeconds(rule.windowMinutes)
	const envFilter = rule.environments.length > 0 ? { environments: rule.environments } : {}
	const baseTraceFilters = {
		...(!(rule.serviceName == null) ? { serviceName: rule.serviceName } : undefined),
		...envFilter,
	}

	// An explicit alert-on-no-data wins: a low-throughput rule reads an empty window
	// as zero, but a minimum sample count then skips it instead of breaching.
	const noDataBehavior: QueryEngineNoDataBehavior = rule.alertOnNoData
		? "alert"
		: rule.signalType === "throughput" && ["lt", "lte"].includes(rule.comparator)
			? "zero"
			: "skip"
	const traceSignalMetrics: Record<string, string> = {
		error_rate: "error_rate",
		p95_latency: "p95_duration",
		p99_latency: "p99_duration",
		throughput: "count",
		apdex: "apdex",
	} satisfies Record<string, string>

	const resolveRuleGroupBy = (
		source: QueryBuilderDataSource,
	): Effect.Effect<
		{
			readonly tokens: ReadonlyArray<string>
			readonly attributeKeys: ReadonlyArray<string>
			readonly resourceAttributeKeys: ReadonlyArray<string>
		} | null,
		AlertValidationError
	> => {
		if (rule.groupBy == null || rule.groupBy.length === 0) return Effect.succeed(null)
		const resolved = resolveGroupBy(source, rule.groupBy)
		if (resolved.warnings.length > 0) {
			return Effect.fail(
				makeAlertValidationError(`Invalid groupBy for ${source} alert`, [...resolved.warnings]),
			)
		}
		if (resolved.tokens.length === 0) {
			return Effect.fail(
				makeAlertValidationError(`groupBy did not resolve to any usable dimension for ${source}`),
			)
		}
		if (source === "metrics" && resolved.attributeKeys.length > 1) {
			return Effect.fail(
				makeAlertValidationError(
					"Metrics alerts support at most one attr.* groupBy dimension",
					resolved.attributeKeys.map(
						(key) => `Unsupported additional metrics groupBy attribute: ${key}`,
					),
				),
			)
		}
		if (source === "metrics" && resolved.resourceAttributeKeys.length > 1) {
			return Effect.fail(
				makeAlertValidationError(
					"Metrics alerts support at most one resource.* groupBy dimension",
					resolved.resourceAttributeKeys.map(
						(key) => `Unsupported additional metrics groupBy resource attribute: ${key}`,
					),
				),
			)
		}
		if (
			source === "metrics" &&
			resolved.attributeKeys.length > 0 &&
			resolved.resourceAttributeKeys.length > 0
		) {
			return Effect.fail(
				makeAlertValidationError(
					"Metrics alerts cannot combine attr.* and resource.* groupBy dimensions",
				),
			)
		}
		return Effect.succeed({
			tokens: resolved.tokens,
			attributeKeys: resolved.attributeKeys,
			resourceAttributeKeys: resolved.resourceAttributeKeys,
		})
	}

	let query: QuerySpec
	let sampleCountStrategy: QueryEngineSampleCountStrategy
	const traceMetric = traceSignalMetrics[rule.signalType]
	if (traceMetric) {
		const groupResolved = yield* resolveRuleGroupBy("traces")
		const filters: Record<string, unknown> = {
			...baseTraceFilters,
			rootSpansOnly: true,
		} satisfies Record<string, unknown>
		if (groupResolved && groupResolved.attributeKeys.length > 0) {
			filters.groupByAttributeKeys = [...groupResolved.attributeKeys]
		}
		query = decodeQuerySpecSync({
			kind: "timeseries",
			source: "traces",
			metric: traceMetric,
			groupBy: groupResolved ? [...groupResolved.tokens] : ["none"],
			bucketSeconds,
			...(rule.signalType === "apdex" ? { apdexThresholdMs: rule.apdexThresholdMs ?? 500 } : undefined),
			filters,
		})
		sampleCountStrategy = "trace_count"
	} else if (rule.signalType === "builder_query") {
		if (rule.queryBuilderDraft == null) {
			return yield* Effect.fail(
				makeAlertValidationError("builder_query alerts require a queryBuilderDraft"),
			)
		}
		const built = buildTimeseriesQuerySpec(rule.queryBuilderDraft)
		if (built.error != null || built.query == null) {
			return yield* Effect.fail(
				makeAlertValidationError(built.error ?? "Failed to build query builder spec", [
					...built.warnings,
				]),
			)
		}
		query = decodeQuerySpecSync({ ...built.query, bucketSeconds })
		sampleCountStrategy = Match.value(rule.queryBuilderDraft.dataSource).pipe(
			Match.when("logs", (): QueryEngineSampleCountStrategy => "log_count"),
			Match.when("metrics", (): QueryEngineSampleCountStrategy => "metric_data_points"),
			Match.when("product_events", (): QueryEngineSampleCountStrategy => "product_event_count"),
			Match.when("traces", (): QueryEngineSampleCountStrategy => "trace_count"),
			Match.exhaustive,
		)
	} else if (rule.signalType === "raw_query") {
		const sql = rule.rawQuerySql?.trim() ?? ""
		if (sql.length === 0) {
			return yield* Effect.fail(makeAlertValidationError("raw_query alerts require rawQuerySql"))
		}
		if (!sql.includes("$__orgFilter")) {
			return yield* Effect.fail(
				makeAlertValidationError("raw_query SQL must reference $__orgFilter for org scoping"),
			)
		}
		return new CompiledAlertQueryPlan({
			kind: "raw_sql",
			query: null,
			rawSql: sql,
			reducer: rule.rawQueryReducer ?? "identity",
			sampleCountStrategy: null,
			noDataBehavior,
		})
	} else if (rule.signalType === "uptime") {
		return yield* Effect.fail(makeAlertValidationError(UPTIME_RULE_MANAGED_MESSAGE))
	} else {
		return yield* Effect.fail(makeAlertValidationError(`Unsupported signal type: ${rule.signalType}`))
	}

	return new CompiledAlertQueryPlan({
		kind: "spec",
		query,
		rawSql: null,
		reducer: "identity",
		sampleCountStrategy,
		noDataBehavior,
	})
})

const parseCompiledPlan = (
	row: Pick<
		StoredAlertRuleRow,
		| "id"
		| "signalType"
		| "querySpecJson"
		| "rawQuerySql"
		| "reducer"
		| "sampleCountStrategy"
		| "noDataBehavior"
	>,
): Effect.Effect<Schema.Schema.Type<typeof CompiledAlertQueryPlan>, AlertRuleStoredConfigInvalidError> => {
	const invalid = (message: string, cause: unknown) =>
		new AlertRuleStoredConfigInvalidError({
			message,
			ruleId: row.id,
			component: "compiled_plan",
			cause,
		})
	// An uptime rule reads its monitor's state, not the warehouse: no query to decode.
	if (row.signalType === "uptime") return Effect.succeed(UPTIME_RULE_PLAN)
	if (row.signalType === "raw_query") {
		if (row.rawQuerySql == null) {
			return Effect.fail(invalid("Stored raw alert is missing its SQL query", "rawQuerySql is null"))
		}
		return Schema.decodeUnknownEffect(CompiledAlertQueryPlan)({
			kind: "raw_sql",
			query: null,
			rawSql: row.rawQuerySql,
			reducer: row.reducer,
			sampleCountStrategy: null,
			noDataBehavior: row.noDataBehavior,
		}).pipe(Effect.mapError((cause) => invalid("Stored compiled alert plan is invalid", cause)))
	}
	return Schema.decodeUnknownEffect(QuerySpec)(row.querySpecJson).pipe(
		Effect.flatMap((query) =>
			Schema.decodeUnknownEffect(CompiledAlertQueryPlan)({
				kind: "spec",
				query,
				rawSql: null,
				reducer: row.reducer,
				sampleCountStrategy: row.sampleCountStrategy,
				noDataBehavior: row.noDataBehavior,
			}),
		),
		Effect.mapError((cause) => invalid("Stored compiled alert plan is invalid", cause)),
	)
}

type IsoDateTimeValue = Schema.Schema.Type<typeof AlertDestinationDocument.fields.createdAt>

const toIso = (value: number | null | undefined): IsoDateTimeValue | null =>
	value == null ? null : decodeIsoDateTimeStringSync(new Date(value).toISOString())

type StoredRuleComponent = AlertRuleStoredConfigInvalidError["component"]

const decodeStoredRuleComponent = <S extends Schema.Top>(
	ruleId: AlertRuleId,
	component: StoredRuleComponent,
	schema: S,
	value: unknown,
): Effect.Effect<S["Type"], AlertRuleStoredConfigInvalidError, S["DecodingServices"]> =>
	Schema.decodeUnknownEffect(schema)(value).pipe(
		Effect.mapError(
			(cause) =>
				new AlertRuleStoredConfigInvalidError({
					message: `Stored alert rule ${component} is invalid`,
					ruleId,
					component,
					cause,
				}),
		),
	)

const decodeStoredStringArray = (
	ruleId: AlertRuleId,
	component: "service_names" | "exclude_service_names" | "environments" | "tags",
	value: unknown,
): Effect.Effect<ReadonlyArray<string>, AlertRuleStoredConfigInvalidError> =>
	value == null
		? Effect.succeed([])
		: decodeStoredRuleComponent(ruleId, component, StringArraySchema, value)

const decodeNullableStoredRuleComponent = <S extends Schema.Top>(
	ruleId: AlertRuleId,
	component: StoredRuleComponent,
	schema: S,
	value: unknown,
): Effect.Effect<S["Type"] | null, AlertRuleStoredConfigInvalidError, S["DecodingServices"]> =>
	value == null ? Effect.succeed(null) : decodeStoredRuleComponent(ruleId, component, schema, value)

export const decodeStoredAlertRuleMetadata = (row: StoredAlertRuleRow) =>
	Effect.all({
		serviceNames: decodeStoredStringArray(row.id, "service_names", row.serviceNamesJson),
		excludeServiceNames: decodeStoredStringArray(
			row.id,
			"exclude_service_names",
			row.excludeServiceNamesJson,
		),
		environments: decodeStoredStringArray(row.id, "environments", row.environmentsJson),
		tags: decodeStoredStringArray(row.id, "tags", row.tagsJson),
		groupBy: decodeNullableStoredRuleComponent(row.id, "group_by", AlertGroupByFromJson, row.groupBy),
		notificationTemplate: decodeNullableStoredRuleComponent(
			row.id,
			"notification_template",
			AlertNotificationTemplate,
			row.notificationTemplateJson,
		),
		queryBuilderDraft: decodeNullableStoredRuleComponent(
			row.id,
			"query_builder_draft",
			QueryBuilderQueryDraftSchema,
			row.queryBuilderDraftJson,
		),
	})

export const decodeStoredAlertRuleDestinationIds = (
	ruleId: AlertRuleId,
	value: unknown,
): Effect.Effect<ReadonlyArray<AlertDestinationId>, AlertRuleStoredConfigInvalidError> =>
	Schema.decodeUnknownEffect(DestinationIdArraySchema)(value).pipe(
		Effect.mapError(
			(cause) =>
				new AlertRuleStoredConfigInvalidError({
					message: "Stored rule destinations are invalid",
					ruleId,
					component: "destination_ids",
					cause,
				}),
		),
	)

/** The rule's tiers; a pre-tier row (`thresholds_json` null) is one tier from its legacy columns. */
const decodeStoredAlertRuleThresholds = (
	row: StoredAlertRuleRow,
	destinationIds: ReadonlyArray<AlertDestinationId>,
): Effect.Effect<AlertThresholds, AlertRuleStoredConfigInvalidError> =>
	row.thresholdsJson === null
		? decodeStoredRuleComponent(row.id, "thresholds", AlertSeveritySchema, row.severity).pipe(
				Effect.map((severity) =>
					Arr.of(
						legacyAlertThreshold({
							severity,
							threshold: row.threshold,
							thresholdUpper: row.thresholdUpper,
							destinationIds,
						}),
					),
				),
			)
		: decodeStoredRuleComponent(row.id, "thresholds", AlertThresholdsSchema, row.thresholdsJson).pipe(
				Effect.map(sortAlertThresholds),
			)

/** The stored condition ticks are judged against; none when the row no longer decodes. */
export const storedRuleCondition = (row: StoredAlertRuleRow) =>
	decodeStoredAlertRuleDestinationIds(row.id, row.destinationIdsJson).pipe(
		Effect.flatMap((destinationIds) => decodeStoredAlertRuleThresholds(row, destinationIds)),
		Effect.map((thresholds) => ({ comparator: row.comparator, thresholds })),
		Effect.option,
	)

export const rowToRuleDocument = (
	row: StoredAlertRuleRow,
	evaluationState?: RuleEvaluationState,
): Effect.Effect<AlertRuleDocument, AlertRuleStoredConfigInvalidError> =>
	Effect.gen(function* () {
		const stored = yield* decodeStoredAlertRuleMetadata(row)
		const destinationIds = yield* decodeStoredAlertRuleDestinationIds(row.id, row.destinationIdsJson)
		const thresholds = yield* decodeStoredAlertRuleThresholds(row, destinationIds)
		const legacy = alertThresholdLegacyFields(thresholds)
		return yield* Effect.try({
			try: () => {
				return new AlertRuleDocument({
					id: decodeAlertRuleIdSync(row.id),
					name: row.name,
					notes: row.notes ?? null,
					notificationTemplate: stored.notificationTemplate,
					enabled: row.enabled,
					severity: legacy.severity,
					thresholds,
					serviceNames: [...stored.serviceNames],
					excludeServiceNames: [...stored.excludeServiceNames],
					environments: [...stored.environments],
					tags: [...stored.tags],
					groupBy: stored.groupBy,
					signalType: decodeAlertSignalTypeSync(row.signalType),
					comparator: decodeAlertComparatorSync(row.comparator),
					threshold: legacy.threshold,
					thresholdUpper: legacy.thresholdUpper,
					windowMinutes: row.windowMinutes,
					evaluationIntervalMinutes: decodeEvaluationIntervalSync(row.evaluationIntervalMinutes),
					minimumSampleCount: row.minimumSampleCount,
					consecutiveBreachesRequired: row.consecutiveBreachesRequired,
					breachesOutOf: row.breachesOutOf,
					consecutiveHealthyRequired: row.consecutiveHealthyRequired,
					renotifyIntervalMinutes: row.renotifyIntervalMinutes,
					apdexThresholdMs: row.apdexThresholdMs,
					queryBuilderDraft: stored.queryBuilderDraft,
					rawQuerySql: row.signalType === "raw_query" ? (row.rawQuerySql ?? null) : null,
					rawQueryReducer:
						row.signalType === "raw_query"
							? decodeQueryEngineAlertReducerSync(row.reducer)
							: null,
					destinationIds: legacy.destinationIds,
					noDataBehavior: decodeNoDataBehaviorSync(row.noDataBehavior),
					lastEvaluationError: evaluationState?.error ?? null,
					lastEvaluationErrorKind: evaluationState?.errorKind ?? null,
					slowedIntervalMinutes: decodeEvaluationIntervalSync(row.slowedIntervalMinutes),
					slowedAt: toIso(row.slowedAt),
					lastEvaluatedAt:
						evaluationState?.evaluatedAt != null ? toIso(evaluationState.evaluatedAt) : null,
					lastScheduledAt: toIso(row.lastScheduledAt),
					createdAt: decodeIsoDateTimeStringSync(new Date(row.createdAt).toISOString()),
					updatedAt: decodeIsoDateTimeStringSync(new Date(row.updatedAt).toISOString()),
					createdBy: decodeUserIdSync(row.createdBy),
					updatedBy: decodeUserIdSync(row.updatedBy),
				})
			},
			catch: (cause) =>
				new AlertRuleStoredConfigInvalidError({
					message: "Stored alert rule document is invalid",
					ruleId: row.id,
					component: "document",
					cause,
				}),
		})
	})

export const makeAlertRuleNormalizer = (runtime: AlertRuntimeApi) => {
	const normalizeRuleRow = Effect.fn("AlertsService.normalizeRuleRow")(function* (
		row: StoredAlertRuleRow,
	): Effect.fn.Return<NormalizedRule, AlertRuleStoredConfigInvalidError> {
		const metadata = yield* decodeStoredAlertRuleMetadata(row)
		// Rows written before the request normalizer dropped a builder query's
		// service scope evaluate as the draft alone, once, like new ones.
		const stored =
			row.signalType === "builder_query"
				? { ...metadata, serviceNames: [], excludeServiceNames: [] }
				: metadata
		const decoded = yield* Effect.try({
			try: () => {
				return {
					id: decodeAlertRuleIdSync(row.id),
					serviceName: stored.serviceNames.length === 1 ? (stored.serviceNames[0] ?? null) : null,
					signalType: decodeAlertSignalTypeSync(row.signalType),
					comparator: decodeAlertComparatorSync(row.comparator),
					groupBy: stored.groupBy,
					rawQueryReducer:
						row.signalType === "raw_query"
							? decodeQueryEngineAlertReducerSync(row.reducer)
							: null,
					evaluationIntervalMinutes: decodeEvaluationIntervalSync(row.evaluationIntervalMinutes),
					slowedIntervalMinutes: decodeEvaluationIntervalSync(row.slowedIntervalMinutes),
				}
			},
			catch: (cause) =>
				new AlertRuleStoredConfigInvalidError({
					message: "Stored alert rule fields are invalid",
					ruleId: row.id,
					component: "document",
					cause,
				}),
		})
		const thresholds = yield* decodeStoredAlertRuleThresholds(
			row,
			yield* decodeStoredAlertRuleDestinationIds(row.id, row.destinationIdsJson),
		)
		const legacy = alertThresholdLegacyFields(thresholds)
		return {
			id: decoded.id,
			name: row.name,
			notificationTemplate: stored.notificationTemplate,
			enabled: row.enabled,
			thresholds,
			severity: legacy.severity,
			serviceName: decoded.serviceName,
			serviceNames: stored.serviceNames,
			excludeServiceNames: stored.excludeServiceNames,
			environments: stored.environments,
			tags: stored.tags,
			groupBy: decoded.groupBy,
			signalType: decoded.signalType,
			comparator: decoded.comparator,
			threshold: legacy.threshold,
			thresholdUpper: legacy.thresholdUpper,
			windowMinutes: row.windowMinutes,
			evaluationIntervalMinutes: decoded.evaluationIntervalMinutes,
			slowedIntervalMinutes: decoded.slowedIntervalMinutes,
			minimumSampleCount: row.minimumSampleCount,
			consecutiveBreachesRequired: row.consecutiveBreachesRequired,
			breachesOutOf: row.breachesOutOf,
			consecutiveHealthyRequired: row.consecutiveHealthyRequired,
			renotifyIntervalMinutes: row.renotifyIntervalMinutes,
			apdexThresholdMs: row.apdexThresholdMs,
			queryBuilderDraft: stored.queryBuilderDraft,
			rawQuerySql: row.rawQuerySql ?? null,
			rawQueryReducer: decoded.rawQueryReducer,
			alertOnNoData: row.noDataBehavior === "alert",
			destinationIds: legacy.destinationIds,
			compiledPlan: yield* parseCompiledPlan(row),
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
		}
	})

	const normalizeRule = Effect.fn("AlertsService.normalizeRule")(function* (
		orgId: OrgId,
		request: AlertRuleUpsertRequest,
		options?: { readonly forPreview?: boolean },
	): Effect.fn.Return<NormalizedRule, AlertValidationError> {
		if (request.signalType === "uptime") {
			return yield* Effect.fail(invalidRuleError([UPTIME_RULE_MANAGED_MESSAGE]))
		}
		const name = request.name.trim()
		// A builder query's draft carries its own scope and never reads the
		// service fields, so keeping them would only fan out identical queries.
		const draftOwnsScope = request.signalType === "builder_query"
		const serviceNames =
			request.serviceNames && request.serviceNames.length > 0 && !draftOwnsScope
				? request.serviceNames
						.map((service) => service.trim())
						.filter((service) => service.length > 0)
				: []
		const serviceName = serviceNames.length === 1 ? (serviceNames[0] ?? null) : null
		const excludeServiceNames =
			request.excludeServiceNames && !draftOwnsScope
				? request.excludeServiceNames
						.map((service) => service.trim())
						.filter((service) => service.length > 0)
				: []
		const queryOwnsScope = request.signalType === "builder_query" || request.signalType === "raw_query"
		const environments =
			request.environments && !queryOwnsScope
				? Arr.dedupe(
						Arr.filterMap(request.environments, (environment) => {
							const trimmed = environment.trim()
							return trimmed.length > 0 ? Result.succeed(trimmed) : Result.failVoid
						}),
					)
				: []
		const tags = normalizeTags(request.tags)
		const groupBy = request.groupBy ?? null
		const details: string[] = []
		if (name.length === 0 && !options?.forPreview) details.push("name is required")
		// `thresholds` wins; the single-threshold shape is still one tier.
		const tiered = request.thresholds !== undefined
		const requestedThresholds: AlertThresholds | null =
			request.thresholds !== undefined
				? request.thresholds
				: request.threshold === undefined
					? null
					: Arr.of(
							legacyAlertThreshold({
								severity: request.severity ?? "warning",
								threshold: request.threshold,
								thresholdUpper: request.thresholdUpper ?? null,
								destinationIds: request.destinationIds ?? [],
							}),
						)
		if (requestedThresholds === null) {
			details.push("threshold must be a finite number")
		} else {
			if (!tiered && request.severity === undefined) details.push("severity is required")
			details.push(
				...validateThresholds(request.comparator, requestedThresholds, {
					label: (index, field) =>
						tiered
							? `thresholds[${index}].${field}`
							: field === "value"
								? "threshold"
								: field === "upper"
									? "thresholdUpper"
									: "recoveryValue",
					requireDestinations: !options?.forPreview,
				}),
			)
		}
		const consecutiveBreachesRequired = request.consecutiveBreachesRequired ?? 2
		const breachesOutOf = request.breachesOutOf ?? null
		details.push(...validateBreachWindow(consecutiveBreachesRequired, breachesOutOf))
		const evaluationIntervalMinutes = request.evaluationIntervalMinutes ?? null
		// A check reads only its window, so a longer gap between checks would leave data unread.
		if (evaluationIntervalMinutes !== null && evaluationIntervalMinutes > request.windowMinutes) {
			details.push(
				`windowMinutes (${request.windowMinutes}) must be at least evaluationIntervalMinutes (${evaluationIntervalMinutes}), or data between checks is never evaluated`,
			)
		}
		if (request.signalType === "builder_query" && !request.queryBuilderDraft) {
			details.push("queryBuilderDraft is required for builder_query alerts")
		}
		if (request.signalType === "raw_query") {
			const sql = request.rawQuerySql?.trim() ?? ""
			if (sql.length === 0) details.push("rawQuerySql is required for raw_query alerts")
			if (serviceNames.length > 0) details.push("serviceNames is not supported for raw_query alerts")
			if (groupBy != null) {
				details.push("groupBy is not supported for raw_query alerts; return a group column instead")
			}
		} else {
			if (normalizeOptionalString(request.rawQuerySql) != null) {
				details.push("rawQuerySql is only supported for raw_query alerts")
			}
			if (request.rawQueryReducer != null) {
				details.push("rawQueryReducer is only supported for raw_query alerts")
			}
		}
		if (groupBy != null && serviceNames.length > 0) {
			details.push("groupBy is only supported when no service is specified")
		}
		if (excludeServiceNames.length > 0 && serviceNames.length > 0) {
			details.push("excludeServiceNames is only supported when no specific services are selected")
		}
		if (
			excludeServiceNames.length > 0 &&
			!(groupBy != null && groupBy.length === 1 && groupBy[0] === "service.name")
		) {
			details.push('excludeServiceNames requires groupBy=["service.name"]')
		}
		// A null tier list always left a detail behind; the check is for the narrowing.
		if (details.length > 0 || requestedThresholds === null) {
			return yield* Effect.fail(invalidRuleError(details))
		}
		const thresholds = sortAlertThresholds(requestedThresholds)
		if (request.signalType === "raw_query") {
			yield* prepareRawSql({
				sql: request.rawQuerySql ?? "",
				orgId,
				startTime: "2000-01-01 00:00:00",
				endTime: "2000-01-01 00:05:00",
				granularitySeconds: 60,
				workload: "alert",
			}).pipe(
				Effect.mapError((error) =>
					makeAlertValidationError("Invalid raw SQL alert query", [error.message], error),
				),
			)
		}

		const nowMs = yield* runtime.now
		const legacy = alertThresholdLegacyFields(thresholds)
		const normalizedBase = {
			id: decodeAlertRuleIdSync(runtime.makeUuid()),
			name,
			notificationTemplate: request.notificationTemplate ?? null,
			enabled: request.enabled ?? true,
			thresholds,
			severity: legacy.severity,
			serviceName,
			serviceNames,
			excludeServiceNames,
			environments,
			tags,
			groupBy,
			signalType: request.signalType,
			comparator: request.comparator,
			threshold: legacy.threshold,
			thresholdUpper: legacy.thresholdUpper,
			windowMinutes: request.windowMinutes,
			evaluationIntervalMinutes,
			// An edit gives a slowed rule a fresh start at the interval it asks for.
			slowedIntervalMinutes: null,
			minimumSampleCount: request.minimumSampleCount ?? 0,
			consecutiveBreachesRequired,
			breachesOutOf,
			consecutiveHealthyRequired: request.consecutiveHealthyRequired ?? 2,
			renotifyIntervalMinutes: request.renotifyIntervalMinutes ?? 30,
			apdexThresholdMs: request.apdexThresholdMs ?? (request.signalType === "apdex" ? 500 : null),
			queryBuilderDraft: request.queryBuilderDraft ?? null,
			rawQuerySql:
				request.signalType === "raw_query" ? normalizeOptionalString(request.rawQuerySql) : null,
			rawQueryReducer: request.signalType === "raw_query" ? (request.rawQueryReducer ?? null) : null,
			alertOnNoData: request.alertOnNoData ?? false,
			destinationIds: legacy.destinationIds,
			createdAt: nowMs,
			updatedAt: nowMs,
		}
		const compiledPlan = yield* compileRulePlan(normalizedBase)
		// A grouped rule's missing group is already held open by its incident's
		// liveness check; an empty result would breach under no real group.
		if (normalizedBase.alertOnNoData && planGroupingTokens(compiledPlan) != null) {
			return yield* Effect.fail(
				invalidRuleError([
					"alertOnNoData is not supported on grouped rules: a group that stops reporting is already held open by its incident's telemetry check",
				]),
			)
		}
		return { ...normalizedBase, compiledPlan }
	})

	return { normalizeRule, normalizeRuleRow }
}
