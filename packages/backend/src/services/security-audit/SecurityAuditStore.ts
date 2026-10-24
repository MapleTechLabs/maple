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
	type SecurityAuditRunKind,
	SecurityAuditTargetId,
} from "@maple/domain/security-audit"
import {
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
	) => Effect.Effect<SecurityAuditTargetRow, AuditStoreError>
	readonly startRun: (input: StartRunInput) => Effect.Effect<SecurityAuditRunRow, AuditStoreError>
	readonly finishRun: (runId: string, outcome: FinishRunOutcome) => Effect.Effect<void, AuditStoreError>
	readonly addUsage: (runId: string, usage: RunUsage) => Effect.Effect<void, AuditStoreError>
	readonly getRun: (runId: string) => Effect.Effect<Option.Option<SecurityAuditRunRow>, AuditStoreError>
	readonly listRuns: (options?: {
		readonly targetId?: SecurityAuditTargetId
		readonly limit?: number
	}) => Effect.Effect<ReadonlyArray<SecurityAuditRunRow>, AuditStoreError>
	readonly listUnits: (runId: string) => Effect.Effect<ReadonlyArray<SecurityAuditUnitRow>, AuditStoreError>
	/** One run's final records, the input a later run carries forward. */
	readonly listRunFindings: (runId: string) => Effect.Effect<ReadonlyArray<Finding>, AuditStoreError>
	readonly listEvents: (
		runId: string,
	) => Effect.Effect<ReadonlyArray<SecurityAuditEventRow>, AuditStoreError>
	readonly listFindings: (
		targetId: SecurityAuditTargetId,
	) => Effect.Effect<ReadonlyArray<SecurityAuditFindingRow>, AuditStoreError>
	/** Findings a revalidation no longer finds: open ones become `fixed`; returns how many did. */
	readonly markFixed: (
		targetId: SecurityAuditTargetId,
		fingerprints: ReadonlyArray<string>,
		runId: string,
	) => Effect.Effect<number, AuditStoreError>
}

export interface SecurityAuditStoreApi {
	readonly forOrg: (orgId: OrgId) => SecurityAuditOrgStore
}

const DEFAULT_RUN_LIST_LIMIT = 50

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
						// `status` is the row's lifecycle, settled by finishRun; the engine's stays in metadata.
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
									if (!Arr.isReadonlyArrayNonEmpty(ledger)) return
									yield* db.run(
										PG.insertInto(SecurityAuditUnits).values(
											Arr.map(ledger, (unit) => ({
												runId,
												coverageId: unit.coverage_id,
												orgId,
												status: unit.status,
												wave: unit.wave,
												agentId: unit.agent_id,
												unit,
											})),
										),
									)
								}),
							),
						)
					},
				)

				/**
				 * Replaces the run's findings, then folds them into the target's lifecycle rows: a new
				 * fingerprint opens, a `fixed` one regresses to open, dismissed and accepted stay put.
				 * Lifecycle rows this run created that its latest save dropped are removed again while
				 * still open; a triaged one (dismissed, accepted) stays.
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
										$.status.eq("open"),
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
								.returning(),
						),
					)
					return yield* firstOrFail(rows, "Security audit target insert returned no row")
				})

				const startRun: SecurityAuditOrgStore["startRun"] = Effect.fn("SecurityAuditStore.startRun")(
					function* (input) {
						const now = yield* Clock.currentTimeMillis
						const runId = input.runId ?? newRunId()
						return yield* dbExecute((db) =>
							db.transaction(
								Effect.gen(function* () {
									const targets = yield* db.run(
										PG.from(SecurityAuditTargets)
											.select("profile", "scopePaths", "budgetPerRun")
											.where(($) => [$.orgId.eq(orgId), $.id.eq(input.targetId)])
											.limit(1),
									)
									const target = yield* firstOrFail(
										targets,
										`Security audit target ${input.targetId} not found`,
									)
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
											.onConflictDoNothing({ target: ["id"] }),
									)
									const runs = yield* db.run(
										PG.from(SecurityAuditRuns)
											.select()
											.where(($) => [$.orgId.eq(orgId), $.id.eq(runId)])
											.limit(1),
									)
									return yield* firstOrFail(
										runs,
										`Security audit run ${runId} belongs to another org`,
									)
								}),
							),
						)
					},
				)

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

				const addUsage: SecurityAuditOrgStore["addUsage"] = Effect.fn("SecurityAuditStore.addUsage")(
					function* (rawRunId, usage) {
						const runId = yield* decodeRunId(rawRunId)
						const cost = usage.costUsd
						const rows = yield* dbExecute((db) =>
							db.run(
								PG.update(SecurityAuditRuns)
									.set(($) => ({
										invocationsSpent: $.invocationsSpent.add(usage.invocations),
										inputTokens: $.inputTokens.add(usage.inputTokens),
										outputTokens: $.outputTokens.add(usage.outputTokens),
										costUsd:
											cost === undefined
												? undefined
												: PG.coalesce($.costUsd, PG.lit(0)).add(cost),
									}))
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
								PG.from(SecurityAuditRuns)
									.select()
									.where(($) => [$.orgId.eq(orgId), $.id.eq(runId)])
									.limit(1),
							),
						)
						return Option.fromUndefinedOr(rows[0])
					},
				)

				const listRuns: SecurityAuditOrgStore["listRuns"] = Effect.fn("SecurityAuditStore.listRuns")(
					function* (options) {
						const targetId = options?.targetId
						return yield* dbExecute((db) =>
							db.run(
								PG.from(SecurityAuditRuns)
									.select()
									.where(($) => [
										$.orgId.eq(orgId),
										targetId === undefined ? undefined : $.targetId.eq(targetId),
									])
									.orderBy(($) => [[$.startedAt, "desc"]])
									.limit(options?.limit ?? DEFAULT_RUN_LIST_LIMIT),
							),
						)
					},
				)

				const listUnits: SecurityAuditOrgStore["listUnits"] = Effect.fn(
					"SecurityAuditStore.listUnits",
				)(function* (rawRunId) {
					const runId = yield* decodeRunId(rawRunId)
					return yield* dbExecute((db) =>
						db.run(
							PG.from(SecurityAuditUnits)
								.select()
								.where(($) => [$.orgId.eq(orgId), $.runId.eq(runId)])
								.orderBy(($) => [[$.coverageId, "asc"]]),
						),
					)
				})

				const listRunFindings: SecurityAuditOrgStore["listRunFindings"] = Effect.fn(
					"SecurityAuditStore.listRunFindings",
				)(function* (rawRunId) {
					const runId = yield* decodeRunId(rawRunId)
					const rows = yield* dbExecute((db) =>
						db.run(
							PG.from(SecurityAuditRunFindings)
								.select()
								.where(($) => [$.orgId.eq(orgId), $.runId.eq(runId)])
								.orderBy(($) => [[$.fingerprint, "asc"]]),
						),
					)
					return rows.map((row) => row.record)
				})

				const listEvents: SecurityAuditOrgStore["listEvents"] = Effect.fn(
					"SecurityAuditStore.listEvents",
				)(function* (rawRunId) {
					const runId = yield* decodeRunId(rawRunId)
					return yield* dbExecute((db) =>
						db.run(
							PG.from(SecurityAuditEvents)
								.select()
								.where(($) => [$.orgId.eq(orgId), $.runId.eq(runId)])
								// Ties (one millisecond) break on the id, so a read's order is stable.
								.orderBy(($) => [
									[$.at, "asc"],
									[$.id, "asc"],
								]),
						),
					)
				})

				const listFindings: SecurityAuditOrgStore["listFindings"] = Effect.fn(
					"SecurityAuditStore.listFindings",
				)(function* (targetId) {
					return yield* dbExecute((db) =>
						db.run(
							PG.from(SecurityAuditFindings)
								.select()
								.where(($) => [$.orgId.eq(orgId), $.targetId.eq(targetId)])
								.orderBy(($) => [
									[$.createdAt, "asc"],
									[$.fingerprint, "asc"],
								]),
						),
					)
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

				return {
					saveMetadata,
					saveArchitecture,
					saveLedger,
					saveFindings,
					saveReports,
					recordEvent,
					createTarget,
					startRun,
					finishRun,
					addUsage,
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
