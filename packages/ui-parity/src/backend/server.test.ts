import { spawn, type ChildProcess } from "node:child_process"
import { fileURLToPath } from "node:url"
import { Schema } from "effect"
import {
	QueryEngineExecuteBatchResponse,
	QueryEngineExecuteRequest,
	formatWarehouseDateTime,
} from "@maple/query-engine"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { CAPTURE_HEADER, DATASET_HEADER } from "../contract.ts"
import { FROZEN_NOW_MS } from "../fixtures/identity.ts"

// The backend needs `bun:ffi` for chDB, so the suite runs it the way a developer does: as a Bun
// child process on its own ports, read back through `/__parity/calls`.
const base = 20_000 + Math.floor(Math.random() * 20_000)
const api = `http://localhost:${base}`
const main = fileURLToPath(new URL("./main.ts", import.meta.url))
const children: Array<ChildProcess> = []

beforeAll(async () => {
	const child = spawn("bun", ["run", main], { env: { ...process.env, PARITY_PORT_BASE: String(base) } })
	children.push(child)
	await new Promise<void>((resolve, reject) => {
		const output: Array<string> = []
		child.stdout?.on("data", (chunk: Buffer) => {
			output.push(chunk.toString())
			if (output.join("").includes("ready")) resolve()
		})
		child.stderr?.on("data", (chunk: Buffer) => output.push(chunk.toString()))
		child.on("exit", (code) => reject(new Error(`backend exited with ${code}: ${output.join("")}`)))
	})
}, 60_000)

afterAll(() => {
	children.forEach((child) => child.kill("SIGTERM"))
})

const login = async (dataset: string) => {
	const response = await fetch(`${api}/api/auth/login`, {
		method: "POST",
		headers: { "content-type": "application/json", [DATASET_HEADER]: dataset },
		body: JSON.stringify({ password: "parity" }),
	})
	const body: { readonly token: string } = await response.json()
	return body.token
}

/** The services facets request exactly as `getServicesFacets` (apps/web/src/api/warehouse/services.ts) builds it. */
const servicesFacetsRequest = () =>
	new QueryEngineExecuteRequest({
		startTime: formatWarehouseDateTime(FROZEN_NOW_MS - 24 * 60 * 60 * 1000),
		endTime: formatWarehouseDateTime(FROZEN_NOW_MS),
		query: { kind: "facets" as const, source: "services" as const },
	})

const executeBatch = async (dataset: string, capture: string) => {
	const token = await login(dataset)
	const response = await fetch(`${api}/internal/query-engine/execute-batch`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${token}`,
			[DATASET_HEADER]: dataset,
			[CAPTURE_HEADER]: capture,
		},
		body: JSON.stringify({ requests: [Schema.encodeUnknownSync(QueryEngineExecuteRequest)(servicesFacetsRequest())] }),
	})
	return { status: response.status, text: await response.text() }
}

const takeCalls = async (capture: string) => {
	const response = await fetch(`${api}/__parity/calls?capture=${capture}`)
	const body: { readonly calls: ReadonlyArray<{ readonly tag: string }>; readonly unmocked: ReadonlyArray<string> } =
		await response.json()
	return body
}

/** Decodes with the response schema the web app's batcher uses; failures and other kinds yield `undefined`. */
const facetRows = (text: string) => {
	const outcome = Schema.decodeUnknownSync(Schema.fromJsonString(QueryEngineExecuteBatchResponse))(text).results[0]
	return outcome?.outcome === "success" && outcome.result.kind === "facets" ? outcome.result.data : undefined
}

describe("execute-batch on the fixture warehouse", () => {
	it("answers the services facets query with the default org's seeded services", async () => {
		const { status, text } = await executeBatch("default", "facets-default")
		expect(status).toBe(200)
		const services = (facetRows(text) ?? []).filter((row) => row.facetType === "service").map((row) => row.name)
		expect(services).toEqual(
			expect.arrayContaining(["storefront", "checkout-api", "cart-svc", "catalog-api", "payment-svc", "auth-svc"]),
		)
	})

	it("answers the same query with no rows for a brand-new org", async () => {
		const { status, text } = await executeBatch("empty", "facets-empty")
		expect(status).toBe(200)
		expect(facetRows(text)).toEqual([])
	})

	it("returns byte-identical JSON for the same request", async () => {
		const first = await executeBatch("default", "repeat-1")
		const second = await executeBatch("default", "repeat-2")
		expect(second.text).toBe(first.text)
	})

	it("logs each query under a fingerprint that does not depend on the capture", async () => {
		await executeBatch("default", "log-a")
		await executeBatch("default", "log-b")
		const a = await takeCalls("log-a")
		const b = await takeCalls("log-b")
		expect(a.calls.map((call) => call.tag)).toEqual(b.calls.map((call) => call.tag))
		expect(a.calls[0]?.tag).toMatch(/^warehouse:[0-9a-f]{16}$/)
	})
})

describe("unmocked requests", () => {
	it("reports an endpoint without a fixture handler and answers 501", async () => {
		const token = await login("default")
		const response = await fetch(`${api}/internal/query-engine/list-nodes`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${token}`,
				[CAPTURE_HEADER]: "unmocked-endpoint",
			},
			body: JSON.stringify({ startTime: "2026-09-30 12:00:00", endTime: "2026-10-01 12:00:00" }),
		})
		expect(response.status).toBe(501)
		const { unmocked } = await takeCalls("unmocked-endpoint")
		expect(unmocked).toEqual(["queryEngine.listNodes (POST /internal/query-engine/list-nodes)"])
	})

	it("reports a path no API declares", async () => {
		await fetch(`${api}/internal/does-not-exist`, { headers: { [CAPTURE_HEADER]: "unmocked-path" } })
		const { unmocked } = await takeCalls("unmocked-path")
		expect(unmocked).toEqual(["GET /internal/does-not-exist (no such route)"])
	})
})

describe("auth", () => {
	it("answers authenticated endpoints with 401 for a signed-out dataset", async () => {
		const response = await fetch(`${api}/api/auth/session`, {
			headers: { authorization: `Bearer ${await login("default")}`, [DATASET_HEADER]: "signed-out" },
		})
		expect(response.status).toBe(401)
	})

	it("resolves the session token to the dataset's org", async () => {
		const response = await fetch(`${api}/api/auth/session`, {
			headers: { authorization: `Bearer ${await login("default")}` },
		})
		const body: { readonly orgId: string; readonly authMode: string } = await response.json()
		expect(body).toMatchObject({ orgId: "org_parity_acme", authMode: "self_hosted" })
	})
})
