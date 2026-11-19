import type {
	CloudFindingSeverity,
	CloudFindingSource,
	CloudFindingStatus,
	CloudSecurityFeed,
	CloudServiceState,
} from "@maple/domain/cloud-security"
import { IntegrationsPersistenceError } from "@maple/domain/http"
import {
	type CloudSecurityFindingRow,
	CloudSecurityFindings,
	type CloudSecurityServiceStateRow,
	CloudSecurityServiceStates,
} from "@maple/db/tables"
import type { AwsAccountId, AwsConnectionId, AwsRegion, OrgId } from "@maple/primitives"
import * as PG from "@maple-dev/effect-orm/postgres"
import { Array as Arr, Context, Effect, Layer, Option, Record as Rec, String as Str } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute, makePersistenceErrorMapper } from "@maple/backend/platform/db-execute"

// The AWS `security` module's findings at their latest version, and the per-region service states
// the poller keeps its cursors in. Every read and write is pinned to one org.

/** A finding as a poll read it, before it is stamped with the sync time. */
export interface CloudFindingWrite {
	readonly orgId: OrgId
	readonly connectionId: AwsConnectionId
	readonly accountId: AwsAccountId
	readonly region: AwsRegion
	readonly source: CloudFindingSource
	readonly findingId: string
	readonly type: string
	readonly title: string
	readonly description: string | null
	readonly severity: CloudFindingSeverity
	readonly status: CloudFindingStatus
	readonly resourceType: string
	readonly resourceId: string
	readonly resourceName: string | null
	readonly occurrences: number
	readonly firstSeenAt: number
	readonly lastSeenAt: number
	readonly providerUpdatedAt: number
	/** When Maple first saw it closed; absent on a closed finding means now. */
	readonly closedAt?: number | null
	readonly detail: Record<string, unknown> | null
}

/** One service in one region of one connection. */
export interface CloudFeedRef {
	readonly orgId: OrgId
	readonly connectionId: AwsConnectionId
	readonly region: AwsRegion
	readonly source: CloudFindingSource
}

export interface CloudServiceStateWrite {
	readonly orgId: OrgId
	readonly connectionId: AwsConnectionId
	readonly region: AwsRegion
	readonly source: CloudSecurityFeed
	readonly state: CloudServiceState
	/** Moves the cursor; null keeps the stored one (a failed or empty poll). */
	readonly cursorAt: number | null
	/** The window size to start the next windowed read with; null keeps the stored one. */
	readonly windowMs: number | null
	readonly lastError: string | null
	readonly checkedAt: number
}

/** What the findings list narrows to. Absent filters match everything; `status` is required. */
export interface CloudFindingFilters {
	readonly status: CloudFindingStatus
	readonly severities?: ReadonlyArray<CloudFindingSeverity> | undefined
	readonly sources?: ReadonlyArray<CloudFindingSource> | undefined
	readonly accountId?: AwsAccountId | undefined
	readonly region?: AwsRegion | undefined
	/** Matched case-insensitively against the title, type and resource id. */
	readonly search?: string | undefined
}

export interface CloudFindingPage {
	readonly limit: number
	readonly offset: number
}

/** The primary key of one finding inside an org. */
export interface CloudFindingKey {
	readonly connectionId: AwsConnectionId
	readonly region: AwsRegion
	readonly source: CloudFindingSource
	readonly findingId: string
}

/** Active findings counted by severity and by source. */
export interface CloudFindingSummary {
	readonly total: number
	readonly bySeverity: Readonly<Record<CloudFindingSeverity, number>>
	readonly bySource: Readonly<Record<CloudFindingSource, number>>
}

/** Sort rank: critical first. */
const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3, info: 4 } as const satisfies Record<
	CloudFindingSeverity,
	number
>

/** Rows per INSERT: a finding carries a jsonb detail, and Postgres caps one statement's parameters. */
const UPSERT_CHUNK = 100

/** How long after it closed a resolved finding is still refreshed by id, for a console reopen. */
const REOPEN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

/** A closed finding is kept this long after Maple saw it close. */
export const CLOSED_FINDING_RETENTION_MS = 90 * 24 * 60 * 60 * 1000

const toPersistenceError = makePersistenceErrorMapper(
	IntegrationsPersistenceError,
	"Cloud security findings are unavailable",
)

export interface CloudSecurityStoreApi {
	readonly upsertFindings: (
		rows: ReadonlyArray<CloudFindingWrite>,
		syncedAt: number,
	) => Effect.Effect<void, IntegrationsPersistenceError>
	readonly recordServiceState: (
		state: CloudServiceStateWrite,
	) => Effect.Effect<void, IntegrationsPersistenceError>
	/** Marks a feed as receiving events. A feed the poller has not read yet is left to it. */
	readonly recordPush: (feed: CloudFeedRef, at: number) => Effect.Effect<void, IntegrationsPersistenceError>
	readonly serviceStates: (
		orgId: OrgId,
		connectionId: AwsConnectionId,
	) => Effect.Effect<ReadonlyArray<CloudSecurityServiceStateRow>, IntegrationsPersistenceError>
	/** Whether the poller has read this region of the connection, so it reconciles what is stored there. */
	readonly knowsRegion: (
		orgId: OrgId,
		connectionId: AwsConnectionId,
		region: AwsRegion,
	) => Effect.Effect<boolean, IntegrationsPersistenceError>
	/** Severity first, then the newest sighting. Reads one row past the page to tell if more follow. */
	readonly listFindings: (
		orgId: OrgId,
		filters: CloudFindingFilters,
		page: CloudFindingPage,
	) => Effect.Effect<
		{ readonly rows: ReadonlyArray<CloudSecurityFindingRow>; readonly hasMore: boolean },
		IntegrationsPersistenceError
	>
	readonly getFinding: (
		orgId: OrgId,
		key: CloudFindingKey,
	) => Effect.Effect<Option.Option<CloudSecurityFindingRow>, IntegrationsPersistenceError>
	readonly summary: (orgId: OrgId) => Effect.Effect<CloudFindingSummary, IntegrationsPersistenceError>
	/** Every service state across the org's connections. */
	readonly orgServiceStates: (
		orgId: OrgId,
	) => Effect.Effect<ReadonlyArray<CloudSecurityServiceStateRow>, IntegrationsPersistenceError>
	/**
	 * Findings of one feed synced before `syncedBefore`, oldest sync first, resolved ones included:
	 * a finding reopened in the console may not move its update time either.
	 */
	readonly staleIds: (
		feed: CloudFeedRef,
		syncedBefore: number,
		limit: number,
	) => Effect.Effect<ReadonlyArray<string>, IntegrationsPersistenceError>
	/** Marks the feed's open findings resolved: `only` those ids, or every one not in `except`. */
	readonly resolve: (
		feed: CloudFeedRef,
		ids: { readonly only: ReadonlyArray<string> } | { readonly except: ReadonlyArray<string> },
		at: number,
	) => Effect.Effect<number, IntegrationsPersistenceError>
	/** Deletes the org's findings closed (as Maple first saw them closed) before `beforeMs`. */
	readonly pruneClosed: (
		orgId: OrgId,
		beforeMs: number,
	) => Effect.Effect<number, IntegrationsPersistenceError>
}

export class CloudSecurityStore extends Context.Service<CloudSecurityStore, CloudSecurityStoreApi>()(
	"@maple/backend/services/CloudSecurityStore",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const dbExecute = makeDbExecute(database, "CloudSecurityStore", toPersistenceError)

			/** One finding's identity across orgs and connections. */
			const keyOf = (row: {
				readonly orgId: string
				readonly connectionId: string
				readonly region: string
				readonly source: string
				readonly findingId: string
			}) => `${row.orgId}\n${row.connectionId}\n${row.region}\n${row.source}\n${row.findingId}`

			/**
			 * The closed rows among `rows` that are stored already, with when each closed: a finding first
			 * seen closed is not kept, and one that closes now is stamped with this sync.
			 */
			const storedClosed = (rows: ReadonlyArray<CloudFindingWrite>, syncedAt: number) => {
				const closed = Arr.filter(rows, (row) => row.status !== "active")
				// Each lookup is pinned to one org and connection, whatever mix of rows a caller passes.
				const groups = Arr.flatMap(
					Rec.values(Arr.groupBy(closed, (row) => `${row.orgId}\n${row.connectionId}`)),
					(group) => (group === undefined ? [] : Arr.chunksOf(group, UPSERT_CHUNK)),
				)
				return Effect.map(
					Effect.forEach(groups, (chunk) =>
						dbExecute((db) =>
							db.run(
								PG.from(CloudSecurityFindings)
									.select(($) => ({
										orgId: $.orgId,
										connectionId: $.connectionId,
										region: $.region,
										source: $.source,
										findingId: $.findingId,
										status: $.status,
										closedAt: $.closedAt,
									}))
									.where(($) => [
										$.orgId.eq(chunk[0].orgId),
										$.connectionId.eq(chunk[0].connectionId),
										PG.inList(
											$.findingId,
											Arr.map(chunk, (row) => row.findingId),
										),
									]),
							),
						),
					),
					(found) => {
						const stored = new Map(
							Arr.map(Arr.flatten(found), (row) => [keyOf(row), row] as const),
						)
						return Arr.flatMap(closed, (row) => {
							const existing = stored.get(keyOf(row))
							if (existing === undefined) return []
							const closedAt =
								existing.status === "active" ? syncedAt : (existing.closedAt ?? syncedAt)
							return [{ ...row, closedAt }]
						})
					},
				)
			}

			const upsertFindings = Effect.fn("CloudSecurityStore.upsertFindings")(function* (
				rows: ReadonlyArray<CloudFindingWrite>,
				syncedAt: number,
			) {
				// One row per finding, its newest version: Postgres refuses an upsert that names a key twice.
				const newest = new Map<string, CloudFindingWrite>()
				Arr.forEach(rows, (row) => {
					const key = `${row.orgId}\n${row.connectionId}\n${row.region}\n${row.source}\n${row.findingId}`
					const seen = newest.get(key)
					if (seen === undefined || seen.providerUpdatedAt <= row.providerUpdatedAt)
						newest.set(key, row)
				})
				const unique = Arr.fromIterable(newest.values())
				const closed = yield* storedClosed(unique, syncedAt)
				const kept = Arr.appendAll(
					Arr.map(
						Arr.filter(unique, (row) => row.status === "active"),
						(row) => ({ ...row, closedAt: null }),
					),
					closed,
				)
				yield* Effect.annotateCurrentSpan({
					"maple.cloud_security.findings": rows.length,
					"maple.cloud_security.findings_kept": kept.length,
				})
				yield* Effect.forEach(
					Arr.chunksOf(kept, UPSERT_CHUNK),
					(chunk) =>
						dbExecute((db) =>
							db.run(
								PG.insertInto(CloudSecurityFindings)
									.values(
										// A closed finding without a close time closed now, as far as Maple knows.
										Arr.map(chunk, (row) => ({
											...row,
											closedAt:
												row.closedAt ?? (row.status === "active" ? null : syncedAt),
											syncedAt,
										})),
									)
									.onConflictDoUpdate({
										target: ["orgId", "connectionId", "region", "source", "findingId"],
										// Every column from the new version but closed_at: the first time Maple saw the
										// finding close stands while it stays closed, and the caller's (null) applies on reopen.
										set: ($, excluded) => ({
											accountId: excluded.accountId,
											type: excluded.type,
											title: excluded.title,
											description: excluded.description,
											severity: excluded.severity,
											status: excluded.status,
											resourceType: excluded.resourceType,
											resourceId: excluded.resourceId,
											resourceName: excluded.resourceName,
											occurrences: excluded.occurrences,
											firstSeenAt: excluded.firstSeenAt,
											lastSeenAt: excluded.lastSeenAt,
											providerUpdatedAt: excluded.providerUpdatedAt,
											detail: excluded.detail,
											syncedAt: excluded.syncedAt,
											closedAt: PG.caseWhen(
												[[excluded.status.eq("active"), excluded.closedAt]],
												PG.coalesce($.closedAt, excluded.closedAt),
											),
										}),
										// An older version read late never replaces a newer one; the same time does,
										// since a console change can leave the service's update time alone.
										where: (existing, excluded) =>
											existing.providerUpdatedAt.lte(excluded.providerUpdatedAt),
									}),
							),
						),
					{ discard: true },
				)
			})

			const recordServiceState = Effect.fn("CloudSecurityStore.recordServiceState")(function* (
				state: CloudServiceStateWrite,
			) {
				const base = { state: state.state, lastError: state.lastError, checkedAt: state.checkedAt }
				const withCursor = state.cursorAt === null ? base : { ...base, cursorAt: state.cursorAt }
				const values =
					state.windowMs === null ? withCursor : { ...withCursor, windowMs: state.windowMs }
				yield* dbExecute((db) =>
					db.run(
						PG.insertInto(CloudSecurityServiceStates)
							.values({
								orgId: state.orgId,
								connectionId: state.connectionId,
								region: state.region,
								source: state.source,
								...values,
							})
							.onConflictDoUpdate({
								target: ["orgId", "connectionId", "region", "source"],
								set: values,
							}),
					),
				)
			})

			const recordPush = Effect.fn("CloudSecurityStore.recordPush")(function* (
				feed: CloudFeedRef,
				at: number,
			) {
				yield* dbExecute((db) =>
					db.run(
						PG.update(CloudSecurityServiceStates)
							.set({ pushedAt: at })
							.where(($) => [
								$.orgId.eq(feed.orgId),
								$.connectionId.eq(feed.connectionId),
								$.region.eq(feed.region),
								$.source.eq(feed.source),
							]),
					),
				)
			})

			const serviceStates = Effect.fn("CloudSecurityStore.serviceStates")(function* (
				orgId: OrgId,
				connectionId: AwsConnectionId,
			) {
				return yield* dbExecute((db) =>
					db.run(
						PG.from(CloudSecurityServiceStates)
							.select()
							.where(($) => [$.orgId.eq(orgId), $.connectionId.eq(connectionId)]),
					),
				)
			})

			const knowsRegion = Effect.fn("CloudSecurityStore.knowsRegion")(function* (
				orgId: OrgId,
				connectionId: AwsConnectionId,
				region: AwsRegion,
			) {
				const rows = yield* dbExecute((db) =>
					db.run(
						PG.from(CloudSecurityServiceStates)
							.select(($) => ({ source: $.source }))
							.where(($) => [
								$.orgId.eq(orgId),
								$.connectionId.eq(connectionId),
								$.region.eq(region),
							])
							.limit(1),
					),
				)
				return rows.length > 0
			})

			const staleIds = Effect.fn("CloudSecurityStore.staleIds")(function* (
				feed: CloudFeedRef,
				syncedBefore: number,
				limit: number,
			) {
				const rows = yield* dbExecute((db) =>
					db.run(
						PG.from(CloudSecurityFindings)
							.select(($) => ({ findingId: $.findingId }))
							.where(($) => [
								$.orgId.eq(feed.orgId),
								$.connectionId.eq(feed.connectionId),
								$.region.eq(feed.region),
								$.source.eq(feed.source),
								$.syncedAt.lt(syncedBefore),
								// A resolved finding is rechecked for a week after it closed, for a console reopen.
								PG.or(
									$.status.neq("resolved"),
									$.closedAt.gte(syncedBefore - REOPEN_WINDOW_MS),
								),
							])
							.orderBy(($) => [[$.syncedAt, "asc"]])
							.limit(limit),
					),
				)
				return Arr.map(rows, (row) => row.findingId)
			})

			const resolve = Effect.fn("CloudSecurityStore.resolve")(function* (
				feed: CloudFeedRef,
				ids: { readonly only: ReadonlyArray<string> } | { readonly except: ReadonlyArray<string> },
				at: number,
			) {
				if ("only" in ids && ids.only.length === 0) return 0
				// An open finding closes now; an archived one keeps the time it closed. Not the provider
				// time either: the service may still report this finding, at its own time.
				const resolveWhere = (
					from: "active" | "archived" | "resolved",
					set: { readonly closedAt?: number },
				) =>
					dbExecute((db) =>
						db.run(
							PG.update(CloudSecurityFindings)
								.set({ status: "resolved", syncedAt: at, ...set })
								.where(($) => [
									$.orgId.eq(feed.orgId),
									$.connectionId.eq(feed.connectionId),
									$.region.eq(feed.region),
									$.source.eq(feed.source),
									$.status.eq(from),
									// A finding an event stored after the read began is newer than what the read saw.
									$.syncedAt.lt(at),
									...("only" in ids
										? [PG.inList($.findingId, ids.only)]
										: ids.except.length === 0
											? []
											: [PG.notInList($.findingId, ids.except)]),
								])
								.returning(($) => ({ findingId: $.findingId })),
						),
					)
				const opened = yield* resolveWhere("active", { closedAt: at })
				const archived = yield* resolveWhere("archived", {})
				// Checked and still gone: a resolved row moves to the back of the recheck queue.
				if ("only" in ids) yield* resolveWhere("resolved", {})
				return opened.length + archived.length
			})

			const pruneClosed = Effect.fn("CloudSecurityStore.pruneClosed")(function* (
				orgId: OrgId,
				beforeMs: number,
			) {
				const deleted = yield* dbExecute((db) =>
					db.run(
						PG.deleteFrom(CloudSecurityFindings)
							.where(($) => [
								$.orgId.eq(orgId),
								$.status.neq("active"),
								$.closedAt.lt(beforeMs),
							])
							.returning(($) => ({ findingId: $.findingId })),
					),
				)
				return deleted.length
			})

			const listFindings = Effect.fn("CloudSecurityStore.listFindings")(function* (
				orgId: OrgId,
				filters: CloudFindingFilters,
				page: CloudFindingPage,
			) {
				yield* Effect.annotateCurrentSpan({
					"tenant.orgId": orgId,
					"maple.cloud_security.status": filters.status,
				})
				const search = filters.search === undefined ? "" : Str.trim(filters.search)
				const pattern = search === "" ? undefined : `%${PG.escapeLike(search)}%`
				const severities = filters.severities ?? []
				const sources = filters.sources ?? []
				const rows = yield* dbExecute((db) =>
					db.run(
						PG.from(CloudSecurityFindings)
							.select()
							.where(($) => [
								$.orgId.eq(orgId),
								$.status.eq(filters.status),
								Arr.isReadonlyArrayNonEmpty(severities)
									? $.severity.in_(...severities)
									: undefined,
								Arr.isReadonlyArrayNonEmpty(sources) ? $.source.in_(...sources) : undefined,
								filters.accountId === undefined
									? undefined
									: $.accountId.eq(filters.accountId),
								filters.region === undefined ? undefined : $.region.eq(filters.region),
								pattern === undefined
									? undefined
									: PG.or(
											$.title.ilike(pattern),
											$.type.ilike(pattern),
											$.resourceId.ilike(pattern),
										),
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
										PG.lit(SEVERITY_RANK.info),
									),
									"asc",
								],
								[$.lastSeenAt, "desc"],
								[$.findingId, "asc"],
								[$.connectionId, "asc"],
								[$.region, "asc"],
								[$.source, "asc"],
							])
							.limit(page.limit + 1)
							.offset(page.offset),
					),
				)
				yield* Effect.annotateCurrentSpan("result.rowCount", rows.length)
				return { rows: Arr.take(rows, page.limit), hasMore: rows.length > page.limit }
			})

			const getFinding = Effect.fn("CloudSecurityStore.getFinding")(function* (
				orgId: OrgId,
				key: CloudFindingKey,
			) {
				const rows = yield* dbExecute((db) =>
					db.run(
						PG.from(CloudSecurityFindings)
							.select()
							.where(($) => [
								$.orgId.eq(orgId),
								$.connectionId.eq(key.connectionId),
								$.region.eq(key.region),
								$.source.eq(key.source),
								$.findingId.eq(key.findingId),
							])
							.limit(1),
					),
				)
				return Option.fromUndefinedOr(rows[0])
			})

			const summary = Effect.fn("CloudSecurityStore.summary")(function* (orgId: OrgId) {
				const groups = yield* dbExecute((db) =>
					db.run(
						PG.from(CloudSecurityFindings)
							.select(($) => ({ severity: $.severity, source: $.source, findings: PG.count() }))
							.where(($) => [$.orgId.eq(orgId), $.status.eq("active")])
							.groupBy("severity", "source"),
					),
				)
				const bySeverity = { critical: 0, high: 0, medium: 0, low: 0, info: 0 }
				const bySource = { guardduty: 0, securityhub: 0, inspector: 0, access_analyzer: 0 }
				const total = Arr.reduce(groups, 0, (sum, group) => {
					const findings = Number(group.findings)
					bySeverity[group.severity] += findings
					bySource[group.source] += findings
					return sum + findings
				})
				return { total, bySeverity, bySource } satisfies CloudFindingSummary
			})

			const orgServiceStates = Effect.fn("CloudSecurityStore.orgServiceStates")(function* (
				orgId: OrgId,
			) {
				return yield* dbExecute((db) =>
					db.run(
						PG.from(CloudSecurityServiceStates)
							.select()
							.where(($) => [$.orgId.eq(orgId)])
							.orderBy(["source", "asc"], ["region", "asc"]),
					),
				)
			})

			return {
				upsertFindings,
				recordServiceState,
				recordPush,
				serviceStates,
				knowsRegion,
				listFindings,
				getFinding,
				summary,
				orgServiceStates,
				staleIds,
				resolve,
				pruneClosed,
			} satisfies CloudSecurityStoreApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
