import {
	DashboardConcurrencyError,
	DashboardDeleteResponse,
	DashboardId,
	DashboardNotFoundError,
	DashboardPersistenceError,
	DashboardStoredConfigInvalidError,
	DashboardValidationError,
	DashboardDocument,
	DashboardVersionDetail,
	DashboardVersionId,
	DashboardVersionNotFoundError,
	DashboardVersionsListResponse,
	DashboardVersionSummary,
	IsoDateTimeString,
	OrgId,
	PortableDashboardDocument,
	sanitizeDashboardSections,
	UserId,
} from "@maple/domain/http"
import { dataSourceRawSql, parseStoredDashboard, stampCurrentVersion } from "@maple/widgets/dashboard"
import { dashboardTimeBoundIssue } from "@maple/domain/raw-sql"
import * as PG from "@maple-dev/effect-orm/postgres"
import { Dashboards, DashboardVersions, type DashboardVersionRow } from "@maple/db/tables"
import { DateTime, Clock, Effect, Layer, Option, Schema, Context, Array as Arr } from "effect"
import { randomUUID } from "node:crypto"
import type { MapleDb } from "@maple/db/client"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute } from "@maple/backend/platform/db-execute"
import { currentTxid, readTxid } from "@maple/backend/platform/electric-txid"
import { summarizeDashboardChange } from "./dashboard-changes"
import { timestampMs } from "@maple/backend/platform/time"

const decodeDashboardIdSync = Schema.decodeUnknownSync(DashboardId)
const decodeDashboardVersionIdSync = Schema.decodeUnknownSync(DashboardVersionId)
const decodeIsoDateTimeStringSync = Schema.decodeUnknownSync(IsoDateTimeString)
const encodeJsonSync = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

const COALESCE_WINDOW_MS = 5_000

// Optimistic-locking retry budget for `mutate`. Each attempt re-reads the
// current dashboard, re-applies the caller's transform on top of it, and
// attempts a compare-and-swap on (id, version). Five attempts is enough for
// genuine contention; if we still can't win the CAS we surface the conflict
// to the caller so they can refetch and retry at their own pace.
const MUTATE_MAX_ATTEMPTS = 5

const toPersistenceError = (error: unknown) =>
	new DashboardPersistenceError({
		message: error instanceof Error ? error.message : "Dashboard persistence failed",
	})

const parseTimestamp = (field: "createdAt" | "updatedAt", value: string) => {
	const timestamp = timestampMs(value)

	if (!Number.isFinite(timestamp)) {
		return Effect.fail(
			new DashboardValidationError({
				message: `Invalid ${field} timestamp`,
				details: [`${field} must be an ISO date-time string`],
			}),
		)
	}

	return Effect.succeed(timestamp)
}

/**
 * Reads a stored payload: migrate the raw JSON up to the current schema version,
 * then decode.
 *
 * A rejection is a hard failure for `get`, `mutate` and version reads: a
 * partially-decoded document handed to `mutate` would be written back and the
 * original lost. Only `list` and `listPage` skip a rejected row (logged), so one
 * bad board cannot hide the rest of the org's.
 */
const parsePayload = Effect.fnUntraced(function* (
	payloadJson: unknown,
	context: {
		readonly dashboardId: DashboardId
		readonly component: DashboardStoredConfigInvalidError["component"]
		readonly versionId?: DashboardVersionId
	},
) {
	const outcome = yield* parseStoredDashboard(payloadJson)

	if (outcome._tag === "Rejected") {
		yield* Effect.logError("Stored dashboard payload failed schema decode", {
			fromVersion: outcome.fromVersion,
			issue: outcome.issue,
		})
		return yield* new DashboardStoredConfigInvalidError({
			message: "Stored dashboard payload is invalid",
			dashboardId: context.dashboardId,
			component: context.component,
			...(!(context.versionId === undefined) ? { versionId: context.versionId } : undefined),
			cause: outcome.issue,
		})
	}

	yield* Effect.annotateCurrentSpan({
		"maple.dashboard.schema_version_read": outcome.fromVersion,
		"maple.dashboard.degraded_widgets": outcome.degradedWidgetIds.length,
	})

	return outcome.document
})

// jsonb columns take the document object directly; this guard preserves the
// pre-Postgres validation that the payload is JSON-serializable before write.
const duplicatesOf = (values: ReadonlyArray<string>) => [
	...new Set(Arr.filter(values, (value, index) => values.indexOf(value) !== index)),
]

/** Every raw SQL text by widget id: the tile and a stat's sparkline, which runs on every refresh too. */
const rawSqlByWidget = (dashboard: DashboardDocument | undefined) =>
	Arr.flatMap(dashboard?.widgets ?? [], (widget) =>
		Arr.flatMap([widget.dataSource, widget.display?.sparkline?.dataSource], (dataSource) => {
			const rawSql = dataSourceRawSql(dataSource)
			return rawSql === null || rawSql.sql === "" ? [] : [[widget.id, rawSql.sql] as const]
		}),
	)

const validatePayload = Effect.fnUntraced(function* (
	dashboard: DashboardDocument,
	previous?: DashboardDocument,
	/** A version restore reinstates SQL this dashboard already ran, so the time-bound rule does not apply. */
	isRestore = false,
) {
	const duplicateNames = duplicatesOf(Arr.map(dashboard.variables ?? [], (variable) => variable.name))
	if (duplicateNames.length > 0) {
		return yield* new DashboardValidationError({
			message: "Dashboard variable names must be unique",
			details: Arr.map(duplicateNames, (name) => `Duplicate variable name: ${name}`),
		})
	}

	// Widget ids address shares, patches and widget_data requests; a duplicate makes them ambiguous.
	// Boards stored with duplicates before this rule stay editable: only a new duplicate is refused.
	const storedDuplicates = new Set(duplicatesOf(Arr.map(previous?.widgets ?? [], (widget) => widget.id)))
	const duplicateWidgetIds = Arr.filter(
		duplicatesOf(Arr.map(dashboard.widgets, (widget) => widget.id)),
		(id) => !storedDuplicates.has(id),
	)
	if (duplicateWidgetIds.length > 0) {
		return yield* new DashboardValidationError({
			message: "Dashboard widget ids must be unique",
			details: Arr.map(duplicateWidgetIds, (id) => `Duplicate widget id: ${id}`),
		})
	}

	// Raw SQL reruns on every refresh, so new or changed SQL must bound its time range.
	// Widgets saved before the rule keep their SQL (and keep running) until edited.
	const storedSql = new Set(Arr.map(rawSqlByWidget(previous), ([, sql]) => sql))
	const unboundedWidgets = isRestore
		? []
		: Arr.filter(
				rawSqlByWidget(dashboard),
				([, sql]) => !storedSql.has(sql) && dashboardTimeBoundIssue(sql) !== null,
			)
	if (unboundedWidgets.length > 0) {
		return yield* new DashboardValidationError({
			// The v2 envelope exposes only the message, so it names the widgets itself.
			message: `Raw SQL widgets must reference $__timeFilter(...) or $__startTime: ${Arr.join(
				Arr.dedupe(Arr.map(unboundedWidgets, ([id]) => id)),
				", ",
			)}`,
			details: Arr.map(
				unboundedWidgets,
				([id]) =>
					`Widget ${id}: add \`AND $__timeFilter(Timestamp)\` (or the table's time column) to the WHERE clause`,
			),
		})
	}

	return yield* Effect.try({
		try: () => {
			encodeJsonSync(dashboard)
			// Repair the section invariants here — the single choke point for every
			// jsonb write — so v1 upsert, v2 PATCH, MCP, template instantiate,
			// Perses import and version restore all get it, and every reader can
			// trust that storage is consistent. A no-op by reference on any
			// document without sections, which is every pre-sections dashboard.
			const repaired = sanitizeDashboardSections(dashboard)
			// `txid` is a transport-only field carried on mutation responses; it must
			// never be persisted into `payload_json` (nor a version snapshot). Strip
			// it here so a client that echoes it back in an upsert payload can't
			// leak it into storage.
			const { txid: _txid, ...rest } = repaired
			// Stamp the schema version every writer's document is being stored in.
			// This is the only place it happens, which is why upgrades are lazy: a
			// legacy document is migrated in memory on every read and only recorded
			// at its next natural write. No backfill job, and so nothing to undo.
			return new DashboardDocument(stampCurrentVersion(rest))
		},
		catch: () =>
			new DashboardValidationError({
				message: "Dashboard payload must be JSON serializable",
				details: ["Dashboard contains non-serializable values"],
			}),
	})
})

const createDashboardDocument = (portableDashboard: PortableDashboardDocument, nowMillis: number) => {
	const now = new Date(nowMillis).toISOString()

	// A document is a portable document plus identity and timestamps, so spread
	// the portable one rather than naming its fields: a field added to
	// `makeDashboardDocumentFields`' portable half then reaches storage without a
	// second edit here. Spreading is safe because an absent `Schema.optionalKey`
	// field is not an own property of a decoded instance, so nothing forwards a
	// present `undefined` (which the Schema.Class constructor rejects).
	return new DashboardDocument({
		...portableDashboard,
		id: decodeDashboardIdSync(randomUUID()),
		createdAt: decodeIsoDateTimeStringSync(now),
		updatedAt: decodeIsoDateTimeStringSync(now),
	})
}

const versionRowToSummary = (row: DashboardVersionRow): DashboardVersionSummary =>
	new DashboardVersionSummary({
		id: row.id,
		dashboardId: row.dashboardId,
		versionNumber: row.versionNumber,
		changeKind: row.changeKind as DashboardVersionSummary["changeKind"],
		changeSummary: row.changeSummary ?? null,
		sourceVersionId: row.sourceVersionId ?? null,
		createdAt: decodeIsoDateTimeStringSync(new Date(row.createdAt).toISOString()),
		createdBy: row.createdBy,
	})

export type MutateOptions = {
	readonly forceKind?: DashboardVersionSummary["changeKind"]
	readonly forceSummary?: string
	readonly sourceVersionId?: DashboardVersionId | null
	/** The `dashboards.version` the caller's edit was based on; any other current version is a conflict. */
	readonly expectedVersion?: number
}

/** Keyset position in the newest-first list: the last row a page returned. */
export interface DashboardPageCursor {
	readonly updatedAt: number
	readonly id: DashboardId
}

/** A stored document with its `dashboards.version`, the CAS token a client sends back as `expected_version`. */
export interface StoredDashboard {
	readonly document: DashboardDocument
	readonly version: number
}

export interface DashboardPage {
	readonly dashboards: ReadonlyArray<StoredDashboard>
	/** Where the next page starts, `null` on the last page. */
	readonly next: DashboardPageCursor | null
}

export interface DashboardPersistenceServiceApi {
	readonly create: (
		orgId: OrgId,
		userId: UserId,
		dashboard: PortableDashboardDocument,
	) => Effect.Effect<StoredDashboard, DashboardValidationError | DashboardPersistenceError>
	/** Every dashboard of the org, newest first; a row that does not decode is logged and skipped. */
	readonly list: (
		orgId: OrgId,
	) => Effect.Effect<{ readonly dashboards: ReadonlyArray<StoredDashboard> }, DashboardPersistenceError>
	/** One page of `list`, paginated in SQL on (updatedAt, id). */
	readonly listPage: (
		orgId: OrgId,
		page: { readonly limit: number; readonly after?: DashboardPageCursor },
	) => Effect.Effect<DashboardPage, DashboardPersistenceError>
	readonly get: (
		orgId: OrgId,
		dashboardId: DashboardId,
	) => Effect.Effect<
		StoredDashboard,
		DashboardPersistenceError | DashboardNotFoundError | DashboardStoredConfigInvalidError
	>
	readonly mutate: <E>(
		orgId: OrgId,
		userId: UserId,
		dashboardId: DashboardId,
		transform: (dashboard: DashboardDocument) => Effect.Effect<DashboardDocument, E>,
		options?: MutateOptions,
	) => Effect.Effect<
		StoredDashboard,
		| E
		| DashboardNotFoundError
		| DashboardValidationError
		| DashboardConcurrencyError
		| DashboardPersistenceError
		| DashboardStoredConfigInvalidError
	>
	readonly delete: (
		orgId: OrgId,
		dashboardId: DashboardId,
	) => Effect.Effect<DashboardDeleteResponse, DashboardPersistenceError | DashboardNotFoundError>
	readonly listVersions: (
		orgId: OrgId,
		dashboardId: DashboardId,
		options?: { readonly limit?: number; readonly before?: number },
	) => Effect.Effect<
		DashboardVersionsListResponse,
		DashboardPersistenceError | DashboardNotFoundError | DashboardStoredConfigInvalidError
	>
	readonly getVersion: (
		orgId: OrgId,
		dashboardId: DashboardId,
		versionId: DashboardVersionId,
	) => Effect.Effect<
		DashboardVersionDetail,
		| DashboardPersistenceError
		| DashboardNotFoundError
		| DashboardVersionNotFoundError
		| DashboardStoredConfigInvalidError
	>
	readonly restoreVersion: (
		orgId: OrgId,
		userId: UserId,
		dashboardId: DashboardId,
		versionId: DashboardVersionId,
	) => Effect.Effect<
		StoredDashboard,
		| DashboardPersistenceError
		| DashboardNotFoundError
		| DashboardVersionNotFoundError
		| DashboardValidationError
		| DashboardConcurrencyError
		| DashboardStoredConfigInvalidError
	>
}

export class DashboardPersistenceService extends Context.Service<
	DashboardPersistenceService,
	DashboardPersistenceServiceApi
>()("@maple/backend/services/DashboardPersistenceService", {
	make: Effect.gen(function* () {
		const database = yield* Database
		const dbExecute = makeDbExecute(database, "DashboardPersistenceService", toPersistenceError)

		const loadCurrent = Effect.fn("DashboardPersistenceService.loadCurrent")(function* (
			orgId: OrgId,
			dashboardId: DashboardId,
		) {
			yield* Effect.annotateCurrentSpan({ orgId, "maple.dashboard.id": dashboardId })
			const rows: ReadonlyArray<{
				readonly payloadJson: unknown
				readonly version: number
			}> = yield* dbExecute((db) =>
				db.run(
					PG.from(Dashboards)
						.select("payloadJson", "version")
						.where(($) => [$.orgId.eq(orgId), $.id.eq(dashboardId)]),
				),
			)

			const row = rows[0]
			if (row === undefined) return null
			const document = yield* parsePayload(row.payloadJson, {
				dashboardId,
				component: "document",
			})
			return { document, version: row.version } satisfies StoredDashboard
		})

		// Runs inside the dashboard write's transaction, after its row is written and
		// locked, so concurrent saves serialize on that lock and `max + 1` cannot collide.
		const recordVersionIn = (
			db: MapleDb,
			orgId: OrgId,
			userId: UserId,
			dashboard: DashboardDocument,
			snapshotJson: DashboardDocument,
			previous: DashboardDocument | null,
			now: number,
			options: MutateOptions = {},
		) =>
			Effect.gen(function* () {
				const summary = summarizeDashboardChange(previous, dashboard)
				const kind = options.forceKind ?? summary.kind
				const summaryText = options.forceSummary ?? summary.summary

				const latest: ReadonlyArray<DashboardVersionRow> = yield* db.run(
					PG.from(DashboardVersions)
						.select()
						.where(($) => [$.orgId.eq(orgId), $.dashboardId.eq(dashboard.id)])
						.orderBy(["versionNumber", "desc"])
						.limit(1),
				)

				const latestRow = latest[0]
				// Measured from the version's own createdAt, which a merge never moves,
				// so a steady stream of edits still cuts a new version every window.
				const canCoalesce =
					!options.sourceVersionId &&
					!options.forceKind &&
					latestRow !== undefined &&
					latestRow.createdBy === userId &&
					latestRow.changeKind === kind &&
					now - latestRow.createdAt < COALESCE_WINDOW_MS

				if (canCoalesce && latestRow !== undefined) {
					yield* db.run(
						PG.update(DashboardVersions)
							.set({ snapshotJson, changeSummary: summaryText })
							.where(($) => [$.orgId.eq(orgId), $.id.eq(latestRow.id)]),
					)
					return
				}

				const versionNumber = (latestRow?.versionNumber ?? 0) + 1

				yield* db.run(
					PG.insertInto(DashboardVersions).values({
						orgId,
						id: decodeDashboardVersionIdSync(randomUUID()),
						dashboardId: dashboard.id,
						versionNumber,
						snapshotJson,
						changeKind: kind,
						changeSummary: summaryText,
						sourceVersionId: options.sourceVersionId ?? null,
						createdAt: now,
						createdBy: userId,
					}),
				)
			})

		/** Decode listed rows, logging and dropping any that `get` would refuse. */
		const decodeListed = (
			rows: ReadonlyArray<{
				readonly id: DashboardId
				readonly payloadJson: unknown
				readonly version: number
			}>,
		) =>
			Effect.forEach(rows, (row) =>
				parsePayload(row.payloadJson, { dashboardId: row.id, component: "document" }).pipe(
					Effect.map((document): Option.Option<StoredDashboard> =>
						Option.some({ document, version: row.version }),
					),
					Effect.catchTag("@maple/http/errors/DashboardStoredConfigInvalidError", () =>
						Effect.logWarning("Skipping undecodable dashboard in list").pipe(
							Effect.annotateLogs({ "maple.dashboard.id": row.id }),
							Effect.as(Option.none<StoredDashboard>()),
						),
					),
				),
			).pipe(Effect.map(Arr.getSomes))

		const list = Effect.fn("DashboardPersistenceService.list")(function* (orgId: OrgId) {
			yield* Effect.annotateCurrentSpan("orgId", orgId)
			const rows: ReadonlyArray<{
				readonly id: DashboardId
				readonly payloadJson: unknown
				readonly version: number
			}> = yield* dbExecute((db) =>
				db.run(
					PG.from(Dashboards)
						.select("id", "payloadJson", "version")
						.where(($) => [$.orgId.eq(orgId)])
						.orderBy(($) => [
							[$.updatedAt, "desc"],
							[$.id, "desc"],
						]),
				),
			)

			return { dashboards: yield* decodeListed(rows) }
		})

		const listPage = Effect.fn("DashboardPersistenceService.listPage")(function* (
			orgId: OrgId,
			page: { readonly limit: number; readonly after?: DashboardPageCursor },
		) {
			yield* Effect.annotateCurrentSpan("orgId", orgId)
			const after = page.after
			// One row of lookahead says whether another page exists.
			const rows: ReadonlyArray<{
				readonly id: DashboardId
				readonly payloadJson: unknown
				readonly version: number
				readonly updatedAt: number
			}> = yield* dbExecute((db) =>
				db.run(
					PG.from(Dashboards)
						.select("id", "payloadJson", "version", "updatedAt")
						.where(($) => [
							$.orgId.eq(orgId),
							after === undefined
								? undefined
								: PG.or(
										$.updatedAt.lt(after.updatedAt),
										PG.and($.updatedAt.eq(after.updatedAt), $.id.lt(after.id)),
									),
						])
						.orderBy(($) => [
							[$.updatedAt, "desc"],
							[$.id, "desc"],
						])
						.limit(page.limit + 1),
				),
			)

			const pageRows = rows.slice(0, page.limit)
			const last = pageRows[pageRows.length - 1]
			// The cursor follows the last row read, decodable or not, so a skipped row never stalls paging.
			const next =
				rows.length > page.limit && last !== undefined
					? { updatedAt: last.updatedAt, id: last.id }
					: null
			return { dashboards: yield* decodeListed(pageRows), next } satisfies DashboardPage
		})

		const get = Effect.fn("DashboardPersistenceService.get")(function* (
			orgId: OrgId,
			dashboardId: DashboardId,
		) {
			yield* Effect.annotateCurrentSpan({ orgId, "maple.dashboard.id": dashboardId })
			const current = yield* loadCurrent(orgId, dashboardId)
			if (current === null) {
				return yield* new DashboardNotFoundError({ dashboardId, message: "Dashboard not found" })
			}
			return current
		})

		// Compare-and-swap on `dashboards.version` and the history row, in one
		// transaction: a lost CAS writes nothing, and a saved edit always has its version.
		const writeVersioned = Effect.fn("DashboardPersistenceService.writeVersioned")(function* (
			orgId: OrgId,
			userId: UserId,
			next: DashboardDocument,
			previous: DashboardDocument,
			expectedVersion: number,
			conflict: DashboardConcurrencyError,
			options: MutateOptions,
		) {
			yield* Effect.annotateCurrentSpan({
				orgId,
				"tenant.userId": userId,
				"maple.dashboard.id": next.id,
			})
			const payloadJson = yield* validatePayload(next, previous, options.forceKind === "restored")
			const updatedAt = yield* parseTimestamp("updatedAt", next.updatedAt)
			const now = yield* Clock.currentTimeMillis
			return yield* dbExecute((db) =>
				db.transaction(
					Effect.gen(function* () {
						const updated = yield* db.run(
							PG.update(Dashboards)
								.set({
									name: next.name,
									payloadJson,
									updatedAt,
									updatedBy: userId,
									version: expectedVersion + 1,
								})
								.where(($) => [
									$.orgId.eq(orgId),
									$.id.eq(next.id),
									$.version.eq(expectedVersion),
								])
								.returning(($) => ({ id: $.id, txid: currentTxid })),
						)
						if (updated.length === 0) return yield* conflict
						yield* recordVersionIn(db, orgId, userId, next, payloadJson, previous, now, options)
						return readTxid(updated)
					}),
				),
			)
		})

		const create = Effect.fn("DashboardPersistenceService.create")(function* (
			orgId: OrgId,
			userId: UserId,
			dashboard: PortableDashboardDocument,
		) {
			yield* Effect.annotateCurrentSpan({ orgId, "tenant.userId": userId })
			const nowMillis = yield* Clock.currentTimeMillis
			const createdDashboard = createDashboardDocument(dashboard, nowMillis)
			yield* Effect.annotateCurrentSpan("maple.dashboard.id", createdDashboard.id)
			const payloadJson = yield* validatePayload(createdDashboard)
			const createdAt = yield* parseTimestamp("createdAt", createdDashboard.createdAt)
			const updatedAt = yield* parseTimestamp("updatedAt", createdDashboard.updatedAt)
			const txid = yield* dbExecute((db) =>
				db.transaction(
					Effect.gen(function* () {
						const inserted = yield* db.run(
							PG.insertInto(Dashboards)
								.values({
									orgId,
									id: createdDashboard.id,
									name: createdDashboard.name,
									payloadJson,
									createdAt,
									updatedAt,
									createdBy: userId,
									updatedBy: userId,
									version: 1,
								})
								.returning(() => ({ txid: currentTxid })),
						)
						yield* recordVersionIn(
							db,
							orgId,
							userId,
							createdDashboard,
							payloadJson,
							null,
							nowMillis,
						)
						return readTxid(inserted)
					}),
				),
			)

			const document =
				txid === undefined ? createdDashboard : new DashboardDocument({ ...createdDashboard, txid })
			return { document, version: 1 } satisfies StoredDashboard
		})

		// Read-modify-write behind every edit: load, run the caller's transform, CAS.
		// A lost CAS re-reads and re-applies the transform, up to MUTATE_MAX_ATTEMPTS.
		// With `expectedVersion` the caller's own read is the base instead, so a
		// current version other than it fails at once rather than being merged over.
		const mutate = Effect.fn("DashboardPersistenceService.mutate")(function* <E>(
			orgId: OrgId,
			userId: UserId,
			dashboardId: DashboardId,
			transform: (dashboard: DashboardDocument) => Effect.Effect<DashboardDocument, E>,
			options: MutateOptions = {},
		) {
			yield* Effect.annotateCurrentSpan({
				orgId,
				"tenant.userId": userId,
				"maple.dashboard.id": dashboardId,
			})
			// One instance per call, so the retry predicate matches only a lost CAS
			// and never an error the caller's transform happens to raise.
			const conflict = new DashboardConcurrencyError({
				dashboardId,
				message:
					"Dashboard mutation failed after repeated concurrency conflicts. Refetch and try again.",
			})
			const attempt = Effect.gen(function* () {
				const current = yield* loadCurrent(orgId, dashboardId)
				if (current === null) {
					return yield* new DashboardNotFoundError({
						dashboardId,
						message: "Dashboard not found",
					})
				}
				if (options.expectedVersion !== undefined && options.expectedVersion !== current.version) {
					return yield* new DashboardConcurrencyError({
						dashboardId,
						message:
							"Someone else changed this dashboard since it was loaded. Reload and try again.",
					})
				}

				const next = yield* transform(current.document)
				const txid = yield* writeVersioned(
					orgId,
					userId,
					next,
					current.document,
					current.version,
					conflict,
					options,
				)

				const document = txid === undefined ? next : new DashboardDocument({ ...next, txid })
				// writeVersioned committed `current.version + 1`.
				return { document, version: current.version + 1 } satisfies StoredDashboard
			})

			return yield* attempt.pipe(
				Effect.retry({ times: MUTATE_MAX_ATTEMPTS - 1, while: (error) => error === conflict }),
			)
		})

		const remove = Effect.fn("DashboardPersistenceService.delete")(function* (
			orgId: OrgId,
			dashboardId: DashboardId,
		) {
			yield* Effect.annotateCurrentSpan({ orgId, "maple.dashboard.id": dashboardId })
			const notFound = new DashboardNotFoundError({ dashboardId, message: "Dashboard not found" })
			// History goes with the board, atomically: a failed delete leaves both.
			const rows = yield* dbExecute((db) =>
				db.transaction(
					Effect.gen(function* () {
						const deleted = yield* db.run(
							PG.deleteFrom(Dashboards)
								.where(($) => [$.orgId.eq(orgId), $.id.eq(dashboardId)])
								.returning(($) => ({ id: $.id, txid: currentTxid })),
						)
						if (deleted.length === 0) return yield* notFound
						yield* db.run(
							PG.deleteFrom(DashboardVersions).where(($) => [
								$.orgId.eq(orgId),
								$.dashboardId.eq(dashboardId),
							]),
						)
						return deleted
					}),
				),
			)

			const txid = readTxid(rows)
			return new DashboardDeleteResponse({
				id: rows[0]?.id ?? dashboardId,
				...(txid !== undefined ? { txid } : undefined),
			})
		})

		const ensureDashboardExists = Effect.fn("DashboardPersistenceService.ensureDashboardExists")(
			function* (orgId: OrgId, dashboardId: DashboardId) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.dashboard.id": dashboardId })
				const current = yield* loadCurrent(orgId, dashboardId)
				if (current === null) {
					return yield* new DashboardNotFoundError({
						dashboardId,
						message: "Dashboard not found",
					})
				}
				return current.document
			},
		)

		const listVersions = Effect.fn("DashboardPersistenceService.listVersions")(function* (
			orgId: OrgId,
			dashboardId: DashboardId,
			options: {
				readonly limit?: number
				readonly before?: number
			} = {},
		) {
			yield* Effect.annotateCurrentSpan({ orgId, "maple.dashboard.id": dashboardId })
			yield* ensureDashboardExists(orgId, dashboardId)

			const limit = Math.min(options.limit ?? 50, 200)
			const before = options.before
			const rows: ReadonlyArray<DashboardVersionRow> = yield* dbExecute((db) =>
				db.run(
					PG.from(DashboardVersions)
						.select()
						.where(($) => [
							$.orgId.eq(orgId),
							$.dashboardId.eq(dashboardId),
							before !== undefined ? $.versionNumber.lt(before) : undefined,
						])
						.orderBy(["versionNumber", "desc"])
						.limit(limit + 1),
				),
			)

			const hasMore = rows.length > limit
			const sliced = hasMore ? rows.slice(0, limit) : rows

			return new DashboardVersionsListResponse({
				versions: Arr.map(sliced, versionRowToSummary),
				hasMore,
			})
		})

		const getVersion = Effect.fn("DashboardPersistenceService.getVersion")(function* (
			orgId: OrgId,
			dashboardId: DashboardId,
			versionId: DashboardVersionId,
		) {
			yield* Effect.annotateCurrentSpan({
				orgId,
				"maple.dashboard.id": dashboardId,
				"maple.dashboard.version_id": versionId,
			})
			yield* ensureDashboardExists(orgId, dashboardId)

			const rows: ReadonlyArray<DashboardVersionRow> = yield* dbExecute((db) =>
				db.run(
					PG.from(DashboardVersions)
						.select()
						.where(($) => [$.orgId.eq(orgId), $.id.eq(versionId)])
						.limit(1),
				),
			)

			const row = rows[0]
			if (row === undefined || row.dashboardId !== dashboardId) {
				return yield* new DashboardVersionNotFoundError({
					dashboardId,
					versionId,
					message: "Dashboard version not found",
				})
			}

			const snapshot = yield* parsePayload(row.snapshotJson, {
				dashboardId,
				component: "version_snapshot",
				versionId,
			})

			return new DashboardVersionDetail({
				id: row.id,
				dashboardId: row.dashboardId,
				versionNumber: row.versionNumber,
				changeKind: row.changeKind as DashboardVersionSummary["changeKind"],
				changeSummary: row.changeSummary ?? null,
				sourceVersionId: row.sourceVersionId ?? null,
				createdAt: decodeIsoDateTimeStringSync(
					DateTime.formatIso(DateTime.makeUnsafe(row.createdAt)),
				),
				createdBy: row.createdBy,
				snapshot,
			})
		})

		const restoreVersion = Effect.fn("DashboardPersistenceService.restoreVersion")(function* (
			orgId: OrgId,
			userId: UserId,
			dashboardId: DashboardId,
			versionId: DashboardVersionId,
		) {
			yield* Effect.annotateCurrentSpan({
				orgId,
				"tenant.userId": userId,
				"maple.dashboard.id": dashboardId,
				"maple.dashboard.version_id": versionId,
			})
			const detail = yield* getVersion(orgId, dashboardId, versionId)

			const nowMs = yield* Clock.currentTimeMillis
			const nowIso = decodeIsoDateTimeStringSync(DateTime.formatIso(DateTime.makeUnsafe(nowMs)))
			const restored = new DashboardDocument({
				...detail.snapshot,
				updatedAt: nowIso,
			})

			return yield* mutate(orgId, userId, dashboardId, () => Effect.succeed(restored), {
				forceKind: "restored",
				forceSummary: `Restored from v${detail.versionNumber}`,
				sourceVersionId: detail.id,
			})
		})

		return {
			create,
			list,
			listPage,
			get,
			mutate,
			delete: remove,
			listVersions,
			getVersion,
			restoreVersion,
		} satisfies DashboardPersistenceServiceApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
}
