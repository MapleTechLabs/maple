// The users directory's group view against real ClickHouse: a user in two groups counts in both,
// users in none share the `''` row, rollup requests count toward each of a user's groups, and the
// directory's filters narrow the groups the same way they narrow the list.

import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest"
import { Array as Arr, Schema, String as Str } from "effect"
import * as CH from "@maple/query-engine/ch"
import { normalizeSqlForClickHouseClient } from "@maple/query-engine/execution"
import {
	applyRealMigrations,
	clickhouseE2eEnabled,
	clickhouseExec,
	uniqueDatabase,
} from "../warehouse/clickhouse-e2e-support"

const database = uniqueDatabase("maple_users_groups_e2e")
const ORG_ID = "org_users_groups"

const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000
const chDateTime = (epochMs: number): string =>
	Str.slice(0, 19)(Str.replace("T", " ")(new Date(epochMs).toISOString()))
/** Anchored to now: the tables' TTLs drop rows older than their horizon at insert. */
const BASE_MS = Math.floor((Date.now() - 3 * DAY_MS) / DAY_MS) * DAY_MS
const at = (hours: number): string => chDateTime(BASE_MS + hours * HOUR_MS)

const params = {
	orgId: ORG_ID,
	startTime: at(0),
	endTime: at(24),
	activeSince: at(4),
}

const scope: CH.UsersScope = {
	namespaces: [],
	services: [],
	serviceNamespaces: [["web", "storefront"]],
	mcpServices: [],
	activityRollup: true,
}

const quote = (value: string) => `'${Str.replaceAll("'", "\\'")(value)}'`

const seed = async () => {
	const replays = [
		// ada: two sessions in Acme; the later one carries the newer name.
		{ session: "s1", user: "ada", group: "grp_acme", name: "Acme Old", hour: 1, errors: 0 },
		{ session: "s2", user: "ada", group: "grp_acme", name: "Acme Inc.", hour: 5, errors: 0 },
		// grace: Acme on a replay, Globex on a product event below, so she is in both.
		{ session: "s3", user: "grace", group: "grp_acme", name: "", hour: 2, errors: 0 },
		// linus: no group, two browser errors.
		{ session: "s4", user: "linus", group: "", name: "", hour: 3, errors: 2 },
		// joan: two replays in two groups under one service, so one source sees both groups.
		{ session: "s5", user: "joan", group: "grp_acme", name: "", hour: 8, errors: 0 },
		{ session: "s6", user: "joan", group: "grp_initech", name: "Initech", hour: 9, errors: 0 },
	]
	await clickhouseExec(
		`INSERT INTO session_replays (OrgId, SessionId, UserId, GroupId, GroupName, ServiceName, StartTime, LastActivityAt, ErrorCount, Version) VALUES\n${Arr.join(
			Arr.map(
				replays,
				(row) =>
					`(${quote(ORG_ID)}, ${quote(row.session)}, ${quote(row.user)}, ${quote(row.group)}, ${quote(row.name)}, 'web', ${quote(at(row.hour))}, ${quote(at(row.hour))}, ${row.errors}, 1)`,
			),
			",\n",
		)}`,
		database,
	)
	await clickhouseExec(
		`INSERT INTO product_events (OrgId, Timestamp, Source, UserId, GroupId, Kind, EventName, ServiceName) VALUES
(${quote(ORG_ID)}, ${quote(at(6))}, 'server', 'grace', 'grp_globex', 'custom', 'plan_started', 'api'),
(${quote(ORG_ID)}, ${quote(at(7))}, 'server', 'ken', '', 'custom', 'sync_ran', 'api')`,
		database,
	)
	// Requests carry no group: ada's count toward Acme, ken's toward no group.
	await clickhouseExec(
		`INSERT INTO user_activity_hourly (OrgId, ServiceNamespace, UserId, Hour, ServiceName, SpanCount, RequestCount, FailedRequestCount, LogCount, FirstSeen, LastSeen) VALUES
(${quote(ORG_ID)}, 'storefront', 'ada', ${quote(at(5))}, 'api', 10, 10, 1, 0, ${quote(at(5))}, ${quote(at(5))}),
(${quote(ORG_ID)}, 'storefront', 'ken', ${quote(at(7))}, 'api', 5, 5, 0, 0, ${quote(at(7))}, ${quote(at(7))})`,
		database,
	)
}

const Rows = Schema.fromJsonString(
	Schema.Struct({ data: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)) }),
)

const runJson = async (sql: string) => {
	const body = await clickhouseExec(normalizeSqlForClickHouseClient(sql), database, {
		default_format: "JSON",
		output_format_json_quote_64bit_integers: "0",
	})
	return Schema.decodeSync(Rows)(body).data
}

const groups = (filter: CH.UsersListFilter = {}) =>
	runJson(CH.compileUnsafe(CH.usersGroupsQuery(scope, filter), params).sql)

const pick = (rows: ReadonlyArray<Record<string, unknown>>, ...keys: ReadonlyArray<string>) =>
	Arr.map(rows, (row) => Arr.map(keys, (key) => row[key]))

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

describe.skipIf(!clickhouseE2eEnabled)("users grouped by group", () => {
	it("counts a user in each of their groups and folds the ungrouped into one row", async () => {
		const rows = await groups()
		assert.deepStrictEqual(
			pick(rows, "groupId", "users", "sessions", "requests", "errors", "withErrors"),
			[
				["grp_acme", 3, 5, 10, 1, 1],
				["", 2, 1, 5, 2, 1],
				["grp_globex", 1, 1, 0, 0, 0],
				["grp_initech", 1, 2, 0, 0, 0],
			],
		)
	})

	it("counts the users active since the cutoff", async () => {
		const rows = await groups()
		assert.deepStrictEqual(pick(rows, "groupId", "activeToday"), [
			["grp_acme", 3],
			["", 1],
			["grp_globex", 1],
			["grp_initech", 1],
		])
	})

	it("keeps only the picked groups' rows", async () => {
		assert.deepStrictEqual(pick(await groups({ groups: ["grp_globex"] }), "groupId", "users"), [
			["grp_globex", 1],
		])
		// joan's replays name both groups under one service: picking either finds her there.
		assert.deepStrictEqual(pick(await groups({ groups: ["grp_initech"] }), "groupId", "users"), [
			["grp_initech", 1],
		])
	})

	it("counts a user in every group one source saw them in", async () => {
		const facets = await runJson(CH.compileUnionUnsafe(CH.usersFacetsQuery(scope), params).sql)
		assert.deepStrictEqual(
			Arr.sort(pick(facets, "name", "count"), (a, b) => (String(a[0]) < String(b[0]) ? -1 : 1)),
			[
				["grp_acme", 3],
				["grp_globex", 1],
				["grp_initech", 1],
			],
		)
	})

	it("groups only the users the directory's filters keep", async () => {
		assert.deepStrictEqual(pick(await groups({ hasErrors: true }), "groupId", "users"), [
			["", 1],
			["grp_acme", 1],
		])
		assert.deepStrictEqual(pick(await groups({ search: "grace" }), "groupId", "users"), [
			["grp_acme", 1],
			["grp_globex", 1],
		])
	})

	it("names a group from its latest named replay, and leaves an event-only group unnamed", async () => {
		const rows = await runJson(
			CH.compileUnsafe(CH.usersGroupNamesQuery(["grp_acme", "grp_globex"]), params).sql,
		)
		assert.deepStrictEqual(pick(rows, "groupId", "groupName"), [["grp_acme", "Acme Inc."]])
	})
})
