import { randomUUID } from "node:crypto"
import * as PG from "@maple-dev/effect-orm/postgres"
import type { MapleDb } from "@maple/db/client"
import { AlertDestinations, AlertRuleClaims, AlertRules } from "@maple/db/tables"
import type { AuditDetectionFilters } from "@maple/domain/audit-trail"
import {
	type AlertSeverity,
	type AuditDetection,
	AuditDetectionInvalidError,
	AuditDetectionNotFoundError,
	AuditTrailPersistenceError,
	MAX_AUDIT_DETECTIONS_PER_ORG,
} from "@maple/domain/http"
import { type AlertDestinationId, AlertRuleId, type OrgId, type UserId } from "@maple/primitives"
import { Array as Arr, Clock, Context, Effect, Layer, Option } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute, makePersistenceErrorMapper } from "@maple/backend/platform/db-execute"
import { deleteRuleRows } from "@maple/backend/services/alerts/AlertRulesService"
import { lockOrgAlertRules } from "@maple/backend/services/alerts/alert-persistence"
import {
	auditDetectionFromRow,
	auditDetectionRuleFields,
	type AuditDetectionRuleInput,
} from "./audit-detection-rule"

export interface CreateAuditDetectionInput {
	readonly name: string
	readonly enabled?: boolean
	readonly filters?: AuditDetectionFilters
	readonly windowMinutes: number
	readonly threshold: number
	readonly severity: AlertSeverity
	readonly destinationIds?: ReadonlyArray<AlertDestinationId>
	readonly createdBy: UserId
}

export interface UpdateAuditDetectionInput {
	readonly name?: string
	readonly enabled?: boolean
	/** Replaces the stored filters whole. */
	readonly filters?: AuditDetectionFilters
	readonly windowMinutes?: number
	readonly threshold?: number
	readonly severity?: AlertSeverity
	readonly destinationIds?: ReadonlyArray<AlertDestinationId>
	readonly updatedBy: UserId
}

type DetectionReadError = AuditDetectionNotFoundError | AuditTrailPersistenceError

export interface AuditDetectionsServiceApi {
	/** One org's detections, newest first. */
	readonly list: (orgId: OrgId) => Effect.Effect<ReadonlyArray<AuditDetection>, AuditTrailPersistenceError>
	readonly get: (orgId: OrgId, id: AlertRuleId) => Effect.Effect<AuditDetection, DetectionReadError>
	readonly create: (
		orgId: OrgId,
		input: CreateAuditDetectionInput,
	) => Effect.Effect<AuditDetection, AuditDetectionInvalidError | AuditTrailPersistenceError>
	readonly update: (
		orgId: OrgId,
		id: AlertRuleId,
		input: UpdateAuditDetectionInput,
	) => Effect.Effect<AuditDetection, DetectionReadError | AuditDetectionInvalidError>
	/** Deletes the rule with its state, incidents and deliveries, open incidents included. */
	readonly remove: (orgId: OrgId, id: AlertRuleId) => Effect.Effect<AlertRuleId, DetectionReadError>
}

const makeDetectionPersistenceError = makePersistenceErrorMapper(
	AuditTrailPersistenceError,
	"Audit detection persistence failed",
)

const invalid = (message: string) => new AuditDetectionInvalidError({ message })
const notFound = (detectionId: AlertRuleId) =>
	new AuditDetectionNotFoundError({ detectionId, message: "Detection not found" })
const unreadable = () => new AuditTrailPersistenceError({ message: "The stored detection cannot be read" })

/** The columns a detection reads back from; add a `where` to it. */
const selectDetections = () =>
	PG.from(AlertRules).select(($) => ({
		id: $.id,
		name: $.name,
		enabled: $.enabled,
		auditFiltersJson: PG.undecoded($.auditFiltersJson),
		windowMinutes: $.windowMinutes,
		threshold: $.threshold,
		thresholdsJson: $.thresholdsJson,
		createdAt: $.createdAt,
		updatedAt: $.updatedAt,
	}))

const selectDetection = (orgId: OrgId, id: AlertRuleId) =>
	selectDetections()
		.where(($) => [$.orgId.eq(orgId), $.id.eq(id), $.signalType.eq("audit")])
		.limit(1)

/** Checks a detection write: its destinations exist and its name is free among alert rules. */
const claimRuleWrite = Effect.fnUntraced(function* (
	db: MapleDb,
	orgId: OrgId,
	ruleId: AlertRuleId,
	rule: AuditDetectionRuleInput,
) {
	if (rule.destinationIds.length > 0) {
		const found = yield* db.run(
			PG.from(AlertDestinations)
				.select("id")
				.where(($) => [$.orgId.eq(orgId), $.id.in_(...rule.destinationIds)]),
		)
		const known = new Set(Arr.map(found, (row) => row.id))
		const missing = Arr.findFirst(rule.destinationIds, (id) => !known.has(id))
		if (Option.isSome(missing)) return yield* invalid(`Unknown alert destination ${missing.value}`)
	}
	// Alert rule names are unique per org, across every kind of rule.
	const sameName = yield* db.run(
		PG.from(AlertRules)
			.select("id")
			.where(($) => [$.orgId.eq(orgId), $.name.eq(rule.name), $.id.neq(ruleId)])
			.limit(1),
	)
	if (sameName.length > 0) {
		return yield* invalid(
			`A detection or alert rule named '${rule.name}' already exists; pick another name`,
		)
	}
})

const sameIds = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
	a.length === b.length && Arr.every(a, (id, index) => id === b[index])

const sameFilters = (a: AuditDetectionFilters, b: AuditDetectionFilters) =>
	a.provider === b.provider && a.category === b.category && a.outcome === b.outcome && a.action === b.action

/** Audit log detections: each one is a hidden `audit` alert rule, written only from here. */
export class AuditDetectionsService extends Context.Service<
	AuditDetectionsService,
	AuditDetectionsServiceApi
>()("@maple/backend/services/audit-trail/AuditDetectionsService", {
	make: Effect.gen(function* () {
		const database = yield* Database
		const dbExecute = makeDbExecute(database, "AuditDetectionsService", makeDetectionPersistenceError)

		const selectOne = Effect.fnUntraced(function* (orgId: OrgId, id: AlertRuleId) {
			const rows = yield* dbExecute((db) => db.run(selectDetection(orgId, id)))
			const row = rows[0]
			if (row === undefined) return yield* notFound(id)
			const detection = auditDetectionFromRow(row)
			if (Option.isNone(detection)) return yield* unreadable()
			return detection.value
		})

		const list = Effect.fn("AuditDetectionsService.list")(function* (orgId: OrgId) {
			yield* Effect.annotateCurrentSpan({ orgId })
			const rows = yield* dbExecute((db) =>
				db.run(
					selectDetections()
						.where(($) => [$.orgId.eq(orgId), $.signalType.eq("audit")])
						.orderBy(["createdAt", "desc"], ["id", "desc"]),
				),
			)
			// A row this build cannot read is left out, so the rest of the list still shows.
			return Arr.getSomes(Arr.map(rows, auditDetectionFromRow))
		})

		const get = Effect.fn("AuditDetectionsService.get")(function* (orgId: OrgId, id: AlertRuleId) {
			yield* Effect.annotateCurrentSpan({ orgId, "maple.alert.rule_id": id })
			return yield* selectOne(orgId, id)
		})

		const create = Effect.fn("AuditDetectionsService.create")(function* (
			orgId: OrgId,
			input: CreateAuditDetectionInput,
		) {
			yield* Effect.annotateCurrentSpan({ orgId })
			const now = yield* Clock.currentTimeMillis
			const id = AlertRuleId.make(randomUUID())
			const rule: AuditDetectionRuleInput = {
				name: input.name,
				enabled: input.enabled ?? true,
				filters: input.filters ?? {},
				windowMinutes: input.windowMinutes,
				threshold: input.threshold,
				severity: input.severity,
				destinationIds: Arr.dedupe(input.destinationIds ?? []),
			}
			yield* dbExecute((db) =>
				db.transaction(
					Effect.gen(function* () {
						yield* lockOrgAlertRules(db, orgId)
						const [existing] = yield* db.run(
							PG.from(AlertRules)
								.select(() => ({ count: PG.count() }))
								.where(($) => [$.orgId.eq(orgId), $.signalType.eq("audit")]),
						)
						if (Number(existing?.count ?? 0) >= MAX_AUDIT_DETECTIONS_PER_ORG) {
							return yield* invalid(
								`An organization can have at most ${MAX_AUDIT_DETECTIONS_PER_ORG} detections`,
							)
						}
						yield* claimRuleWrite(db, orgId, id, rule)
						yield* db.run(
							PG.insertInto(AlertRules).values({
								id,
								orgId,
								...auditDetectionRuleFields(rule),
								// Counts from here: what is already in the log did not happen on its watch.
								auditCountFrom: now,
								lastScheduledAt: null,
								createdAt: now,
								updatedAt: now,
								createdBy: input.createdBy,
								updatedBy: input.createdBy,
							}),
						)
					}),
				),
			)
			return yield* selectOne(orgId, id).pipe(
				Effect.catchTag("@maple/http/errors/AuditDetectionNotFoundError", () =>
					Effect.fail(new AuditTrailPersistenceError({ message: "Created detection not found" })),
				),
			)
		})

		const update = Effect.fn("AuditDetectionsService.update")(function* (
			orgId: OrgId,
			id: AlertRuleId,
			input: UpdateAuditDetectionInput,
		) {
			yield* Effect.annotateCurrentSpan({ orgId, "maple.alert.rule_id": id })
			const now = yield* Clock.currentTimeMillis
			yield* dbExecute((db) =>
				db.transaction(
					Effect.gen(function* () {
						// Lock, then re-read: the rule is rebuilt from a row no other write changes
						// before commit, and a concurrent delete either finished first or waits.
						yield* lockOrgAlertRules(db, orgId)
						const rows = yield* db.run(selectDetection(orgId, id))
						const row = rows[0]
						if (row === undefined) return yield* notFound(id)
						const stored = auditDetectionFromRow(row)
						if (Option.isNone(stored)) return yield* unreadable()
						const locked = stored.value
						const rule: AuditDetectionRuleInput = {
							name: input.name ?? locked.name,
							enabled: input.enabled ?? locked.enabled,
							filters: input.filters ?? locked.filters,
							windowMinutes: input.windowMinutes ?? locked.windowMinutes,
							threshold: input.threshold ?? locked.threshold,
							severity: input.severity ?? locked.severity,
							destinationIds:
								input.destinationIds === undefined
									? locked.destinationIds
									: Arr.dedupe(input.destinationIds),
						}
						// The rule is written only when it changes: alert_rules is synced to browsers.
						const changed =
							rule.name !== locked.name ||
							rule.enabled !== locked.enabled ||
							!sameFilters(rule.filters, locked.filters) ||
							rule.windowMinutes !== locked.windowMinutes ||
							rule.threshold !== locked.threshold ||
							rule.severity !== locked.severity ||
							!sameIds(rule.destinationIds, locked.destinationIds)
						if (!changed) return
						// The floor moves only when the detection starts counting events it did not
						// before. A rename or a new severity keeps the window, and an open incident.
						const countsMore =
							!sameFilters(rule.filters, locked.filters) ||
							rule.windowMinutes > locked.windowMinutes ||
							(rule.enabled && !locked.enabled)
						yield* claimRuleWrite(db, orgId, id, rule)
						// Ends a tick's claim on the old config, as a rule edit does.
						yield* db.run(PG.deleteFrom(AlertRuleClaims).where(($) => [$.ruleId.eq(id)]))
						yield* db.run(
							PG.update(AlertRules)
								.set({
									...auditDetectionRuleFields(rule),
									...(countsMore ? { auditCountFrom: now } : undefined),
									updatedAt: now,
									updatedBy: input.updatedBy,
								})
								.where(($) => [$.orgId.eq(orgId), $.id.eq(id)]),
						)
					}),
				),
			)
			return yield* selectOne(orgId, id)
		})

		const remove = Effect.fn("AuditDetectionsService.remove")(function* (orgId: OrgId, id: AlertRuleId) {
			yield* Effect.annotateCurrentSpan({ orgId, "maple.alert.rule_id": id })
			yield* dbExecute((db) =>
				db.transaction(
					Effect.gen(function* () {
						yield* lockOrgAlertRules(db, orgId)
						// Only a detection's rule: another kind of rule is deleted through its owner.
						const rows = yield* db.run(
							PG.from(AlertRules)
								.select("id")
								.where(($) => [$.orgId.eq(orgId), $.id.eq(id), $.signalType.eq("audit")])
								.limit(1),
						)
						if (rows.length === 0) return yield* notFound(id)
						// The rule delete's own cascade: state, deliveries and incidents go with it.
						yield* deleteRuleRows(db, orgId, id)
					}),
				),
			)
			return id
		})

		return { list, get, create, update, remove } satisfies AuditDetectionsServiceApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
}
