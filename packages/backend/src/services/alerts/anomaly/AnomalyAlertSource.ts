import { randomUUID } from "node:crypto"
import * as PG from "@maple-dev/effect-orm/postgres"
import { AlertIncidents, AlertRules, AnomalyIncidents } from "@maple/db/tables"
import type { MapleDb } from "@maple/db/client"
import {
	AlertPersistenceError,
	AlertSeverity as AlertSeveritySchema,
	AlertThresholds as AlertThresholdsSchema,
	type AnomalySignalType,
} from "@maple/domain/http"
import {
	AlertRuleId,
	AnomalyIncidentId,
	UserId,
	type ErrorIssueId,
	type OrgId,
} from "@maple/domain/primitives"
import { Array as Arr, Clock, Context, Effect, HashMap, HashSet, Layer, Option, Result, Schema } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute } from "@maple/backend/platform/db-execute"
import { lockOrgAlertRules, makePersistenceError } from "../alert-persistence"
import {
	anomalyGroupLabel,
	anomalySeverityCode,
	assignAnomalyRule,
	DEFAULT_ANOMALY_RULE_FALLBACK_NAME,
	DEFAULT_ANOMALY_RULE_NAME,
	defaultAnomalyRuleFields,
	describeAnomaly,
	isDefaultAnomalyScope,
	storedAnomalyScope,
	type AnomalySeverityCode,
} from "./anomaly-rule"

/** What an `anomaly` alert rule observes for one anomaly incident on a tick. */
export interface AnomalyAlertObservation {
	/** The anomaly incident's id: stable while the detector rewrites its detector key. */
	readonly groupKey: string
	readonly value: AnomalySeverityCode
	readonly detail: string
	/** Null only for a stale alert incident whose anomaly row is gone. */
	readonly anomalyIncidentId: AnomalyIncidentId | null
	/** The anomaly incident's own issue, which the alert incident shares. */
	readonly errorIssueId: ErrorIssueId | null
	readonly serviceName: string
	readonly deploymentEnv: string
	readonly signalType: AnomalySignalType | null
	/** Shown where a group key would be, e.g. "checkout (production)". */
	readonly groupLabel: string
}

export interface AnomalyAlertSourceApi {
	/**
	 * The open anomalies assigned to `ruleId`, plus a value-0 observation for each of the rule's
	 * open alert incidents whose anomaly ended or moved, so the evaluator resolves them without a probe.
	 */
	readonly observe: (
		orgId: OrgId,
		ruleId: AlertRuleId,
	) => Effect.Effect<ReadonlyArray<AnomalyAlertObservation>, AlertPersistenceError>
	/**
	 * Creates the default anomaly rule for orgs with an open anomaly and no default rule, at most
	 * {@link MAX_DEFAULT_RULE_BACKFILL} per call. Idempotent; returns how many it created.
	 */
	readonly backfillDefaultRules: Effect.Effect<number, AlertPersistenceError>
}

const MAX_DEFAULT_RULE_BACKFILL = 100
const SYSTEM_USER_ID = Schema.decodeSync(UserId)("system-alerting")
const decodeAnomalyIncidentId = Schema.decodeUnknownOption(AnomalyIncidentId)
const decodeThresholds = Schema.decodeUnknownOption(AlertThresholdsSchema)
const decodeSeverity = Schema.decodeUnknownOption(AlertSeveritySchema)

/** A rule's lowest tier as a severity code; a row whose tiers do not decode reads its severity. */
const lowestSeverityCode = (rule: { readonly severity: string; readonly thresholdsJson: unknown }): 1 | 2 =>
	Option.match(decodeThresholds(rule.thresholdsJson), {
		onSome: (tiers) => (Arr.some(tiers, (tier) => anomalySeverityCode(tier.severity) === 1) ? 1 : 2),
		onNone: () =>
			Option.match(decodeSeverity(rule.severity), {
				onSome: anomalySeverityCode,
				onNone: () => 1 as const,
			}),
	})

/** Names the backfill tries in order, so a user rule holding one never blocks the default. */
const DEFAULT_RULE_NAMES = [
	DEFAULT_ANOMALY_RULE_NAME,
	DEFAULT_ANOMALY_RULE_FALLBACK_NAME,
	...Arr.makeBy(8, (index) => `${DEFAULT_ANOMALY_RULE_NAME} (default ${index + 2})`),
]

/**
 * The alert evaluator's view of the anomaly detector: which open anomalies each anomaly rule
 * pages on. Its own service with only the database, like `UptimeAlertSource`.
 */
export class AnomalyAlertSource extends Context.Service<AnomalyAlertSource, AnomalyAlertSourceApi>()(
	"@maple/backend/services/alerts/anomaly/AnomalyAlertSource",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const dbExecute = makeDbExecute(database, "AnomalyAlertSource", makePersistenceError)

			const observe = Effect.fn("AnomalyAlertSource.observe")(function* (
				orgId: OrgId,
				ruleId: AlertRuleId,
			) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.alert.rule_id": ruleId })
				const { rules, anomalies, openAlertIncidents } = yield* dbExecute((db) =>
					Effect.all({
						rules: db.run(
							PG.from(AlertRules)
								.select(
									"id",
									"severity",
									"thresholdsJson",
									"serviceNamesJson",
									"environmentsJson",
									"anomalySignalsJson",
								)
								.where(($) => [
									$.orgId.eq(orgId),
									$.signalType.eq("anomaly"),
									$.enabled.eq(true),
								]),
						),
						anomalies: db.run(
							PG.from(AnomalyIncidents)
								.select(
									"id",
									"signalType",
									"serviceName",
									"deploymentEnv",
									"severity",
									"lastObservedValue",
									"baselineMedian",
									"errorIssueId",
								)
								.where(($) => [$.orgId.eq(orgId), $.status.eq("open")]),
						),
						// Every anomaly rule's open incidents, so an anomaly stays on the rule paging it.
						openAlertIncidents: db.run(
							PG.from(AlertIncidents)
								.select("ruleId", "groupKey")
								.where(($) => [
									$.orgId.eq(orgId),
									$.signalType.eq("anomaly"),
									$.status.eq("open"),
								]),
						),
					}),
				)
				const candidates = Arr.map(rules, (rule) => ({
					id: rule.id,
					...storedAnomalyScope(rule),
					lowestSeverityCode: lowestSeverityCode(rule),
				}))
				const pagingRule = HashMap.fromIterable(
					Arr.filterMap(openAlertIncidents, (incident) =>
						incident.groupKey === null
							? Result.failVoid
							: Result.succeed([incident.groupKey, incident.ruleId] as const),
					),
				)
				const assigned = Arr.filter(anomalies, (incident) =>
					Option.exists(
						assignAnomalyRule(
							candidates,
							incident,
							Option.getOrNull(HashMap.get(pagingRule, incident.id)),
						),
						(rule) => rule.id === ruleId,
					),
				)
				const firing = Arr.map(assigned, (incident): AnomalyAlertObservation => ({
					groupKey: incident.id,
					value: anomalySeverityCode(incident.severity),
					detail: describeAnomaly(incident),
					anomalyIncidentId: incident.id,
					errorIssueId: incident.errorIssueId,
					serviceName: incident.serviceName,
					deploymentEnv: incident.deploymentEnv,
					signalType: incident.signalType,
					groupLabel: anomalyGroupLabel(incident),
				}))
				const firingKeys = HashSet.fromIterable(
					Arr.map(firing, (observation) => observation.groupKey),
				)
				const endedKeys = Arr.filterMap(openAlertIncidents, (incident) =>
					incident.ruleId === ruleId &&
					incident.groupKey !== null &&
					!HashSet.has(firingKeys, incident.groupKey)
						? Result.succeed(incident.groupKey)
						: Result.failVoid,
				)
				const endedIds = Arr.filterMap(endedKeys, (key) =>
					Option.match(decodeAnomalyIncidentId(key), {
						onNone: () => Result.failVoid,
						onSome: Result.succeed,
					}),
				)
				// Resolved, or still open but now paged by another rule: either way it ends here.
				const endedRows =
					endedIds.length === 0
						? []
						: yield* dbExecute((db) =>
								db.run(
									PG.from(AnomalyIncidents)
										.select(
											"id",
											"signalType",
											"serviceName",
											"deploymentEnv",
											"status",
											"errorIssueId",
										)
										.where(($) => [$.orgId.eq(orgId), $.id.in_(...endedIds)]),
								),
							)
				const endedById = HashMap.fromIterable(
					Arr.map(endedRows, (row): readonly [string, (typeof endedRows)[number]] => [row.id, row]),
				)
				const ended = Arr.map(endedKeys, (groupKey): AnomalyAlertObservation => {
					const row = Option.getOrNull(HashMap.get(endedById, groupKey))
					if (row === null) {
						return {
							groupKey,
							value: 0,
							detail: "The anomaly ended",
							anomalyIncidentId: null,
							errorIssueId: null,
							serviceName: "",
							deploymentEnv: "",
							signalType: null,
							groupLabel: "anomaly",
						}
					}
					return {
						groupKey,
						value: 0,
						detail:
							row.status === "open" ? "The anomaly moved off this rule" : "The anomaly ended",
						anomalyIncidentId: row.id,
						errorIssueId: row.errorIssueId,
						serviceName: row.serviceName,
						deploymentEnv: row.deploymentEnv,
						signalType: row.signalType,
						groupLabel: anomalyGroupLabel(row),
					}
				})
				yield* Effect.annotateCurrentSpan({
					"maple.alert.observation_count": firing.length + ended.length,
					"maple.anomaly.ended_count": ended.length,
				})
				return [...firing, ...ended]
			})

			/** Inserts one org's default rule under the org lock; false when it already has one. */
			const backfillOne = (orgId: OrgId) =>
				dbExecute((db: MapleDb) =>
					db.transaction(
						Effect.gen(function* () {
							yield* lockOrgAlertRules(db, orgId)
							const rules = yield* db.run(
								PG.from(AlertRules)
									.select(
										"name",
										"signalType",
										"serviceNamesJson",
										"environmentsJson",
										"anomalySignalsJson",
									)
									.where(($) => [$.orgId.eq(orgId)]),
							)
							const hasDefault = Arr.some(
								rules,
								(rule) =>
									rule.signalType === "anomaly" &&
									isDefaultAnomalyScope(storedAnomalyScope(rule)),
							)
							if (hasDefault) return false
							const taken = HashSet.fromIterable(Arr.map(rules, (rule) => rule.name))
							const free = Arr.findFirst(
								DEFAULT_RULE_NAMES,
								(candidate) => !HashSet.has(taken, candidate),
							)
							if (Option.isNone(free)) {
								yield* Effect.logWarning(
									"Default anomaly rule backfill found every default name taken",
								).pipe(Effect.annotateLogs({ orgId }))
								return false
							}
							const name = free.value
							const now = yield* Clock.currentTimeMillis
							const inserted = yield* db.run(
								PG.insertInto(AlertRules)
									.values({
										id: AlertRuleId.make(randomUUID()),
										...defaultAnomalyRuleFields(orgId, name),
										lastScheduledAt: null,
										createdAt: now,
										updatedAt: now,
										createdBy: SYSTEM_USER_ID,
										updatedBy: SYSTEM_USER_ID,
									})
									.onConflictDoNothing()
									.returning("id"),
							)
							return inserted.length > 0
						}),
					),
				)

			const backfillDefaultRules = Effect.gen(function* () {
				// System path across orgs: orgs with an open anomaly, then those already defaulted.
				const { anomalyOrgs, anomalyRules } = yield* dbExecute((db) =>
					Effect.all({
						anomalyOrgs: db.run(
							PG.from(AnomalyIncidents)
								.select("orgId")
								.distinct()
								.where(($) => [$.status.eq("open")]),
						),
						anomalyRules: db.run(
							PG.from(AlertRules)
								.select("orgId", "serviceNamesJson", "environmentsJson", "anomalySignalsJson")
								.where(($) => [$.signalType.eq("anomaly")]),
						),
					}),
				)
				const defaulted = HashSet.fromIterable(
					Arr.filterMap(anomalyRules, (rule) =>
						isDefaultAnomalyScope(storedAnomalyScope(rule))
							? Result.succeed(rule.orgId)
							: Result.failVoid,
					),
				)
				const missing = Arr.take(
					Arr.filter(anomalyOrgs, (row) => !HashSet.has(defaulted, row.orgId)),
					MAX_DEFAULT_RULE_BACKFILL,
				)
				// One org's failure must not stop the rest; it is retried on the next pass.
				const created = yield* Effect.forEach(missing, (row) =>
					backfillOne(row.orgId).pipe(
						Effect.catch((error) =>
							Effect.logWarning("Default anomaly rule backfill skipped an org").pipe(
								Effect.annotateLogs({ orgId: row.orgId, error: error.message }),
								Effect.as(false),
							),
						),
					),
				)
				const count = Arr.filter(created, (made) => made).length
				yield* Effect.annotateCurrentSpan("maple.anomaly.default_rules_backfilled", count)
				return count
			}).pipe(Effect.withSpan("AnomalyAlertSource.backfillDefaultRules"))

			return { observe, backfillDefaultRules } satisfies AnomalyAlertSourceApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
