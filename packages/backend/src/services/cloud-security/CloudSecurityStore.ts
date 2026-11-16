import type {
	CloudFindingSeverity,
	CloudFindingSource,
	CloudFindingStatus,
	CloudSecurityFeed,
	CloudServiceState,
} from "@maple/domain/cloud-security"
import { IntegrationsPersistenceError } from "@maple/domain/http"
import {
	CloudSecurityFindings,
	type CloudSecurityServiceStateRow,
	CloudSecurityServiceStates,
} from "@maple/db/tables"
import type { AwsAccountId, AwsConnectionId, AwsRegion, OrgId } from "@maple/primitives"
import * as PG from "@maple-dev/effect-orm/postgres"
import { Array as Arr, Context, Effect, Layer, Record as Rec } from "effect"
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

/** Rows per INSERT: a finding carries a jsonb detail, and Postgres caps one statement's parameters. */
const UPSERT_CHUNK = 100

/** A closed finding is kept this long after the service last touched it. */
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
	readonly serviceStates: (
		orgId: OrgId,
		connectionId: AwsConnectionId,
	) => Effect.Effect<ReadonlyArray<CloudSecurityServiceStateRow>, IntegrationsPersistenceError>
	/** Active and archived findings of one feed synced before `syncedBefore`, oldest sync first. */
	readonly staleOpenIds: (
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
	/** Deletes the org's closed findings the service last touched before `beforeMs`. */
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

			/** The closed rows among `rows` that are stored already: a finding first seen closed is not kept. */
			/** One finding's identity across orgs and connections. */
			const keyOf = (row: {
				readonly orgId: string
				readonly connectionId: string
				readonly region: string
				readonly source: string
				readonly findingId: string
			}) => `${row.orgId}\n${row.connectionId}\n${row.region}\n${row.source}\n${row.findingId}`

			/** The closed rows among `rows` that are stored already: a finding first seen closed is not kept. */
			const storedClosed = (rows: ReadonlyArray<CloudFindingWrite>) => {
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
						const keys = new Set(Arr.map(Arr.flatten(found), keyOf))
						return Arr.filter(closed, (row) => keys.has(keyOf(row)))
					},
				)
			}

			const upsertFindings = Effect.fn("CloudSecurityStore.upsertFindings")(function* (
				rows: ReadonlyArray<CloudFindingWrite>,
				syncedAt: number,
			) {
				const closed = yield* storedClosed(rows)
				const kept = Arr.appendAll(
					Arr.filter(rows, (row) => row.status === "active"),
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
									.values(Arr.map(chunk, (row) => ({ ...row, syncedAt })))
									.onConflictDoUpdate({
										target: ["orgId", "connectionId", "region", "source", "findingId"],
										set: PG.excludedAll(),
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

			const staleOpenIds = Effect.fn("CloudSecurityStore.staleOpenIds")(function* (
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
								$.status.neq("resolved"),
								$.syncedAt.lt(syncedBefore),
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
				const updated = yield* dbExecute((db) =>
					db.run(
						PG.update(CloudSecurityFindings)
							.set({ status: "resolved", providerUpdatedAt: at, syncedAt: at })
							.where(($) => [
								$.orgId.eq(feed.orgId),
								$.connectionId.eq(feed.connectionId),
								$.region.eq(feed.region),
								$.source.eq(feed.source),
								$.status.neq("resolved"),
								...("only" in ids
									? [PG.inList($.findingId, ids.only)]
									: ids.except.length === 0
										? []
										: [PG.notInList($.findingId, ids.except)]),
							])
							.returning(($) => ({ findingId: $.findingId })),
					),
				)
				return updated.length
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
								$.providerUpdatedAt.lt(beforeMs),
							])
							.returning(($) => ({ findingId: $.findingId })),
					),
				)
				return deleted.length
			})

			return {
				upsertFindings,
				recordServiceState,
				serviceStates,
				staleOpenIds,
				resolve,
				pruneClosed,
			} satisfies CloudSecurityStoreApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
