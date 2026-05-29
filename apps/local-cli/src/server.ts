// Optional HTTP mode (`maple-local serve`): exposes the same operations as the
// CLI as JSON endpoints, for non-CLI/agent clients. Uses Bun.serve directly —
// the operations build SQL via the TS query engine, so this lives here rather
// than in the Rust binary (which only serves raw /local/query). Each request
// runs its operation under the shared LocalWarehouseExecutor layer.

import { Effect } from "effect"
import type { WarehouseExecutor } from "@maple/query-engine/observability"
import { LocalWarehouseExecutorLive, resolveBaseUrl } from "./core/executor"
import { resolveRange } from "./core/time"
import * as Ops from "./core/operations"

const JSON_HEADERS = { "content-type": "application/json" } as const

const json = (data: unknown, status = 200): Response =>
	new Response(JSON.stringify(data, null, 2), { status, headers: JSON_HEADERS })

const run = <A, E>(effect: Effect.Effect<A, E, WarehouseExecutor>): Promise<A> =>
	Effect.runPromise(effect.pipe(Effect.provide(LocalWarehouseExecutorLive)))

const num = (q: URLSearchParams, key: string): number | undefined =>
	q.has(key) ? Number(q.get(key)) : undefined

const str = (q: URLSearchParams, key: string): string | undefined => q.get(key) ?? undefined

export const startServer = (port: number): void => {
	Bun.serve({
		port,
		idleTimeout: 120,
		fetch: async (req) => {
			const url = new URL(req.url)
			const path = url.pathname
			const q = url.searchParams
			const range = resolveRange({ since: str(q, "since"), start: str(q, "start"), end: str(q, "end") })

			try {
				if (path === "/health") return new Response("OK")

				if (path === "/api/services") {
					return json(await run(Ops.listServices({ range, environment: str(q, "env") })))
				}
				if (path === "/api/traces") {
					return json(
						await run(
							Ops.searchTraces({
								range,
								service: str(q, "service"),
								spanName: str(q, "span_name"),
								hasError: q.get("has_error") === "true" || undefined,
								minDurationMs: num(q, "min_duration_ms"),
								maxDurationMs: num(q, "max_duration_ms"),
								httpMethod: str(q, "http_method"),
								limit: num(q, "limit"),
								offset: num(q, "offset"),
							}),
						),
					)
				}
				const traceMatch = path.match(/^\/api\/trace\/(.+)$/)
				if (traceMatch) {
					return json(await run(Ops.inspectTrace({ traceId: decodeURIComponent(traceMatch[1]!) })))
				}
				if (path === "/api/errors") {
					return json(
						await run(
							Ops.findErrors({
								range,
								service: str(q, "service"),
								environment: str(q, "env"),
								limit: num(q, "limit"),
							}),
						),
					)
				}
				if (path === "/api/logs") {
					return json(
						await run(
							Ops.searchLogs({
								range,
								service: str(q, "service"),
								severity: str(q, "severity"),
								search: str(q, "search"),
								traceId: str(q, "trace_id"),
								limit: num(q, "limit"),
								offset: num(q, "offset"),
							}),
						),
					)
				}
				if (path === "/api/service-map") {
					return json(
						await run(Ops.serviceMap({ range, service: str(q, "service"), environment: str(q, "env") })),
					)
				}
				if (path === "/api/slow-traces") {
					return json(
						await run(
							Ops.findSlowTraces({
								range,
								service: str(q, "service"),
								environment: str(q, "env"),
								limit: num(q, "limit"),
							}),
						),
					)
				}
				if (path === "/api/metrics") {
					return json(
						await run(
							Ops.listMetrics({
								range,
								service: str(q, "service"),
								search: str(q, "search"),
								limit: num(q, "limit"),
							}),
						),
					)
				}
				if (path === "/api/query" && req.method === "POST") {
					const body = (await req.json().catch(() => ({}))) as { sql?: unknown }
					if (typeof body.sql !== "string" || body.sql.trim() === "") {
						return json({ error: "Body must be { sql: string }" }, 400)
					}
					return json(await run(Ops.rawQuery(body.sql)))
				}

				return json({ error: "Not found", path }, 404)
			} catch (error) {
				return json({ error: error instanceof Error ? error.message : String(error) }, 500)
			}
		},
	})

	console.log(`maple-local endpoints on http://localhost:${port}  (querying ${resolveBaseUrl()})`)
	console.log("  GET  /api/services | /api/traces | /api/trace/:id | /api/errors | /api/logs")
	console.log("  GET  /api/service-map | /api/slow-traces | /api/metrics")
	console.log('  POST /api/query  { "sql": "..." }')
}
