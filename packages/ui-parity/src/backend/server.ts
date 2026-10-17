import { Effect, Schema } from "effect"
import {
	QueryEngineExecuteBatchRequest,
	QueryEngineExecuteBatchResponse,
	QueryEngineExecuteRequest,
} from "@maple/query-engine"
import { createHash } from "node:crypto"
import { CAPTURE_HEADER, DATASET_HEADER, type DatasetSummary, type StartBackend } from "../contract.ts"
import type { Dataset, EndpointHandler } from "../fixtures/dataset.ts"
import { fixtureAreaEndpoints, fixtureAreaRawRoutes, withFixtureAreas } from "../fixtures/areas.ts"
import { DATASETS, DEFAULT_DATASET } from "../fixtures/datasets/index.ts"
import { defaultDataset } from "../fixtures/datasets/default.ts"
import { acceptsBearer } from "./auth.ts"
import { makeCallLog, normalizePayload } from "./call-log.ts"
import { defaultHandlers } from "./defaults.ts"
import { warehouseEndpoints } from "./endpoints/index.ts"
import { telemetrySignalsEndpoint } from "./endpoints/signal-presence.ts"
import { electricCorsHeaders, handleSyncRequest } from "./electric.ts"
import { makeApiWebHandler } from "./http-api.ts"
import { makeFixtureWarehouse, parityOrgId, seedWarehouse, type FixtureWarehouse } from "./warehouse.ts"

/**
 * One local process standing in for the whole backend: the HttpApis (`/api`, `/internal`, `/v2`)
 * plus the warehouse on `apiPort`, Electric shapes on `electricPort`. Both frontends are built
 * against these origins, so they can be captured by Playwright or opened side by side.
 */

const encodeRequest = Schema.encodeUnknownEffect(QueryEngineExecuteRequest)
const encodeBatchResponse = Schema.encodeUnknownEffect(QueryEngineExecuteBatchResponse)
const isBatchRequest = Schema.is(QueryEngineExecuteBatchRequest)

export class ParityBackendError extends Schema.TaggedError<ParityBackendError>()(
	"@maple/ui-parity/ParityBackendError",
	{
		message: Schema.String,
	},
) {}

/** Stable across runs and apps: a hash of the normalized wire request. */
export const warehouseFingerprint = (normalized: unknown): string =>
	createHash("sha256").update(JSON.stringify(normalized)).digest("hex").slice(0, 16)

/**
 * `queryEngine.executeBatch`, answered like the API: every item through the real lowering on the
 * warehouse, per-item outcomes. Each item is logged as `warehouse:<fingerprint>`; the batch itself
 * is not, because how the browser groups queries into batches depends on timing.
 */
const executeBatch =
	(warehouse: FixtureWarehouse): EndpointHandler =>
	({ dataset, payload, record }) =>
		Effect.gen(function* () {
			if (!isBatchRequest(payload))
				return yield* new ParityBackendError({ message: "execute-batch payload did not decode" })
			const orgId = parityOrgId(dataset.identity?.orgId ?? "org_parity_signed_out")
			const results = yield* Effect.forEach(payload.requests, (request) =>
				Effect.gen(function* () {
					const normalized = normalizePayload(yield* encodeRequest(request))
					record(`warehouse:${warehouseFingerprint(normalized)}`, normalized)
					return yield* warehouse.execute(orgId, request)
				}),
			)
			return yield* encodeBatchResponse(new QueryEngineExecuteBatchResponse({ results }))
		})

/** `GET` returns and forgets one capture's calls: `{ calls, unmocked }`, as `takeCalls` does. */
export const CALL_LOG_PATH = "/__parity/calls"

const corsHeaders = (request: Request): Record<string, string> => ({
	"access-control-allow-origin": request.headers.get("origin") ?? "*",
	"access-control-allow-credentials": "true",
	"access-control-allow-headers": request.headers.get("access-control-request-headers") ?? "*",
	"access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
	"access-control-max-age": "600",
	vary: "Origin",
})

const withCors = (request: Request, response: Response): Response => {
	const headers = new Headers(response.headers)
	Object.entries(corsHeaders(request)).forEach(([key, value]) => headers.set(key, value))
	return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

const summary = (dataset: Dataset): DatasetSummary => ({
	name: dataset.name,
	now: dataset.now,
	identity: dataset.identity,
	auth: dataset.auth,
})

const bearerOf = (request: Request): string => {
	const header = request.headers.get("authorization") ?? ""
	return header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : ""
}

export interface StartFixtureBackendOptions {
	readonly apiPort: number
	readonly electricPort: number
	readonly datasets?: ReadonlyArray<Dataset>
}

export const startFixtureBackend = async (options: StartFixtureBackendOptions) => {
	const datasets = options.datasets ?? withFixtureAreas(DATASETS)
	const byName = new Map(datasets.map((dataset) => [dataset.name, dataset]))
	const fallback = byName.get(DEFAULT_DATASET) ?? datasets[0] ?? defaultDataset
	const datasetNamed = (name: string | null) => (name === null ? fallback : byName.get(name))
	const chdb = await Effect.runPromise(
		seedWarehouse(
			datasets.map((dataset) => ({
				orgId: dataset.identity?.orgId ?? `dataset:${dataset.name}`,
				rows: dataset.telemetry,
				now: dataset.now,
			})),
		),
	)
	const warehouse = makeFixtureWarehouse(chdb)
	const calls = makeCallLog()
	const builtIn = new Map([
		...defaultHandlers,
		...warehouseEndpoints(warehouse),
		...fixtureAreaEndpoints(warehouse),
	])
		.set("queryEngine.executeBatch", executeBatch(warehouse))
		.set("telemetrySignals.retrieve", telemetrySignalsEndpoint(warehouse))
	const api = makeApiWebHandler({
		// Unknown names were already refused in `fetch` below, so this never falls back silently.
		datasetOf: (request) => datasetNamed(request.headers[DATASET_HEADER] ?? null) ?? fallback,
		captureOf: (request) => request.headers[CAPTURE_HEADER] ?? null,
		calls,
		handlerFor: (dataset, tag) => dataset.endpoints[tag] ?? builtIn.get(tag),
		selfLogging: new Set(["queryEngine.executeBatch"]),
	})
	// Raw routes answer only a signed-in bearer, like the API's own auth on them.
	const rawRouteAnswer = (request: Request, url: URL, dataset: Dataset): Response | undefined => {
		const capture = request.headers.get(CAPTURE_HEADER)
		for (const route of fixtureAreaRawRoutes) {
			const answer = route.answer({ dataset, url, method: request.method })
			if (answer === undefined) continue
			if (!acceptsBearer(dataset, bearerOf(request)))
				return Response.json({ message: "Unauthorized" }, { status: 401 })
			calls.record(
				capture,
				route.tag,
				url.search
					? { path: url.pathname, query: Object.fromEntries(url.searchParams) }
					: { path: url.pathname },
			)
			return answer
		}
		return undefined
	}
	const unknownDataset = (request: Request, name: string | null) =>
		Response.json(
			{ _tag: "@maple/ui-parity/UnknownDataset", message: `ui-parity: unknown dataset "${name}"` },
			{ status: 400, headers: corsHeaders(request) },
		)

	const apiServer = Bun.serve({
		port: options.apiPort,
		idleTimeout: 0,
		fetch: async (request) => {
			if (request.method === "OPTIONS")
				return new Response(null, { status: 204, headers: corsHeaders(request) })
			const url = new URL(request.url)
			// Out-of-process access to `takeCalls` (the vitest suite runs the backend as a Bun child).
			if (url.pathname === CALL_LOG_PATH)
				return Response.json(calls.take(url.searchParams.get("capture") ?? ""))
			const name = request.headers.get(DATASET_HEADER)
			const dataset = datasetNamed(name)
			if (dataset === undefined) return unknownDataset(request, name)
			const raw = rawRouteAnswer(request, url, dataset)
			if (raw !== undefined) return withCors(request, raw)
			return withCors(request, await api.handler(request))
		},
	})
	const electricServer = Bun.serve({
		port: options.electricPort,
		idleTimeout: 0,
		fetch: (request) => {
			if (request.method === "OPTIONS")
				return new Response(null, { status: 204, headers: electricCorsHeaders(request) })
			const name = request.headers.get(DATASET_HEADER)
			const dataset = datasetNamed(name)
			if (dataset === undefined) return unknownDataset(request, name)
			const answer = handleSyncRequest(request, dataset, acceptsBearer(dataset, bearerOf(request)))
			if (answer.logged !== undefined)
				calls.record(
					request.headers.get(CAPTURE_HEADER),
					`shape:${answer.logged.table}`,
					answer.logged.payload,
				)
			return answer.response
		},
	})

	return {
		apiOrigin: `http://localhost:${apiServer.port}`,
		electricOrigin: `http://localhost:${electricServer.port}`,
		datasets: datasets.map(summary),
		takeCalls: calls.take,
		close: async () => {
			await Promise.all([apiServer.stop(true), electricServer.stop(true)])
			await api.dispose()
			// The chDB connection is per process; closing it here keeps libchdb from crashing at exit.
			await Effect.runPromise(chdb.close)
		},
	}
}

export const startBackend: StartBackend = (options) => startFixtureBackend(options)
