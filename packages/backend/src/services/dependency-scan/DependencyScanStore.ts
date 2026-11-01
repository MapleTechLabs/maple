/**
 * Postgres persistence for the dependency scanner: scans, the vulnerable packages each one found,
 * and the findings a default-branch head reconciles. Every method takes the org and filters by it.
 */
import type { AdvisorySeverity, PackageEcosystem } from "@maple/domain/package-advisories"
import {
	DependencyFindingId,
	DependencyScanId,
	type DependencyFindingStatus,
	type DependencyFindingTriageStatus,
	type DependencyRelation,
	type DependencyScanLockfile,
	type DependencyScanTrigger,
} from "@maple/domain/dependency-scan"
import type { GitCommitSha, VcsRepositoryId } from "@maple/domain/http/vcs"
import type { OrgId, UserId } from "@maple/domain/primitives"
import {
	DependencyFindings,
	DependencyScanMatches,
	DependencyScans,
	type DependencyFindingRow,
	type DependencyScanMatchRow,
	type DependencyScanRow,
} from "@maple/db/tables"
import type { MapleDb } from "@maple/db/client"
import * as Orm from "@maple-dev/effect-orm/database"
import * as PG from "@maple-dev/effect-orm/postgres"
import { Array as Arr, Clock, Context, Effect, Layer, Option, Order, Schema } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute, makePersistenceErrorMapper } from "@maple/backend/platform/db-execute"

export class DependencyScanPersistenceError extends Schema.TaggedError<DependencyScanPersistenceError>()(
	"@maple/dependency-scan/DependencyScanPersistenceError",
	{ message: Schema.String, cause: Schema.optionalKey(Schema.Defect()) },
) {}

export class DependencyScanNotFoundError extends Schema.TaggedError<DependencyScanNotFoundError>()(
	"@maple/dependency-scan/DependencyScanNotFoundError",
	{ message: Schema.String, scanId: DependencyScanId },
) {}

/** A scan that already completed or failed takes no further writes. */
export class DependencyScanNotRunningError extends Schema.TaggedError<DependencyScanNotRunningError>()(
	"@maple/dependency-scan/DependencyScanNotRunningError",
	{ message: Schema.String, scanId: DependencyScanId },
) {}

export class DependencyFindingNotFoundError extends Schema.TaggedError<DependencyFindingNotFoundError>()(
	"@maple/dependency-scan/DependencyFindingNotFoundError",
	{ message: Schema.String, findingId: DependencyFindingId },
) {}

export interface StartScanInput {
	readonly orgId: OrgId
	readonly repositoryId: VcsRepositoryId
	readonly commitSha: GitCommitSha
	/** The branch scanned; null for a bare commit. */
	readonly ref: string | null
	readonly trigger: DependencyScanTrigger
	/** Whether this scan reconciles the repository's findings. */
	readonly defaultBranchHead: boolean
}

/** One vulnerable package version one lockfile pins, matched to one advisory. */
export interface DependencyScanMatchInput {
	readonly lockfilePath: string
	readonly ecosystem: PackageEcosystem
	readonly packageName: string
	readonly version: string
	readonly relation: DependencyRelation
	/** The OSV id. */
	readonly advisoryId: string
	readonly aliases: ReadonlyArray<string>
	readonly severity: AdvisorySeverity
	readonly summary: string | null
	readonly fixedIn: string | null
}

export interface CompleteScanInput {
	readonly orgId: OrgId
	readonly scanId: DependencyScanId
	readonly lockfiles: ReadonlyArray<DependencyScanLockfile>
	readonly packageCount: number
	readonly matches: ReadonlyArray<DependencyScanMatchInput>
	/** Why the matches are not the whole answer; such a scan stores them but reconciles nothing. */
	readonly incomplete?: string | undefined
}

export interface SetFindingStatusInput {
	readonly orgId: OrgId
	readonly id: DependencyFindingId
	readonly status: DependencyFindingTriageStatus
	readonly reason: string | null
	readonly actor: UserId
}

export interface DependencyScanStoreApi {
	readonly startScan: (
		input: StartScanInput,
	) => Effect.Effect<DependencyScanRow, DependencyScanPersistenceError>
	/** Stores the matches and settles the scan in one transaction; a default-branch head reconciles findings. */
	readonly completeScan: (
		input: CompleteScanInput,
	) => Effect.Effect<
		DependencyScanRow,
		DependencyScanPersistenceError | DependencyScanNotFoundError | DependencyScanNotRunningError
	>
	readonly failScan: (input: {
		readonly orgId: OrgId
		readonly scanId: DependencyScanId
		readonly error: string
	}) => Effect.Effect<
		DependencyScanRow,
		DependencyScanPersistenceError | DependencyScanNotFoundError | DependencyScanNotRunningError
	>
	/** Most severe first, then most recently updated. */
	readonly listFindings: (input: {
		readonly orgId: OrgId
		readonly repositoryId?: VcsRepositoryId | undefined
		/** Only these repositories, so the limit is spent on them; an empty list reads nothing. */
		readonly repositoryIds?: ReadonlyArray<VcsRepositoryId> | undefined
		readonly status?: DependencyFindingStatus | undefined
		readonly limit: number
	}) => Effect.Effect<ReadonlyArray<DependencyFindingRow>, DependencyScanPersistenceError>
	readonly getFinding: (input: {
		readonly orgId: OrgId
		readonly id: DependencyFindingId
	}) => Effect.Effect<Option.Option<DependencyFindingRow>, DependencyScanPersistenceError>
	readonly setFindingStatus: (
		input: SetFindingStatusInput,
	) => Effect.Effect<DependencyFindingRow, DependencyScanPersistenceError | DependencyFindingNotFoundError>
	/** Newest first. */
	readonly listScans: (input: {
		readonly orgId: OrgId
		readonly repositoryId?: VcsRepositoryId
		readonly limit: number
	}) => Effect.Effect<ReadonlyArray<DependencyScanRow>, DependencyScanPersistenceError>
	/** The repository's latest completed scan, optionally at one commit: its lockfile blobs say what changed. */
	readonly latestScan: (input: {
		readonly orgId: OrgId
		readonly repositoryId: VcsRepositoryId
		readonly commitSha?: GitCommitSha
		/** Only scans of the tracked branch head (true) or only scans of other commits (false). */
		readonly defaultBranchHead?: boolean
	}) => Effect.Effect<Option.Option<DependencyScanRow>, DependencyScanPersistenceError>
	/** Each repository's newest scan of its tracked branch head, any status. */
	readonly latestBranchScans: (input: {
		readonly orgId: OrgId
	}) => Effect.Effect<ReadonlyArray<DependencyScanRow>, DependencyScanPersistenceError>
	readonly scanMatches: (input: {
		readonly orgId: OrgId
		readonly scanId: DependencyScanId
	}) => Effect.Effect<ReadonlyArray<DependencyScanMatchRow>, DependencyScanPersistenceError>
	/** Every scan of these repositories at these commits, any status, newest first. */
	readonly scansAtCommits: (input: {
		readonly orgId: OrgId
		readonly repositoryIds: ReadonlyArray<VcsRepositoryId>
		readonly commitShas: ReadonlyArray<GitCommitSha>
	}) => Effect.Effect<ReadonlyArray<DependencyScanRow>, DependencyScanPersistenceError>
	/** The matches of several scans in one read. */
	readonly matchesOfScans: (input: {
		readonly orgId: OrgId
		readonly scanIds: ReadonlyArray<DependencyScanId>
	}) => Effect.Effect<ReadonlyArray<DependencyScanMatchRow>, DependencyScanPersistenceError>
}

const toPersistenceError = makePersistenceErrorMapper(
	DependencyScanPersistenceError,
	"Dependency scan store operation failed",
)

const newScanId = () => Schema.decodeSync(DependencyScanId)(crypto.randomUUID())

/** Rows per statement: ~20 binds each keeps one insert far under Postgres's 65,535. */
const WRITE_CHUNK = 1000

const SEVERITY_RANK = {
	critical: 0,
	high: 1,
	medium: 2,
	low: 3,
	unknown: 4,
} satisfies Record<AdvisorySeverity, number>

const RELATION_RANK = {
	direct: 0,
	dev: 1,
	transitive: 2,
	unknown: 3,
} satisfies Record<DependencyRelation, number>

/** SHA-256 of `text` as lowercase hex, through Web Crypto so it runs in Workers and Node. */
const sha256Hex = (text: string) =>
	Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))).pipe(
		Effect.map((digest) =>
			Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
		),
	)

/** The finding's id from its key, so a replayed or concurrent scan lands on the same row. */
const findingId = (orgId: OrgId, repositoryId: VcsRepositoryId, match: DependencyScanMatchInput) =>
	sha256Hex(
		JSON.stringify([
			orgId,
			repositoryId,
			match.lockfilePath,
			match.ecosystem,
			match.packageName,
			match.advisoryId,
		]),
	).pipe(Effect.map((hex) => Schema.decodeSync(DependencyFindingId)(hex.slice(0, 32))))

const findingKey = (match: DependencyScanMatchInput) =>
	JSON.stringify([match.lockfilePath, match.ecosystem, match.packageName, match.advisoryId])

/**
 * OSV can later link a new record to an advisory a finding already tracks (a GO- entry gains its
 * GHSA). A match whose ids overlap a known finding of the same package keeps that finding's id,
 * so it is not closed and reopened under a new one, losing its triage.
 */
const keepKnownAdvisoryId = (
	match: DependencyScanMatchInput,
	known: ReadonlyArray<
		Pick<DependencyFindingRow, "lockfilePath" | "ecosystem" | "packageName" | "advisoryId" | "aliases">
	>,
): DependencyScanMatchInput => {
	const names = new Set([match.advisoryId, ...match.aliases])
	const samePackage = known.filter(
		(finding) =>
			finding.lockfilePath === match.lockfilePath &&
			finding.ecosystem === match.ecosystem &&
			finding.packageName === match.packageName,
	)
	// An exact id wins; an alias overlap only renames a match no finding tracks by its own id.
	const same =
		samePackage.find((finding) => finding.advisoryId === match.advisoryId) ??
		samePackage.find((finding) =>
			[finding.advisoryId, ...finding.aliases].some((name) => names.has(name)),
		)
	if (same === undefined || same.advisoryId === match.advisoryId) return match
	return {
		...match,
		advisoryId: same.advisoryId,
		aliases: [...names].filter((name) => name !== same.advisoryId).sort(),
	}
}

const matchKey = (match: DependencyScanMatchInput) =>
	JSON.stringify([match.lockfilePath, match.ecosystem, match.packageName, match.version, match.advisoryId])

const firstNonNull = (values: ReadonlyArray<string | null>) => values.find((value) => value !== null) ?? null

/** One finding's fields from the matches that share its key: every version, the worst severity. */
const aggregate = (matches: Arr.NonEmptyReadonlyArray<DependencyScanMatchInput>) => ({
	head: matches[0],
	aliases: Arr.sort(Arr.dedupe(matches.flatMap((match) => match.aliases)), Order.String),
	versions: Arr.sort(Arr.dedupe(matches.map((match) => match.version)), Order.String),
	severity: Arr.reduce(matches, matches[0].severity, (worst, match) =>
		SEVERITY_RANK[match.severity] < SEVERITY_RANK[worst] ? match.severity : worst,
	),
	relation: Arr.reduce(matches, matches[0].relation, (strongest, match) =>
		RELATION_RANK[match.relation] < RELATION_RANK[strongest] ? match.relation : strongest,
	),
	summary: firstNonNull(matches.map((match) => match.summary)),
	fixedIn: firstNonNull(matches.map((match) => match.fixedIn)),
})

/** The org's scan, locked for the caller's transaction; fails when it is missing or already settled. */
const lockRunningScan = (db: MapleDb, orgId: OrgId, scanId: DependencyScanId) =>
	Effect.gen(function* () {
		const rows = yield* db.run(
			PG.from(DependencyScans)
				.select()
				.where(($) => [$.orgId.eq(orgId), $.id.eq(scanId)])
				.limit(1)
				.forUpdate(),
		)
		const row = rows[0]
		if (row === undefined) {
			return yield* new DependencyScanNotFoundError({
				message: `Dependency scan ${scanId} not found`,
				scanId,
			})
		}
		if (row.status !== "running") {
			return yield* new DependencyScanNotRunningError({
				message: `Dependency scan ${scanId} already ${row.status}`,
				scanId,
			})
		}
		return row
	})

const settledRow = (rows: ReadonlyArray<DependencyScanRow>, scanId: DependencyScanId) =>
	rows[0] === undefined
		? Effect.fail(
				new DependencyScanPersistenceError({ message: `Dependency scan ${scanId} was not updated` }),
			)
		: Effect.succeed(rows[0])

type FindingGroup = ReturnType<typeof aggregate> & { readonly id: DependencyFindingId }

/**
 * Brings the repository's findings in line with a default-branch head scan: matched keys open (a
 * `fixed` one reopens, a triaged one keeps its status), and open ones no longer matched are fixed
 * unless their lockfile could not be read this time.
 */
const reconcileFindings = (
	db: MapleDb,
	scan: DependencyScanRow,
	lockfiles: ReadonlyArray<DependencyScanLockfile>,
	groups: ReadonlyArray<FindingGroup>,
	now: number,
) =>
	Effect.gen(function* () {
		const orgId = scan.orgId
		const open = yield* db.run(
			PG.from(DependencyFindings)
				.select("id", "lockfilePath", "ecosystem", "packageName", "advisoryId", "aliases")
				.where(($) => [$.orgId.eq(orgId), $.repositoryId.eq(scan.repositoryId), $.status.eq("open")]),
		)
		yield* Effect.forEach(Arr.chunksOf(groups, WRITE_CHUNK), (chunk) =>
			db.run(
				PG.insertInto(DependencyFindings)
					.values(
						chunk.map((group) => ({
							id: group.id,
							orgId,
							repositoryId: scan.repositoryId,
							lockfilePath: group.head.lockfilePath,
							ecosystem: group.head.ecosystem,
							packageName: group.head.packageName,
							advisoryId: group.head.advisoryId,
							aliases: group.aliases,
							severity: group.severity,
							summary: group.summary,
							versions: group.versions,
							fixedIn: group.fixedIn,
							relation: group.relation,
							status: "open" as const,
							firstSeenScanId: scan.id,
							lastSeenScanId: scan.id,
							firstSeenSha: scan.commitSha,
							lastSeenSha: scan.commitSha,
							fixedScanId: null,
							fixedSha: null,
							createdAt: now,
							updatedAt: now,
						})),
					)
					.onConflictDoUpdate({
						target: ["repositoryId", "lockfilePath", "ecosystem", "packageName", "advisoryId"],
						set: ($, excluded) => ({
							aliases: excluded.aliases,
							severity: excluded.severity,
							summary: excluded.summary,
							versions: excluded.versions,
							fixedIn: excluded.fixedIn,
							relation: excluded.relation,
							lastSeenScanId: excluded.lastSeenScanId,
							lastSeenSha: excluded.lastSeenSha,
							updatedAt: excluded.updatedAt,
							status: PG.caseWhen(
								[
									[
										$.status.eq("fixed"),
										PG.typedValue(DependencyFindings.columns.status, "open"),
									],
								],
								$.status,
							),
							fixedScanId: PG.caseWhen(
								[
									[
										$.status.eq("fixed"),
										PG.typedValue(DependencyFindings.columns.fixedScanId, null),
									],
								],
								$.fixedScanId,
							),
							fixedSha: PG.caseWhen(
								[
									[
										$.status.eq("fixed"),
										PG.typedValue(DependencyFindings.columns.fixedSha, null),
									],
								],
								$.fixedSha,
							),
						}),
						where: ($) => $.orgId.eq(orgId),
					}),
			),
		)
		// A lockfile that failed, was too large or unsupported says nothing about its findings.
		const lockfileStatus = new Map(lockfiles.map((lockfile) => [lockfile.path, lockfile.status]))
		const matched = new Set(groups.map((group) => group.id))
		// A finding OSV now lists only as another advisory's alias is still matched, not fixed.
		const matchedNames = groups.map((group) => ({
			key: JSON.stringify([group.head.lockfilePath, group.head.ecosystem, group.head.packageName]),
			names: new Set([group.head.advisoryId, ...group.aliases]),
		}))
		const namedByMatch = (row: (typeof open)[number]) => {
			const key = JSON.stringify([row.lockfilePath, row.ecosystem, row.packageName])
			return matchedNames.some(
				(group) =>
					group.key === key &&
					[row.advisoryId, ...row.aliases].some((name) => group.names.has(name)),
			)
		}
		const fixedIds = open
			.filter((row) => !matched.has(row.id) && !namedByMatch(row))
			.filter((row) => {
				const status = lockfileStatus.get(row.lockfilePath)
				return status === undefined || status === "parsed"
			})
			.map((row) => row.id)
		yield* Effect.forEach(Arr.chunksOf(fixedIds, WRITE_CHUNK), (chunk) =>
			db.run(
				PG.update(DependencyFindings)
					.set({ status: "fixed", fixedScanId: scan.id, fixedSha: scan.commitSha, updatedAt: now })
					.where(($) => [$.orgId.eq(orgId), $.status.eq("open"), $.id.in_(...chunk)]),
			),
		)
	})

export class DependencyScanStore extends Context.Service<DependencyScanStore, DependencyScanStoreApi>()(
	"@maple/backend/services/dependency-scan/DependencyScanStore",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const dbExecute = makeDbExecute(database, "DependencyScanStore", toPersistenceError)

			const startScan: DependencyScanStoreApi["startScan"] = Effect.fn("DependencyScanStore.startScan")(
				function* (input) {
					const now = yield* Clock.currentTimeMillis
					const rows = yield* dbExecute((db) =>
						db.run(
							PG.insertInto(DependencyScans)
								.values({
									id: newScanId(),
									orgId: input.orgId,
									repositoryId: input.repositoryId,
									commitSha: input.commitSha,
									ref: input.ref,
									trigger: input.trigger,
									defaultBranchHead: input.defaultBranchHead,
									status: "running",
									lockfiles: [],
									packageCount: 0,
									vulnerableCount: 0,
									error: null,
									startedAt: now,
									finishedAt: null,
								})
								.returning(),
						),
					)
					const row = rows[0]
					if (row === undefined) {
						return yield* new DependencyScanPersistenceError({
							message: "Dependency scan was not created",
						})
					}
					return row
				},
			)

			const completeScan: DependencyScanStoreApi["completeScan"] = Effect.fn(
				"DependencyScanStore.completeScan",
			)(function* (input) {
				const { orgId, scanId } = input
				const now = yield* Clock.currentTimeMillis
				return yield* dbExecute((db) =>
					db.transaction(
						Effect.gen(function* () {
							const scan = yield* lockRunningScan(db, orgId, scanId)
							// Scans of one repository settle one at a time, so reconciling sees the last word.
							yield* db.execute(
								Orm.sql`select pg_advisory_xact_lock(hashtext(${scan.repositoryId}), hashtext('dependency_scan'))`,
							)
							const known = yield* db.run(
								PG.from(DependencyFindings)
									.select(
										"lockfilePath",
										"ecosystem",
										"packageName",
										"advisoryId",
										"aliases",
									)
									.where(($) => [$.orgId.eq(orgId), $.repositoryId.eq(scan.repositoryId)]),
							)
							// One row per primary key; a repeated match keeps its last copy.
							const matches = Array.from(
								new Map(
									input.matches.map((m) => {
										const kept = keepKnownAdvisoryId(m, known)
										return [matchKey(kept), kept] as const
									}),
								).values(),
							)
							const vulnerableCount = new Set(
								matches.map((m) =>
									JSON.stringify([m.lockfilePath, m.ecosystem, m.packageName, m.version]),
								),
							).size
							yield* Effect.forEach(Arr.chunksOf(matches, WRITE_CHUNK), (chunk) =>
								db.run(
									PG.insertInto(DependencyScanMatches)
										.values(chunk.map((match) => ({ ...match, scanId, orgId })))
										.onConflictDoNothing(),
								),
							)
							// A slower scan of an older head must not undo what a newer one settled.
							const newer = scan.defaultBranchHead
								? yield* db.run(
										PG.from(DependencyScans)
											.select("id")
											.where(($) => [
												$.orgId.eq(orgId),
												$.repositoryId.eq(scan.repositoryId),
												$.defaultBranchHead.eq(true),
												$.status.eq("completed"),
												$.startedAt.gt(scan.startedAt),
											])
											.limit(1),
									)
								: []
							if (
								scan.defaultBranchHead &&
								newer.length === 0 &&
								input.incomplete === undefined
							) {
								const groups = yield* Effect.forEach(
									Object.values(Arr.groupBy(matches, findingKey)),
									(group) =>
										findingId(orgId, scan.repositoryId, group[0]).pipe(
											Effect.map((id) => ({ ...aggregate(group), id })),
										),
								)
								yield* reconcileFindings(db, scan, input.lockfiles, groups, now)
							}
							const rows = yield* db.run(
								PG.update(DependencyScans)
									.set({
										status: "completed",
										lockfiles: input.lockfiles,
										packageCount: input.packageCount,
										vulnerableCount,
										error: input.incomplete ?? null,
										finishedAt: now,
									})
									.where(($) => [$.orgId.eq(orgId), $.id.eq(scanId)])
									.returning(),
							)
							return yield* settledRow(rows, scanId)
						}),
					),
				)
			})

			const failScan: DependencyScanStoreApi["failScan"] = Effect.fn("DependencyScanStore.failScan")(
				function* (input) {
					const now = yield* Clock.currentTimeMillis
					return yield* dbExecute((db) =>
						db.transaction(
							Effect.gen(function* () {
								yield* lockRunningScan(db, input.orgId, input.scanId)
								const rows = yield* db.run(
									PG.update(DependencyScans)
										.set({ status: "failed", error: input.error, finishedAt: now })
										.where(($) => [$.orgId.eq(input.orgId), $.id.eq(input.scanId)])
										.returning(),
								)
								return yield* settledRow(rows, input.scanId)
							}),
						),
					)
				},
			)

			const listFindings: DependencyScanStoreApi["listFindings"] = Effect.fn(
				"DependencyScanStore.listFindings",
			)(function* (input) {
				const repositoryIds = input.repositoryIds
				if (repositoryIds !== undefined && repositoryIds.length === 0) return []
				return yield* dbExecute((db) =>
					db.run(
						PG.from(DependencyFindings)
							.select()
							.where(($) => [
								$.orgId.eq(input.orgId),
								input.repositoryId === undefined
									? undefined
									: $.repositoryId.eq(input.repositoryId),
								repositoryIds === undefined
									? undefined
									: $.repositoryId.in_(...repositoryIds),
								input.status === undefined ? undefined : $.status.eq(input.status),
							])
							.orderBy(($) => [
								[
									PG.caseWhen(
										[
											[$.severity.eq("critical"), PG.lit(SEVERITY_RANK.critical)],
											[$.severity.eq("high"), PG.lit(SEVERITY_RANK.high)],
											[$.severity.eq("medium"), PG.lit(SEVERITY_RANK.medium)],
											[$.severity.eq("low"), PG.lit(SEVERITY_RANK.low)],
										],
										PG.lit(SEVERITY_RANK.unknown),
									),
									"asc",
								],
								[$.updatedAt, "desc"],
								[$.id, "asc"],
							])
							.limit(input.limit),
					),
				)
			})

			const getFinding: DependencyScanStoreApi["getFinding"] = Effect.fn(
				"DependencyScanStore.getFinding",
			)(function* (input) {
				const rows = yield* dbExecute((db) =>
					db.run(
						PG.from(DependencyFindings)
							.select()
							.where(($) => [$.orgId.eq(input.orgId), $.id.eq(input.id)])
							.limit(1),
					),
				)
				return Option.fromUndefinedOr(rows[0])
			})

			const setFindingStatus: DependencyScanStoreApi["setFindingStatus"] = Effect.fn(
				"DependencyScanStore.setFindingStatus",
			)(function* (input) {
				const now = yield* Clock.currentTimeMillis
				const rows = yield* dbExecute((db) =>
					db.run(
						PG.update(DependencyFindings)
							.set({
								status: input.status,
								statusReason: input.reason,
								statusChangedBy: input.actor,
								statusChangedAt: now,
								// A person's triage is not the scan that closed it.
								fixedScanId: null,
								fixedSha: null,
								updatedAt: now,
							})
							.where(($) => [$.orgId.eq(input.orgId), $.id.eq(input.id)])
							.returning(),
					),
				)
				const row = rows[0]
				if (row === undefined) {
					return yield* new DependencyFindingNotFoundError({
						message: `Dependency finding ${input.id} not found`,
						findingId: input.id,
					})
				}
				return row
			})

			const listScans: DependencyScanStoreApi["listScans"] = Effect.fn("DependencyScanStore.listScans")(
				function* (input) {
					return yield* dbExecute((db) =>
						db.run(
							PG.from(DependencyScans)
								.select()
								.where(($) => [
									$.orgId.eq(input.orgId),
									input.repositoryId === undefined
										? undefined
										: $.repositoryId.eq(input.repositoryId),
								])
								.orderBy(($) => [
									[$.startedAt, "desc"],
									[$.id, "asc"],
								])
								.limit(input.limit),
						),
					)
				},
			)

			const latestScan: DependencyScanStoreApi["latestScan"] = Effect.fn(
				"DependencyScanStore.latestScan",
			)(function* (input) {
				const rows = yield* dbExecute((db) =>
					db.run(
						PG.from(DependencyScans)
							.select()
							.where(($) => [
								$.orgId.eq(input.orgId),
								$.repositoryId.eq(input.repositoryId),
								$.status.eq("completed"),
								input.commitSha === undefined ? undefined : $.commitSha.eq(input.commitSha),
								input.defaultBranchHead === undefined
									? undefined
									: $.defaultBranchHead.eq(input.defaultBranchHead),
							])
							.orderBy(($) => [
								[$.startedAt, "desc"],
								[$.id, "asc"],
							])
							.limit(1),
					),
				)
				return Option.fromUndefinedOr(rows[0])
			})

			const scanMatches: DependencyScanStoreApi["scanMatches"] = Effect.fn(
				"DependencyScanStore.scanMatches",
			)(function* (input) {
				return yield* dbExecute((db) =>
					db.run(
						PG.from(DependencyScanMatches)
							.select()
							.where(($) => [$.orgId.eq(input.orgId), $.scanId.eq(input.scanId)])
							.orderBy(($) => [
								[$.lockfilePath, "asc"],
								[$.packageName, "asc"],
								[$.version, "asc"],
								[$.advisoryId, "asc"],
							]),
					),
				)
			})

			const latestBranchScans: DependencyScanStoreApi["latestBranchScans"] = Effect.fn(
				"DependencyScanStore.latestBranchScans",
			)(function* (input) {
				return yield* dbExecute((db) =>
					db.run(
						PG.from(DependencyScans)
							.select()
							.distinctOn("repositoryId")
							.where(($) => [$.orgId.eq(input.orgId), $.defaultBranchHead.eq(true)])
							.orderBy(($) => [
								[$.repositoryId, "asc"],
								[$.startedAt, "desc"],
								[$.id, "asc"],
							]),
					),
				)
			})

			const scansAtCommits: DependencyScanStoreApi["scansAtCommits"] = Effect.fn(
				"DependencyScanStore.scansAtCommits",
			)(function* (input) {
				if (input.repositoryIds.length === 0 || input.commitShas.length === 0) return []
				return yield* dbExecute((db) =>
					db.run(
						PG.from(DependencyScans)
							.select()
							.where(($) => [
								$.orgId.eq(input.orgId),
								$.repositoryId.in_(...new Set(input.repositoryIds)),
								$.commitSha.in_(...new Set(input.commitShas)),
							])
							.orderBy(($) => [
								[$.startedAt, "desc"],
								[$.id, "asc"],
							]),
					),
				)
			})

			const matchesOfScans: DependencyScanStoreApi["matchesOfScans"] = Effect.fn(
				"DependencyScanStore.matchesOfScans",
			)(function* (input) {
				if (input.scanIds.length === 0) return []
				return yield* dbExecute((db) =>
					db.run(
						PG.from(DependencyScanMatches)
							.select()
							.where(($) => [$.orgId.eq(input.orgId), $.scanId.in_(...new Set(input.scanIds))]),
					),
				)
			})

			return {
				latestBranchScans,
				scansAtCommits,
				matchesOfScans,
				startScan,
				completeScan,
				failScan,
				listFindings,
				getFinding,
				setFindingStatus,
				listScans,
				latestScan,
				scanMatches,
			}
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
