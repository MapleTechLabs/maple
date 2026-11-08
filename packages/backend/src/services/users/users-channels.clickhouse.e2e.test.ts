// The users directory's request channels against real ClickHouse: spans go through the migrated
// `user_activity_hourly_traces_mv`, which marks browser and native-app requests, and the list
// read counts MCP from the MCP servers' names and API as the classified rest.

import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest"
import { Array as Arr, Record as Rec, Schema, String as Str } from "effect"
import * as CH from "@maple/query-engine/ch"
import { normalizeSqlForClickHouseClient } from "@maple/query-engine/execution"
import {
	applyRealMigrations,
	clickhouseE2eEnabled,
	clickhouseExec,
	uniqueDatabase,
} from "../warehouse/clickhouse-e2e-support"
import { channelsOf } from "./users-reads"

const database = uniqueDatabase("maple_users_channels_e2e")
const ORG_ID = "org_users_channels"

const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000
const chDateTime = (epochMs: number): string =>
	Str.slice(0, 19)(Str.replace("T", " ")(new Date(epochMs).toISOString()))
/** Anchored to now: the tables' TTLs drop rows older than their horizon at insert. */
const BASE_MS = Math.floor((Date.now() - 2 * DAY_MS) / DAY_MS) * DAY_MS
const at = (hours: number): string => chDateTime(BASE_MS + hours * HOUR_MS)

const params = { orgId: ORG_ID, startTime: at(0), endTime: at(24) }

const scope: CH.UsersScope = {
	namespaces: [],
	services: [],
	serviceNamespaces: [],
	mcpServices: ["maple-ai"],
	activityRollup: true,
	requestChannels: true,
}

const quote = (value: string) => `'${Str.replace(/[\\']/g, "\\$&")(value)}'`

type Span = Readonly<{
	user: string
	service: string
	kind?: string
	parent?: string
	resource?: Readonly<Record<string, string>>
	attributes?: Readonly<Record<string, string>>
}>

const mapOf = (entries: Readonly<Record<string, string>>) =>
	`map(${Arr.join(
		Arr.flatMap(Rec.toEntries(entries), ([key, value]) => [quote(key), quote(value)]),
		", ",
	)})`

const SPANS: ReadonlyArray<Span> = [
	// ada: two browser-SDK spans, a server span her browser called, and one curl request.
	{ user: "ada", service: "web", kind: "Client", resource: { "maple.sdk.type": "browser" } },
	{ user: "ada", service: "web", kind: "Internal", resource: { "maple.sdk.type": "browser" } },
	{
		user: "ada",
		service: "api",
		attributes: { "user_agent.original": "Mozilla/5.0 (Macintosh) Firefox/158.0" },
	},
	{ user: "ada", service: "api", attributes: { "user_agent.original": "curl/8.7.1" } },
	// ada's child span of a request is no request.
	{ user: "ada", service: "api", kind: "Internal", parent: "p1" },
	// ben: an Android app (old `http.user_agent` key), an iOS app, and an MCP tool call whose
	// client sent a browser user agent: on an MCP server it is MCP all the same.
	{ user: "ben", service: "api", attributes: { "http.user_agent": "Dalvik/2.1.0 (Linux; Android 17)" } },
	{
		user: "ben",
		service: "api",
		attributes: { "user_agent.original": "Day%20One/490 CFNetwork/3860.700.1 Darwin/25.6.0" },
	},
	{ user: "ben", service: "maple-ai", attributes: { "user_agent.original": "Mozilla/5.0" } },
	// cat: a server SDK with no user agent at all is API.
	{ user: "cat", service: "worker", resource: { "maple.sdk.type": "server" } },
]

const seed = async () => {
	const rows = Arr.map(SPANS, (span, i) => {
		const attributes = { "user.id": span.user, ...span.attributes }
		return `(${quote(ORG_ID)}, ${quote(at(3))}, ${quote(`t${i}`)}, ${quote(`s${i}`)}, ${quote(span.parent ?? "")}, 'op', ${quote(span.kind ?? "Server")}, ${quote(span.service)}, 1000000, 'Ok', 1, '', ${mapOf(attributes)}, ${mapOf(span.resource ?? {})})`
	})
	await clickhouseExec(
		`INSERT INTO traces
		 (OrgId, Timestamp, TraceId, SpanId, ParentSpanId, SpanName, SpanKind, ServiceName, Duration, StatusCode, SampleRate, TraceState, SpanAttributes, ResourceAttributes)
		 VALUES\n${Arr.join(rows, ",\n")}`,
		database,
	)
	// An hour from before migration 0058: requests, none classified.
	await clickhouseExec(
		`INSERT INTO user_activity_hourly (OrgId, ServiceNamespace, UserId, Hour, ServiceName, SpanCount, RequestCount, FailedRequestCount, LogCount, FirstSeen, LastSeen) VALUES
(${quote(ORG_ID)}, '', 'cat', ${quote(at(1))}, 'worker', 50, 50, 0, 0, ${quote(at(1))}, ${quote(at(1))})`,
		database,
	)
}

const Rows = Schema.fromJsonString(
	Schema.Struct({ data: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)) }),
)

const ListRow = Schema.Struct({
	userId: Schema.String,
	requests: Schema.Number,
	classifiedRequests: Schema.Number,
	mcpRequests: Schema.Number,
	webRequests: Schema.Number,
	mobileRequests: Schema.Number,
})

const listRows = async () => {
	const body = await clickhouseExec(
		normalizeSqlForClickHouseClient(CH.compileUnsafe(CH.usersListQuery(scope), params).sql),
		database,
		{ default_format: "JSON", output_format_json_quote_64bit_integers: "0" },
	)
	const rows = Arr.map(Schema.decodeSync(Rows)(body).data, (row) => Schema.decodeUnknownSync(ListRow)(row))
	return new Map(Arr.map(rows, (row) => [row.userId, row] as const))
}

if (clickhouseE2eEnabled) {
	beforeAll(async () => {
		await clickhouseExec(`CREATE DATABASE ${database}`)
		await applyRealMigrations(database)
		await seed()
	}, 180_000)

	afterAll(async () => {
		await clickhouseExec(`DROP DATABASE IF EXISTS ${database}`)
	}, 30_000)
}

describe.skipIf(!clickhouseE2eEnabled)("users request channels", () => {
	it("splits a user's requests into web and api from the SDK and the user agent", async () => {
		const ada = (await listRows()).get("ada")
		assert.isDefined(ada)
		assert.deepStrictEqual(channelsOf(ada), [
			{ channel: "web", requests: 3 },
			{ channel: "api", requests: 1 },
		])
	})

	it("counts native apps as mobile and an MCP server's requests as mcp", async () => {
		const ben = (await listRows()).get("ben")
		assert.isDefined(ben)
		assert.deepStrictEqual(channelsOf(ben), [
			{ channel: "mobile", requests: 2 },
			{ channel: "mcp", requests: 1 },
		])
	})

	it("leaves unclassified hours out of the split, not out of the request count", async () => {
		const cat = (await listRows()).get("cat")
		assert.isDefined(cat)
		assert.strictEqual(cat.requests, 51)
		assert.deepStrictEqual(channelsOf(cat), [{ channel: "api", requests: 1 }])
	})
})
