import type { CloudFindingSource, CloudServiceState } from "@maple/domain/cloud-security"
import { IntegrationsPersistenceError } from "@maple/domain/http"
import {
	CloudSecurityFindings,
	type CloudSecurityServiceStateRow,
	CloudSecurityServiceStates,
} from "@maple/db/tables"
import type { AwsConnectionId, AwsRegion, OrgId } from "@maple/primitives"
import * as PG from "@maple-dev/effect-orm/postgres"
import { Array as Arr, Context, Effect, Layer } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute, makePersistenceErrorMapper } from "@maple/backend/platform/db-execute"

// The AWS `security` module's findings at their latest version, and the per-region service states
// the poller keeps its cursors in. Every read and write is pinned to one org.

/** A finding as a poll read it, before it is stamped with the sync time. */
export type CloudFindingWrite = Omit<PG.InsertRowOf<typeof CloudSecurityFindings>, "syncedAt">

export interface CloudServiceStateWrite {
	readonly orgId: OrgId
	readonly connectionId: AwsConnectionId
	readonly region: AwsRegion
	readonly source: CloudFindingSource
	readonly state: CloudServiceState
	/** Moves the cursor; absent keeps the stored one (a failed or empty poll). */
	readonly cursorAt?: number
	/** The window size to start the next windowed read with; absent keeps the stored one. */
	readonly windowMs?: number
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

			const upsertFindings = Effect.fn("CloudSecurityStore.upsertFindings")(function* (
				rows: ReadonlyArray<CloudFindingWrite>,
				syncedAt: number,
			) {
				yield* Effect.annotateCurrentSpan({ "maple.cloud_security.findings": rows.length })
				yield* Effect.forEach(
					Arr.chunksOf(rows, UPSERT_CHUNK),
					(chunk) =>
						dbExecute((db) =>
							db.run(
								PG.insertInto(CloudSecurityFindings)
									.values(Arr.map(chunk, (row) => ({ ...row, syncedAt })))
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
				const withCursor = state.cursorAt === undefined ? base : { ...base, cursorAt: state.cursorAt }
				const values =
					state.windowMs === undefined ? withCursor : { ...withCursor, windowMs: state.windowMs }
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

			return {
				upsertFindings,
				recordServiceState,
				serviceStates,
				pruneClosed,
			} satisfies CloudSecurityStoreApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
