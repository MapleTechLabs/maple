// The local-mode server (`maple start`) as apps/local-ui sees it: `GET /local/status` and
// `POST /local/query`, run through the CLI's own query guard on chDB. Each store is its own chDB
// database, since every local row carries the same OrgId (`local`).
import { Effect, Option, Result, Schema } from "effect"
import { LOCAL_ORG_ID } from "@maple/query-engine/local"
import { parseWarehouseDateTime } from "@maple/query-engine"
import {
	prepareLocalQuery,
	READ_ONLY_REJECTION_PREFIX,
	ReadOnlyQueryRejected,
} from "../../../../apps/cli/src/server/query-guard.ts"
import { CAPTURE_HEADER, FAULTS_HEADER } from "../contract.ts"
import type { Dataset, LocalStore } from "../fixtures/dataset.ts"
import { TELEMETRY_TABLES } from "../fixtures/telemetry/rows.ts"
import type { Chdb } from "./chdb.ts"
import type { CallLog } from "./call-log.ts"
import { type Holds, mergeFaults, resolveFault } from "./faults.ts"
import { insertRows, once, schemaStatements, sealServiceMap } from "./warehouse.ts"

/** What `maple start` reports about itself; fixed so captures never depend on the host. */
const STATUS_IDENTITY = {
	service: "maple-local",
	pid: 4242,
	version: "0.0.27",
	url: "http://127.0.0.1:4318",
	dataDir: "/home/parity/.maple/data",
}

/** Runs `effect` with `database` as the session's current database, then switches back. */
const inDatabase = <A, E>(chdb: Chdb, database: string, effect: Effect.Effect<A, E>) =>
	Effect.acquireUseRelease(
		chdb.run(`USE ${database}`),
		() => effect,
		() => Effect.ignore(chdb.run("USE default")),
	)

/** Creates every local store's database with the warehouse schema and seeds its rows once. */
export const seedLocalStores = (chdb: Chdb, datasets: ReadonlyArray<Dataset>) =>
	Effect.forEach(
		datasets.flatMap((dataset) => (dataset.local === undefined ? [] : [{ dataset, store: dataset.local }])),
		({ dataset, store }) =>
			once(
				`local:${store.database}`,
				Effect.andThen(
					chdb.run(`CREATE DATABASE IF NOT EXISTS ${store.database}`),
					inDatabase(
						chdb,
						store.database,
						Effect.gen(function* () {
							yield* Effect.forEach([...schemaStatements, "SYSTEM STOP MERGES"], (sql) => chdb.run(sql), {
								discard: true,
							})
							yield* Effect.forEach(TELEMETRY_TABLES, (table) => insertRows(chdb, table, store.rows[table]), {
								discard: true,
							})
							yield* sealServiceMap(chdb, LOCAL_ORG_ID, parseWarehouseDateTime(dataset.now))
						}),
					),
				),
			),
		{ discard: true },
	)

const QueryBody = Schema.fromJsonString(Schema.Struct({ sql: Schema.String }))
const decodeQueryBody = Schema.decodeUnknownOption(QueryBody)

const text = (body: string, status: number, contentType = "text/plain;charset=utf-8") =>
	new Response(body, { status, headers: { "content-type": contentType } })

/**
 * One read statement, as `handleQuery` in apps/cli/src/server/serve.ts runs it. Synchronous from
 * `USE` to `USE default`, so no other request runs on the switched database in between.
 */
const runQuery = (chdb: Chdb, store: LocalStore, sql: string): Response => {
	const engine = { query: (statement: string, format?: string) => Effect.runSync(chdb.run(statement, format)) }
	const prepared = prepareLocalQuery(engine, sql, { allowWrites: false })
	if (Result.isFailure(prepared))
		return prepared.failure instanceof ReadOnlyQueryRejected
			? text(`${READ_ONLY_REJECTION_PREFIX}${prepared.failure.message}`, 400)
			: text(`query failed: ${prepared.failure.message}`, 400)
	const output = Effect.runSync(
		Effect.result(inDatabase(chdb, store.database, chdb.run(prepared.success.sql, "JSONEachRow"))),
	)
	if (Result.isFailure(output)) return text(`query failed: ${output.failure.message}`, 400)
	return text(output.success.length === 0 ? "[]" : output.success, 200, "application/json")
}

/** An injected failure, answered as the server answers: plain text at the status. */
const faultText = (body: Schema.JsonObject) =>
	typeof body.message === "string" ? body.message : JSON.stringify(body)

const statusBody = (store: LocalStore) => ({
	...STATUS_IDENTITY,
	lastIngestAtMs: store.lastIngestAt === null ? null : parseWarehouseDateTime(store.lastIngestAt),
	lastDeleteAtMs: null,
})

export interface LocalServer {
	/** The answer for a `/local/*` request, or `undefined` when the dataset has no local store. */
	readonly answer: (request: Request, url: URL, dataset: Dataset) => Promise<Response | undefined>
}

export const makeLocalServer = (chdb: Chdb, calls: CallLog, holds: Holds): LocalServer => ({
	answer: (request, url, dataset) =>
		Effect.runPromise(
			Effect.gen(function* () {
				const store = dataset.local
				if (store === undefined) return undefined
				const capture = request.headers.get(CAPTURE_HEADER)
				const isQuery = request.method === "POST" && url.pathname === "/local/query"
				const isStatus = request.method === "GET" && url.pathname === "/local/status"
				if (!isQuery && !isStatus) return text("not found", 404)
				const body = isQuery ? yield* Effect.promise(() => request.text()) : ""
				const sql = Option.map(decodeQueryBody(body), (decoded) => decoded.sql)
				const tag = isQuery ? "local.query" : "local.status"
				if (isStatus) calls.recordOnce(capture, tag, { path: url.pathname })
				else calls.record(capture, tag, { sql: Option.getOrElse(sql, () => body) })
				const faults = mergeFaults(dataset.faults, request.headers.get(FAULTS_HEADER) ?? undefined)
				const fault = Option.map(faults, (merged) => resolveFault(merged, tag))
				const delayMs = Option.match(fault, { onNone: () => 0, onSome: (found) => found.delayMs })
				if (delayMs > 0) yield* holds.hold(capture, delayMs)
				const failure = Option.flatMapNullishOr(fault, (found) => found.failure)
				if (Option.isSome(failure)) return text(faultText(failure.value.body), failure.value.status)
				if (isStatus) return Response.json(statusBody(store))
				return Option.match(sql, {
					onNone: () => text("missing 'sql' string", 400),
					onSome: (statement) => runQuery(chdb, store, statement),
				})
			}),
		),
})
