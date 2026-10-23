/**
 * Postgres persistence for the security-audit engine. `forOrg(orgId)` gives the engine's
 * `AuditStore` for one org plus the run lifecycle and readers the host and API need. Every query
 * filters by that org, so a store for one org cannot read or write another's runs.
 */
import type { OrgId, UserId } from "@maple/domain/primitives"
import type { VcsRepositoryId } from "@maple/domain/http/vcs"
import {
	SecurityAuditRunId,
	type SecurityAuditProfile,
	type SecurityAuditFindingStatus,
	type SecurityAuditRunKind,
	type SecurityAuditRunStatus,
	SecurityAuditTargetId,
} from "@maple/domain/security-audit"
import {
	SecurityAuditEventDetail,
	SecurityAuditEvents,
	SecurityAuditFindings,
	SecurityAuditRunFindings,
	SecurityAuditRuns,
	SecurityAuditTargets,
	SecurityAuditUnits,
	VcsRepositories,
	type SecurityAuditEventRow,
	type SecurityAuditFindingRow,
	type SecurityAuditRunRow,
	type SecurityAuditTargetRow,
	type SecurityAuditUnitRow,
} from "@maple/db/tables"
import type { MapleDb } from "@maple/db/client"
import {
	AuditStore,
	AuditStoreError,
	type AuditEvent,
	type AuditStoreApi,
	type Finding,
} from "@maple/security-audit"
import {
	AuditReportsRecord,
	CoverageUnit,
	Finding as FindingSchema,
	RunMetadataRecord,
	UnitStatus,
} from "@maple/security-audit/schema"
import * as PG from "@maple-dev/effect-orm/postgres"
import { Array as Arr, Clock, Context, Effect, Layer, Option, Schema } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute, makePersistenceErrorMapper } from "@maple/backend/platform/db-execute"

export interface CreateTargetInput {
	readonly repository: string
	readonly branch: string
	readonly createdBy: UserId
	readonly vcsRepositoryId?: VcsRepositoryId
	readonly profile?: SecurityAuditProfile
	readonly scopePaths?: ReadonlyArray<string>
	readonly sliceIntervalHours?: number
	readonly revalidateOnPush?: boolean
	readonly budgetPerRun?: number
	readonly monthlyInvocationBudget?: number
}

export interface StartRunInput {
	/** The engine's `run_id`; minted here when absent. Starting the same id again is a no-op. */
	readonly runId?: SecurityAuditRunId
	readonly targetId: SecurityAuditTargetId
	readonly kind: SecurityAuditRunKind
	readonly sourceRef: string
	/** Defaults to the target's. */
	readonly profile?: SecurityAuditProfile
	readonly scopePaths?: ReadonlyArray<string>
	readonly budget?: number | null
	readonly workflowInstanceId?: string
}

export type FinishRunOutcome =
	| { readonly status: "complete" }
	| { readonly status: "incomplete"; readonly reason: string }
	| { readonly status: "failed"; readonly error: string }

export interface RunUsage {
	readonly invocations: number
	readonly inputTokens: number
	readonly outputTokens: number
	readonly costUsd?: number
}

export interface SecurityAuditOrgStore extends AuditStoreApi {
	readonly createTarget: (
		input: CreateTargetInput,
	) => Effect.Effect<SecurityAuditTargetRow, AuditStoreError | SecurityAuditTargetExists>
	/** The org's active connected repository by `owner/name`, case-insensitively. */
	readonly findConnectedRepository: (
		repository: string,
	) => Effect.Effect<Option.Option<ConnectedRepository>, AuditStoreError>
	readonly listTargets: () => Effect.Effect<ReadonlyArray<SecurityAuditTargetRow>, AuditStoreError>
	readonly getTarget: (
		targetId: SecurityAuditTargetId,
	) => Effect.Effect<Option.Option<SecurityAuditTargetRow>, AuditStoreError>
	/** Refuses a disabled target, and a second run while one is in progress. */
	readonly startRun: (
		input: StartRunInput,
	) => Effect.Effect<
		SecurityAuditRunRow,
		AuditStoreError | SecurityAuditRunInProgress | SecurityAuditTargetDisabled
	>
	/**
	 * The run a new one carries forward: the latest finished run that audited the whole target,
	 * else the latest finished run at all.
	 */
	readonly latestPriorRun: (
		targetId: SecurityAuditTargetId,
	) => Effect.Effect<Option.Option<SecurityAuditRunRow>, AuditStoreError>
	readonly finishRun: (runId: string, outcome: FinishRunOutcome) => Effect.Effect<void, AuditStoreError>
	/** Sets the run's totals (absolute, so a retried or replayed write cannot double-count). */
	readonly setUsage: (runId: string, usage: RunUsage) => Effect.Effect<void, AuditStoreError>
	readonly getRun: (runId: string) => Effect.Effect<Option.Option<SecurityAuditRunRow>, AuditStoreError>
	readonly listRuns: (options?: {
		readonly targetId?: SecurityAuditTargetId
		readonly statuses?: Arr.NonEmptyReadonlyArray<SecurityAuditRunStatus>
		readonly limit?: number
	}) => Effect.Effect<ReadonlyArray<SecurityAuditRunRow>, AuditStoreError>
	readonly listUnits: (runId: string) => Effect.Effect<ReadonlyArray<SecurityAuditUnitRow>, AuditStoreError>
	/** Ledger units per status, counted in SQL. */
	readonly countUnits: (runId: string) => Effect.Effect<Record<string, number>, AuditStoreError>
	/** One run's final records, the input a later run carries forward. */
	readonly listRunFindings: (runId: string) => Effect.Effect<ReadonlyArray<Finding>, AuditStoreError>
	/** Oldest first; with a `limit`, the newest page strictly before `beforeAt`. */
	readonly listEvents: (
		runId: string,
		options?: {
			readonly limit?: number | undefined
			readonly beforeAt?: number | undefined
			/** With `beforeAt`, the last event id of the previous page: events in the same millisecond. */
			readonly beforeId?: string | undefined
		},
	) => Effect.Effect<ReadonlyArray<SecurityAuditEventRecord>, AuditStoreError>
	readonly listFindings: (
		targetId: SecurityAuditTargetId,
	) => Effect.Effect<ReadonlyArray<SecurityAuditFindingRow>, AuditStoreError>
	/** Findings a revalidation no longer finds: open ones become `fixed`; returns how many did. */
	readonly markFixed: (
		targetId: SecurityAuditTargetId,
		fingerprints: ReadonlyArray<string>,
		runId: string,
	) => Effect.Effect<number, AuditStoreError>
	/** A person's triage of one finding, with why; None when the target has no such finding. */
	readonly setFindingStatus: (
		targetId: SecurityAuditTargetId,
		fingerprint: string,
		status: Exclude<SecurityAuditFindingStatus, "fixed">,
		reason: string,
		actor: UserId,
	) => Effect.Effect<Option.Option<SecurityAuditTriage>, AuditStoreError>
}

/** What a triage write changed; built from the write itself, so an old stored record cannot hide it. */
export interface SecurityAuditTriage {
	readonly fingerprint: string
	readonly status: Exclude<SecurityAuditFindingStatus, "fixed">
	readonly statusReason: string
	readonly statusChangedAt: number
}

export interface ConnectedRepository {
	readonly id: VcsRepositoryId
	readonly fullName: string
}

/** An event row whose `detail` is null when it was written under an older shape. */
export type SecurityAuditEventRecord = Omit<SecurityAuditEventRow, "detail"> & {
	readonly detail: SecurityAuditEventRow["detail"] | null
}

export class SecurityAuditRunInProgress extends Schema.TaggedError<SecurityAuditRunInProgress>()(
	"@maple/backend/security-audit/RunInProgress",
	{ message: Schema.String, targetId: SecurityAuditTargetId },
) {}

export class SecurityAuditTargetDisabled extends Schema.TaggedError<SecurityAuditTargetDisabled>()(
	"@maple/backend/security-audit/TargetDisabled",
	{ message: Schema.String, targetId: SecurityAuditTargetId },
) {}

export class SecurityAuditTargetExists extends Schema.TaggedError<SecurityAuditTargetExists>()(
	"@maple/backend/security-audit/TargetExists",
	{ message: Schema.String, repository: Schema.String, branch: Schema.String },
) {}

export interface SecurityAuditStoreApi {
	readonly forOrg: (orgId: OrgId) => SecurityAuditOrgStore
}

const DEFAULT_RUN_LIST_LIMIT = 50

/** Longer than any audit run lasts; an `in_progress` run older than this was abandoned. */
const STALE_RUN_MS = 48 * 60 * 60 * 1000

/** Ledger units per insert: 7 binds each keeps one statement far under Postgres's 65,535. */
const LEDGER_INSERT_CHUNK = 500

const decodeCoverageUnit = Schema.decodeUnknownOption(CoverageUnit)
const decodeUnitStatus = Schema.decodeUnknownOption(UnitStatus)
const decodeFinding = Schema.decodeUnknownOption(FindingSchema)
const decodeRunMetadata = Schema.decodeUnknownOption(RunMetadataRecord)
const decodeReports = Schema.decodeUnknownOption(AuditReportsRecord)
const decodeEventDetail = Schema.decodeUnknownOption(SecurityAuditEventDetail)

/** A stored jsonb value under the current schema, or null when it was written under an older one. */
const lenient = <A>(stored: { readonly isNull: boolean; readonly decoded: Option.Option<A> }) =>
	stored.isNull
		? { value: null, stale: false }
		: Option.match(stored.decoded, {
				onNone: () => ({ value: null, stale: true }),
				onSome: (value) => ({ value, stale: false }),
			})

const warnStale = (what: string, stale: number, total: number) =>
	stale === 0
		? Effect.void
		: Effect.logWarning(`Read stored ${what} under an older shape as null`).pipe(
				Effect.annotateLogs({ stale, total }),
			)

type RawRunRow = Omit<SecurityAuditRunRow, "metadata" | "reports"> & {
	readonly metadata: unknown
	readonly reports: unknown
}

/** Runs with `metadata` and `reports` read leniently: an old shape becomes null, not a failure. */
const lenientRuns = (rows: ReadonlyArray<RawRunRow>) =>
	Effect.gen(function* () {
		const decoded = rows.map((row) => {
			const metadata = lenient({
				isNull: row.metadata === null,
				decoded: decodeRunMetadata(row.metadata),
			})
			const reports = lenient({ isNull: row.reports === null, decoded: decodeReports(row.reports) })
			return {
				row: { ...row, metadata: metadata.value, reports: reports.value },
				stale: metadata.stale || reports.stale,
			}
		})
		yield* warnStale("run metadata or reports", decoded.filter((d) => d.stale).length, rows.length)
		return decoded.map((d): SecurityAuditRunRow => d.row)
	})

const selectRuns = () =>
	PG.from(SecurityAuditRuns).select(($) => ({
		...$,
		metadata: PG.undecoded($.metadata),
		reports: PG.undecoded($.reports),
	}))

/**
 * Keeps the rows that still decode against the current schemas. Stored jsonb outlives a skill
 * upgrade that tightens them; one stale row must not fail every later run that reads it.
 */
const keepDecodable = <Raw, A>(
	rows: ReadonlyArray<Raw>,
	decode: (row: Raw) => Option.Option<A>,
	what: string,
) =>
	Effect.gen(function* () {
		const decoded = Arr.getSomes(rows.map(decode))
		const skipped = rows.length - decoded.length
		if (skipped > 0) {
			yield* Effect.logWarning(`Skipped stored ${what} that no longer decode`).pipe(
				Effect.annotateLogs({ skipped, total: rows.length }),
			)
		}
		return decoded
	})

const newTargetId = () => Schema.decodeSync(SecurityAuditTargetId)(crypto.randomUUID())
const newRunId = () => Schema.decodeSync(SecurityAuditRunId)(crypto.randomUUID())

const firstOrFail = <A>(rows: ReadonlyArray<A>, message: string) =>
	rows[0] === undefined ? Effect.fail(new AuditStoreError({ message })) : Effect.succeed(rows[0])

const toStoreError = makePersistenceErrorMapper(AuditStoreError, "Security audit store operation failed")

const decodeRunId = (raw: string) =>
	Schema.decodeUnknownEffect(SecurityAuditRunId)(raw).pipe(
		Effect.mapError(
			() => new AuditStoreError({ message: `Invalid security audit run id: ${JSON.stringify(raw)}` }),
		),
	)

/** SHA-256 of `text` as lowercase hex, through Web Crypto so it runs in Workers and Node. */
const sha256Hex = (text: string) =>
	Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))).pipe(
		Effect.map((digest) =>
			Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
		),
	)

/**
 * A replayed workflow step records the same event again; its id is derived from the run and the
 * event's identity so the second insert is a no-op.
 */
const eventId = (runId: SecurityAuditRunId, event: AuditEvent) =>
	Effect.gen(function* () {
		const key =
			event._tag === "Agent"
				? `agent:${event.agentId}:${event.outcome}`
				: event._tag === "Phase"
					? `phase:${event.phase}`
					: `note:${(yield* sha256Hex(event.message)).slice(0, 32)}`
		return yield* sha256Hex(`${runId}:${key}`)
	})

const runNotFound = (runId: string) =>
	new AuditStoreError({ message: `Security audit run ${runId} not found` })

const overallSeverity = (finding: Finding) =>
	finding.verdict === "confirmed" ? finding.severity.overall_severity : null

/** The run's own row, read inside the caller's transaction; absent for another org's run. */
const requireRun = (db: MapleDb, orgId: OrgId, runId: SecurityAuditRunId) =>
	db
		.run(
			PG.from(SecurityAuditRuns)
				.select("id", "targetId", "sourceRef")
				.where(($) => [$.orgId.eq(orgId), $.id.eq(runId)])
				.limit(1),
		)
		.pipe(
			Effect.flatMap((rows) =>
				rows[0] === undefined ? Effect.fail(runNotFound(runId)) : Effect.succeed(rows[0]),
			),
		)

export class SecurityAuditStore extends Context.Service<SecurityAuditStore, SecurityAuditStoreApi>()(
	"@maple/backend/services/security-audit/SecurityAuditStore",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const dbExecute = makeDbExecute(database, "SecurityAuditStore", toStoreError)

			const forOrg = (orgId: OrgId): SecurityAuditOrgStore => {
				/** Updates the org's run and fails when no such run exists. */
				const updateRun = (
					runId: SecurityAuditRunId,
					values: PG.UpdateSetOf<typeof SecurityAuditRuns>,
				) =>
					dbExecute((db) =>
						db.run(
							PG.update(SecurityAuditRuns)
								.set(values)
								.where(($) => [$.orgId.eq(orgId), $.id.eq(runId)])
								.returning("id"),
						),
					).pipe(
						Effect.flatMap((rows) =>
							rows.length === 0 ? Effect.fail(runNotFound(runId)) : Effect.void,
						),
					)

				/** The target's lifecycle rows, tolerant of records stored under an older schema. */
				const readFindings = (targetId: SecurityAuditTargetId, fingerprint?: string) =>
					dbExecute((db) =>
						db.run(
							PG.from(SecurityAuditFindings)
								.select(($) => ({ ...$, record: PG.undecoded($.record) }))
								.where(($) => [
									$.orgId.eq(orgId),
									$.targetId.eq(targetId),
									fingerprint === undefined ? undefined : $.fingerprint.eq(fingerprint),
								])
								.orderBy(($) => [
									[$.createdAt, "asc"],
									[$.fingerprint, "asc"],
								]),
						),
					).pipe(
						Effect.flatMap((rows) =>
							keepDecodable(
								rows,
								(row): Option.Option<SecurityAuditFindingRow> =>
									Option.map(decodeFinding(row.record), (record) => ({ ...row, record })),
								"findings",
							),
						),
					)

				const saveMetadata: AuditStoreApi["saveMetadata"] = Effect.fn(
					"SecurityAuditStore.saveMetadata",
				)(function* (metadata) {
					const runId = yield* decodeRunId(metadata.run_id)
					yield* updateRun(runId, {
						metadata,
						sourceRef: metadata.source_ref,
						profile: metadata.profile,
						scopePaths: metadata.scope_paths,
						budget: metadata.budget,
						status: metadata.run_status,
						incompleteReason: metadata.incomplete_reason ?? null,
					})
				})

				const saveArchitecture: AuditStoreApi["saveArchitecture"] = Effect.fn(
					"SecurityAuditStore.saveArchitecture",
				)(function* (rawRunId, architectureMd) {
					const runId = yield* decodeRunId(rawRunId)
					yield* updateRun(runId, { architectureMd })
				})

				const saveReports: AuditStoreApi["saveReports"] = Effect.fn("SecurityAuditStore.saveReports")(
					function* (rawRunId, reports) {
						const runId = yield* decodeRunId(rawRunId)
						yield* updateRun(runId, { reports })
					},
				)

				const saveLedger: AuditStoreApi["saveLedger"] = Effect.fn("SecurityAuditStore.saveLedger")(
					function* (rawRunId, ledger) {
						const runId = yield* decodeRunId(rawRunId)
						yield* dbExecute((db) =>
							db.transaction(
								Effect.gen(function* () {
									yield* requireRun(db, orgId, runId)
									yield* db.run(
										PG.deleteFrom(SecurityAuditUnits).where(($) => [
											$.orgId.eq(orgId),
											$.runId.eq(runId),
										]),
									)
									yield* Effect.forEach(
										Arr.chunksOf(ledger, LEDGER_INSERT_CHUNK),
										(chunk) =>
											db.run(
												PG.insertInto(SecurityAuditUnits).values(
													Arr.map(chunk, (unit) => ({
														runId,
														coverageId: unit.coverage_id,
														orgId,
														status: unit.status,
														wave: unit.wave,
														agentId: unit.agent_id,
														unit,
													})),
												),
											),
										{ discard: true },
									)
								}),
							),
						)
					},
				)

				/**
				 * Replaces the run's findings, then folds them into the target's lifecycle rows: a new
				 * fingerprint opens, a `fixed` one regresses to open, dismissed and accepted stay put.
				 * Lifecycle rows this run created that its latest save dropped are removed again.
				 */
				const saveFindings: AuditStoreApi["saveFindings"] = Effect.fn(
					"SecurityAuditStore.saveFindings",
				)(function* (rawRunId, findings) {
					const runId = yield* decodeRunId(rawRunId)
					const now = yield* Clock.currentTimeMillis
					// One row per fingerprint; a repeated one keeps its last record.
					const unique = Array.from(
						new Map(findings.map((f): [string, Finding] => [f.fingerprint, f])).values(),
					)
					const fingerprints = unique.map((f) => f.fingerprint)
					yield* dbExecute((db) =>
						db.transaction(
							Effect.gen(function* () {
								const run = yield* requireRun(db, orgId, runId)
								yield* db.run(
									PG.deleteFrom(SecurityAuditRunFindings).where(($) => [
										$.orgId.eq(orgId),
										$.runId.eq(runId),
									]),
								)
								yield* db.run(
									PG.deleteFrom(SecurityAuditFindings).where(($) => [
										$.orgId.eq(orgId),
										$.targetId.eq(run.targetId),
										$.firstSeenRunId.eq(runId),
										$.lastSeenRunId.eq(runId),
										$.fingerprint.notIn(...fingerprints),
									]),
								)
								if (!Arr.isReadonlyArrayNonEmpty(unique)) return
								yield* db.run(
									PG.insertInto(SecurityAuditRunFindings).values(
										Arr.map(unique, (finding) => ({
											runId,
											fingerprint: finding.fingerprint,
											orgId,
											verdict: finding.verdict,
											overallSeverity: overallSeverity(finding),
											record: finding,
										})),
									),
								)
								yield* db.run(
									PG.insertInto(SecurityAuditFindings)
										.values(
											Arr.map(unique, (finding) => ({
												id: crypto.randomUUID(),
												orgId,
												targetId: run.targetId,
												fingerprint: finding.fingerprint,
												verdict: finding.verdict,
												overallSeverity: overallSeverity(finding),
												record: finding,
												status: "open" as const,
												firstSeenRunId: runId,
												lastSeenRunId: runId,
												firstSeenRef: run.sourceRef,
												lastSeenRef: run.sourceRef,
												fixedRunId: null,
												createdAt: now,
												updatedAt: now,
											})),
										)
										.onConflictDoUpdate({
											target: ["targetId", "fingerprint"],
											set: ($, excluded) => ({
												verdict: excluded.verdict,
												overallSeverity: excluded.overallSeverity,
												record: excluded.record,
												lastSeenRunId: excluded.lastSeenRunId,
												lastSeenRef: excluded.lastSeenRef,
												updatedAt: excluded.updatedAt,
												status: PG.caseWhen(
													[
														[
															$.status.eq("fixed"),
															PG.typedValue(
																SecurityAuditFindings.columns.status,
																"open",
															),
														],
													],
													$.status,
												),
												fixedRunId: PG.caseWhen(
													[
														[
															$.status.eq("fixed"),
															PG.typedValue(
																SecurityAuditFindings.columns.fixedRunId,
																null,
															),
														],
													],
													$.fixedRunId,
												),
											}),
											where: ($) => $.orgId.eq(orgId),
										}),
								)
							}),
						),
					)
				})

				const recordEvent: AuditStoreApi["recordEvent"] = Effect.fn("SecurityAuditStore.recordEvent")(
					function* (rawRunId, event) {
						const runId = yield* decodeRunId(rawRunId)
						const at = yield* Clock.currentTimeMillis
						const id = yield* eventId(runId, event)
						const base = { id, runId, orgId, at, kind: event._tag }
						const row: PG.InsertRowOf<typeof SecurityAuditEvents> =
							event._tag === "Agent"
								? {
										...base,
										role: event.role,
										agentId: event.agentId,
										outcome: event.outcome,
										detail: {
											message: event.message ?? null,
											phase: null,
											detail: null,
											costUsd: event.usage?.costUsd ?? null,
										},
										inputTokens: event.usage?.inputTokens ?? null,
										outputTokens: event.usage?.outputTokens ?? null,
									}
								: {
										...base,
										role: null,
										agentId: null,
										outcome: null,
										detail:
											event._tag === "Phase"
												? {
														message: null,
														phase: event.phase,
														detail: event.detail,
														costUsd: null,
													}
												: {
														message: event.message,
														phase: null,
														detail: null,
														costUsd: null,
													},
										inputTokens: null,
										outputTokens: null,
									}
						yield* dbExecute((db) =>
							db.transaction(
								Effect.gen(function* () {
									yield* requireRun(db, orgId, runId)
									yield* db.run(
										PG.insertInto(SecurityAuditEvents)
											.values(row)
											.onConflictDoNothing({ target: ["id"] }),
									)
								}),
							),
						)
					},
				)

				const createTarget: SecurityAuditOrgStore["createTarget"] = Effect.fn(
					"SecurityAuditStore.createTarget",
				)(function* (input) {
					const now = yield* Clock.currentTimeMillis
					const id = newTargetId()
					// A repository reference must be this org's: never another tenant's connected repository.
					const repositoryId = input.vcsRepositoryId
					if (repositoryId !== undefined) {
						const owned = yield* dbExecute((db) =>
							db.run(
								PG.from(VcsRepositories)
									.select("id")
									.where(($) => [$.orgId.eq(orgId), $.id.eq(repositoryId)])
									.limit(1),
							),
						)
						if (owned.length === 0) {
							return yield* new AuditStoreError({
								message: "Repository is not connected to this org",
							})
						}
					}
					const rows = yield* dbExecute((db) =>
						db.run(
							PG.insertInto(SecurityAuditTargets)
								.values({
									id,
									orgId,
									repository: input.repository,
									vcsRepositoryId: input.vcsRepositoryId ?? null,
									branch: input.branch,
									enabled: true,
									profile: input.profile ?? "deep",
									scopePaths: input.scopePaths ?? [],
									sliceIntervalHours: input.sliceIntervalHours ?? null,
									revalidateOnPush: input.revalidateOnPush ?? false,
									budgetPerRun: input.budgetPerRun ?? null,
									monthlyInvocationBudget: input.monthlyInvocationBudget ?? null,
									createdBy: input.createdBy,
									createdAt: now,
									updatedAt: now,
								})
								.onConflictDoNothing({ target: ["orgId", "repository", "branch"] })
								.returning(),
						),
					)
					if (rows[0] === undefined) {
						return yield* new SecurityAuditTargetExists({
							message: `${input.repository}@${input.branch} is already an audit target`,
							repository: input.repository,
							branch: input.branch,
						})
					}
					return rows[0]
				})

				const findConnectedRepository: SecurityAuditOrgStore["findConnectedRepository"] = Effect.fn(
					"SecurityAuditStore.findConnectedRepository",
				)(function* (repository) {
					const rows = yield* dbExecute((db) =>
						db.run(
							PG.from(VcsRepositories)
								.select("id", "fullName")
								.where(($) => [
									$.orgId.eq(orgId),
									$.status.eq("active"),
									PG.lower($.fullName).eq(repository.toLowerCase()),
								])
								.limit(1),
						),
					)
					return Option.fromUndefinedOr(rows[0])
				})

				const startRun: SecurityAuditOrgStore["startRun"] = Effect.fn("SecurityAuditStore.startRun")(
					function* (input) {
						const now = yield* Clock.currentTimeMillis
						const runId = input.runId ?? newRunId()
						const inProgress = new SecurityAuditRunInProgress({
							message: `Security audit target ${input.targetId} already has a run in progress`,
							targetId: input.targetId,
						})
						return yield* dbExecute((db) =>
							db.transaction(
								Effect.gen(function* () {
									const readRun = db
										.run(
											selectRuns()
												.where(($) => [$.orgId.eq(orgId), $.id.eq(runId)])
												.limit(1),
										)
										.pipe(Effect.flatMap(lenientRuns))
									// Starting the same id again is a no-op, even while it runs.
									const existing = yield* readRun
									if (existing[0] !== undefined) return existing[0]

									const targets = yield* db.run(
										PG.from(SecurityAuditTargets)
											.select("profile", "scopePaths", "budgetPerRun", "enabled")
											.where(($) => [$.orgId.eq(orgId), $.id.eq(input.targetId)])
											.limit(1),
									)
									const target = yield* firstOrFail(
										targets,
										`Security audit target ${input.targetId} not found`,
									)
									if (!target.enabled) {
										return yield* new SecurityAuditTargetDisabled({
											message: `Security audit target ${input.targetId} is disabled`,
											targetId: input.targetId,
										})
									}
									// A run with no settlement for longer than any run lasts is abandoned (an
									// externally terminated instance, a lost settle): it must not block the target.
									yield* db.run(
										PG.update(SecurityAuditRuns)
											.set({
												status: "failed",
												error: "abandoned: no settlement within 48 hours",
												finishedAt: now,
											})
											.where(($) => [
												$.orgId.eq(orgId),
												$.targetId.eq(input.targetId),
												$.status.eq("in_progress"),
												$.startedAt.lt(now - STALE_RUN_MS),
											]),
									)
									const running = yield* db.run(
										PG.from(SecurityAuditRuns)
											.select("id")
											.where(($) => [
												$.orgId.eq(orgId),
												$.targetId.eq(input.targetId),
												$.status.eq("in_progress"),
											])
											.limit(1),
									)
									if (running.length > 0) return yield* inProgress
									// No conflict target: a concurrent start losing on the one-running index
									// inserts nothing, and is told so below rather than failing as a 5xx.
									yield* db.run(
										PG.insertInto(SecurityAuditRuns)
											.values({
												id: runId,
												orgId,
												targetId: input.targetId,
												kind: input.kind,
												sourceRef: input.sourceRef,
												profile: input.profile ?? target.profile,
												scopePaths: input.scopePaths ?? target.scopePaths,
												budget:
													input.budget === undefined
														? target.budgetPerRun
														: input.budget,
												metadata: null,
												status: "in_progress",
												workflowInstanceId: input.workflowInstanceId ?? null,
												startedAt: now,
											})
											.onConflictDoNothing(),
									)
									const inserted = yield* readRun
									if (inserted[0] !== undefined) return inserted[0]
									const raced = yield* db.run(
										PG.from(SecurityAuditRuns)
											.select("id")
											.where(($) => [
												$.orgId.eq(orgId),
												$.targetId.eq(input.targetId),
												$.status.eq("in_progress"),
											])
											.limit(1),
									)
									if (raced.length > 0) return yield* inProgress
									return yield* new AuditStoreError({
										message: `Security audit run ${runId} belongs to another org`,
									})
								}),
							),
						)
					},
				)

				const latestPriorRun: SecurityAuditOrgStore["latestPriorRun"] = Effect.fn(
					"SecurityAuditStore.latestPriorRun",
				)(function* (targetId) {
					const latest = (unscopedOnly: boolean) =>
						dbExecute((db) =>
							db.run(
								selectRuns()
									.where(($) => [
										$.orgId.eq(orgId),
										$.targetId.eq(targetId),
										$.status.in_("complete", "incomplete"),
										unscopedOnly ? $.scopePaths.eq([]) : undefined,
									])
									.orderBy(($) => [[$.startedAt, "desc"]])
									.limit(1),
							),
						).pipe(Effect.flatMap(lenientRuns), Effect.map(Arr.head))
					const unscoped = yield* latest(true)
					return Option.isSome(unscoped) ? unscoped : yield* latest(false)
				})

				const finishRun: SecurityAuditOrgStore["finishRun"] = Effect.fn(
					"SecurityAuditStore.finishRun",
				)(function* (rawRunId, outcome) {
					const runId = yield* decodeRunId(rawRunId)
					const now = yield* Clock.currentTimeMillis
					yield* updateRun(runId, {
						status: outcome.status,
						finishedAt: now,
						incompleteReason: outcome.status === "incomplete" ? outcome.reason : null,
						error: outcome.status === "failed" ? outcome.error : null,
					})
				})

				const setUsage: SecurityAuditOrgStore["setUsage"] = Effect.fn("SecurityAuditStore.setUsage")(
					function* (rawRunId, usage) {
						const runId = yield* decodeRunId(rawRunId)
						const cost = usage.costUsd
						const rows = yield* dbExecute((db) =>
							db.run(
								PG.update(SecurityAuditRuns)
									.set({
										invocationsSpent: usage.invocations,
										inputTokens: usage.inputTokens,
										outputTokens: usage.outputTokens,
										costUsd: cost === undefined ? undefined : cost,
									})
									.where(($) => [$.orgId.eq(orgId), $.id.eq(runId)])
									.returning("id"),
							),
						)
						if (rows.length === 0) return yield* runNotFound(runId)
					},
				)

				const getRun: SecurityAuditOrgStore["getRun"] = Effect.fn("SecurityAuditStore.getRun")(
					function* (rawRunId) {
						const runId = yield* decodeRunId(rawRunId)
						const rows = yield* dbExecute((db) =>
							db.run(
								selectRuns()
									.where(($) => [$.orgId.eq(orgId), $.id.eq(runId)])
									.limit(1),
							),
						).pipe(Effect.flatMap(lenientRuns))
						return Arr.head(rows)
					},
				)

				const listRuns: SecurityAuditOrgStore["listRuns"] = Effect.fn("SecurityAuditStore.listRuns")(
					function* (options) {
						const targetId = options?.targetId
						const statuses = options?.statuses
						return yield* dbExecute((db) =>
							db.run(
								selectRuns()
									.where(($) => [
										$.orgId.eq(orgId),
										targetId === undefined ? undefined : $.targetId.eq(targetId),
										statuses === undefined ? undefined : $.status.in_(...statuses),
									])
									.orderBy(($) => [[$.startedAt, "desc"]])
									.limit(options?.limit ?? DEFAULT_RUN_LIST_LIMIT),
							),
						).pipe(Effect.flatMap(lenientRuns))
					},
				)

				const listUnits: SecurityAuditOrgStore["listUnits"] = Effect.fn(
					"SecurityAuditStore.listUnits",
				)(function* (rawRunId) {
					const runId = yield* decodeRunId(rawRunId)
					const rows = yield* dbExecute((db) =>
						db.run(
							PG.from(SecurityAuditUnits)
								.select(($) => ({
									...$,
									status: PG.undecoded($.status),
									unit: PG.undecoded($.unit),
								}))
								.where(($) => [$.orgId.eq(orgId), $.runId.eq(runId)])
								.orderBy(($) => [[$.coverageId, "asc"]]),
						),
					)
					return yield* keepDecodable(
						rows,
						(row): Option.Option<SecurityAuditUnitRow> =>
							Option.all({
								status: decodeUnitStatus(row.status),
								unit: decodeCoverageUnit(row.unit),
							}).pipe(Option.map((decoded) => ({ ...row, ...decoded }))),
						"ledger units",
					)
				})

				const listRunFindings: SecurityAuditOrgStore["listRunFindings"] = Effect.fn(
					"SecurityAuditStore.listRunFindings",
				)(function* (rawRunId) {
					const runId = yield* decodeRunId(rawRunId)
					const rows = yield* dbExecute((db) =>
						db.run(
							PG.from(SecurityAuditRunFindings)
								.select(($) => ({ record: PG.undecoded($.record) }))
								.where(($) => [$.orgId.eq(orgId), $.runId.eq(runId)])
								.orderBy(($) => [[$.fingerprint, "asc"]]),
						),
					)
					return yield* keepDecodable(rows, (row) => decodeFinding(row.record), "run findings")
				})

				const listEvents: SecurityAuditOrgStore["listEvents"] = Effect.fn(
					"SecurityAuditStore.listEvents",
				)(function* (rawRunId, options) {
					const runId = yield* decodeRunId(rawRunId)
					const beforeAt = options?.beforeAt
					const beforeId = options?.beforeId
					const query = PG.from(SecurityAuditEvents)
						.select(($) => ({ ...$, detail: PG.undecoded($.detail) }))
						.where(($) => [
							$.orgId.eq(orgId),
							$.runId.eq(runId),
							beforeAt === undefined
								? undefined
								: beforeId === undefined
									? $.at.lt(beforeAt)
									: PG.or($.at.lt(beforeAt), PG.and($.at.eq(beforeAt), $.id.lt(beforeId))),
						])
					const limit = options?.limit
					const rows = yield* dbExecute((db) =>
						limit === undefined
							? db.run(
									query.orderBy(($) => [
										[$.at, "asc"],
										[$.id, "asc"],
									]),
								)
							: db
									.run(
										query
											.orderBy(($) => [
												[$.at, "desc"],
												[$.id, "desc"],
											])
											.limit(limit),
									)
									.pipe(Effect.map((page) => page.toReversed())),
					)
					const decoded = rows.map((row) => ({
						row,
						detail: lenient({
							isNull: row.detail === null,
							decoded: decodeEventDetail(row.detail),
						}),
					}))
					yield* warnStale(
						"event details",
						decoded.filter((d) => d.detail.stale).length,
						rows.length,
					)
					return decoded.map(({ row, detail }): SecurityAuditEventRecord => ({
						...row,
						detail: detail.value,
					}))
				})

				const countUnits: SecurityAuditOrgStore["countUnits"] = Effect.fn(
					"SecurityAuditStore.countUnits",
				)(function* (rawRunId) {
					const runId = yield* decodeRunId(rawRunId)
					const rows = yield* dbExecute((db) =>
						db.run(
							PG.from(SecurityAuditUnits)
								.select(($) => ({ status: PG.undecoded($.status), count: PG.count() }))
								.where(($) => [$.orgId.eq(orgId), $.runId.eq(runId)])
								.groupBy("status"),
						),
					)
					return Object.fromEntries(rows.map((row) => [String(row.status), row.count]))
				})

				const listFindings: SecurityAuditOrgStore["listFindings"] = Effect.fn(
					"SecurityAuditStore.listFindings",
				)(function* (targetId) {
					return yield* readFindings(targetId)
				})

				const markFixed: SecurityAuditOrgStore["markFixed"] = Effect.fn(
					"SecurityAuditStore.markFixed",
				)(function* (targetId, fingerprints, rawRunId) {
					const runId = yield* decodeRunId(rawRunId)
					if (!Arr.isReadonlyArrayNonEmpty(fingerprints)) return 0
					const now = yield* Clock.currentTimeMillis
					const rows = yield* dbExecute((db) =>
						db.run(
							PG.update(SecurityAuditFindings)
								.set({ status: "fixed", fixedRunId: runId, updatedAt: now })
								.where(($) => [
									$.orgId.eq(orgId),
									$.targetId.eq(targetId),
									$.status.eq("open"),
									$.fingerprint.in_(...fingerprints),
								])
								.returning("id"),
						),
					)
					return rows.length
				})

				const listTargets: SecurityAuditOrgStore["listTargets"] = Effect.fn(
					"SecurityAuditStore.listTargets",
				)(function* () {
					return yield* dbExecute((db) =>
						db.run(
							PG.from(SecurityAuditTargets)
								.select()
								.where(($) => [$.orgId.eq(orgId)])
								.orderBy(($) => [[$.createdAt, "asc"]]),
						),
					)
				})

				const getTarget: SecurityAuditOrgStore["getTarget"] = Effect.fn(
					"SecurityAuditStore.getTarget",
				)(function* (targetId) {
					const rows = yield* dbExecute((db) =>
						db.run(
							PG.from(SecurityAuditTargets)
								.select()
								.where(($) => [$.orgId.eq(orgId), $.id.eq(targetId)])
								.limit(1),
						),
					)
					return Option.fromUndefinedOr(rows[0])
				})

				const setFindingStatus: SecurityAuditOrgStore["setFindingStatus"] = Effect.fn(
					"SecurityAuditStore.setFindingStatus",
				)(function* (targetId, fingerprint, status, reason, actor) {
					const now = yield* Clock.currentTimeMillis
					const rows = yield* dbExecute((db) =>
						db.run(
							PG.update(SecurityAuditFindings)
								.set({
									status,
									statusReason: reason,
									statusChangedBy: actor,
									statusChangedAt: now,
									updatedAt: now,
								})
								.where(($) => [
									$.orgId.eq(orgId),
									$.targetId.eq(targetId),
									$.fingerprint.eq(fingerprint),
								])
								.returning("id"),
						),
					)
					// None only when no finding matched; the stored record is not read back.
					if (rows.length === 0) return Option.none()
					return Option.some({ fingerprint, status, statusReason: reason, statusChangedAt: now })
				})

				return {
					listTargets,
					getTarget,
					setFindingStatus,
					findConnectedRepository,
					latestPriorRun,
					countUnits,
					saveMetadata,
					saveArchitecture,
					saveLedger,
					saveFindings,
					saveReports,
					recordEvent,
					createTarget,
					startRun,
					finishRun,
					setUsage,
					getRun,
					listRuns,
					listUnits,
					listRunFindings,
					listEvents,
					listFindings,
					markFixed,
				}
			}

			return { forOrg }
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)

	/** The engine's `AuditStore` for one org, for the run that org started. */
	static readonly auditStoreFor = (orgId: OrgId): Layer.Layer<AuditStore, never, SecurityAuditStore> =>
		Layer.effect(
			AuditStore,
			Effect.gen(function* () {
				const store = yield* SecurityAuditStore
				return store.forOrg(orgId)
			}),
		)
}
