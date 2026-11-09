/**
 * Escalation runs: one incident's walk through a chain. The alert scheduler starts a run in the
 * transaction that opens or escalates an incident, and advances due runs between evaluation and
 * the delivery drain, so a due step is sent in the same tick. Each step is a compare-and-set on the
 * run's position committed with the step's delivery rows: at most one writer sends a given step.
 */
import {
	ESCALATION_SILENCE_RECHECK_MS,
	ONCALL_LOOKAROUND_MS,
	makeAlertDeliveryKey,
	onCallAt,
	planEscalationAdvance,
	type EscalationAdvancePlan,
} from "@maple/alerting-core"
import type {
	AlertDestinationId,
	AlertIncidentId,
	AlertSeverity,
	EscalationChainId,
	EscalationStep,
	EscalationSteps,
	OnCallScheduleId,
	OrgId,
} from "@maple/domain/http"
import type { AlertEscalationRunId, ChatConnectorId, ChatIdentityId, UserId } from "@maple/domain/primitives"
import * as PG from "@maple-dev/effect-orm/postgres"
import {
	AlertDeliveryEvents,
	AlertDestinations,
	AlertEscalationRuns,
	AlertIncidents,
	AlertMemberNotifications,
	ChatIdentities,
	ChatWorkspaces,
	EscalationChains,
	OnCallOverrides,
	OnCallSchedules,
} from "@maple/db/tables"
import type { MapleDb } from "@maple/db/client"
import { Array as Arr, DateTime, Effect, Option } from "effect"
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
	/** Start past step 1, which a flap-suppressed re-open's predecessor already paged. */
	readonly firstStepSent?: boolean
}

/**
 * Starts `chain` for an incident, superseding the run already live on it. The first step is due
 * now, and its delivery key matches the incident's own trigger, so a destination both in the tier
 * and in step 1 is notified once.
 */
export const startEscalationRun = (db: MapleDb, input: StartEscalationRunInput) =>
	Effect.gen(function* () {
		const position = startPosition(input)
		yield* db.run(
			PG.update(AlertEscalationRuns)
				.set({ status: "superseded", endedAt: input.nowMs, updatedAt: input.nowMs })
				.where(($) => [
					$.orgId.eq(input.orgId),
					$.incidentId.eq(input.incidentId),
					$.status.in_(...LIVE_STATUSES),
				]),
		)
		if (position === null) return
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
				stepIndex: position.stepIndex,
				passIndex: position.passIndex,
				nextStepAt: position.nextStepAt,
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

/** Where a new run starts: step 1 now, or the step after it; null when step 1 was the whole chain. */
const startPosition = (input: StartEscalationRunInput) => {
	const first = { stepIndex: 0, passIndex: 0, nextStepAt: input.nowMs }
	if (input.firstStepSent !== true) return first
	const plan = planEscalationAdvance(
		{ status: "active", steps: input.chain.steps, repeatCount: input.chain.repeatCount, ...first },
		{ open: true, acknowledged: false, silenced: false },
		input.nowMs,
	)
	return plan.kind === "send" && plan.next.kind === "step" ? plan.next : null
}

/** Stops the incident's runs started by a tier above `severity`, on a de-escalation. */
export const endEscalationRunsAbove = (
	db: MapleDb,
	input: {
		readonly orgId: OrgId
		readonly incidentId: AlertIncidentId
		readonly severity: AlertSeverity
		readonly nowMs: number
	},
) =>
	// Two tiers: only a warning incident has a tier above it.
	input.severity !== "warning"
		? Effect.void
		: db
				.run(
					PG.update(AlertEscalationRuns)
						.set({ status: "superseded", endedAt: input.nowMs, updatedAt: input.nowMs })
						.where(($) => [
							$.orgId.eq(input.orgId),
							$.incidentId.eq(input.incidentId),
							$.status.in_(...LIVE_STATUSES),
							$.severity.eq("critical"),
						]),
				)
				.pipe(Effect.asVoid)

/** The running chain's next steps carry the incident's new trigger (its severity), on an escalation. */
export const refreshEscalationRunPayload = (
	db: MapleDb,
	input: {
		readonly orgId: OrgId
		readonly incidentId: AlertIncidentId
		readonly payload: Record<string, unknown>
		readonly nowMs: number
	},
) =>
	db.run(
		PG.update(AlertEscalationRuns)
			.set({ payloadJson: input.payload, updatedAt: input.nowMs })
			.where(($) => [
				$.orgId.eq(input.orgId),
				$.incidentId.eq(input.incidentId),
				$.status.in_(...LIVE_STATUSES),
			]),
	)

/**
 * When a silence ends, the page it held back goes out at `atMs`. A step a silence deferred (due by
 * the next look) is keyed to that page, so a destination in both the tier and the step is paged once.
 */
export const alignDueEscalationStep = (
	db: MapleDb,
	input: { readonly orgId: OrgId; readonly incidentId: AlertIncidentId; readonly atMs: number },
) =>
	db
		.run(
			PG.update(AlertEscalationRuns)
				.set({ nextStepAt: input.atMs, updatedAt: input.atMs })
				.where(($) => [
					$.orgId.eq(input.orgId),
					$.incidentId.eq(input.incidentId),
					$.status.eq("active"),
					$.nextStepAt.lte(input.atMs + ESCALATION_SILENCE_RECHECK_MS),
				]),
		)
		.pipe(Effect.asVoid)

/**
 * Live runs with something to decide: an active run that is due or whose incident closed, and a
 * paused run whose ack is gone or whose incident closed. A run paused on a standing ack is not
 * read, so long acknowledged incidents cannot crowd out due ones. Across orgs: the scheduler is
 * the system actor.
 */
export const selectEscalationWork = (db: MapleDb, nowMs: number, limit = ESCALATION_RUNS_PER_TICK) =>
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
				labelsJson: $.i.labelsJson,
				severity: $.i.severity,
				incidentStatus: $.i.status,
				acknowledgedAt: $.i.acknowledgedAt,
			}))
			.where(($) => [
				$.status.in_(...LIVE_STATUSES),
				PG.or(
					$.i.status.neq("open"),
					$.status.eq("active").and($.nextStepAt.lte(nowMs)),
					$.status.eq("acknowledged").and($.i.acknowledgedAt.isNull()),
				),
			])
			.orderBy(["nextStepAt", "asc"])
			.limit(limit),
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

/** One channel a person is paged on: email, or a direct message to a linked chat account. */
export type MemberRecipient =
	| { readonly userId: UserId; readonly channel: "email" }
	| {
			readonly userId: UserId
			readonly channel: ChatConnectorId
			/** The `chat_identities` row; the workspace is chosen at delivery. */
			readonly identityId: ChatIdentityId
			readonly externalUserId: string
	  }

/** A step's destination targets. */
export const stepDestinationIds = (step: EscalationStep): ReadonlyArray<AlertDestinationId> =>
	Arr.dedupe(
		Arr.flatMap(step.targets, (target) => (target.type === "destination" ? [target.destinationId] : [])),
	)

export interface StepRecipients {
	readonly recipients: ReadonlyArray<MemberRecipient>
	/** Users paged, deduped across targets. */
	readonly userIds: ReadonlyArray<UserId>
	/** Schedule targets with nobody on call at `nowMs` (or deleted since). */
	readonly gapScheduleIds: ReadonlyArray<OnCallScheduleId>
	/** Each schedule target's on-call user at `nowMs`. */
	readonly onCall: ReadonlyArray<{ readonly scheduleId: OnCallScheduleId; readonly userId: UserId }>
	/** Resolved users dropped because they are no longer org members. */
	readonly missingUserIds: ReadonlyArray<UserId>
}

/**
 * Who a step pages at `nowMs`: its user targets, plus whoever each schedule target has on call.
 * Each person gets an email row and one row per chat account they linked in the org, on a
 * connector in `directMessageConnectors` with a workspace linked in the org.
 */
export const loadStepRecipients = (
	db: MapleDb,
	orgId: OrgId,
	step: EscalationStep,
	nowMs: number,
	directMessageConnectors: ReadonlySet<ChatConnectorId>,
) =>
	Effect.gen(function* () {
		const directUserIds = Arr.flatMap(step.targets, (target) =>
			target.type === "user" ? [target.userId] : [],
		)
		const scheduleIds = Arr.dedupe(
			Arr.flatMap(step.targets, (target) => (target.type === "schedule" ? [target.scheduleId] : [])),
		)
		const [schedules, overrides] = yield* Effect.all([
			scheduleIds.length === 0
				? Effect.succeed([])
				: db.run(
						PG.from(OnCallSchedules)
							.select("id", "timeZone", "layersJson")
							.where(($) => [$.orgId.eq(orgId), $.id.in_(...scheduleIds)]),
					),
			scheduleIds.length === 0
				? Effect.succeed([])
				: db.run(
						PG.from(OnCallOverrides)
							.select("id", "scheduleId", "userId", "startsAt", "endsAt", "createdAt")
							.where(($) => [
								$.orgId.eq(orgId),
								$.scheduleId.in_(...scheduleIds),
								$.endsAt.gt(nowMs - ONCALL_LOOKAROUND_MS),
								$.startsAt.lt(nowMs + ONCALL_LOOKAROUND_MS),
							]),
					),
		])
		const shifts = Arr.map(scheduleIds, (scheduleId) => {
			const schedule = Arr.findFirst(schedules, (row) => row.id === scheduleId)
			if (Option.isNone(schedule)) return { scheduleId, userId: null }
			const shift = onCallAt(
				{ timeZone: schedule.value.timeZone, layers: schedule.value.layersJson },
				Arr.filter(overrides, (override) => override.scheduleId === scheduleId),
				nowMs,
			)
			return { scheduleId, userId: shift === null ? null : shift.userId }
		})
		const onCall = Arr.flatMap(shifts, ({ scheduleId, userId }) =>
			userId === null ? [] : [{ scheduleId, userId }],
		)
		const userIds = Arr.dedupe([...directUserIds, ...Arr.map(onCall, (entry) => entry.userId)])
		const gapScheduleIds = Arr.flatMap(shifts, (entry) =>
			entry.userId === null ? [entry.scheduleId] : [],
		)
		const base = { userIds, gapScheduleIds, onCall, missingUserIds: [] }
		if (userIds.length === 0) return { ...base, recipients: [] } satisfies StepRecipients
		const [identities, workspaces] = yield* Effect.all([
			db.run(
				PG.from(ChatIdentities)
					.select("id", "userId", "connector", "externalUserId", "createdAt")
					.where(($) => [$.orgId.eq(orgId), $.userId.in_(...userIds)])
					.orderBy(["createdAt", "asc"], ["id", "asc"]),
			),
			db.run(
				PG.from(ChatWorkspaces)
					.select("connector")
					.where(($) => [$.orgId.eq(orgId)]),
			),
		])
		const linked = new Set(Arr.map(workspaces, (row) => row.connector))
		// A connector that cannot open a DM, or with no workspace to send through, pages nobody.
		const chatRecipients = Arr.flatMap(identities, (identity): ReadonlyArray<MemberRecipient> =>
			directMessageConnectors.has(identity.connector) && linked.has(identity.connector)
				? [
						{
							userId: identity.userId,
							channel: identity.connector,
							identityId: identity.id,
							externalUserId: identity.externalUserId,
						},
					]
				: [],
		)
		const recipients = Arr.flatMap(userIds, (userId): ReadonlyArray<MemberRecipient> => [
			{ userId, channel: "email" },
			...Arr.filter(chatRecipients, (recipient) => recipient.userId === userId),
		])
		return { ...base, recipients } satisfies StepRecipients
	})

/**
 * Drops users the member directory no longer lists; a schedule whose on-call person left counts
 * as a gap. `members` null (no directory, or it could not be read) keeps everyone.
 */
export const withoutDepartedMembers = (
	paged: StepRecipients,
	members: ReadonlySet<string> | null,
): StepRecipients => {
	if (members === null) return paged
	const isMember = (userId: UserId) => members.has(userId)
	const departed = Arr.filter(paged.userIds, (userId) => !isMember(userId))
	if (departed.length === 0) return paged
	return {
		recipients: Arr.filter(paged.recipients, (recipient) => isMember(recipient.userId)),
		userIds: Arr.filter(paged.userIds, isMember),
		gapScheduleIds: [
			...paged.gapScheduleIds,
			...Arr.flatMap(paged.onCall, (entry) => (isMember(entry.userId) ? [] : [entry.scheduleId])),
		],
		onCall: Arr.filter(paged.onCall, (entry) => isMember(entry.userId)),
		missingUserIds: departed,
	}
}

/** One row per person, channel and step; a chat row is also keyed by its identity. */
export const memberNotificationDedupeKey = (
	runId: AlertEscalationRunId,
	pass: number,
	step: number,
	recipient: MemberRecipient,
) =>
	"identityId" in recipient
		? `${runId}:${pass}:${step}:${recipient.userId}:${recipient.channel}:${recipient.identityId}`
		: `${runId}:${pass}:${step}:${recipient.userId}:email`

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
	/** The people the step pages, one entry per channel; only needed for a `send`. */
	readonly recipients?: ReadonlyArray<MemberRecipient>
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
				// Locks the incident so a resolve or ack serializes with this step: once either has
				// committed, the step is not sent and the next tick ends or pauses the run.
				const firing = yield* db.run(
					PG.from(AlertIncidents)
						.select("id")
						.where(($) => [
							$.id.eq(row.incidentId),
							$.orgId.eq(row.orgId),
							$.status.eq("open"),
							$.acknowledgedAt.isNull(),
						])
						.forUpdate(),
				)
				if (firing.length === 0) return "lost" satisfies EscalationApplyOutcome
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
				const enabledIds = Arr.filter(stepDestinationIds(plan.step), (id) => input.enabled.has(id))
				// A silence's catch-up at this step's due time may have gone out as a renotify, which the
				// step's trigger key would not dedupe against; those destinations are already paged.
				const renotified =
					enabledIds.length === 0
						? []
						: yield* db.run(
								PG.from(AlertDeliveryEvents)
									.select("destinationId")
									.where(($) => [
										$.orgId.eq(row.orgId),
										$.incidentId.eq(row.incidentId),
										$.deliveryKey.in_(
											...Arr.map(enabledIds, (destinationId) =>
												makeAlertDeliveryKey(
													row.incidentId,
													destinationId,
													"renotify",
													row.nextStepAt,
												),
											),
										),
									]),
							)
				const destinationIds = Arr.filter(
					enabledIds,
					(id) => !Arr.some(renotified, (delivery) => delivery.destinationId === id),
				)
				const recipients = input.recipients ?? []
				if (enabledIds.length === 0 && recipients.length === 0) {
					yield* Effect.logWarning(
						"Escalation step has no enabled destination or person to page; nobody was notified",
					).pipe(
						Effect.annotateLogs({
							runId: row.id,
							incidentId: row.incidentId,
							step: plan.stepIndex + 1,
						}),
					)
				}
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
				// Committed with the position, so a lost compare-and-set queues no page either.
				yield* Effect.forEach(
					recipients,
					(recipient) =>
						db.run(
							PG.insertInto(AlertMemberNotifications)
								.values({
									id: input.makeDeliveryId(),
									orgId: row.orgId,
									incidentId: row.incidentId,
									runId: row.id,
									userId: recipient.userId,
									channel: recipient.channel,
									status: "queued",
									// Attempts started: each claim counts one before it sends.
									attemptNumber: 0,
									scheduledAt: nowMs,
									claimedAt: null,
									claimExpiresAt: null,
									payloadJson: { ...payload, recipient },
									dedupeKey: memberNotificationDedupeKey(
										row.id,
										plan.passIndex + 1,
										plan.stepIndex + 1,
										recipient,
									),
									errorMessage: null,
									attemptedAt: null,
									createdAt: nowMs,
									updatedAt: nowMs,
								})
								.onConflictDoNothing(),
						),
					{ discard: true },
				)
				return "sent" satisfies EscalationApplyOutcome
			}
		}
	})
