/**
 * Escalation runs: one incident's walk through a chain. The alert scheduler starts a run in the
 * transaction that opens or escalates an incident, and advances due runs between evaluation and
 * the delivery drain, so a due step is sent in the same tick. Each step is a compare-and-set on the
 * run's position committed with the step's delivery rows: at most one writer sends a given step.
 */
import { makeAlertDeliveryKey, planEscalationAdvance, type EscalationAdvancePlan } from "@maple/alerting-core"
import type {
	AlertDestinationId,
	AlertIncidentId,
	AlertSeverity,
	EscalationChainId,
	EscalationSteps,
	OrgId,
} from "@maple/domain/http"
import type { AlertEscalationRunId } from "@maple/domain/primitives"
import * as PG from "@maple-dev/effect-orm/postgres"
import {
	AlertDeliveryEvents,
	AlertDestinations,
	AlertEscalationRuns,
	AlertIncidents,
	EscalationChains,
} from "@maple/db/tables"
import type { MapleDb } from "@maple/db/client"
import { Array as Arr, DateTime, Effect } from "effect"
import { queuedDeliveryEventRow } from "./alert-delivery-rows"

const LIVE_STATUSES = ["active", "acknowledged"] as const

/** Runs one scheduler tick looks at; the rest wait a minute, oldest due first. */
export const ESCALATION_RUNS_PER_TICK = 200

export interface EscalationChainSnapshot {
	readonly id: EscalationChainId
	readonly name: string
	readonly steps: EscalationSteps
	readonly repeatCount: number
}

/** The chain an org's tier names, or null when it was deleted since the rule was saved. */
export const loadEscalationChain = (db: MapleDb, orgId: OrgId, chainId: EscalationChainId) =>
	db
		.run(
			PG.from(EscalationChains)
				.select("id", "name", "stepsJson", "repeatCount")
				.where(($) => [$.orgId.eq(orgId), $.id.eq(chainId)])
				.limit(1),
		)
		.pipe(
			Effect.map((rows) =>
				Arr.match(rows, {
					onEmpty: (): EscalationChainSnapshot | null => null,
					onNonEmpty: ([row]) => ({
						id: row.id,
						name: row.name,
						steps: row.stepsJson,
						repeatCount: row.repeatCount,
					}),
				}),
			),
		)

export interface StartEscalationRunInput {
	readonly id: AlertEscalationRunId
	readonly orgId: OrgId
	readonly incidentId: AlertIncidentId
	readonly chain: EscalationChainSnapshot
	readonly severity: AlertSeverity
	/** The incident's trigger notification; each step resends it to the step's targets. */
	readonly payload: Record<string, unknown>
	readonly nowMs: number
}

/**
 * Starts `chain` for an incident, superseding the run already live on it. The first step is due
 * now, and its delivery key matches the incident's own trigger, so a destination both in the tier
 * and in step 1 is notified once.
 */
export const startEscalationRun = (db: MapleDb, input: StartEscalationRunInput) =>
	Effect.gen(function* () {
		yield* db.run(
			PG.update(AlertEscalationRuns)
				.set({ status: "superseded", endedAt: input.nowMs, updatedAt: input.nowMs })
				.where(($) => [
					$.orgId.eq(input.orgId),
					$.incidentId.eq(input.incidentId),
					$.status.in_(...LIVE_STATUSES),
				]),
		)
		yield* db.run(
			PG.insertInto(AlertEscalationRuns).values({
				id: input.id,
				orgId: input.orgId,
				incidentId: input.incidentId,
				chainId: input.chain.id,
				chainName: input.chain.name,
				severity: input.severity,
				stepsJson: input.chain.steps,
				repeatCount: input.chain.repeatCount,
				stepIndex: 0,
				passIndex: 0,
				nextStepAt: input.nowMs,
				status: "active",
				payloadJson: input.payload,
				stepsSent: 0,
				lastStepAt: null,
				endedAt: null,
				createdAt: input.nowMs,
				updatedAt: input.nowMs,
			}),
		)
	})

/**
 * Live runs with something to decide: due, paused on an ack that may be gone, or on an incident
 * that is no longer open. Across orgs: the scheduler is the system actor.
 */
export const selectEscalationWork = (db: MapleDb, nowMs: number) =>
	db.run(
		PG.from(AlertEscalationRuns, "r")
			.innerJoin(AlertIncidents, "i", (r, i) => r.incidentId.eq(i.id).and(r.orgId.eq(i.orgId)))
			.select(($) => ({
				id: $.id,
				orgId: $.orgId,
				incidentId: $.incidentId,
				chainId: $.chainId,
				chainName: $.chainName,
				status: $.status,
				stepsJson: $.stepsJson,
				repeatCount: $.repeatCount,
				stepIndex: $.stepIndex,
				passIndex: $.passIndex,
				nextStepAt: $.nextStepAt,
				payloadJson: $.payloadJson,
				stepsSent: $.stepsSent,
				ruleId: $.i.ruleId,
				groupKey: $.i.groupKey,
				severity: $.i.severity,
				incidentStatus: $.i.status,
				acknowledgedAt: $.i.acknowledgedAt,
			}))
			.where(($) => [
				$.status.in_(...LIVE_STATUSES),
				PG.or($.nextStepAt.lte(nowMs), $.status.eq("acknowledged"), $.i.status.neq("open")),
			])
			.orderBy(["nextStepAt", "asc"])
			.limit(ESCALATION_RUNS_PER_TICK),
	)

export type EscalationWorkRow = Effect.Success<ReturnType<typeof selectEscalationWork>>[number]

export const planEscalationWork = (row: EscalationWorkRow, silenced: boolean, nowMs: number) =>
	planEscalationAdvance(
		{
			status: row.status,
			steps: row.stepsJson,
			repeatCount: row.repeatCount,
			stepIndex: row.stepIndex,
			passIndex: row.passIndex,
			nextStepAt: row.nextStepAt,
		},
		{ open: row.incidentStatus === "open", acknowledged: row.acknowledgedAt !== null, silenced },
		nowMs,
	)

/** The enabled destinations among `ids` in `orgId`; a deleted or disabled one is skipped. */
export const enabledDestinationIds = (db: MapleDb, orgId: OrgId, ids: ReadonlyArray<AlertDestinationId>) =>
	ids.length === 0
		? Effect.succeed(new Set<AlertDestinationId>())
		: db
				.run(
					PG.from(AlertDestinations)
						.select("id")
						.where(($) => [$.orgId.eq(orgId), $.id.in_(...ids), $.enabled.eq(true)]),
				)
				.pipe(Effect.map((rows) => new Set(Arr.map(rows, (row) => row.id))))

export type EscalationApplyOutcome = "sent" | "ended" | "paused" | "resumed" | "deferred" | "lost" | "idle"

type RunUpdate = Partial<Omit<EscalationRunInsert, "id" | "orgId" | "incidentId" | "createdAt">>
type EscalationRunInsert = PG.InsertRowOf<typeof AlertEscalationRuns>

/** Moves the run only from the position it was read at, so of two concurrent writers one wins. */
const atPosition = (row: EscalationWorkRow, set: RunUpdate) =>
	PG.update(AlertEscalationRuns)
		.set(set)
		.where(($) => [
			$.id.eq(row.id),
			$.status.eq(row.status),
			$.stepIndex.eq(row.stepIndex),
			$.passIndex.eq(row.passIndex),
			$.nextStepAt.eq(row.nextStepAt),
		])
		.returning("id")

export interface ApplyEscalationPlanInput {
	readonly row: EscalationWorkRow
	readonly plan: EscalationAdvancePlan
	readonly nowMs: number
	/** Of the step's destinations, those enabled; only needed for a `send`. */
	readonly enabled: ReadonlySet<AlertDestinationId>
	readonly makeDeliveryId: () => string
}

/** Applies one plan; run inside a transaction so a step's position and deliveries commit together. */
export const applyEscalationPlan = (db: MapleDb, input: ApplyEscalationPlanInput) =>
	Effect.gen(function* () {
		const { row, plan, nowMs } = input
		const write = (set: RunUpdate) =>
			db.run(atPosition(row, { ...set, updatedAt: nowMs })).pipe(Effect.map((rows) => rows.length > 0))
		switch (plan.kind) {
			case "wait":
				return "idle" satisfies EscalationApplyOutcome
			case "end":
				return (yield* write({ status: plan.status, endedAt: nowMs })) ? "ended" : "lost"
			case "pause":
				return (yield* write({ status: "acknowledged" })) ? "paused" : "lost"
			case "resume":
				return (yield* write({ status: "active" })) ? "resumed" : "lost"
			case "defer":
				return (yield* write({ status: "active", nextStepAt: plan.nextStepAt })) ? "deferred" : "lost"
			case "send": {
				const moved = yield* write(
					plan.next.kind === "exhausted"
						? {
								status: "exhausted",
								endedAt: nowMs,
								stepsSent: row.stepsSent + 1,
								lastStepAt: nowMs,
							}
						: {
								status: "active",
								stepIndex: plan.next.stepIndex,
								passIndex: plan.next.passIndex,
								nextStepAt: plan.next.nextStepAt,
								stepsSent: row.stepsSent + 1,
								lastStepAt: nowMs,
							},
				)
				if (!moved) return "lost" satisfies EscalationApplyOutcome
				const payload = {
					...row.payloadJson,
					sentAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
					escalation: {
						chainId: row.chainId,
						chainName: row.chainName,
						step: plan.stepIndex + 1,
						stepCount: row.stepsJson.length,
						pass: plan.passIndex + 1,
						passCount: row.repeatCount + 1,
					},
				}
				const destinationIds = Arr.dedupe(
					Arr.filter(
						Arr.map(plan.step.targets, (target) => target.destinationId),
						(id) => input.enabled.has(id),
					),
				)
				yield* Effect.forEach(
					destinationIds,
					(destinationId) =>
						db.run(
							PG.insertInto(AlertDeliveryEvents)
								.values(
									queuedDeliveryEventRow({
										id: input.makeDeliveryId(),
										orgId: row.orgId,
										incidentId: row.incidentId,
										ruleId: row.ruleId,
										destinationId,
										eventType: "trigger",
										payload,
										scheduledAt: nowMs,
										// Keyed by the step's due time: the step a tier trigger shares a
										// destination with dedupes against it, and no two steps share one.
										deliveryKey: makeAlertDeliveryKey(
											row.incidentId,
											destinationId,
											"trigger",
											row.nextStepAt,
										),
										attemptNumber: 1,
									}),
								)
								.onConflictDoNothing(),
						),
					{ discard: true },
				)
				return "sent" satisfies EscalationApplyOutcome
			}
		}
	})
