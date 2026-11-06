import * as CH from "@maple/query-engine/ch"
import {
	AlertCheckDocument,
	AlertChecksListResponse,
	AlertComparator as AlertComparatorSchema,
	AlertDeliveryEventDocument,
	AlertDeliveryEventsListResponse,
	AlertDeliveryStatus,
	AlertDestinationDocument,
	AlertDestinationType as AlertDestinationTypeSchema,
	AlertEventType as AlertEventTypeSchema,
	AlertIncidentDocument,
	AlertIncidentEscalationDocument,
	AlertIncidentsListResponse,
	AlertIncidentAckSource,
	AlertIncidentHoldReason,
	AlertIncidentStatus,
	AlertIncidentTransition as AlertIncidentTransitionSchema,
	AlertIncidentNotFoundError,
	AlertRuleNotFoundError,
	AlertPersistenceError,
	AlertRuleDocument,
	AlertSeverity as AlertSeveritySchema,
	AlertSignalType as AlertSignalTypeSchema,
	AlertCheckStatus as AlertCheckStatusSchema,
	AlertSkipReason,
	AlertValidationError,
	OrgId,
	type AlertIncidentId,
	type AlertRuleId,
	type ManagedWarehouseError,
} from "@maple/domain/http"
import * as PG from "@maple-dev/effect-orm/postgres"
import {
	AlertDeliveryEvents,
	AlertDestinations,
	AlertEscalationRuns,
	AlertIncidents,
	AlertRules,
	type AlertIncidentRow,
} from "@maple/db/tables"
import {
	Array as Arr,
	Context,
	DateTime,
	Duration,
	Effect,
	Layer,
	Option,
	Record as Rec,
	Schema,
} from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute } from "@maple/backend/platform/db-execute"
import { makePersistenceError } from "./alert-persistence"
import { systemTenant } from "./system-tenant"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { parseUtc } from "@maple/query-engine"

export interface AlertChecksSummaryPoint {
	readonly bucket: DateTime.Utc
	readonly groupKey: string
	readonly totalCount: number
	readonly breachedCount: number
	readonly healthyCount: number
	readonly skippedCount: number
	readonly errorCount: number
	readonly transitionCount: number
	readonly observedValue: number | null
	readonly threshold: number
}

export interface AlertChecksSummary {
	readonly bucketSeconds: number
	readonly topGroupKeys: ReadonlyArray<string>
	readonly points: ReadonlyArray<AlertChecksSummaryPoint>
	readonly totals: {
		readonly total: number
		readonly breached: number
		readonly healthy: number
		readonly skipped: number
		readonly error: number
		readonly transitions: number
	}
}

export interface ListAlertIncidentsOptions {
	readonly status?: AlertIncidentStatus
	readonly ruleId?: AlertRuleId
	/** Open incidents only, split by whether someone has acknowledged them. */
	readonly acknowledged?: boolean
	readonly limit?: number
	readonly offset?: number
}

export interface ListAlertDeliveryEventsOptions {
	readonly limit?: number
	readonly offset?: number
	readonly incidentId?: AlertIncidentId
	readonly ruleId?: AlertRuleId
	/** Leave out the internal PagerDuty `acknowledge` syncs, which the public API does not report. */
	readonly notificationsOnly?: boolean
}

export interface AlertReadModelsServiceApi {
	readonly listIncidents: (
		orgId: OrgId,
		options?: ListAlertIncidentsOptions,
	) => Effect.Effect<AlertIncidentsListResponse, AlertPersistenceError>
	readonly getIncident: (
		orgId: OrgId,
		incidentId: AlertIncidentId,
	) => Effect.Effect<AlertIncidentDocument, AlertPersistenceError | AlertIncidentNotFoundError>
	/** Each incident's latest escalation run, in one query for the whole set; incidents without one are absent. */
	readonly listIncidentEscalations: (
		orgId: OrgId,
		incidentIds: ReadonlyArray<AlertIncidentId>,
	) => Effect.Effect<ReadonlyArray<AlertIncidentEscalationDocument>, AlertPersistenceError>
	readonly listRuleChecks: (
		orgId: OrgId,
		ruleId: AlertRuleId,
		options: {
			readonly groupKey?: string
			readonly status?: AlertCheckDocument["status"]
			readonly since?: string
			readonly until?: string
			readonly limit?: number
			readonly beforeTimestamp?: string
			readonly beforeGroupKey?: string
		},
	) => Effect.Effect<
		AlertChecksListResponse,
		AlertPersistenceError | AlertRuleNotFoundError | ManagedWarehouseError
	>
	readonly summarizeRuleChecks: (
		orgId: OrgId,
		ruleId: AlertRuleId,
		options: {
			readonly since: string
			readonly until: string
		},
	) => Effect.Effect<
		AlertChecksSummary,
		AlertPersistenceError | AlertRuleNotFoundError | AlertValidationError | ManagedWarehouseError
	>
	readonly listDeliveryEvents: (
		orgId: OrgId,
		options?: ListAlertDeliveryEventsOptions,
	) => Effect.Effect<AlertDeliveryEventsListResponse, AlertPersistenceError>
}

const decodeAlertIncidentIdSync = Schema.decodeUnknownSync(AlertIncidentDocument.fields.id)
const decodeAlertRuleIdSync = Schema.decodeUnknownSync(AlertRuleDocument.fields.id)
const decodeAlertDeliveryEventIdSync = Schema.decodeUnknownSync(AlertDeliveryEventDocument.fields.id)
const decodeAlertDestinationIdSync = Schema.decodeUnknownSync(AlertDestinationDocument.fields.id)
const decodeIsoDateTimeStringSync = Schema.decodeUnknownSync(AlertDestinationDocument.fields.createdAt)
const decodeAlertDestinationTypeSync = Schema.decodeUnknownSync(AlertDestinationTypeSchema)
const decodeAlertSeveritySync = Schema.decodeUnknownSync(AlertSeveritySchema)
const decodeAlertSignalTypeSync = Schema.decodeUnknownSync(AlertSignalTypeSchema)
const decodeAlertComparatorSync = Schema.decodeUnknownSync(AlertComparatorSchema)
const decodeAlertCheckStatusSync = Schema.decodeUnknownSync(AlertCheckStatusSchema)
// A reason this build does not know (a newer writer, or a rollback) reads as none rather than failing the page.
const decodeAlertSkipReason = Schema.decodeUnknownOption(AlertSkipReason)
const decodeAlertIncidentTransitionSync = Schema.decodeUnknownSync(AlertIncidentTransitionSchema)
const decodeAlertIncidentStatusSync = Schema.decodeUnknownSync(AlertIncidentStatus)
const decodeAlertIncidentHoldReasonSync = Schema.decodeUnknownSync(AlertIncidentHoldReason)
const decodeAlertEventTypeSync = Schema.decodeUnknownSync(AlertEventTypeSchema)
const decodeErrorIssueIdSync = Schema.decodeUnknownSync(AlertIncidentDocument.fields.errorIssueId)
const decodeAlertDeliveryStatusSync = Schema.decodeUnknownSync(AlertDeliveryStatus)
// An unknown source (a newer writer) reads as none rather than failing the page.
const decodeAlertIncidentAckSource = Schema.decodeUnknownOption(AlertIncidentAckSource)

type IsoDateTimeValue = Schema.Schema.Type<typeof AlertDestinationDocument.fields.createdAt>

const toIso = (value: number | null | undefined): IsoDateTimeValue | null =>
	value == null ? null : decodeIsoDateTimeStringSync(new Date(value).toISOString())

const makeValidationError = (message: string) => new AlertValidationError({ message, details: [] })

export const rowToIncidentDocument = (row: AlertIncidentRow) =>
	new AlertIncidentDocument({
		id: decodeAlertIncidentIdSync(row.id),
		ruleId: decodeAlertRuleIdSync(row.ruleId),
		ruleName: row.ruleName,
		groupKey: row.groupKey,
		signalType: decodeAlertSignalTypeSync(row.signalType),
		severity: decodeAlertSeveritySync(row.severity),
		peakSeverity: row.peakSeverity === null ? null : decodeAlertSeveritySync(row.peakSeverity),
		status: decodeAlertIncidentStatusSync(row.status),
		comparator: decodeAlertComparatorSync(row.comparator),
		threshold: row.threshold,
		thresholdUpper: row.thresholdUpper,
		firstTriggeredAt: decodeIsoDateTimeStringSync(new Date(row.firstTriggeredAt).toISOString()),
		lastTriggeredAt: decodeIsoDateTimeStringSync(new Date(row.lastTriggeredAt).toISOString()),
		resolvedAt: toIso(row.resolvedAt),
		lastObservedValue: row.lastObservedValue,
		lastSampleCount: row.lastSampleCount,
		dedupeKey: row.dedupeKey,
		lastDeliveredEventType:
			row.lastDeliveredEventType != null ? decodeAlertEventTypeSync(row.lastDeliveredEventType) : null,
		lastNotifiedAt: toIso(row.lastNotifiedAt),
		holdReason: row.holdReason != null ? decodeAlertIncidentHoldReasonSync(row.holdReason) : null,
		heldSince: toIso(row.heldSince),
		acknowledgedAt: toIso(row.acknowledgedAt),
		acknowledgedByUserId: row.acknowledgedByUserId,
		acknowledgedByName: row.acknowledgedByName,
		acknowledgedVia:
			row.acknowledgedVia === null
				? null
				: Option.getOrNull(decodeAlertIncidentAckSource(row.acknowledgedVia)),
		errorIssueId: row.errorIssueId != null ? decodeErrorIssueIdSync(row.errorIssueId) : null,
		...(row.signalType === "anomaly" ? { anomalyIncidentId: row.anomalyIncidentId } : undefined),
		...(row.groupLabel === null ? undefined : { groupLabel: row.groupLabel }),
		...(row.labelsJson === null ? undefined : { labels: row.labelsJson }),
		silenceId: row.silenceId,
		silencedAt: toIso(row.silencedAt),
	})

/** An optional request bound, or `null` when it does not parse (the filter is then skipped). */
const optionalInstant = (input: string | undefined): DateTime.Utc | null =>
	input == null ? null : Option.getOrNull(parseUtc(input))

/** A warehouse row timestamp as the ISO string the HTTP document carries. */
const isoOf = (value: DateTime.Utc) => decodeIsoDateTimeStringSync(DateTime.formatIso(value))

export class AlertReadModelsService extends Context.Service<
	AlertReadModelsService,
	AlertReadModelsServiceApi
>()("@maple/backend/services/alerts/AlertReadModelsService", {
	make: Effect.gen(function* () {
		const database = yield* Database
		const warehouse = yield* WarehouseQueryService

		const dbExecute = makeDbExecute(database, "AlertReadModelsService", makePersistenceError)

		const listIncidents = Effect.fn("AlertReadModelsService.listIncidents")(function* (
			orgId: OrgId,
			options: ListAlertIncidentsOptions = {},
		) {
			yield* Effect.annotateCurrentSpan({
				orgId,
				...(options.status !== undefined ? { status: options.status } : undefined),
				...(options.ruleId !== undefined ? { ruleId: options.ruleId } : undefined),
				...(options.acknowledged !== undefined ? { acknowledged: options.acknowledged } : undefined),
			})
			const { status, ruleId, acknowledged } = options
			const rows = yield* dbExecute((db) =>
				db.run(
					PG.from(AlertIncidents)
						.select()
						.where(($) => [
							$.orgId.eq(orgId),
							status ? $.status.eq(status) : undefined,
							ruleId ? $.ruleId.eq(ruleId) : undefined,
							acknowledged === undefined ? undefined : $.status.eq("open"),
							acknowledged === undefined
								? undefined
								: acknowledged
									? $.acknowledgedAt.isNotNull()
									: $.acknowledgedAt.isNull(),
						])
						.orderBy(["lastTriggeredAt", "desc"], ["id", "desc"])
						.limit(options.limit ?? 100)
						.offset(options.offset ?? 0),
				),
			)
			yield* Effect.annotateCurrentSpan("result.rowCount", rows.length)
			return new AlertIncidentsListResponse({
				incidents: rows.map(rowToIncidentDocument),
			})
		})

		const getIncident = Effect.fn("AlertReadModelsService.getIncident")(function* (
			orgId: OrgId,
			incidentId: AlertIncidentId,
		) {
			yield* Effect.annotateCurrentSpan({ orgId, "maple.alert.incident_id": incidentId })
			const rows = yield* dbExecute((db) =>
				db.run(
					PG.from(AlertIncidents)
						.select()
						.where(($) => [$.orgId.eq(orgId), $.id.eq(incidentId)])
						.limit(1),
				),
			)
			const incident = rows[0]
			if (incident === undefined) {
				return yield* new AlertIncidentNotFoundError({
					message: `No such alert incident: '${incidentId}'`,
					incidentId,
				})
			}
			return rowToIncidentDocument(incident)
		})

		const listIncidentEscalations = Effect.fn("AlertReadModelsService.listIncidentEscalations")(
			function* (orgId: OrgId, incidentIds: ReadonlyArray<AlertIncidentId>) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.alert.incident_count": incidentIds.length })
				if (incidentIds.length === 0) return []
				const rows = yield* dbExecute((db) =>
					db.run(
						PG.from(AlertEscalationRuns)
							.select(
								"id",
								"createdAt",
								"incidentId",
								"chainId",
								"chainName",
								"status",
								"stepIndex",
								"passIndex",
								"stepsJson",
								"repeatCount",
								"stepsSent",
								"nextStepAt",
							)
							.where(($) => [$.orgId.eq(orgId), $.incidentId.in_(...incidentIds)])
							.orderBy(["createdAt", "desc"], ["id", "desc"]),
					),
				)
				// Newest first, so each incident's group starts with its latest run.
				return Arr.map(
					Rec.values(Arr.groupBy(rows, (row) => row.incidentId)),
					([row]) =>
						new AlertIncidentEscalationDocument({
							incidentId: row.incidentId,
							chainId: row.chainId,
							chainName: row.chainName,
							status: row.status,
							stepIndex: row.stepIndex,
							passIndex: row.passIndex,
							stepCount: row.stepsJson.length,
							repeatCount: row.repeatCount,
							stepsSent: row.stepsSent,
							nextStepAt: row.status === "active" ? toIso(row.nextStepAt) : null,
						}),
				)
			},
		)

		const listRuleChecks = Effect.fn("AlertReadModelsService.listRuleChecks")(function* (
			orgId: OrgId,
			ruleId: AlertRuleId,
			options: {
				readonly groupKey?: string
				readonly status?: AlertCheckDocument["status"]
				readonly since?: string
				readonly until?: string
				readonly limit?: number
				readonly beforeTimestamp?: string
				readonly beforeGroupKey?: string
			},
		) {
			yield* Effect.annotateCurrentSpan({ orgId, "maple.alert.rule_id": ruleId })
			// Verify the rule exists and belongs to this org before querying Tinybird.
			const ruleRow = yield* dbExecute((db) =>
				db.run(
					PG.from(AlertRules)
						.select("id")
						.where(($) => [$.orgId.eq(orgId), $.id.eq(ruleId)])
						.limit(1),
				),
			)
			if (ruleRow.length === 0) {
				return yield* new AlertRuleNotFoundError({
					message: "Alert rule not found",
					ruleId,
				})
			}

			const clamp = (n: number | undefined, min: number, max: number, fallback: number) => {
				if (n == null || Number.isNaN(n)) return fallback
				return Math.min(max, Math.max(min, Math.trunc(n)))
			}
			const limit = clamp(options.limit, 1, 2000, 500)

			const since = optionalInstant(options.since)
			const until = optionalInstant(options.until)
			const beforeTimestamp = optionalInstant(options.beforeTimestamp)
			const hasGroupKey = options.groupKey != null && options.groupKey !== ""

			const compiled = CH.compile(
				CH.listRuleChecksQuery({
					limit,
					groupKey: hasGroupKey ? options.groupKey : undefined,
					status: options.status,
					since: since ?? undefined,
					until: until ?? undefined,
					beforeTimestamp: beforeTimestamp ?? undefined,
					beforeGroupKey: beforeTimestamp != null ? (options.beforeGroupKey ?? "") : undefined,
				}),
				{
					orgId,
					ruleId,
					...(hasGroupKey ? { groupKey: options.groupKey } : undefined),
					...(options.status != null ? { status: options.status } : undefined),
					...(since != null ? { since } : undefined),
					...(until != null ? { until } : undefined),
					...(beforeTimestamp != null
						? {
								beforeTimestamp,
								beforeGroupKey: options.beforeGroupKey ?? "",
							}
						: undefined),
				},
			)

			// listRuleChecksQuery declares .route("ingest") — alert_checks only
			// exists in the managed Tinybird pipeline.
			const rows = yield* warehouse.compiledQuery(systemTenant(orgId), compiled, {
				profile: "list",
				context: "listAlertChecks",
			})

			const checks = yield* Effect.try({
				try: () =>
					rows.map((r) => {
						const rawTransition =
							r.incidentTransition == null || r.incidentTransition === ""
								? "none"
								: r.incidentTransition
						return new AlertCheckDocument({
							timestamp: isoOf(r.timestamp),
							groupKey: r.groupKey,
							status: decodeAlertCheckStatusSync(r.status),
							skipReason: Option.getOrNull(decodeAlertSkipReason(r.skipReason)),
							signalType: decodeAlertSignalTypeSync(r.signalType),
							comparator: decodeAlertComparatorSync(r.comparator),
							threshold: r.threshold,
							// thresholdUpper not yet recorded in the Tinybird alert_checks
							// datasource — schema column will be backfilled with the
							// datasource update; for now always null in the audit log.
							thresholdUpper: null,
							observedValue: r.observedValue == null ? null : r.observedValue,
							sampleCount: r.sampleCount,
							windowMinutes: r.windowMinutes,
							windowStart: isoOf(r.windowStart),
							windowEnd: isoOf(r.windowEnd),
							consecutiveBreaches: r.consecutiveBreaches,
							consecutiveHealthy: r.consecutiveHealthy,
							incidentId:
								r.incidentId == null || r.incidentId === ""
									? null
									: decodeAlertIncidentIdSync(r.incidentId),
							incidentTransition: decodeAlertIncidentTransitionSync(rawTransition),
							level: r.level === "" ? null : decodeAlertSeveritySync(r.level),
							evaluationDurationMs: r.evaluationDurationMs,
							errorMessage:
								r.errorMessage == null || r.errorMessage === "" ? null : r.errorMessage,
							errorCategory:
								r.errorCategory == null || r.errorCategory === "" ? null : r.errorCategory,
						})
					}),
				catch: (error) =>
					new AlertPersistenceError({
						message: `Failed to decode alert check row: ${error instanceof Error ? error.message : String(error)}`,
					}),
			})

			return new AlertChecksListResponse({ checks })
		})

		const summarizeRuleChecks = Effect.fn("AlertReadModelsService.summarizeRuleChecks")(function* (
			orgId: OrgId,
			ruleId: AlertRuleId,
			options: { readonly since: string; readonly until: string },
		) {
			yield* Effect.annotateCurrentSpan({ orgId, "maple.alert.rule_id": ruleId })
			const ruleRow = yield* dbExecute((db) =>
				db.run(
					PG.from(AlertRules)
						.select("id")
						.where(($) => [$.orgId.eq(orgId), $.id.eq(ruleId)])
						.limit(1),
				),
			)
			if (ruleRow.length === 0) {
				return yield* new AlertRuleNotFoundError({
					message: "Alert rule not found",
					ruleId,
				})
			}

			const since = optionalInstant(options.since)
			const until = optionalInstant(options.until)
			const maxRangeMs = 365 * 24 * 60 * 60 * 1000
			const rangeMs =
				since != null && until != null
					? Duration.toMillis(DateTime.distance(since, until))
					: Number.NaN
			if (!(rangeMs > 0 && rangeMs <= maxRangeMs) || since == null || until == null) {
				return yield* makeValidationError(
					"Alert check summaries require a valid range of at most 365 days",
				)
			}

			// At most 720 time buckets; minute alignment keeps the boundaries
			// stable across refreshes and matches alert evaluation granularity.
			const bucketSeconds = Math.max(1, Math.ceil(rangeMs / 1000 / 720 / 60)) * 60
			const tenant = systemTenant(orgId)
			const groupRows = yield* warehouse.compiledQuery(
				tenant,
				CH.compile(CH.alertCheckGroupTotalsQuery({ since, until, limit: 20 }), {
					orgId,
					ruleId,
					since,
					until,
				}),
				{ profile: "aggregation", context: "alertCheckSummaryGroups" },
			)
			const topGroupKeys = groupRows.map((row) => row.groupKey)
			const rows = yield* warehouse.compiledQuery(
				tenant,
				CH.compile(CH.alertChecksSummaryQuery({ topGroupKeys }), {
					orgId,
					ruleId,
					since,
					until,
					bucketSeconds,
				}),
				{ profile: "aggregation", context: "alertCheckSummary" },
			)

			const points: AlertChecksSummaryPoint[] = rows.map((row) => ({
				bucket: row.bucket,
				groupKey: row.groupKey,
				totalCount: row.totalCount,
				breachedCount: row.breachedCount,
				healthyCount: row.healthyCount,
				skippedCount: row.skippedCount,
				errorCount: row.errorCount,
				transitionCount: row.transitionCount,
				observedValue: row.observedValue == null ? null : row.observedValue,
				threshold: row.threshold ?? 0,
			}))
			const totals = points.reduce(
				(acc, point) => ({
					total: acc.total + point.totalCount,
					breached: acc.breached + point.breachedCount,
					healthy: acc.healthy + point.healthyCount,
					skipped: acc.skipped + point.skippedCount,
					error: acc.error + point.errorCount,
					transitions: acc.transitions + point.transitionCount,
				}),
				{ total: 0, breached: 0, healthy: 0, skipped: 0, error: 0, transitions: 0 },
			)
			return { bucketSeconds, topGroupKeys, points, totals } satisfies AlertChecksSummary
		})

		const listDeliveryEvents = Effect.fn("AlertReadModelsService.listDeliveryEvents")(function* (
			orgId: OrgId,
			options: ListAlertDeliveryEventsOptions = {},
		) {
			yield* Effect.annotateCurrentSpan("orgId", orgId)
			const { incidentId, ruleId, notificationsOnly } = options
			const rows = yield* dbExecute((db) =>
				db.run(
					PG.from(AlertDeliveryEvents)
						.select()
						.where(($) => [
							$.orgId.eq(orgId),
							incidentId === undefined ? undefined : $.incidentId.eq(incidentId),
							ruleId === undefined ? undefined : $.ruleId.eq(ruleId),
							notificationsOnly === true ? $.eventType.neq("acknowledge") : undefined,
						])
						.orderBy(["createdAt", "desc"], ["id", "desc"])
						.limit(options.limit ?? 100)
						.offset(options.offset ?? 0),
				),
			)

			const destinationRows = yield* dbExecute((db) =>
				db.run(
					PG.from(AlertDestinations)
						.select("id", "name", "type")
						.where(($) => [$.orgId.eq(orgId)]),
				),
			)
			const destinationMap = new Map(destinationRows.map((row) => [row.id, row]))

			const events = rows.map((row) => {
				const destination = destinationMap.get(row.destinationId)
				return new AlertDeliveryEventDocument({
					id: decodeAlertDeliveryEventIdSync(row.id),
					incidentId: row.incidentId ? decodeAlertIncidentIdSync(row.incidentId) : null,
					ruleId: decodeAlertRuleIdSync(row.ruleId),
					destinationId: decodeAlertDestinationIdSync(row.destinationId),
					destinationName: destination?.name ?? "Deleted destination",
					destinationType:
						destination?.type != null
							? decodeAlertDestinationTypeSync(destination.type)
							: decodeAlertDestinationTypeSync("webhook"),
					deliveryKey: row.deliveryKey,
					eventType: decodeAlertEventTypeSync(row.eventType),
					attemptNumber: row.attemptNumber,
					status: decodeAlertDeliveryStatusSync(row.status),
					scheduledAt: decodeIsoDateTimeStringSync(new Date(row.scheduledAt).toISOString()),
					attemptedAt: toIso(row.attemptedAt),
					providerMessage: row.providerMessage,
					providerReference: row.providerReference,
					responseCode: row.responseCode,
					errorMessage: row.errorMessage,
				})
			})

			return new AlertDeliveryEventsListResponse({ events })
		})

		return {
			listIncidents,
			getIncident,
			listIncidentEscalations,
			listRuleChecks,
			summarizeRuleChecks,
			listDeliveryEvents,
		} satisfies AlertReadModelsServiceApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(WarehouseQueryService.layer))
}
