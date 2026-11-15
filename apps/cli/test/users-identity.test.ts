// The users directory names users from their spans and logs (chDB): `user.name` and `user.email`
// pass through the `user_activity_hourly` views, so a user seen only in traces gets an email.

import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as CH from "@maple/query-engine/ch"
import { normalizeSqlForClickHouseClient } from "@maple/query-engine/execution"
import { Array as Arr, Record as Rec, Schema, String as Str } from "effect"
import schemaSql from "@maple/local-server/schema/local-schema.sql" with { type: "text" }
import { OrgId } from "@maple/domain"
import { Chdb } from "@maple/local-server/chdb"
import { decodeJsonEachRow } from "@maple/local-server/chdb-rows"
import { describeWithChdb } from "./libchdb-test-support"

const ORG_ID = OrgId.make("org_users_identity")
const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS
/** Anchored to now: the rollup's TTL drops hours older than its horizon at insert. */
const BASE_MS = Math.floor((Date.now() - 2 * DAY_MS) / DAY_MS) * DAY_MS
const at = (hours: number): string =>
	Str.slice(0, 19)(Str.replace("T", " ")(new Date(BASE_MS + hours * HOUR_MS).toISOString()))
const params = { orgId: ORG_ID, startTime: at(0), endTime: at(24) }

const scope: CH.UsersScope = {
	namespaces: [],
	services: [],
	serviceNamespaces: [],
	mcpServices: [],
	activityRollup: true,
	activityIdentity: true,
}

const quote = (value: string) => `'${Str.replace(/[\\']/g, "\\$&")(value)}'`
const mapOf = (entries: Readonly<Record<string, string>>) =>
	`map(${Arr.join(
		Arr.flatMap(Rec.toEntries(entries), ([key, value]) => [quote(key), quote(value)]),
		", ",
	)})`

const span = (i: number, hour: number, attributes: Readonly<Record<string, string>>, namespace?: string) =>
	`(${quote(ORG_ID)}, ${quote(at(hour))}, ${quote(`t${i}`)}, ${quote(`s${i}`)}, '', 'GET /x', 'Server', 'api', 1000000, 'Ok', 1, '', ${mapOf(attributes)}, ${namespace === undefined ? "map()" : mapOf({ "service.namespace": namespace })})`

const ListRow = Schema.Struct({ userId: Schema.String, name: Schema.String, email: Schema.String })
const decodeList = decodeJsonEachRow(ListRow)
const decodeIdentity = decodeJsonEachRow(Schema.Struct({ name: Schema.String, email: Schema.String }))

describeWithChdb("users identity from spans and logs", () => {
	let root: string | undefined
	let db: Chdb

	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "maple-users-identity-"))
		db = Chdb.open({ dataDir: join(root, "data"), schemaSql })
		db.exec(
			`INSERT INTO traces (OrgId, Timestamp, TraceId, SpanId, ParentSpanId, SpanName, SpanKind, ServiceName, Duration, StatusCode, SampleRate, TraceState, SpanAttributes, ResourceAttributes) VALUES ${Arr.join(
				[
					// ada changed email: the later hour's wins, and a span without one keeps it.
					span(0, 2, { "user.id": "ada", "user.email": "ada@old.example" }),
					span(1, 5, { "user.id": "ada", "user.email": "ada@new.example", "user.name": "Ada" }),
					span(2, 7, { "user.id": "ada" }),
					// ben only ever sends `enduser.id`.
					span(3, 3, { "enduser.id": "ben", "user.email": "ben@example.com" }),
					// cat never sends an identity.
					span(4, 4, { "user.id": "cat" }),
					// eve's old email in one namespace, her new one in another, then unnamed activity
					// in the first: the newest email wins, not the namespace with the newest activity.
					span(5, 9, { "user.id": "eve", "user.email": "eve@old.example" }, "api"),
					span(6, 10, { "user.id": "eve", "user.email": "eve@new.example" }, "web"),
					span(7, 11, { "user.id": "eve" }, "api"),
				],
				", ",
			)}`,
		)
		// dan only logs.
		db.exec(
			`INSERT INTO logs (OrgId, Timestamp, TimestampTime, ServiceName, SeverityText, SeverityNumber, Body, LogAttributes) VALUES (${quote(ORG_ID)}, ${quote(at(6))}, ${quote(at(6))}, 'worker', 'INFO', 9, 'hi', ${mapOf({ "user.id": "dan", "user.email": "dan@example.com" })})`,
		)
	})

	afterAll(() => {
		db?.close()
		if (root !== undefined) rmSync(root, { recursive: true, force: true })
	})

	const run = (sql: string) => db.query(normalizeSqlForClickHouseClient(sql))
	const list = (filter: CH.UsersListFilter = {}) =>
		new Map(
			Arr.map(
				decodeList(run(CH.compileUnsafe(CH.usersListQuery(scope, filter), params).sql)),
				(row) => [row.userId, row] as const,
			),
		)

	test("lists the latest name and email a user's spans and logs carried", () => {
		const users = list()
		expect(users.get("ada")).toEqual({ userId: "ada", name: "Ada", email: "ada@new.example" })
		expect(users.get("ben")).toEqual({ userId: "ben", name: "", email: "ben@example.com" })
		expect(users.get("cat")).toEqual({ userId: "cat", name: "", email: "" })
		expect(users.get("dan")).toEqual({ userId: "dan", name: "", email: "dan@example.com" })
		expect(users.get("eve")).toEqual({ userId: "eve", name: "", email: "eve@new.example" })
	})

	test("finds a user by an email only their spans carried", () => {
		expect([...list({ search: "ben@example" }).keys()]).toEqual(["ben"])
		expect([...list({ search: "eve@new" }).keys()]).toEqual(["eve"])
	})

	test("finds a user by an email only their spans carried, with the candidate bound", () => {
		const rows = decodeList(
			run(
				CH.compileUnsafe(
					CH.usersListQuery(scope, { search: "ada@new" }, 200, { matching: true }),
					params,
				).sql,
			),
		)
		expect(Arr.map(rows, (row) => row.userId)).toEqual(["ada"])
	})

	test("reads one user's identity for their profile", () => {
		const identity = decodeIdentity(
			run(CH.compileUnsafe(CH.userActivityIdentityQuery({ userId: "ada" }), params).sql),
		)
		expect(identity).toEqual([{ name: "Ada", email: "ada@new.example" }])
	})
})
