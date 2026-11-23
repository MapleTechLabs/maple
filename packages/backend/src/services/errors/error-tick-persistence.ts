import { randomUUID } from "node:crypto"
import * as Orm from "@maple-dev/effect-orm/database"
import * as PG from "@maple-dev/effect-orm/postgres"
import {
	ErrorFingerprintCandidates,
	ErrorIncidents,
	ErrorIssueFingerprints,
	ErrorIssues,
	ErrorIssueEvents,
	ErrorIssueStates,
	ErrorNotificationDeliveries,
	ErrorTickStates,
	type ErrorFingerprintCandidateRow,
	type ErrorIssueEventInsert,
	type ErrorIssueRow,
	type ErrorNotificationPolicyRow,
} from "@maple/db/tables"
import type { MapleDb, MapleDbError } from "@maple/db/client"
import { msToSqlTimestamp } from "@maple/backend/platform/time"
import type {
	ActorId,
	AlertDestinationId,
	ErrorIncidentId,
	ErrorIncidentReason,
	ErrorIssueEventId,
	ErrorIssueId,
	WorkflowState,
	IssueSeverity,
	OrgId,
} from "@maple/domain/http"
import { FINGERPRINT_VERSION } from "@maple/domain/tinybird/fingerprint"
import { foldIssues } from "./issue-fold"
import { MAX_TRACKED_VERSIONS, mergeVersions } from "./issue-versions"
import { regressedColumns } from "./issue-reopen"
import { Array as Arr, Context, Effect, Order, Schema } from "effect"

export interface ErrorTickScanRow {
	readonly fingerprintHash: string
	/** The hashes the previous fingerprint version gave this error, while a bump settles. */
	readonly previousFingerprintHashes?: ReadonlyArray<string> | undefined
	/** Other hashes sharing this one's grouping key (`grouping-keys.ts`): one issue's. */
	readonly groupedFingerprintHashes?: ReadonlyArray<string> | undefined
	readonly serviceName: string
	readonly exceptionType: string
	readonly exceptionMessage: string
	readonly errorLabel: string
	readonly topFrame: string
	/** Every distinct build the fingerprint was seen from in this window. */
	readonly serviceVersions: ReadonlyArray<string>
	readonly count: number
	readonly firstSeenMs: number
	readonly lastSeenMs: number
}

export interface PendingErrorTriage {
	readonly issueId: ErrorIssueId
	readonly incidentId: ErrorIncidentId
	readonly reason: ErrorIncidentReason
	readonly severity: IssueSeverity | null
	readonly row: ErrorTickScanRow
}

interface NotificationPayload {
	readonly kind: "open" | "resolve"
	readonly issueId: string
	readonly incidentId: string
	readonly serviceName: string
	readonly exceptionType: string
	readonly severity: "warning" | "critical"
	readonly threshold: number
	readonly count: number
}

export interface PersistErrorTickWindowInput {
	readonly orgId: OrgId
	readonly actorId: ActorId
	readonly rows: ReadonlyArray<ErrorTickScanRow>
	readonly policy: ErrorNotificationPolicyRow
	readonly destinationIds: ReadonlyArray<AlertDestinationId>
	readonly windowEndMs: number
	readonly autoResolveMinutes: number
	readonly claimToken: string
	/** See `EarlyPromotionsPerDay`. */
	readonly earlyPromotionsPerDay: number
	readonly makeIssueId: () => ErrorIssueId
	readonly makeIncidentId: () => ErrorIncidentId
	readonly makeEventId: () => ErrorIssueEventId
}

export interface PersistErrorTickWindowResult {
	readonly issuesTouched: number
	readonly incidentsOpened: number
	readonly incidentsResolved: number
	readonly pendingTriages: ReadonlyArray<PendingErrorTriage>
}

/**
 * Occurrences a brand-new fingerprint must accumulate before it becomes an
 * Issue once the org's early-promotion budget is spent. Below this it waits in
 * `error_fingerprint_candidates`.
 *
 * The gap this closes: a fingerprint used to become a durable row plus a
 * first-seen notification on its very first occurrence with no limit, so one
 * unapplied migration minted 2,531 issues in three days.
 */
export const PROMOTION_MIN_OCCURRENCES = 3

/**
 * Error issues an org may open in a rolling day before new fingerprints have
 * to clear PROMOTION_MIN_OCCURRENCES. Under it a fingerprint becomes an issue
 * on its first occurrence, so a quiet org (and every trial org throwing its
 * first error) sees it within a tick. A storm spends the budget in one window
 * and everything after it waits for the threshold, which bounds the noise to
 * this many one-off issues a day.
 */
export class EarlyPromotionsPerDay extends Context.Reference<number>(
	"@maple/backend/services/errors/EarlyPromotionsPerDay",
	{ defaultValue: () => 10 },
) {}
const EARLY_PROMOTION_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * How long after an issue is resolved before an occurrence counts as a
 * regression. Covers the rollout window: a fix marked done is not live
 * everywhere the same second, and stragglers from the pre-fix build would
 * otherwise reopen the issue immediately.
 */
const REGRESSION_GRACE_MS = 60 * 60 * 1000

/** The handle `persistErrorTickWindow` runs its statements on, inside its transaction. */
type ErrorTickTransaction = MapleDb

/** A jsonb build set, as the `least`/`greatest`-style SET expressions below return it. */
const VersionListJson = PG.jsonb(Schema.Array(Schema.String))

/**
 * Rows per statement for the window's bulk reads and writes. Postgres caps a
 * statement at 32,767 bind parameters and the widest write here binds 26 per
 * row, so a single statement per window stops committing past ~1,200
 * fingerprints. A steady-state window is far below this and still runs every
 * write as one statement.
 */
const BULK_CHUNK_ROWS = 500

const chunks = <A>(items: ReadonlyArray<A>) => Arr.chunksOf(items, BULK_CHUNK_ROWS)

const inChunks = <A, B, E>(
	items: ReadonlyArray<A>,
	run: (chunk: Array<A>) => Effect.Effect<ReadonlyArray<B>, E>,
): Effect.Effect<Array<B>, E> =>
	Effect.forEach(chunks(items), run).pipe(Effect.map((results) => results.flat()))

/**
 * The below-threshold candidates that the org's early-promotion budget lets
 * through this window, oldest first. The budget is what is left of
 * `earlyPromotionsPerDay` after the error issues the org opened in the last
 * day and the ones `alsoOpening` in this window. Only read when something is
 * waiting, so a steady-state window costs no extra statement.
 */
const earlyPromotions = (
	tx: ErrorTickTransaction,
	input: PersistErrorTickWindowInput,
	alsoOpening: number,
	waiting: ReadonlyArray<ErrorFingerprintCandidateRow>,
): Effect.Effect<ReadonlyArray<ErrorFingerprintCandidateRow>, MapleDbError> =>
	Effect.gen(function* () {
		if (waiting.length === 0) return []
		const [opened] = yield* tx.run(
			PG.from(ErrorIssues)
				.select(() => ({ count: PG.count() }))
				.where(($) => [
					$.orgId.eq(input.orgId),
					$.kind.eq("error"),
					$.createdAt.gte(input.windowEndMs - EARLY_PROMOTION_WINDOW_MS),
				]),
		)
		const budget = input.earlyPromotionsPerDay - Number(opened?.count ?? 0) - alsoOpening
		if (budget <= 0) return []
		return Arr.take(
			Arr.sort(
				waiting,
				Order.mapInput(Order.Number, (row: ErrorFingerprintCandidateRow) => row.firstSeenAt),
			),
			budget,
		)
	})

/**
 * Accumulate not-yet-promoted fingerprints and return the ones that have now
 * earned an Issue, carrying their ACCUMULATED totals rather than this window's.
 *
 * Promotion deletes the candidate row, so a fingerprint is counted once: the
 * Issue takes over from here and the next occurrence lands on it directly.
 */
const promoteCandidates = (
	tx: ErrorTickTransaction,
	input: PersistErrorTickWindowInput,
	unknownRows: ReadonlyArray<ErrorTickScanRow>,
	windowEnd: number,
): Effect.Effect<ReadonlyArray<ErrorTickScanRow>, MapleDbError> =>
	Effect.gen(function* () {
		if (unknownRows.length === 0) return []

		const upserted = yield* inChunks(unknownRows, (chunk) =>
			tx.run(
				PG.insertInto(ErrorFingerprintCandidates)
					.values(
						Arr.map(chunk, (row) => ({
							orgId: input.orgId,
							fingerprintHash: row.fingerprintHash,
							serviceName: row.serviceName,
							exceptionType: row.exceptionType,
							exceptionMessage: row.exceptionMessage,
							errorLabel: row.errorLabel,
							topFrame: row.topFrame,
							serviceVersionsJson: mergeVersions([], row.serviceVersions),
							occurrenceCount: row.count,
							firstSeenAt: row.firstSeenMs,
							lastSeenAt: row.lastSeenMs,
							updatedAt: windowEnd,
						})),
					)
					.onConflictDoUpdate({
						target: ["orgId", "fingerprintHash"],
						set: ($, excluded) => ({
							serviceName: excluded.serviceName,
							exceptionType: excluded.exceptionType,
							exceptionMessage: excluded.exceptionMessage,
							errorLabel: excluded.errorLabel,
							topFrame: excluded.topFrame,
							// Union rather than overwrite: a candidate accumulates across ticks and
							// the builds it was seen from seed the issue it is promoted into. The
							// cap mirrors MAX_TRACKED_VERSIONS; which build is dropped past it is
							// unordered, which is fine for a row that lives at most a day.
							serviceVersionsJson: PG.sql(VersionListJson)`(
					select coalesce(jsonb_agg(version), '[]'::jsonb)
					from (
						select distinct value as version
						from jsonb_array_elements(
							${$.serviceVersionsJson} || ${excluded.serviceVersionsJson}
						)
						limit ${MAX_TRACKED_VERSIONS}
					) as versions
				)`,
							occurrenceCount: $.occurrenceCount.add(excluded.occurrenceCount),
							firstSeenAt: PG.least($.firstSeenAt, excluded.firstSeenAt),
							lastSeenAt: PG.greatest($.lastSeenAt, excluded.lastSeenAt),
							updatedAt: excluded.updatedAt,
						}),
					})
					.returning(),
			),
		)

		const earned = Arr.filter(upserted, (row) => row.occurrenceCount >= PROMOTION_MIN_OCCURRENCES)
		const waiting = Arr.filter(upserted, (row) => row.occurrenceCount < PROMOTION_MIN_OCCURRENCES)
		const early = yield* earlyPromotions(tx, input, earned.length, waiting)
		const ready = [...earned, ...early]
		if (ready.length === 0) return []

		yield* Effect.forEach(
			chunks(ready),
			(chunk) =>
				tx.run(
					PG.deleteFrom(ErrorFingerprintCandidates).where(($) => [
						$.orgId.eq(input.orgId),
						$.fingerprintHash.in_(...Arr.map(chunk, (row) => row.fingerprintHash)),
					]),
				),
			{ discard: true },
		)

		return Arr.map(ready, (row) => ({
			fingerprintHash: row.fingerprintHash,
			serviceName: row.serviceName,
			exceptionType: row.exceptionType,
			exceptionMessage: row.exceptionMessage,
			errorLabel: row.errorLabel,
			topFrame: row.topFrame,
			serviceVersions: row.serviceVersionsJson,
			count: row.occurrenceCount,
			firstSeenMs: row.firstSeenAt,
			lastSeenMs: row.lastSeenAt,
		}))
	})

/**
 * Whether an occurrence on a resolved issue is a genuine regression.
 *
 * Two guards, and the second is the one that matters for shipped clients.
 * `maple-cli` runs on other people's machines: after a fix ships, every old
 * binary in the wild keeps emitting the bug forever. Under the previous rule —
 * any occurrence on a `done` issue reopens it — those issues could never stay
 * fixed, which is why agents kept re-fixing the same bug.
 *
 * Version comparison is set MEMBERSHIP, never ordering: `maple-cli` reports
 * semver ("0.0.18") while the Workers report git SHAs, so "newer than the fix"
 * is not a question these strings can answer. A build already running when the
 * issue was resolved is an old client; a build we had not seen then is a real
 * regression, which is exactly the signal wanted.
 *
 * The rule only engages for services that actually report `service.version`.
 * Where it is absent the guard degrades to the old behaviour — any occurrence
 * reopens — which is the safe direction but silent, so the binding matters:
 * `COMMIT_SHA` is bound for the api/alerting/electric-sync Workers and reaches
 * `service.version` via `resolveResourceFromEnv`, the web build stamps
 * `VITE_COMMIT_SHA`, and `maple-cli` reports `MAPLE_VERSION`.
 */
export const isRegression = (
	prior: Pick<ErrorIssueRow, "workflowState" | "resolvedAt" | "resolvedVersionsJson">,
	row: Pick<ErrorTickScanRow, "lastSeenMs" | "serviceVersions">,
): boolean => {
	if (prior.workflowState !== "done") return false

	const resolvedAtMs = prior.resolvedAt
	if (resolvedAtMs !== null && row.lastSeenMs < resolvedAtMs + REGRESSION_GRACE_MS) return false

	// A window can carry several builds. It is a regression if ANY of them was
	// not already running when the issue was resolved — one new build firing is
	// the signal, and it must not be masked by old clients in the same window.
	// A window with no build information at all cannot be ruled out either.
	if (row.serviceVersions.length === 0) return true
	return Arr.some(row.serviceVersions, (version) => !prior.resolvedVersionsJson.includes(version))
}

/**
 * The evaluator no longer holds this org's cursor row. Only reachable when the
 * worker stalled long enough for the crash-recovery TTL to elapse and another
 * invocation took over, so the window must roll back rather than double-apply.
 * Failing the transaction's Effect with it is what rolls the window back.
 */
export class ErrorTickClaimLost extends Schema.TaggedError<ErrorTickClaimLost>()(
	"@maple/backend/services/ErrorTickClaimLostError",
	{
		message: Schema.String,
		orgId: Schema.String,
		stage: Schema.Literals(["preflight", "checkpoint"]),
	},
) {}

const claimLost = (orgId: string, stage: "preflight" | "checkpoint") =>
	new ErrorTickClaimLost({ message: `claim for ${orgId} was lost before ${stage}`, orgId, stage })

export const isErrorTickClaimLost = (error: unknown): error is ErrorTickClaimLost =>
	Schema.is(ErrorTickClaimLost)(error)

/** The batched issue upsert's RETURNING omitted a fingerprint it was handed. */
export class ErrorTickUpsertMissingRow extends Schema.TaggedError<ErrorTickUpsertMissingRow>()(
	"@maple/backend/services/ErrorTickUpsertMissingRowError",
	{ message: Schema.String, fingerprintHash: Schema.String },
) {}

/**
 * The scan groups by fingerprint, so duplicates are not expected — but a
 * multi-row `ON CONFLICT DO UPDATE` errors outright if the same conflict target
 * appears twice in one statement, so collapsing them is a correctness
 * requirement of the batched write rather than defensive tidying.
 */
const mergeScanRows = (rows: ReadonlyArray<ErrorTickScanRow>): ReadonlyArray<ErrorTickScanRow> => {
	const merged = new Map<string, ErrorTickScanRow>()
	for (const row of rows) {
		const prior = merged.get(row.fingerprintHash)
		merged.set(
			row.fingerprintHash,
			prior
				? {
						...row,
						count: prior.count + row.count,
						serviceVersions: mergeVersions(prior.serviceVersions, row.serviceVersions),
						firstSeenMs: Math.min(prior.firstSeenMs, row.firstSeenMs),
						lastSeenMs: Math.max(prior.lastSeenMs, row.lastSeenMs),
					}
				: row,
		)
	}
	return [...merged.values()]
}

/** The issue fields a hash's occurrences are written under. */
const ownerColumns = (issue: PG.ColumnAccessor<typeof ErrorIssues.columns>) => ({
	id: issue.id,
	fingerprintHash: issue.fingerprintHash,
	serviceName: issue.serviceName,
	exceptionType: issue.exceptionType,
	exceptionMessage: issue.exceptionMessage,
	errorLabel: issue.errorLabel,
	topFrame: issue.topFrame,
})

type Owner = { readonly id: ErrorIssueId } & Pick<
	ErrorTickScanRow,
	"fingerprintHash" | "serviceName" | "exceptionType" | "exceptionMessage" | "errorLabel" | "topFrame"
>

/** The issue each hash belongs to through an alias (a merge or an earlier re-key). */
const aliasOwners = (tx: ErrorTickTransaction, orgId: OrgId, hashes: ReadonlyArray<string>) =>
	inChunks(hashes, (chunk) =>
		tx.run(
			PG.from(ErrorIssueFingerprints)
				.innerJoin(ErrorIssues, "issue", (alias, issue) => issue.id.eq(alias.issueId))
				.select(($) => ({ alias: $.fingerprintHash, ...ownerColumns($.issue) }))
				.where(($) => [$.orgId.eq(orgId), $.issue.orgId.eq(orgId), $.fingerprintHash.in_(...chunk)]),
		),
	).pipe(
		Effect.map((rows) => new Map<string, Owner>(Arr.map(rows, ({ alias, ...owner }) => [alias, owner]))),
	)

/** The hashes a bump replaced with this row's, without the row's own. */
const lineageOf = (row: ErrorTickScanRow) =>
	Arr.filter(row.previousFingerprintHashes ?? [], (hash) => hash !== row.fingerprintHash)

/**
 * Every hash whose issue this row's hash belongs with: the ones a bump replaced, and the
 * ones sharing its grouping key. Both are resolved alike: the row joins their issue, and
 * issues they disagree on are folded into one.
 */
const previousHashesOf = (row: ErrorTickScanRow) =>
	Arr.dedupe([
		...lineageOf(row),
		...Arr.filter(row.groupedFingerprintHashes ?? [], (hash) => hash !== row.fingerprintHash),
	])

/** Each row's hash and its previous ones, once. A set, as a wide window holds thousands. */
const hashesWithPrevious = (rows: ReadonlyArray<ErrorTickScanRow>): Array<string> => [
	...new Set(Arr.flatMap(rows, (row) => [row.fingerprintHash, ...previousHashesOf(row)])),
]

/**
 * Which of several old issues a bump folds into one keeps the new hash: the one
 * somebody is working, then the busiest, then the oldest. The id settles a tie,
 * so the keeper never depends on the order the rows were read in.
 */
const REKEY_STATE_RANK = {
	in_progress: 0,
	in_review: 1,
	verifying: 2,
	todo: 3,
	regressed: 4,
	triage: 5,
	wontfix: 6,
	done: 7,
	cancelled: 8,
} as const satisfies Readonly<Record<WorkflowState, number>>
const rekeyOrder = (a: ErrorIssueRow, b: ErrorIssueRow) => {
	const byState = REKEY_STATE_RANK[a.workflowState] - REKEY_STATE_RANK[b.workflowState]
	if (byState !== 0) return byState
	if (b.occurrenceCount !== a.occurrenceCount) return b.occurrenceCount - a.occurrenceCount
	if (a.firstSeenAt !== b.firstSeenAt) return a.firstSeenAt - b.firstSeenAt
	return Order.String(a.id, b.id)
}

/**
 * Hand a fingerprint version bump's new hashes to the issues their previous hashes
 * belong to, recording each as a `rekey` alias, so a bump carries every issue's
 * state instead of opening new ones. Where the bump folds several old issues into
 * one hash, the first by `rekeyOrder` keeps it and the rest are folded into it,
 * whether their previous hashes arrive in one tick or over several. Hashes sharing a
 * grouping key take the same path, recorded as `group` aliases.
 * Takes the aliases of the rows' hashes and of their previous hashes, and returns
 * the issue each row's hash belongs to through an alias once the pass is done.
 */
const rekeyOwners = (
	tx: ErrorTickTransaction,
	input: PersistErrorTickWindowInput,
	rows: ReadonlyArray<ErrorTickScanRow>,
	aliased: ReadonlyMap<string, Owner>,
): Effect.Effect<ReadonlyMap<string, Owner>, MapleDbError> =>
	Effect.gen(function* () {
		const orgId = input.orgId
		const bumped = Arr.filter(rows, (row) => previousHashesOf(row).length > 0)
		if (bumped.length === 0) return aliased
		// An alias wins over a primary: a merged-away issue's old hash belongs to the issue it was merged into.
		const unaliased = Arr.filter(hashesWithPrevious(bumped), (hash) => !aliased.has(hash))
		const byPrimary = yield* inChunks(unaliased, (chunk) =>
			tx.run(
				PG.from(ErrorIssues)
					.select("id", "fingerprintHash")
					.where(($) => [$.orgId.eq(orgId), $.kind.eq("error"), $.fingerprintHash.in_(...chunk)]),
			),
		)
		const primaryOwners = new Map(Arr.map(byPrimary, (issue) => [issue.fingerprintHash, issue.id]))
		const ownerIdOf = (hash: string) => aliased.get(hash)?.id ?? primaryOwners.get(hash)
		const groups = Arr.map(bumped, (row) => {
			const ownId = ownerIdOf(row.fingerprintHash)
			const previousIds = Arr.flatMap(previousHashesOf(row), (hash) => {
				const id = ownerIdOf(hash)
				return id === undefined ? [] : [id]
			})
			return {
				row,
				ownId,
				// An issue the new hash opened in a tick that had no lineage. Grouping has no
				// stray: hashes sharing a key are peers, and the worked issue keeps them.
				strayId: aliased.has(row.fingerprintHash) || lineageOf(row).length === 0 ? undefined : ownId,
				issueIds: Arr.dedupe(ownId === undefined ? previousIds : [ownId, ...previousIds]),
			}
		})
		// Once a bump has landed, a hash and its previous hashes resolve to one issue on
		// every tick: nothing to load and nothing to write.
		const unsettled = Arr.filter(
			groups,
			(group) => group.issueIds.length > (group.ownId === undefined ? 0 : 1),
		)
		if (unsettled.length === 0) return aliased
		const candidates = yield* inChunks(
			[...new Set(Arr.flatMap(unsettled, (group) => group.issueIds))],
			(chunk) =>
				tx.run(
					PG.from(ErrorIssues)
						.select()
						.where(($) => [$.orgId.eq(orgId), $.id.in_(...chunk), $.mergedIntoIssueId.isNull()]),
				),
		)
		const issueById = new Map(Arr.map(candidates, (issue) => [issue.id, issue]))
		// An issue folded earlier in this pass is reached through the one it was folded into.
		const foldedInto = new Map<ErrorIssueId, ErrorIssueId>()
		const survivor = (id: ErrorIssueId): ErrorIssueId => {
			const next = foldedInto.get(id)
			return next === undefined ? id : survivor(next)
		}
		const rekeyedTo = yield* Effect.forEach(unsettled, ({ row, ownId, strayId, issueIds }) =>
			Effect.gen(function* () {
				// The stray goes last whatever its state: the old issue is the one somebody
				// triaged, and an ignored one must stay ignored.
				const strayLast = (issue: ErrorIssueRow) => (issue.id === strayId ? 1 : 0)
				const order = (a: ErrorIssueRow, b: ErrorIssueRow) =>
					strayLast(a) === strayLast(b) ? rekeyOrder(a, b) : strayLast(a) - strayLast(b)
				const issues = Arr.flatMap(Arr.dedupe(Arr.map(issueIds, survivor)), (id) => {
					const issue = issueById.get(id)
					return issue === undefined ? [] : [issue]
				}).sort(order)
				const [keeper, ...rest] = issues
				if (keeper === undefined) return []
				if (rest.length > 0) {
					Arr.forEach(rest, (issue) => foldedInto.set(issue.id, keeper.id))
					// Folding writes totals from the row it is given, so keep the latest one.
					const folded = yield* foldIssues(tx, {
						orgId,
						target: keeper,
						sources: rest,
						timestamp: input.windowEndMs,
						event: (issueId, payload) => buildEvent(input, issueId, "merge", { payload }),
					})
					issueById.set(folded.id, folded)
				}
				// A hash that had a live issue already resolves to the keeper: the fold moved
				// that issue's aliases and made its primary hash one.
				const source = lineageOf(row).length > 0 ? ("rekey" as const) : ("group" as const)
				return ownId !== undefined && issueById.has(ownId)
					? []
					: [[row.fingerprintHash, keeper.id, source] as const]
			}),
		).pipe(Effect.map(Arr.flatten))
		// A later row may have folded an earlier row's keeper away: alias to the survivor.
		const rekeyed = Arr.flatMap(rekeyedTo, ([fingerprintHash, keeperId, source]) => {
			const issue = issueById.get(survivor(keeperId))
			return issue === undefined ? [] : [[fingerprintHash, ownerOf(issue), source] as const]
		})
		yield* Effect.forEach(
			Arr.chunksOf(rekeyed, BULK_CHUNK_ROWS),
			(chunk) =>
				tx.run(
					PG.insertInto(ErrorIssueFingerprints)
						.values(
							Arr.map(chunk, ([fingerprintHash, owner, source]) => ({
								orgId,
								fingerprintHash,
								issueId: owner.id,
								source,
								originIssueId: null,
								createdAt: input.windowEndMs,
							})),
						)
						.onConflictDoNothing(),
				),
			{ discard: true },
		)
		if (foldedInto.size === 0) {
			return new Map([...Arr.map(rekeyed, ([hash, owner]) => [hash, owner] as const), ...aliased])
		}
		// A fold moved its sources' hashes to the keeper, and any row in the window may
		// resolve through one of them: read the aliases as they now stand.
		return yield* aliasOwners(
			tx,
			orgId,
			Arr.map(rows, (row) => row.fingerprintHash),
		)
	})

const ownerOf = (issue: ErrorIssueRow): Owner => ({
	id: issue.id,
	fingerprintHash: issue.fingerprintHash,
	serviceName: issue.serviceName,
	exceptionType: issue.exceptionType,
	exceptionMessage: issue.exceptionMessage,
	errorLabel: issue.errorLabel,
	topFrame: issue.topFrame,
})

/**
 * New hashes in one window that share a grouping key and have no issue yet: the
 * smallest hash leads, and the others ride on its row, so one issue opens and not one
 * per hash a tick before they fold. Each follower is aliased to the leader's issue once
 * the upsert has made it. Returns follower to leader.
 */
const groupPeers = (rows: ReadonlyArray<ErrorTickScanRow>): ReadonlyMap<string, string> => {
	const inWindow = new Set(Arr.map(rows, (row) => row.fingerprintHash))
	const parent = new Map<string, string>()
	const root = (hash: string): string => {
		const up = parent.get(hash)
		return up === undefined || up === hash ? hash : root(up)
	}
	Arr.forEach(rows, (row) =>
		Arr.forEach(row.groupedFingerprintHashes ?? [], (peer) => {
			if (!inWindow.has(peer)) return
			const a = root(row.fingerprintHash)
			const b = root(peer)
			if (a !== b) parent.set(a < b ? b : a, a < b ? a : b)
		}),
	)
	return new Map(
		Arr.flatMap(rows, (row) => {
			const leader = root(row.fingerprintHash)
			return leader === row.fingerprintHash ? [] : [[row.fingerprintHash, leader] as const]
		}),
	)
}

interface CanonicalRows {
	readonly rows: ReadonlyArray<ErrorTickScanRow>
	/** Follower hash to the leader hash whose issue it joins (`groupPeers`). */
	readonly peers: ReadonlyMap<string, string>
}

/**
 * Rewrite each fingerprint an issue owns through an alias, or that a version bump
 * re-keyed or a grouping key joined, to that issue, then merge again: two hashes of one
 * issue in a window must be one upsert row. The owner keeps its own title and service.
 */
const canonicalizeScanRows = (
	tx: ErrorTickTransaction,
	input: PersistErrorTickWindowInput,
	rows: ReadonlyArray<ErrorTickScanRow>,
): Effect.Effect<CanonicalRows, MapleDbError> =>
	Effect.gen(function* () {
		const orgId = input.orgId
		if (rows.length === 0) return { rows, peers: new Map() }
		// One read covers the rows' hashes and the previous hashes a bump resolves them through.
		const aliased = yield* aliasOwners(tx, orgId, hashesWithPrevious(rows))
		const owners = yield* rekeyOwners(tx, input, rows, aliased)
		const ownerOfRow = (row: ErrorTickScanRow) => owners.get(row.fingerprintHash)
		const unowned = Arr.filter(rows, (row) => ownerOfRow(row) === undefined)
		const peers = groupPeers(unowned)
		if (!Arr.some(rows, (row) => ownerOfRow(row) !== undefined) && peers.size === 0) {
			return { rows, peers }
		}
		// The merge keeps the last row's display fields, so redirected rows go first and an
		// issue's own observation in this window wins over its stored fields.
		return {
			peers,
			rows: mergeScanRows([
				...Arr.flatMap(rows, (row) => {
					const owner = ownerOfRow(row)
					if (owner === undefined) return []
					const { id: _id, ...fields } = owner
					return [{ ...row, ...fields }]
				}),
				...Arr.map(
					Arr.filter(unowned, (row) => peers.has(row.fingerprintHash)),
					(row) => ({
						...row,
						fingerprintHash: peers.get(row.fingerprintHash) ?? row.fingerprintHash,
					}),
				),
				...Arr.filter(unowned, (row) => !peers.has(row.fingerprintHash)),
			]),
		}
	})

const buildEvent = (
	input: PersistErrorTickWindowInput,
	issueId: ErrorIssueId,
	type: ErrorIssueEventInsert["type"],
	options: {
		readonly fromState?: ErrorIssueEventInsert["fromState"]
		readonly toState?: ErrorIssueEventInsert["toState"]
		readonly payload?: Record<string, unknown>
	} = {},
): ErrorIssueEventInsert => ({
	id: input.makeEventId(),
	orgId: input.orgId,
	issueId,
	actorId: input.actorId,
	type,
	fromState: options.fromState ?? null,
	toState: options.toState ?? null,
	payloadJson: options.payload ?? {},
	createdAt: input.windowEndMs,
})

const openNotificationsEnabled = (
	policy: ErrorNotificationPolicyRow,
	reason: ErrorIncidentReason,
	count: number,
): boolean =>
	policy.enabled &&
	count >= policy.minOccurrenceCount &&
	((reason === "first_seen" && policy.notifyOnFirstSeen) ||
		(reason === "regression" && policy.notifyOnRegression))

const buildNotificationRows = (input: PersistErrorTickWindowInput, payload: NotificationPayload) => {
	const deliveryKey = `err:${input.orgId}:${payload.incidentId}:${payload.kind}`
	return Arr.map(input.destinationIds, (destinationId) => ({
		id: randomUUID(),
		orgId: input.orgId,
		destinationId,
		deliveryKey,
		payloadJson: payload,
		status: "queued" as const,
		attemptCount: 0,
		scheduledAt: input.windowEndMs,
		claimedAt: null,
		claimExpiresAt: null,
		claimedBy: null,
		attemptedAt: null,
		errorMessage: null,
		createdAt: input.windowEndMs,
		updatedAt: input.windowEndMs,
	}))
}

/**
 * Reopen fixed issues as `regressed`, guarded on `done`: the scan read the state with a plain
 * SELECT, so a human transition committed since then (a re-triage, a `cancelled`) wins and the
 * row is left alone. Returns the ids that actually reopened, plus the lost ones whose current
 * state still suppresses them (closed again, or a `wontfix` under an active snooze), so the
 * tick keeps them out of the incident path instead of trusting the scan's stale read.
 */
export const applyRegressions = (
	tx: MapleDb,
	input: Pick<PersistErrorTickWindowInput, "orgId" | "windowEndMs">,
	issueIds: ReadonlyArray<ErrorIssueId>,
): Effect.Effect<
	{ readonly reopened: ReadonlySet<ErrorIssueId>; readonly stillSuppressed: ReadonlySet<ErrorIssueId> },
	MapleDbError
> =>
	Effect.gen(function* () {
		const reopened = yield* inChunks(issueIds, (chunk) =>
			tx.run(
				PG.update(ErrorIssues)
					.set(($) => regressedColumns($.regressionCount.add(1), input.windowEndMs))
					.where(($) => [$.orgId.eq(input.orgId), $.id.in_(...chunk), $.workflowState.eq("done")])
					.returning("id"),
			),
		)
		const lost = issueIds.length - reopened.length
		if (lost > 0) {
			yield* Effect.annotateCurrentSpan({ "maple.error_tick.regressions_lost": lost })
			yield* Effect.logInfo("Regression lost to a concurrent transition").pipe(
				Effect.annotateLogs({ orgId: input.orgId, lost }),
			)
		}
		const reopenedIds = new Set(Arr.map(reopened, (row) => row.id))
		const lostIds = Arr.filter(issueIds, (id) => !reopenedIds.has(id))
		const current = yield* inChunks(lostIds, (chunk) =>
			tx.run(
				PG.from(ErrorIssues)
					.select("id", "workflowState", "snoozeUntil")
					.where(($) => [$.orgId.eq(input.orgId), $.id.in_(...chunk)]),
			),
		)
		const stillSuppressed = Arr.filter(
			current,
			(row) =>
				row.workflowState === "done" ||
				(row.workflowState === "wontfix" &&
					(row.snoozeUntil === null || row.snoozeUntil > input.windowEndMs)),
		)
		return { reopened: reopenedIds, stillSuppressed: new Set(Arr.map(stillSuppressed, (row) => row.id)) }
	})

/**
 * Apply one claimed, half-open evaluator window atomically. The durable cursor
 * advances only if every issue, incident, event, and notification-outbox write
 * commits. A transaction retry is safe because none of its generated IDs can
 * escape a rolled-back attempt.
 *
 * Every write is set-based: the cost of a window is a handful of statements
 * per `BULK_CHUNK_ROWS` fingerprints rather than a few per fingerprint. That is what keeps a wide
 * catch-up window inside its lease — a per-row loop over Hyperdrive turns a
 * large window into a transaction that cannot finish before the lease TTL,
 * and a window that can never commit never advances the cursor either.
 */
export const persistErrorTickWindow = (
	db: MapleDb,
	input: PersistErrorTickWindowInput,
): Effect.Effect<
	PersistErrorTickWindowResult,
	MapleDbError | ErrorTickClaimLost | ErrorTickUpsertMissingRow
> =>
	db.transaction(
		Effect.gen(function* () {
			const tx = db
			const windowEnd = input.windowEndMs
			// The raw `sql` bulk updates below bind this with no column type behind it,
			// so it has to reach the driver as a string — see `msToSqlTimestamp`.
			const windowEndSql = msToSqlTimestamp(input.windowEndMs)

			// Lock the cursor row for the life of the transaction. `claimTickWindow`
			// skips locked rows, so an in-flight apply can no longer be stolen by the
			// next cron: the TTL degrades to pure crash recovery. Without this a slow
			// window is stolen, rolled back at the checkpoint, and retried at the same
			// width forever — the org silently stops producing issues.
			const held = yield* tx.run(
				PG.from(ErrorTickStates)
					.select("orgId")
					.where(($) => [$.orgId.eq(input.orgId), $.claimToken.eq(input.claimToken)])
					.forUpdate(),
			)
			if (held.length === 0) return yield* claimLost(input.orgId, "preflight")

			const { rows, peers } = yield* canonicalizeScanRows(tx, input, mergeScanRows(input.rows))
			const fingerprints = Arr.map(rows, (row) => row.fingerprintHash)
			const existingIssues = yield* inChunks(fingerprints, (chunk) =>
				tx.run(
					PG.from(ErrorIssues)
						.select()
						.where(($) => [$.orgId.eq(input.orgId), $.fingerprintHash.in_(...chunk)]),
				),
			)
			const issueByFingerprint = new Map(Arr.map(existingIssues, (row) => [row.fingerprintHash, row]))

			// The cursor row lock makes this evaluator the only writer of error-kind
			// issues for the org, so the prefetch is authoritative: a fingerprint
			// absent here is genuinely new. (Alert-kind issues use an `alert:` prefixed
			// fingerprint and cannot collide.)
			// A fingerprint with no Issue yet goes through the candidate table: it is
			// promoted on sight while the org has early-promotion budget left, and
			// otherwise once it clears PROMOTION_MIN_OCCURRENCES. Promotion returns the ACCUMULATED totals, so a
			// newly promoted issue opens with the occurrences it earned rather than
			// just the ones in this window.
			const promoted = yield* promoteCandidates(
				tx,
				input,
				Arr.filter(rows, (row) => !issueByFingerprint.has(row.fingerprintHash)),
				windowEnd,
			)
			const promotedByFingerprint = new Map(Arr.map(promoted, (row) => [row.fingerprintHash, row]))

			const applicable: Array<{
				readonly row: ErrorTickScanRow
				readonly prior: ErrorIssueRow | undefined
				readonly regression: boolean
				readonly suppressed: boolean
			}> = []
			for (const scanned of rows) {
				const prior = issueByFingerprint.get(scanned.fingerprintHash)
				const promotedRow = promotedByFingerprint.get(scanned.fingerprintHash)
				// A promoted row carries the candidate's ACCUMULATED totals, which the
				// upsert below writes verbatim. Its build set still has to pick up the
				// builds seen in the promoting window itself.
				const row =
					promotedRow === undefined
						? scanned
						: {
								...promotedRow,
								serviceVersions: mergeVersions(
									promotedRow.serviceVersions,
									scanned.serviceVersions,
								),
							}

				// Still short of the promotion threshold — it stays a candidate.
				if (prior === undefined && !promotedByFingerprint.has(scanned.fingerprintHash)) continue

				// `wontfix` suppresses the issue until its snooze elapses; a null snooze
				// means suppressed indefinitely.
				if (
					prior?.workflowState === "wontfix" &&
					(prior.snoozeUntil == null || prior.snoozeUntil > input.windowEndMs)
				) {
					continue
				}
				const regression = prior !== undefined && isRegression(prior, row)
				// An occurrence on a resolved issue that is NOT a regression is an old
				// client still running the pre-fix build. Its counters are still truthful
				// — the event really did happen — but it is not new work: it must not open
				// an incident, notify a destination, or start an investigation. Before the
				// regression rule existed every such occurrence reopened the issue, so the
				// incident always had a reopened issue under it; now the reopen can be
				// skipped, and without this flag the incident path would still fire and
				// re-alert on a bug that is already fixed.
				const suppressed = prior?.workflowState === "done" && !regression
				applicable.push({ row, prior, regression, suppressed })
			}

			const events: Array<ErrorIssueEventInsert> = []
			const notifications: Array<ReturnType<typeof buildNotificationRows>[number]> = []

			const observed: Array<{
				readonly issueId: ErrorIssueId
				readonly row: ErrorTickScanRow
				readonly wasRegression: boolean
				readonly priorSeverity: IssueSeverity | null
			}> = []

			if (applicable.length > 0) {
				// One upsert covers new, ongoing, and regressed fingerprints. The SET
				// expressions all read the pre-update row, so the regression flip and the
				// counter accumulation stay consistent with each other.
				const upserted = yield* inChunks(applicable, (chunk) =>
					tx.run(
						PG.insertInto(ErrorIssues)
							.values(
								Arr.map(chunk, ({ row, prior }) => ({
									id: input.makeIssueId(),
									orgId: input.orgId,
									fingerprintHash: row.fingerprintHash,
									fingerprintVersion: FINGERPRINT_VERSION,
									serviceName: row.serviceName,
									exceptionType: row.exceptionType,
									exceptionMessage: row.exceptionMessage,
									errorLabel: row.errorLabel,
									topFrame: row.topFrame,
									workflowState: "triage" as const,
									priority: 3,
									assignedActorId: null,
									leaseHolderActorId: null,
									leaseExpiresAt: null,
									claimedAt: null,
									notes: null,
									firstSeenAt: row.firstSeenMs,
									lastSeenAt: row.lastSeenMs,
									occurrenceCount: row.count,
									seenVersionsJson: mergeVersions(
										prior?.seenVersionsJson ?? [],
										row.serviceVersions,
									),
									resolvedAt: null,
									resolvedByActorId: null,
									snoozeUntil: null,
									archivedAt: null,
									createdAt: windowEnd,
									updatedAt: windowEnd,
								})),
							)
							.onConflictDoUpdate({
								target: ["orgId", "fingerprintHash"],
								set: ($, excluded) => ({
									fingerprintVersion: excluded.fingerprintVersion,
									serviceName: excluded.serviceName,
									exceptionType: excluded.exceptionType,
									exceptionMessage: excluded.exceptionMessage,
									errorLabel: excluded.errorLabel,
									topFrame: excluded.topFrame,
									firstSeenAt: PG.least($.firstSeenAt, excluded.firstSeenAt),
									lastSeenAt: PG.greatest($.lastSeenAt, excluded.lastSeenAt),
									occurrenceCount: $.occurrenceCount.add(excluded.occurrenceCount),
									// The merged set is computed against the pre-update row and arrives
									// via the INSERT values, so this stays one statement.
									seenVersionsJson: excluded.seenVersionsJson,
									// Reopening is NOT decided here. It used to be
									// `case when workflow_state = 'done' then 'triage'`, which reopened a
									// fixed issue on any occurrence at all — including one from a build
									// that predates the fix. That needs the issue's resolved-build set,
									// which SQL cannot reach from `excluded`, so `isRegression` decides in
									// TypeScript and the targeted update below applies it.
									updatedAt: excluded.updatedAt,
								}),
							})
							.returning("id", "fingerprintHash"),
					),
				)

				const idByFingerprint = new Map(Arr.map(upserted, (row) => [row.fingerprintHash, row.id]))
				const peerAliases = Arr.flatMap([...peers], ([fingerprintHash, leader]) => {
					const issueId = idByFingerprint.get(leader)
					return issueId === undefined ? [] : [{ fingerprintHash, issueId }]
				})
				if (peerAliases.length > 0) {
					yield* tx.run(
						PG.insertInto(ErrorIssueFingerprints)
							.values(
								Arr.map(peerAliases, ({ fingerprintHash, issueId }) => ({
									orgId: input.orgId,
									fingerprintHash,
									issueId,
									source: "group" as const,
									originIssueId: null,
									createdAt: windowEnd,
								})),
							)
							.onConflictDoNothing(),
					)
				}

				const resolvedRows = yield* Effect.forEach(applicable, (entry) => {
					const issueId = idByFingerprint.get(entry.row.fingerprintHash)
					return issueId
						? Effect.succeed({ ...entry, issueId })
						: Effect.fail(
								new ErrorTickUpsertMissingRow({
									message: `Error issue upsert returned no row for ${entry.row.fingerprintHash}`,
									fingerprintHash: entry.row.fingerprintHash,
								}),
							)
				})

				// Apply the reopen decided above. Reopening lands in `regressed`, not
				// `triage`: an issue that was fixed and came back is not the same thing
				// as one nobody has looked at, and flattening the two is what let the
				// same bug be picked up and fixed again from scratch.
				const { reopened: regressedIds, stillSuppressed } = yield* applyRegressions(
					tx,
					input,
					Arr.map(
						Arr.filter(resolvedRows, (entry) => entry.regression),
						(entry) => entry.issueId,
					),
				)

				for (const { row, prior, regression, suppressed, issueId } of resolvedRows) {
					if (!prior) {
						events.push(
							buildEvent(input, issueId, "created", {
								toState: "triage",
								payload: {
									serviceName: row.serviceName,
									exceptionType: row.exceptionType,
									occurrenceCount: row.count,
								},
							}),
						)
					}

					// Only a reopen that actually applied is a regression; one that lost to a
					// concurrent human transition is an ordinary occurrence on the new state.
					const wasRegression = regression && regressedIds.has(issueId)
					if (wasRegression) {
						events.push(
							buildEvent(input, issueId, "state_change", {
								fromState: "done",
								toState: "regressed",
								payload: { viaRegression: true },
							}),
							buildEvent(input, issueId, "regression", {
								payload: { occurrenceCount: row.count },
							}),
						)
					}

					// Counters were accumulated by the upsert above; everything downstream
					// of `observed` is the incident/notification/investigation path, which
					// a pre-fix straggler must not enter.
					// A lost reopen is suppressed by the state it lost to, not the scan's read.
					if (suppressed || stillSuppressed.has(issueId)) continue

					observed.push({
						issueId,
						row,
						wasRegression,
						priorSeverity: prior?.severity ?? null,
					})
				}

				// Only retention archives an issue, on the premise that it stopped occurring.
				// One that occurs again was retired too early: a fingerprint bump whose new
				// hashes are not live yet (a self-hosted warehouse that has not applied the
				// view, or a deploy gap), so it comes back with its state intact. A resolved
				// one stays archived unless the occurrence is a regression, handled above.
				const restoredIds = Arr.map(
					Arr.filter(
						resolvedRows,
						(entry) =>
							entry.prior !== undefined &&
							entry.prior.archivedAt !== null &&
							entry.prior.workflowState !== "done" &&
							// A merged-away issue lives on in the one it was merged into.
							entry.prior.mergedIntoIssueId === null,
					),
					(entry) => entry.issueId,
				)
				yield* Effect.forEach(
					chunks(restoredIds),
					(chunk) =>
						tx.run(
							PG.update(ErrorIssues)
								.set({ archivedAt: null, updatedAt: windowEnd })
								// Re-check the read's filter: a merge or close that commits after it
								// must not be undone by restoring a now merged-away or done issue.
								.where(($) => [
									$.orgId.eq(input.orgId),
									$.id.in_(...chunk),
									$.archivedAt.isNotNull(),
									$.mergedIntoIssueId.isNull(),
									$.workflowState.neq("done"),
								]),
						),
					{ discard: true },
				)
			}

			const observedIssueIds = Arr.map(observed, (entry) => entry.issueId)
			const states = yield* inChunks(observedIssueIds, (chunk) =>
				tx.run(
					PG.from(ErrorIssueStates)
						.select()
						.where(($) => [$.orgId.eq(input.orgId), $.issueId.in_(...chunk)]),
				),
			)
			const stateByIssue = new Map(Arr.map(states, (row) => [row.issueId, row]))

			const refreshing: Array<{
				readonly incidentId: ErrorIncidentId
				readonly issueId: ErrorIssueId
				readonly row: ErrorTickScanRow
			}> = []
			const claiming: Array<{
				readonly incidentId: ErrorIncidentId
				readonly reason: ErrorIncidentReason
				readonly entry: (typeof observed)[number]
			}> = []
			for (const entry of observed) {
				const openIncidentId = stateByIssue.get(entry.issueId)?.openIncidentId
				if (openIncidentId) {
					refreshing.push({ incidentId: openIncidentId, issueId: entry.issueId, row: entry.row })
				} else {
					claiming.push({
						incidentId: input.makeIncidentId(),
						reason: entry.wasRegression ? "regression" : "first_seen",
						entry,
					})
				}
			}

			yield* Effect.forEach(
				chunks(refreshing),
				(chunk) =>
					Effect.gen(function* () {
						const incidentValues = Orm.sql.join(
							Arr.map(
								chunk,
								(item) =>
									Orm.sql`(${item.incidentId}::text, ${msToSqlTimestamp(item.row.lastSeenMs)}::timestamptz, ${item.row.count}::integer)`,
							),
						)
						yield* tx.execute(Orm.sql`
				update error_incidents as t
				set last_triggered_at = greatest(t.last_triggered_at, v.last_seen),
				    occurrence_count = t.occurrence_count + v.cnt,
				    updated_at = ${windowEndSql}::timestamptz
				from (values ${incidentValues}) as v(incident_id, last_seen, cnt)
				where t.id = v.incident_id
			`)

						const stateValues = Orm.sql.join(
							Arr.map(
								chunk,
								(item) =>
									Orm.sql`(${item.issueId}::text, ${msToSqlTimestamp(item.row.lastSeenMs)}::timestamptz)`,
							),
						)
						yield* tx.execute(Orm.sql`
				update error_issue_states as t
				set last_observed_occurrence_at = greatest(t.last_observed_occurrence_at, v.last_seen),
				    last_evaluated_at = ${windowEndSql}::timestamptz,
				    updated_at = ${windowEndSql}::timestamptz
				from (values ${stateValues}) as v(issue_id, last_seen)
				where t.org_id = ${input.orgId} and t.issue_id = v.issue_id
			`)
					}),
				{ discard: true },
			)

			const pendingTriages: PendingErrorTriage[] = []
			let incidentsOpened = 0

			if (claiming.length > 0) {
				// The conditional upsert is the single-open-incident guard: a row whose
				// `open_incident_id` is already set fails the `setWhere` and is therefore
				// absent from RETURNING, so the claimed set is exactly what came back.
				const claimed = yield* inChunks(claiming, (chunk) =>
					tx.run(
						PG.insertInto(ErrorIssueStates)
							.values(
								Arr.map(chunk, (item) => ({
									orgId: input.orgId,
									issueId: item.entry.issueId,
									lastObservedOccurrenceAt: item.entry.row.lastSeenMs,
									lastEvaluatedAt: windowEnd,
									openIncidentId: item.incidentId,
									updatedAt: windowEnd,
								})),
							)
							.onConflictDoUpdate({
								target: ["orgId", "issueId"],
								set: (_, excluded) => ({
									lastObservedOccurrenceAt: excluded.lastObservedOccurrenceAt,
									lastEvaluatedAt: excluded.lastEvaluatedAt,
									openIncidentId: excluded.openIncidentId,
									updatedAt: excluded.updatedAt,
								}),
								where: ($) => $.openIncidentId.isNull(),
							})
							.returning("issueId", "openIncidentId"),
					),
				)

				const claimedIncidentByIssue = new Map(
					Arr.map(claimed, (row) => [row.issueId, row.openIncidentId]),
				)
				const opened = Arr.filter(
					claiming,
					(item) => claimedIncidentByIssue.get(item.entry.issueId) === item.incidentId,
				)

				if (opened.length > 0) {
					yield* Effect.forEach(
						chunks(opened),
						(chunk) =>
							tx.run(
								PG.insertInto(ErrorIncidents).values(
									Arr.map(chunk, (item) => ({
										id: item.incidentId,
										orgId: input.orgId,
										issueId: item.entry.issueId,
										status: "open" as const,
										reason: item.reason,
										firstTriggeredAt: item.entry.row.firstSeenMs,
										lastTriggeredAt: item.entry.row.lastSeenMs,
										resolvedAt: null,
										occurrenceCount: item.entry.row.count,
										createdAt: windowEnd,
										updatedAt: windowEnd,
									})),
								),
							),
						{ discard: true },
					)
					incidentsOpened = opened.length

					for (const item of opened) {
						if (openNotificationsEnabled(input.policy, item.reason, item.entry.row.count)) {
							notifications.push(
								...buildNotificationRows(input, {
									kind: "open",
									issueId: item.entry.issueId,
									incidentId: item.incidentId,
									serviceName: item.entry.row.serviceName,
									exceptionType: item.entry.row.exceptionType,
									severity: input.policy.severity,
									threshold: input.policy.minOccurrenceCount,
									count: item.entry.row.count,
								}),
							)
						}
						pendingTriages.push({
							issueId: item.entry.issueId,
							incidentId: item.incidentId,
							reason: item.reason,
							severity: item.entry.priorSeverity,
							row: item.entry.row,
						})
					}
				}
			}

			const staleBefore = input.windowEndMs - input.autoResolveMinutes * 60_000
			const staleIncidents = yield* tx.run(
				PG.from(ErrorIncidents)
					.select()
					.where(($) => [
						$.orgId.eq(input.orgId),
						$.status.eq("open"),
						$.lastTriggeredAt.lt(staleBefore),
					]),
			)

			let incidentsResolved = 0
			if (staleIncidents.length > 0) {
				// `status = 'open'` in the predicate keeps the flip idempotent, and
				// RETURNING reports exactly which rows this transaction resolved.
				const flipped = yield* inChunks(staleIncidents, (chunk) =>
					tx.run(
						PG.update(ErrorIncidents)
							.set({ status: "resolved", resolvedAt: windowEnd, updatedAt: windowEnd })
							.where(($) => [
								$.orgId.eq(input.orgId),
								$.id.in_(...Arr.map(chunk, (incident) => incident.id)),
								$.status.eq("open"),
							])
							.returning("id"),
					),
				)
				const flippedIds = new Set(Arr.map(flipped, (row) => row.id))
				incidentsResolved = flippedIds.size

				if (flippedIds.size > 0) {
					const resolvedIncidents = Arr.filter(staleIncidents, (incident) =>
						flippedIds.has(incident.id),
					)
					// Match on `open_incident_id` too: a state pointing at some other
					// incident must not be cleared by this one resolving. An incident and
					// its issue share a chunk, so chunking leaves the pairing intact.
					yield* Effect.forEach(
						chunks(resolvedIncidents),
						(chunk) =>
							tx.run(
								PG.update(ErrorIssueStates)
									.set({ openIncidentId: null, updatedAt: windowEnd })
									.where(($) => [
										$.orgId.eq(input.orgId),
										$.issueId.in_(...Arr.map(chunk, (incident) => incident.issueId)),
										$.openIncidentId.in_(...Arr.map(chunk, (incident) => incident.id)),
									]),
							),
						{ discard: true },
					)

					if (input.policy.enabled && input.policy.notifyOnResolve) {
						const staleIssueIds = [
							...new Set(Arr.map(resolvedIncidents, (incident) => incident.issueId)),
						]
						const staleIssues = yield* inChunks(staleIssueIds, (chunk) =>
							tx.run(
								PG.from(ErrorIssues)
									.select()
									.where(($) => [$.orgId.eq(input.orgId), $.id.in_(...chunk)]),
							),
						)
						const staleIssueById = new Map(Arr.map(staleIssues, (issue) => [issue.id, issue]))
						for (const incident of resolvedIncidents) {
							const issue = staleIssueById.get(incident.issueId)
							if (!issue) continue
							notifications.push(
								...buildNotificationRows(input, {
									kind: "resolve",
									issueId: incident.issueId,
									incidentId: incident.id,
									serviceName: issue.serviceName,
									exceptionType: issue.exceptionType,
									severity: input.policy.severity,
									threshold: input.policy.minOccurrenceCount,
									count: incident.occurrenceCount,
								}),
							)
						}
					}
				}
			}

			yield* Effect.forEach(
				chunks(events),
				(chunk) => tx.run(PG.insertInto(ErrorIssueEvents).values(chunk)),
				{
					discard: true,
				},
			)
			yield* Effect.forEach(
				chunks(notifications),
				(chunk) =>
					tx.run(
						PG.insertInto(ErrorNotificationDeliveries)
							.values(chunk)
							.onConflictDoNothing({ target: ["deliveryKey", "destinationId"] }),
					),
				{ discard: true },
			)

			const advanced = yield* tx.run(
				PG.update(ErrorTickStates)
					.set({
						processedThrough: windowEnd,
						bootstrapCompleted: true,
						claimToken: null,
						claimExpiresAt: null,
						updatedAt: windowEnd,
					})
					.where(($) => [$.orgId.eq(input.orgId), $.claimToken.eq(input.claimToken)])
					.returning("orgId"),
			)
			if (advanced.length === 0) return yield* claimLost(input.orgId, "checkpoint")

			return {
				issuesTouched: observed.length,
				incidentsOpened,
				incidentsResolved,
				pendingTriages,
			}
		}),
	)
