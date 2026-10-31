// SAFETY-FILE: JSON in this test is emitted by ClickHouse before its fields are asserted.
// Server spans on the real migration chain must land in `scanner_requests` only when they probe
// or come from a named scanner, runtimes must roll up per service, and the Security Center
// queries must read both.

import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest"
import { PROBE_SIGNATURES } from "@maple/domain/security-telemetry"
import * as CH from "@maple/query-engine/ch"
import {
	applyRealMigrations,
	clickhouseE2eEnabled,
	clickhouseExec,
	uniqueDatabase,
} from "./clickhouse-e2e-support"

const database = uniqueDatabase("maple_security_telemetry_e2e")
const ORG_ID = "org_security_telemetry_e2e"
const OTHER_ORG_ID = "org_security_telemetry_other"

// Anchored to now: `traces` carries a 30-day TTL enforced at insert.
const BASE_MS = Date.now() - 2 * 3_600_000
const chDateTime = (epochMs: number): string => new Date(epochMs).toISOString().replace("T", " ").slice(0, 19)

interface SeedSpan {
	readonly traceId: string
	readonly kind?: string
	readonly service?: string
	readonly path: string
	readonly status: string
	readonly client?: string
	readonly userAgent?: string
	readonly resource?: Record<string, string>
}

const NODE_RESOURCE = {
	"process.runtime.name": "nodejs",
	"process.runtime.version": "18.20.8",
	"telemetry.sdk.language": "nodejs",
	"telemetry.sdk.name": "opentelemetry",
	"telemetry.sdk.version": "1.30.0",
}

const SPANS: ReadonlyArray<SeedSpan> = [
	// Probes the service refused.
	{ traceId: "p1", path: "/.env", status: "404", client: "203.0.113.7" },
	{ traceId: "p2", path: "/.git/config", status: "404", client: "203.0.113.7" },
	{ traceId: "p3", path: "/wp-login.php", status: "404", client: "198.51.100.2" },
	// The exposure: a secrets file answered 200.
	{ traceId: "p4", path: "/api/.ENV.production", status: "200", client: "203.0.113.7" },
	// WordPress answering is normal for a WordPress site: counted, never critical.
	{ traceId: "p5", path: "/wp-login.php", status: "200", client: "198.51.100.2" },
	// A named scanner on an ordinary path.
	{ traceId: "s1", path: "/", status: "200", client: "192.0.2.9", userAgent: "Mozilla/5.0 zgrab/0.x" },
	// Not probes: an ordinary request, and a probe path on a client span.
	{ traceId: "n1", path: "/api/users", status: "200", client: "203.0.113.7" },
	{ traceId: "n2", kind: "Client", path: "/.env", status: "404" },
	// A second service on Python, and one with no runtime version.
	{
		traceId: "n3",
		service: "billing",
		path: "/invoices",
		status: "200",
		resource: { "process.runtime.name": "cpython", "process.runtime.version": "3.12.4" },
	},
	{
		traceId: "n4",
		service: "edge",
		path: "/",
		status: "200",
		resource: { "process.runtime.name": "workerd" },
	},
]

const mapLiteral = (entries: Record<string, string>) =>
	`map(${Object.entries(entries)
		.map(([key, value]) => `'${key}', '${value}'`)
		.join(", ")})`

const insert = (spans: ReadonlyArray<SeedSpan>, orgId: string) =>
	clickhouseExec(
		`INSERT INTO traces
		 (OrgId, Timestamp, TraceId, SpanId, ParentSpanId, SpanName, SpanKind, ServiceName, Duration, StatusCode, StatusMessage, SampleRate, SpanAttributes, ResourceAttributes)
		 VALUES\n${spans
				.map((span, index) => {
					const service = span.service ?? "api"
					const attributes = Object.fromEntries(
						[
							["url.path", span.path],
							["http.response.status_code", span.status],
							["client.address", span.client],
							["user_agent.original", span.userAgent],
						].filter((entry): entry is [string, string] => entry[1] !== undefined),
					)
					const resource = mapLiteral({
						"service.name": service,
						...(span.resource ?? NODE_RESOURCE),
					})
					return `('${orgId}', '${chDateTime(BASE_MS + index * 1000)}', '${span.traceId}', 'span-${span.traceId}', '', 'GET', '${span.kind ?? "Server"}', '${service}', 1000, 'Unset', '', 1, ${mapLiteral(attributes)}, ${resource})`
				})
				.join("\n,")}`,
		database,
	)

const runJson = async (sql: string): Promise<ReadonlyArray<Record<string, unknown>>> => {
	const body = await clickhouseExec(`${sql} FORMAT JSON`, database, {
		output_format_json_quote_64bit_integers: "0",
	})
	return (JSON.parse(body) as { readonly data?: ReadonlyArray<Record<string, unknown>> }).data ?? []
}

const window = {
	orgId: ORG_ID,
	startTime: chDateTime(BASE_MS - 60_000),
	endTime: chDateTime(BASE_MS + 60_000),
}
const read = (query: Parameters<typeof CH.compileUnsafe>[0]) =>
	runJson(CH.compileUnsafe(query, window).sql.replace(/\s*FORMAT JSON\s*$/, ""))

describe.skipIf(!clickhouseE2eEnabled)("security telemetry materialization", () => {
	beforeAll(async () => {
		await clickhouseExec(`CREATE DATABASE ${database}`)
		await applyRealMigrations(database)
		await insert(SPANS, ORG_ID)
		await insert(SPANS.slice(0, 1), OTHER_ORG_ID)
	}, 180_000)

	afterAll(async () => {
		await clickhouseExec(`DROP DATABASE IF EXISTS ${database}`)
	}, 30_000)

	it("keeps probe and scanner Server spans only, with the matched signature", async () => {
		const rows = await runJson(
			`SELECT TraceId, Signature, Scanner, Path, HttpStatus, ClientAddress
			 FROM scanner_requests WHERE OrgId = '${ORG_ID}' ORDER BY TraceId`,
		)
		assert.deepStrictEqual(rows, [
			{
				TraceId: "p1",
				Signature: "/.env",
				Scanner: "",
				Path: "/.env",
				HttpStatus: 404,
				ClientAddress: "203.0.113.7",
			},
			{
				TraceId: "p2",
				Signature: "/.git/",
				Scanner: "",
				Path: "/.git/config",
				HttpStatus: 404,
				ClientAddress: "203.0.113.7",
			},
			{
				TraceId: "p3",
				Signature: "/wp-login.php",
				Scanner: "",
				Path: "/wp-login.php",
				HttpStatus: 404,
				ClientAddress: "198.51.100.2",
			},
			{
				TraceId: "p4",
				Signature: "/.env",
				Scanner: "",
				Path: "/api/.ENV.production",
				HttpStatus: 200,
				ClientAddress: "203.0.113.7",
			},
			{
				TraceId: "p5",
				Signature: "/wp-login.php",
				Scanner: "",
				Path: "/wp-login.php",
				HttpStatus: 200,
				ClientAddress: "198.51.100.2",
			},
			{
				TraceId: "s1",
				Signature: "",
				Scanner: "ZGrab",
				Path: "/",
				HttpStatus: 200,
				ClientAddress: "192.0.2.9",
			},
		])
	})

	it("matches every catalog signature the write filter compiles", async () => {
		const probeDb = `${database}_catalog`
		await clickhouseExec(`CREATE DATABASE ${probeDb}`)
		await applyRealMigrations(probeDb)
		const values = PROBE_SIGNATURES.map(
			(signature, index) =>
				`('${ORG_ID}', '${chDateTime(BASE_MS + index * 1000)}', 'c${index}', 's${index}', '', 'GET', 'Server', 'api', 1, 'Unset', '', 1, map('url.path', '/x${signature.token}y'), map())`,
		).join(",")
		await clickhouseExec(
			`INSERT INTO traces (OrgId, Timestamp, TraceId, SpanId, ParentSpanId, SpanName, SpanKind, ServiceName, Duration, StatusCode, StatusMessage, SampleRate, SpanAttributes, ResourceAttributes) VALUES ${values}`,
			probeDb,
		)
		const body = await clickhouseExec(
			`SELECT Signature FROM scanner_requests ORDER BY Signature FORMAT JSON`,
			probeDb,
		)
		await clickhouseExec(`DROP DATABASE IF EXISTS ${probeDb}`)
		const stored = (JSON.parse(body) as { data: ReadonlyArray<{ Signature: string }> }).data.map(
			(row) => row.Signature,
		)
		assert.deepStrictEqual(stored, PROBE_SIGNATURES.map((signature) => signature.token).toSorted())
	}, 180_000)

	it("lists only the critical probes the service answered", async () => {
		const rows = await read(CH.scannerExposedQuery())
		assert.deepStrictEqual(
			rows.map((row) => [row.path, row.signature, row.httpStatus, row.sampleTraceId]),
			[["/api/.ENV.production", "/.env", 200, "p4"]],
		)
	})

	it("counts requests and answers per signature, and sources by address", async () => {
		const signatures = await read(CH.scannerSignaturesQuery())
		const bySignature = Object.fromEntries(
			signatures.map((row) => [row.signature, [row.requests, row.answered, row.sources]]),
		)
		assert.deepStrictEqual(bySignature, {
			"/.env": [2, 1, 1],
			"/.git/": [1, 0, 1],
			"/wp-login.php": [2, 1, 1],
			"": [1, 1, 1],
		})
		const sources = await read(CH.scannerSourcesQuery())
		assert.deepStrictEqual(
			sources.map((row) => [row.clientAddress, row.requests, row.signatures, row.scanner]),
			[
				["203.0.113.7", 3, 2, ""],
				["198.51.100.2", 2, 1, ""],
				["192.0.2.9", 1, 0, "ZGrab"],
			],
		)
	})

	it("rolls runtimes up per service and reads them back", async () => {
		const rows = await read(CH.runtimeVersionsQuery())
		assert.deepStrictEqual(
			rows.map((row) => [row.service, row.runtimeName, row.runtimeVersion, row.sdkVersion, row.spans]),
			[
				["api", "nodejs", "18.20.8", "1.30.0", 8],
				["billing", "cpython", "3.12.4", "", 1],
				["edge", "workerd", "", "", 1],
			],
		)
	})
})
