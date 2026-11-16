import type {
	CloudFindingSeverity,
	CloudFindingSource,
	CloudFindingStatus,
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
import { Array as Arr, Context, Effect, Layer, Option, String as Str } from "effect"
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
				const values = state.cursorAt === undefined ? base : { ...base, cursorAt: state.cursorAt }
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
								$.providerUpdatedAt.lt(beforeMs),
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
				yield* Effect.annotateCurrentSpan({ orgId, "maple.cloud_security.status": filters.status })
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
				serviceStates,
				listFindings,
				getFinding,
				summary,
				orgServiceStates,
				pruneClosed,
			} satisfies CloudSecurityStoreApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
