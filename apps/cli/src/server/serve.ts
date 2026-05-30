// The local Maple server: OTLP/HTTP ingest + a raw SQL query API + the bundled
// SPA, all on one port, backed by an embedded chDB. Replaces the Rust
// `apps/ingest/src/bin/local.rs`. `maple start` calls `startServer`.

import { Effect, type Scope } from "effect"
import { gunzipSync } from "node:zlib"
import { acquireChdb, type Chdb, type ChdbError } from "./chdb"
import { buildInsertSql } from "./inserts"
import { encodeLogs, encodeMetrics, encodeTraces, type EncodedBatch } from "./otlp/encode"
import { decodeLogsRequest, decodeMetricsRequest, decodeTraceRequest } from "./otlp/proto"
import schemaSql from "./schema/local-schema.sql" with { type: "text" }

/** Resolves a request path to a static asset (the bundled SPA). Returns
 *  `undefined` to fall through to the SPA shell (client-side routing). */
export interface AssetResolver {
	(pathname: string): { readonly body: Uint8Array | string; readonly contentType: string } | undefined
}

export interface ServerOptions {
	readonly port: number
	readonly dataDir: string
	/** Serves the bundled SPA; omit to disable the UI (API-only). */
	readonly assets?: AssetResolver
}

const CORS_HEADERS = {
	"access-control-allow-origin": "*",
	"access-control-allow-methods": "GET, POST, OPTIONS",
	"access-control-allow-headers": "content-type, content-encoding",
} as const

const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", ...CORS_HEADERS },
	})

const text = (body: string, status = 200, contentType = "text/plain"): Response =>
	new Response(body, { status, headers: { "content-type": contentType, ...CORS_HEADERS } })

type Signal = "traces" | "logs" | "metrics"

/** Decode an OTLP request body (protobuf by default, JSON when content-type
 *  says so), transparently gunzipping a gzip content-encoding. */
function decodeOtlp(signal: Signal, raw: Uint8Array, contentType: string, contentEncoding: string | null): unknown {
	let bytes = raw
	if (contentEncoding && contentEncoding.includes("gzip")) {
		bytes = gunzipSync(raw)
	}
	const isJson = contentType.includes("json")
	if (isJson) {
		return JSON.parse(new TextDecoder().decode(bytes)) as unknown
	}
	switch (signal) {
		case "traces":
			return decodeTraceRequest(bytes)
		case "logs":
			return decodeLogsRequest(bytes)
		case "metrics":
			return decodeMetricsRequest(bytes)
	}
}

function encodeFor(signal: Signal, req: unknown): EncodedBatch[] {
	switch (signal) {
		case "traces":
			return encodeTraces(req)
		case "logs":
			return encodeLogs(req)
		case "metrics":
			return encodeMetrics(req)
	}
}

async function ingest(db: Chdb, signal: Signal, req: Request): Promise<Response> {
	const raw = new Uint8Array(await req.arrayBuffer())
	const contentType = req.headers.get("content-type") ?? ""
	const contentEncoding = req.headers.get("content-encoding")
	let decoded: unknown
	try {
		decoded = decodeOtlp(signal, raw, contentType, contentEncoding)
	} catch (error) {
		return text(`decode ${signal}: ${(error as Error).message}`, 400)
	}
	let batches: EncodedBatch[]
	try {
		batches = encodeFor(signal, decoded)
	} catch (error) {
		return text(`encode ${signal}: ${(error as Error).message}`, 500)
	}
	let accepted = 0
	for (const batch of batches) {
		if (batch.rowCount === 0) continue
		try {
			db.exec(buildInsertSql(batch.datasource, batch.ndjson))
		} catch (error) {
			return text(`chDB insert (${batch.datasource}): ${(error as Error).message}`, 500)
		}
		accepted += batch.rowCount
	}
	return json({ accepted })
}

/**
 * Strip a trailing `FORMAT <ident>` clause (optionally followed by `;`) and
 * re-append `FORMAT JSONEachRow`, so the server owns the output format. Port of
 * `force_json_each_row` from the former Rust server: callers POST `compiled.sql`
 * verbatim (`CH.compile(...)` appends `FORMAT JSON`).
 */
export function forceJsonEachRow(sql: string): string {
	let s = sql.trimEnd()
	if (s.endsWith(";")) s = s.slice(0, -1).trimEnd()
	const lower = s.toLowerCase()
	const pos = lower.lastIndexOf("format")
	if (pos !== -1) {
		const beforeOk = pos === 0 || /\s/.test(s[pos - 1]!)
		const rest = s.slice(pos + "format".length)
		const afterOk = rest.length > 0 && /\s/.test(rest[0]!)
		const ident = rest.trim()
		const isIdent = ident.length > 0 && /^[A-Za-z0-9_]+$/.test(ident)
		if (beforeOk && afterOk && isIdent) s = s.slice(0, pos).trimEnd()
	}
	return `${s}\nFORMAT JSONEachRow`
}

async function handleQuery(db: Chdb, req: Request): Promise<Response> {
	let sql: string
	try {
		const body = (await req.json()) as { sql?: unknown }
		if (typeof body.sql !== "string") return text("missing 'sql' string", 400)
		sql = body.sql
	} catch {
		return text("invalid JSON body", 400)
	}
	let out: string
	try {
		out = db.query(forceJsonEachRow(sql))
	} catch (error) {
		return text(`query failed: ${(error as Error).message}`, 500)
	}
	// chDB returns JSONEachRow (one JSON object per line). Wrap the lines into a
	// JSON array without re-parsing each row.
	const rows = out.split("\n").map((l) => l.trim()).filter((l) => l.length > 0)
	return text(`[${rows.join(",")}]`, 200, "application/json")
}

function serveAsset(assets: AssetResolver, pathname: string): Response {
	const path = pathname === "/" ? "index.html" : pathname.replace(/^\//, "")
	const hit = assets(path)
	if (hit) return new Response(hit.body, { headers: { "content-type": hit.contentType } })
	// Unknown path → serve the SPA shell so the client router can take over.
	const shell = assets("index.html")
	if (shell) return new Response(shell.body, { headers: { "content-type": "text/html" } })
	return text("UI not built", 404)
}

/** The `Bun.serve` fetch handler, closed over the chDB connection. Request
 *  handling stays synchronous chDB work — only the server lifecycle is Effect. */
const makeFetch =
	(db: Chdb, options: ServerOptions) =>
	async (req: Request): Promise<Response> => {
		const url = new URL(req.url)
		if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS })
		if (url.pathname === "/health") return text("OK")
		if (req.method === "POST") {
			if (url.pathname === "/v1/traces") return ingest(db, "traces", req)
			if (url.pathname === "/v1/logs") return ingest(db, "logs", req)
			if (url.pathname === "/v1/metrics") return ingest(db, "metrics", req)
			if (url.pathname === "/local/query") return handleQuery(db, req)
		}
		if (req.method === "GET" && options.assets) return serveAsset(options.assets, url.pathname)
		return text("not found", 404)
	}

/** Start the server as a scoped resource. Opens chDB (bootstrapping the schema)
 *  before binding, so a failure surfaces before we accept traffic, and ties both
 *  the chDB connection and the listening socket to the current `Scope`. When the
 *  scope closes the socket stops first, then chDB closes (reverse acquisition
 *  order). Resolves with the bound port once listening. */
export const startServer = (
	options: ServerOptions,
): Effect.Effect<{ readonly port: number }, ChdbError, Scope.Scope> =>
	Effect.gen(function* () {
		const db = yield* acquireChdb({ dataDir: options.dataDir, schemaSql })
		const server = yield* Effect.acquireRelease(
			Effect.sync(() => Bun.serve({ port: options.port, hostname: "127.0.0.1", fetch: makeFetch(db, options) })),
			(s) => Effect.sync(() => s.stop(true)),
		)
		return { port: server.port ?? options.port }
	})
