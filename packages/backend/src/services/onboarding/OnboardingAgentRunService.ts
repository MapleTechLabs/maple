import { randomUUID } from "node:crypto"
import * as Orm from "@maple-dev/effect-orm/database"
import * as PG from "@maple-dev/effect-orm/postgres"
import { OnboardingAgentRuns, type OnboardingAgentRunRow } from "@maple/db/tables"
import {
	ONBOARDING_AGENT_RUN_TTL_MS,
	ONBOARDING_HANDOFF_TTL_MS,
	ONBOARDING_AGENT_SERVICES_MAX,
	OnboardingAgentRunClosedError,
	OnboardingAgentRunNotFoundError,
	OnboardingAgentRunUnavailableError,
	emptyOnboardingAgentStages,
	type OnboardingAgentReportedStatus,
	type OnboardingAgentRunStatus,
	type OnboardingAgentStage,
} from "@maple/domain/onboarding-agent-run"
import type { ApiKeyId, OrgId, UserId } from "@maple/primitives"
import { Array as Arr, Clock, Context, Effect, Layer, Option, Schedule, Schema, String as Str } from "effect"
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

/**
 * Who reads or reports. With `apiKeyId` (the caller authenticated with an API key) only the run
 * that key's handoff minted is reachable: another key the person made, or a replaced agent's key,
 * never reaches their newest run. Without it (the person's session, their MCP grant) the newest run.
 */
export interface OnboardingAgentRunCaller extends Owner {
	readonly apiKeyId?: ApiKeyId | undefined
}

const OPEN_STATUSES = [
	"waiting_for_agent",
	"in_progress",
] as const satisfies ReadonlyArray<OnboardingAgentRunStatus>
const OPEN: ReadonlySet<OnboardingAgentRunStatus> = new Set(OPEN_STATUSES)

/**
 * An open run reads as `expired` past its lifetime, or once its handoff code lapsed with no
 * report; the row is never rewritten for it.
 */
export const effectiveRunStatus = (row: OnboardingAgentRunRow, now: number): OnboardingAgentRunStatus => {
	if (!OPEN.has(row.status)) return row.status
	// Unclaimed: no agent signed in with the code (no key bound) and none reported before it lapsed.
	const unclaimed =
		row.status === "waiting_for_agent" &&
		row.apiKeyId === null &&
		row.createdAt + ONBOARDING_HANDOFF_TTL_MS <= now
	return unclaimed || row.expiresAt <= now ? "expired" : row.status
}

// Control and format characters (bidi overrides, zero-width) go: the note is shown to the person.
const cleanNote = (note: string | undefined): string | null => {
	// Whitespace (newlines included) becomes one space first, so "a\nb" stays two words.
	const spaced = Str.replace(/\s+/g, " ")(note ?? "")
	const trimmed = Str.trim(Str.replace(/[\p{Cc}\p{Cf}]/gu, "")(spaced))
	return trimmed === "" ? null : trimmed
}

/** Another report changed the run between the read and the write. Internal: retried, never surfaced. */
class ReportConflict extends Schema.TaggedError<ReportConflict>()(
	"@maple/backend/OnboardingAgentRunReportConflict",
	{
		message: Schema.String,
	},
) {}

export class OnboardingAgentRunService extends Context.Service<
	OnboardingAgentRunService,
	{
		readonly start: (
			owner: Owner,
			handoffCodeHash: string,
		) => Effect.Effect<OnboardingAgentRunRow, OnboardingAgentRunUnavailableError>
		readonly current: (
			caller: OnboardingAgentRunCaller,
		) => Effect.Effect<
			OnboardingAgentRunRow,
			OnboardingAgentRunNotFoundError | OnboardingAgentRunUnavailableError
		>
		readonly report: (
			caller: OnboardingAgentRunCaller,
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

		const start = Effect.fn("OnboardingAgentRunService.start")(function* (
			owner: Owner,
			handoffCodeHash: string,
		) {
			// One live run per person: the newest copy of the prompt is the one the page follows.
			// Closing the old run and inserting the new one commit together, one start at a time.
			const rows = yield* dbExecute((db) =>
				db.transaction(
					Effect.gen(function* () {
						yield* db.execute(
							Orm.sql`select pg_advisory_xact_lock(hashtext(${`${owner.orgId}:${owner.userId}`}), hashtext('onboarding_agent_runs'))`,
						)
						const clock = yield* Clock.currentTimeMillis
						const newest = yield* db.run(
							PG.from(OnboardingAgentRuns)
								.select("createdAt")
								.where(($) => [$.orgId.eq(owner.orgId), $.userId.eq(owner.userId)])
								.orderBy(($) => [[$.createdAt, "desc"]])
								.limit(1),
						)
						// Strictly after the newest run, so "the newest run" is never a tie.
						const now = Math.max(clock, (newest[0]?.createdAt ?? 0) + 1)
						yield* db.run(
							PG.deleteFrom(OnboardingAgentRuns).where(($) => [
								$.orgId.eq(owner.orgId),
								$.userId.eq(owner.userId),
								$.expiresAt.lt(clock),
							]),
						)
						yield* Effect.forEach(OPEN_STATUSES, (open) =>
							db.run(
								PG.update(OnboardingAgentRuns)
									.set({ status: "expired", updatedAt: now })
									.where(($) => [
										$.orgId.eq(owner.orgId),
										$.userId.eq(owner.userId),
										$.status.eq(open),
									]),
							),
						)
						return yield* db.run(
							PG.insertInto(OnboardingAgentRuns)
								.values({
									id: randomUUID(),
									orgId: owner.orgId,
									userId: owner.userId,
									status: "waiting_for_agent",
									stages: [...emptyOnboardingAgentStages()],
									serviceNames: [],
									traceId: null,
									handoffCodeHash,
									apiKeyId: null,
									lastReportedAt: null,
									createdAt: now,
									expiresAt: now + ONBOARDING_AGENT_RUN_TTL_MS,
									updatedAt: now,
								})
								.returning(),
						)
					}),
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

		const latest = Effect.fn("OnboardingAgentRunService.latest")(function* (
			caller: OnboardingAgentRunCaller,
		) {
			const apiKeyId = caller.apiKeyId
			const rows = yield* dbExecute((db) =>
				db.run(
					PG.from(OnboardingAgentRuns)
						.select()
						.where(($) => [
							$.orgId.eq(caller.orgId),
							apiKeyId === undefined ? $.userId.eq(caller.userId) : $.apiKeyId.eq(apiKeyId),
						])
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

		const current = Effect.fn("OnboardingAgentRunService.current")(function* (
			caller: OnboardingAgentRunCaller,
		) {
			// The clock first: a claim that commits after it is in the row, so a bound run never reads as lapsed.
			const now = yield* Clock.currentTimeMillis
			const row = yield* latest(caller)
			return { ...row, status: effectiveRunStatus(row, now) }
		})

		const runById = Effect.fn("OnboardingAgentRunService.runById")(function* (orgId: OrgId, id: string) {
			const rows = yield* dbExecute((db) =>
				db.run(
					PG.from(OnboardingAgentRuns)
						.select()
						.where(($) => [$.orgId.eq(orgId), $.id.eq(id)])
						.limit(1),
				),
			)
			const row = Option.fromNullishOr(rows[0])
			if (Option.isNone(row)) {
				return yield* new OnboardingAgentRunNotFoundError({ message: "The onboarding run is gone" })
			}
			return row.value
		})

		const attemptReport = Effect.fn("OnboardingAgentRunService.attemptReport")(function* (
			caller: OnboardingAgentRunCaller,
			runId: string,
			input: OnboardingAgentReport,
		) {
			const now = yield* Clock.currentTimeMillis
			const row = yield* runById(caller.orgId, runId)
			const status = effectiveRunStatus(row, now)
			if (!OPEN.has(status)) {
				return yield* new OnboardingAgentRunClosedError({
					message: `The onboarding run is ${status}`,
					status,
				})
			}
			const stages = Arr.map(row.stages, (record) =>
				// `waiting` never undoes a completed stage (a slow verify timing out after another passed).
				record.stage === input.stage && !(input.status === "waiting" && record.status === "completed")
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
			// Written only over the row as read, so a concurrent report or a close is never overwritten.
			const updated = yield* dbExecute((db) =>
				db.run(
					PG.update(OnboardingAgentRuns)
						.set({
							status: input.runStatus ?? "in_progress",
							stages,
							serviceNames,
							traceId: input.traceId ?? row.traceId,
							lastReportedAt: now,
							updatedAt: Math.max(now, row.updatedAt + 1),
						})
						.where(($) => [
							$.orgId.eq(caller.orgId),
							$.id.eq(row.id),
							$.updatedAt.eq(row.updatedAt),
							$.status.eq(row.status),
						])
						.returning(),
				),
			)
			const written = Option.fromNullishOr(updated[0])
			if (Option.isNone(written)) {
				return yield* new ReportConflict({ message: "The run changed during the report" })
			}
			return written.value
		})

		const report = Effect.fn("OnboardingAgentRunService.report")(function* (
			caller: OnboardingAgentRunCaller,
			input: OnboardingAgentReport,
		) {
			// Retries stay on the run first read: a replacement run never gets this report.
			const { id } = yield* latest(caller)
			return yield* attemptReport(caller, id, input).pipe(
				Effect.retry({
					schedule: Schedule.recurs(4),
					while: (error) => error._tag === "@maple/backend/OnboardingAgentRunReportConflict",
				}),
				Effect.catchTag("@maple/backend/OnboardingAgentRunReportConflict", (error) =>
					Effect.fail(
						new OnboardingAgentRunUnavailableError({
							message: error.message,
							operation: "report",
							cause: null,
						}),
					),
				),
			)
		})

		return { start, current, report }
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
}
