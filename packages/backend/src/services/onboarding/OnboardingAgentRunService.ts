import { randomUUID } from "node:crypto"
import * as PG from "@maple-dev/effect-orm/postgres"
import { OnboardingAgentRuns, type OnboardingAgentRunRow } from "@maple/db/tables"
import {
	ONBOARDING_AGENT_RUN_TTL_MS,
	ONBOARDING_AGENT_SERVICES_MAX,
	OnboardingAgentRunClosedError,
	OnboardingAgentRunNotFoundError,
	OnboardingAgentRunUnavailableError,
	emptyOnboardingAgentStages,
	type OnboardingAgentReportedStatus,
	type OnboardingAgentRunStatus,
	type OnboardingAgentStage,
} from "@maple/domain/onboarding-agent-run"
import type { OrgId, UserId } from "@maple/primitives"
import { Array as Arr, Clock, Context, Effect, Layer, Option, String as Str } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute } from "@maple/backend/platform/db-execute"

export interface OnboardingAgentReport {
	readonly stage: OnboardingAgentStage
	readonly status: OnboardingAgentReportedStatus
	readonly note?: string | undefined
	readonly serviceNames?: ReadonlyArray<string> | undefined
	readonly traceId?: string | undefined
	readonly runStatus?: "completed" | "failed" | undefined
}

interface Owner {
	readonly orgId: OrgId
	readonly userId: UserId
}

const OPEN: ReadonlySet<OnboardingAgentRunStatus> = new Set(["waiting_for_agent", "in_progress"])

/** An open run past its lifetime reads as `expired`; the row is never rewritten for it. */
export const effectiveRunStatus = (row: OnboardingAgentRunRow, now: number): OnboardingAgentRunStatus =>
	OPEN.has(row.status) && row.expiresAt <= now ? "expired" : row.status

const cleanNote = (note: string | undefined): string | null => {
	const trimmed = Str.trim(Str.replace(/\s+/g, " ")(note ?? ""))
	return trimmed === "" ? null : trimmed
}

export class OnboardingAgentRunService extends Context.Service<
	OnboardingAgentRunService,
	{
		readonly start: (
			owner: Owner,
		) => Effect.Effect<OnboardingAgentRunRow, OnboardingAgentRunUnavailableError>
		readonly current: (
			owner: Owner,
		) => Effect.Effect<
			OnboardingAgentRunRow,
			OnboardingAgentRunNotFoundError | OnboardingAgentRunUnavailableError
		>
		readonly report: (
			owner: Owner,
			report: OnboardingAgentReport,
		) => Effect.Effect<
			OnboardingAgentRunRow,
			| OnboardingAgentRunNotFoundError
			| OnboardingAgentRunClosedError
			| OnboardingAgentRunUnavailableError
		>
	}
>()("@maple/backend/services/OnboardingAgentRunService", {
	make: Effect.gen(function* () {
		const database = yield* Database
		const dbExecute = makeDbExecute(
			database,
			"OnboardingAgentRunService",
			(error) =>
				new OnboardingAgentRunUnavailableError({
					message: "Onboarding runs are temporarily unavailable",
					operation: "database",
					cause: error,
				}),
		)

		const start = Effect.fn("OnboardingAgentRunService.start")(function* (owner: Owner) {
			const now = yield* Clock.currentTimeMillis
			const rows = yield* dbExecute((db) =>
				db.run(
					PG.insertInto(OnboardingAgentRuns)
						.values({
							id: randomUUID(),
							orgId: owner.orgId,
							userId: owner.userId,
							status: "waiting_for_agent",
							stages: [...emptyOnboardingAgentStages()],
							serviceNames: [],
							traceId: null,
							lastReportedAt: null,
							createdAt: now,
							expiresAt: now + ONBOARDING_AGENT_RUN_TTL_MS,
							updatedAt: now,
						})
						.returning(),
				),
			)
			const row = rows[0]
			if (row === undefined) {
				return yield* new OnboardingAgentRunUnavailableError({
					message: "The onboarding run was not saved",
					operation: "start",
					cause: null,
				})
			}
			return row
		})

		const latest = Effect.fn("OnboardingAgentRunService.latest")(function* (owner: Owner) {
			const rows = yield* dbExecute((db) =>
				db.run(
					PG.from(OnboardingAgentRuns)
						.select()
						.where(($) => [$.orgId.eq(owner.orgId), $.userId.eq(owner.userId)])
						.orderBy(($) => [[$.createdAt, "desc"]])
						.limit(1),
				),
			)
			const row = Option.fromNullishOr(rows[0])
			if (Option.isNone(row)) {
				return yield* new OnboardingAgentRunNotFoundError({
					message: "No onboarding run for this person",
				})
			}
			return row.value
		})

		const current = Effect.fn("OnboardingAgentRunService.current")(function* (owner: Owner) {
			const row = yield* latest(owner)
			const now = yield* Clock.currentTimeMillis
			return { ...row, status: effectiveRunStatus(row, now) }
		})

		const report = Effect.fn("OnboardingAgentRunService.report")(function* (
			owner: Owner,
			input: OnboardingAgentReport,
		) {
			const row = yield* latest(owner)
			const now = yield* Clock.currentTimeMillis
			const status = effectiveRunStatus(row, now)
			if (!OPEN.has(status)) {
				return yield* new OnboardingAgentRunClosedError({
					message: `The onboarding run is ${status}`,
					status,
				})
			}
			const stages = Arr.map(row.stages, (record) =>
				record.stage === input.stage
					? {
							stage: record.stage,
							status: input.status,
							note: cleanNote(input.note),
							updatedAt: now,
						}
					: record,
			)
			const serviceNames = Arr.take(
				Arr.dedupe([...row.serviceNames, ...(input.serviceNames ?? [])]),
				ONBOARDING_AGENT_SERVICES_MAX,
			)
			const updated = yield* dbExecute((db) =>
				db.run(
					PG.update(OnboardingAgentRuns)
						.set({
							status: input.runStatus ?? "in_progress",
							stages,
							serviceNames,
							traceId: input.traceId ?? row.traceId,
							lastReportedAt: now,
							updatedAt: now,
						})
						.where(($) => [$.orgId.eq(owner.orgId), $.id.eq(row.id)])
						.returning(),
				),
			)
			return updated[0] ?? row
		})

		return { start, current, report }
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
}
