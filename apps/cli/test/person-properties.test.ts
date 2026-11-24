// Person and group properties against a real ClickHouse engine (chDB): the views that write
// `person_properties` from product events, product-event spans and browser traits, and the read
// that resolves them. Rows go in out of time order and across separate inserts (separate parts),
// and every expectation is checked before and after `OPTIMIZE ... FINAL`, so a value never depends
// on which parts have merged.

import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as CH from "@maple/query-engine/ch"
import { Array as Arr, Option, Record as Rec, Result, Schema, String as Str } from "effect"
import schemaSql from "@maple/local-server/schema/local-schema.sql" with { type: "text" }
import { Chdb } from "@maple/local-server/chdb"
import { decodeJsonEachRow } from "@maple/local-server/chdb-rows"
import { LOCAL_STORE_STEPS } from "@maple/local-server/local-store-migrations/steps"
import { compileBackfillChunk, isBackfill, migrations } from "@maple/domain/clickhouse"
import { OrgId } from "@maple/domain"
import { describeWithChdb } from "./libchdb-test-support"
import { run } from "./funnel-scenarios-support"

const ORG = "org_props"
const decode = decodeJsonEachRow(CH.personPropertyRowSchema)

// Every literal below is plain text without quotes or backslashes.
const quote = (value: string) => `'${value}'`
const at = (minute: number) => `2026-11-20 10:${Str.padStart(2, "0")(String(minute))}:00.000000000`
const mapLiteral = (entries: Readonly<Record<string, string>>) =>
	`map(${Arr.join(
		Arr.flatMap(Rec.toEntries(entries), ([key, value]) => [quote(key), quote(value)]),
		", ",
	)})`

interface EventRow {
	readonly minute: number
	readonly source?: string
	readonly visitorId?: string
	readonly userId?: string
	readonly groupId?: string
	readonly name?: string
	readonly kind?: string
	readonly attributes: Readonly<Record<string, string>>
}

const insertEvent = (db: Chdb, row: EventRow) =>
	db.exec(
		`INSERT INTO product_events (OrgId, Timestamp, Source, VisitorId, UserId, GroupId, Kind, EventName, Attributes) VALUES (${quote(ORG)}, ${quote(at(row.minute))}, ${quote(row.source ?? "server")}, ${quote(row.visitorId ?? "")}, ${quote(row.userId ?? "")}, ${quote(row.groupId ?? "")}, ${quote(row.kind ?? "custom")}, ${quote(row.name ?? "$identify")}, ${mapLiteral(row.attributes)})`,
	)

const insertSpan = (db: Chdb, minute: number, attributes: Readonly<Record<string, string>>) =>
	db.exec(
		`INSERT INTO traces (OrgId, Timestamp, TraceId, SpanId, ParentSpanId, SpanName, SpanKind, ServiceName, Duration, StatusCode, ResourceAttributes, SpanAttributes, EventsTimestamp, EventsName, EventsAttributes) VALUES (${quote(ORG)}, ${quote(at(minute))}, 't-${minute}', 's-${minute}', '', 'POST /upgrade', 'Server', 'api', 1000, 'Ok', map(), ${mapLiteral(attributes)}, [], [], [])`,
	)

const insertSession = (
	db: Chdb,
	session: {
		readonly id: string
		readonly minute: number
		readonly version: number
		readonly userId: string
		readonly groupId?: string
		readonly email?: string
		readonly name?: string
		readonly groupName?: string
		readonly endMinute?: number
		readonly traits: Readonly<Record<string, string>>
	},
) =>
	db.exec(
		`INSERT INTO session_replays (OrgId, SessionId, StartTime, EndTime, Status, UserId, Version, VisitorId, GroupId, UserEmail, UserName, GroupName, UserTraits) VALUES (${quote(ORG)}, ${quote(session.id)}, ${quote(at(session.minute))}, ${session.endMinute === undefined ? "NULL" : quote(at(session.endMinute))}, 'ended', ${quote(session.userId)}, ${session.version}, 'v-${session.id}', ${quote(session.groupId ?? "")}, ${quote(session.email ?? "")}, ${quote(session.name ?? "")}, ${quote(session.groupName ?? "")}, ${mapLiteral(session.traits)})`,
	)

const props = (db: Chdb, kind: CH.PersonPropertyKind, ids: ReadonlyArray<string>) =>
	Arr.map(
		decode(
			run(
				db,
				CH.compileUnsafe(CH.personPropertiesQuery({ kind, ids }), { orgId: OrgId.make(ORG) }).sql,
			),
		),
		(row) => `${row.id} ${row.key}=${row.value}`,
	)

const links = (db: Chdb) =>
	Arr.filter(
		Str.split("\n")(
			Str.trim(
				db.query(
					`SELECT VisitorId, UserId FROM identity_links WHERE OrgId = ${quote(ORG)} GROUP BY VisitorId, UserId ORDER BY VisitorId FORMAT JSONEachRow`,
				),
			),
		),
		(line) => line !== "",
	)

describeWithChdb("person properties", () => {
	let root: string
	let db: Chdb

	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "maple-person-properties-"))
		db = Chdb.open({ dataDir: join(root, "data"), schemaSql })

		// u1: the newer set lands first; set_once keeps the earliest and loses to any set.
		insertEvent(db, { minute: 30, userId: "u1", attributes: { "$set.plan": "pro" } })
		insertEvent(db, {
			minute: 10,
			userId: "u1",
			attributes: { "$set.plan": "free", "$set_once.first_plan": "free" },
		})
		insertEvent(db, {
			minute: 20,
			userId: "u1",
			attributes: { "$set_once.first_plan": "trial", "$set_once.source": "ads" },
		})
		insertEvent(db, { minute: 25, userId: "u1", attributes: { "$set.source": "sales" } })
		// u2: set then unset; set_once after the unset comes back; a set before it stays gone.
		insertEvent(db, {
			minute: 10,
			userId: "u2",
			attributes: { "$set.role": "admin", "$set.team": "core" },
		})
		insertEvent(db, { minute: 20, userId: "u2", attributes: { "$unset.role": "", "$unset.team": "" } })
		insertEvent(db, { minute: 30, userId: "u2", attributes: { "$set_once.role": "viewer" } })
		insertEvent(db, { minute: 15, userId: "u2", attributes: { "$set_once.team": "early" } })
		// Group ops go to the group; an op with no id to apply to is dropped, and so are ordinary props.
		insertEvent(db, {
			minute: 10,
			userId: "u3",
			groupId: "acme",
			name: "plan_started",
			attributes: { "$group_set.seats": "12", "$set.plan": "team", amount: "99" },
		})
		insertEvent(db, { minute: 11, attributes: { "$set.plan": "nobody" } })
		insertEvent(db, { minute: 12, userId: "u4", attributes: { "$group_set.seats": "1" } })

		// Spans: ops apply only on a product-event span, and the span's ids decide where.
		insertSpan(db, 40, {
			"maple.product_event.name": "plan_upgraded",
			"maple.product_event.user_id": "u5",
			"maple.product_event.group_id": "globex",
			"maple.product_event.set.plan": "enterprise",
			"maple.product_event.set_once.signup_channel": "api",
			"maple.product_event.group_set.tier": "gold",
		})
		insertSpan(db, 41, { "maple.product_event.user_id": "u6", "maple.product_event.set.plan": "ignored" })

		// Browser traits: the session's end row carries the newer identity.
		insertSession(db, {
			id: "s1",
			minute: 5,
			version: 1,
			userId: "u7",
			groupId: "initech",
			email: "a@x.io",
			traits: { plan: "free" },
		})
		insertSession(db, {
			id: "s1",
			minute: 5,
			version: 2,
			userId: "u7",
			groupId: "initech",
			email: "a@x.io",
			name: "Ann",
			groupName: "Initech",
			traits: { plan: "free" },
		})
		insertSession(db, { id: "s2", minute: 50, version: 1, userId: "u7", traits: { plan: "pro" } })
		insertSession(db, { id: "s3", minute: 50, version: 1, userId: "", traits: { plan: "anon" } })
		// A session that closes after a backend upgrade repeats its old trait; the upgrade stands.
		insertSession(db, {
			id: "s4",
			minute: 10,
			endMinute: 40,
			version: 2,
			userId: "u12",
			traits: { plan: "free" },
		})
		insertEvent(db, { minute: 20, userId: "u12", attributes: { "$set.plan": "pro" } })
		// A trait cleared to '' in a later session is stored as ''.
		insertSession(db, { id: "s5", minute: 10, version: 1, userId: "u13", traits: { plan: "pro" } })
		insertSession(db, { id: "s6", minute: 30, version: 1, userId: "u13", traits: { plan: "" } })
		// A page view (sessions-only key) and a trace row (its span applies itself) write nothing.
		insertEvent(db, {
			minute: 5,
			kind: "navigation",
			name: "$pageview",
			userId: "u14",
			attributes: { "$set.plan": "forged" },
		})
		insertEvent(db, {
			minute: 5,
			source: "trace",
			name: "x",
			userId: "u14",
			attributes: { "$set.role": "twice" },
		})

		// Identity links: server and trace events link; a browser event is the session's job.
		insertEvent(db, {
			minute: 1,
			source: "server",
			visitorId: "dev-1",
			userId: "u8",
			name: "signed_in",
			attributes: {},
		})
		insertEvent(db, {
			minute: 1,
			source: "mobile",
			visitorId: "dev-2",
			userId: "u9",
			name: "signed_in",
			attributes: {},
		})
		insertEvent(db, {
			minute: 1,
			source: "browser",
			visitorId: "web-1",
			userId: "u10",
			name: "signed_in",
			attributes: {},
		})
		insertEvent(db, {
			minute: 1,
			source: "server",
			visitorId: "",
			userId: "u11",
			name: "signed_in",
			attributes: {},
		})
	})

	afterAll(() => {
		db?.close()
		if (root) rmSync(root, { recursive: true, force: true })
	})

	const expectations = () => {
		expect(props(db, "user", ["u1"])).toEqual(["u1 first_plan=free", "u1 plan=pro", "u1 source=sales"])
		expect(props(db, "user", ["u2"])).toEqual(["u2 role=viewer"])
		expect(props(db, "user", ["u3", "u4"])).toEqual(["u3 plan=team"])
		expect(props(db, "group", ["acme"])).toEqual(["acme seats=12"])
		expect(props(db, "user", ["u5", "u6"])).toEqual(["u5 plan=enterprise", "u5 signup_channel=api"])
		expect(props(db, "group", ["globex"])).toEqual(["globex tier=gold"])
		expect(props(db, "user", ["u7"])).toEqual(["u7 plan=pro"])
		expect(props(db, "group", ["initech"])).toEqual(["initech name=Initech"])
		expect(props(db, "user", [""])).toEqual([])
		expect(props(db, "user", ["u12"])).toEqual(["u12 plan=pro"])
		expect(props(db, "user", ["u13"])).toEqual(["u13 plan="])
		expect(props(db, "user", ["u14"])).toEqual([])
		expect(props(db, "user", [])).toEqual([])
		expect(links(db)).toEqual([
			JSON.stringify({ VisitorId: "dev-1", UserId: "u8" }),
			JSON.stringify({ VisitorId: "dev-2", UserId: "u9" }),
			// s1 and s2's own visitor ids come from identity_links_mv over session_replays.
			JSON.stringify({ VisitorId: "v-s1", UserId: "u7" }),
			JSON.stringify({ VisitorId: "v-s2", UserId: "u7" }),
			JSON.stringify({ VisitorId: "v-s4", UserId: "u12" }),
			JSON.stringify({ VisitorId: "v-s5", UserId: "u13" }),
			JSON.stringify({ VisitorId: "v-s6", UserId: "u13" }),
		])
	}

	test("resolves set, set_once and unset across unmerged parts", expectations)

	test("reads the same after the parts merge", () => {
		db.exec("OPTIMIZE TABLE person_properties FINAL")
		db.exec("OPTIMIZE TABLE identity_links FINAL")
		expectations()
	})

	test("the local store step's backfill rebuilds the same values", () => {
		const step = Option.getOrUndefined(
			Arr.findFirst(LOCAL_STORE_STEPS, (candidate) => Str.endsWith("person-properties")(candidate.id)),
		)
		const statements = Arr.flatMap(step?.afterBootstrap ?? [], (operation) =>
			operation.op === "backfill" ? operation.statements : [],
		)
		expect(statements.length).toBeGreaterThan(0)
		db.exec("TRUNCATE TABLE person_properties")
		Arr.forEach(statements, (statement) => db.exec(statement))
		expectations()
	})

	test("the self-hosted migration's chunked backfills rebuild the same values", () => {
		db.exec("TRUNCATE TABLE person_properties")
		const migration = Option.getOrUndefined(
			Arr.findFirst(migrations, (candidate) => candidate.version === 71),
		)
		const backfills = Arr.filter(migration?.statements ?? [], isBackfill)
		expect(Arr.map(backfills, (spec) => spec.target)).toEqual(["person_properties", "identity_links"])
		Arr.forEach(backfills, (spec) =>
			db.exec(compileBackfillChunk(spec, "default", "2026-11-20 00:00:00", "2026-11-21 00:00:00")),
		)
		// The migration backfills browser traits only: event and span writes start with its views.
		expect(props(db, "user", ["u7"])).toEqual(["u7 plan=pro"])
		expect(props(db, "group", ["initech"])).toEqual(["initech name=Initech"])
		expect(props(db, "user", ["u1"])).toEqual([])
	})
})

// Reads filtered and broken down by property. Four users: a and c on `pro`, b on `free`, d with no
// plan; a and b in account acme (gold), c in globex (silver). a browsed anonymously on device dev-a
// before signing in, and the $identify that set a's plan also linked the device.
const Q_ORG = "org_props_reads"
const WINDOW = { orgId: OrgId.make(Q_ORG), startTime: "2026-11-20 00:00:00", endTime: "2026-11-21 00:00:00" }
const decodeStates = decodeJsonEachRow(CH.personPropertyStateRowSchema)
const decodeUserIds = decodeJsonEachRow(Schema.Struct({ userId: Schema.String }))
const decodeNamed = decodeJsonEachRow(Schema.Struct({ name: Schema.String, value: CH.CHNumber }))
const decodeSteps = decodeJsonEachRow(CH.productEventsFunnelRowSchema)
const decodeGroups = decodeJsonEachRow(CH.productEventsFunnelBreakdownRowSchema)
const decodeCohort = decodeJsonEachRow(CH.productEventsCohortRowSchema)

const event = (eventName: string) => ({ kind: "event" as const, eventName })

describeWithChdb("reads by person and group property", () => {
	let root: string
	let db: Chdb
	const insert = (row: EventRow) =>
		db.exec(
			`INSERT INTO product_events (OrgId, Timestamp, Source, VisitorId, UserId, GroupId, Kind, EventName, Attributes) VALUES (${quote(Q_ORG)}, ${quote(at(row.minute))}, ${quote(row.source ?? "server")}, ${quote(row.visitorId ?? "")}, ${quote(row.userId ?? "")}, ${quote(row.groupId ?? "")}, 'custom', ${quote(row.name ?? "$identify")}, ${mapLiteral(row.attributes)})`,
		)

	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "maple-person-property-reads-"))
		db = Chdb.open({ dataDir: join(root, "data"), schemaSql })
		insert({ minute: 0, source: "mobile", visitorId: "dev-a", name: "landing", attributes: {} })
		insert({
			minute: 0,
			source: "mobile",
			visitorId: "dev-a",
			userId: "a",
			attributes: { "$set.plan": "pro" },
		})
		insert({ minute: 0, userId: "b", attributes: { "$set.plan": "free" } })
		insert({ minute: 0, userId: "c", attributes: { "$set.plan": "pro" } })
		// a: a blank note and 5 seats; b: a note set then unset; c: seats as text.
		insert({ minute: 0, userId: "a", attributes: { "$set.note": "", "$set.seats": "5" } })
		insert({ minute: 0, userId: "b", attributes: { "$set.note": "renewal" } })
		insert({ minute: 4, userId: "b", attributes: { "$unset.note": "" } })
		insert({ minute: 0, userId: "c", attributes: { "$set.seats": "unlimited" } })
		insert({ minute: 0, groupId: "acme", attributes: { "$group_set.tier": "gold" } })
		insert({ minute: 0, groupId: "globex", attributes: { "$group_set.tier": "silver" } })
		for (const [user, group] of [
			["a", "acme"],
			["b", "acme"],
			["c", "globex"],
			["d", ""],
		] as const) {
			insert({ minute: 1, userId: user, groupId: group, name: "signup", attributes: {} })
			insert({ minute: 2, userId: user, groupId: group, name: "create_project", attributes: {} })
		}
		insert({ minute: 3, userId: "a", groupId: "acme", name: "invite", attributes: {} })
		// A visit referred by google on app.example that never signed up, for a host breakdown.
		db.exec(
			`INSERT INTO session_replays (OrgId, SessionId, StartTime, Status, UserId, Version, VisitorId, ReferrerHost, Host) VALUES (${quote(Q_ORG)}, 'sess-e', ${quote(at(5))}, 'ended', '', 1, 'dev-e', 'google.com', 'app.example')`,
		)
	})

	afterAll(() => {
		db?.close()
		if (root) rmSync(root, { recursive: true, force: true })
	})

	const breakdown = (opts: CH.ProductEventsBreakdownOpts) =>
		Arr.map(
			decodeNamed(run(db, CH.compileUnsafe(CH.productEventsBreakdownQuery(opts), WINDOW).sql)),
			(row) => `${row.name}=${row.value}`,
		)

	test("a chart breaks down and filters by the user's and the account's property", () => {
		expect(
			breakdown({
				metric: "users",
				groupBy: "user_property",
				groupByUserPropertyKey: "plan",
				eventNames: ["signup"],
			}),
		).toEqual(["pro=2", "=1", "free=1"])
		expect(
			breakdown({
				metric: "count",
				groupBy: "group_property",
				groupByGroupPropertyKey: "tier",
				eventNames: ["create_project"],
			}),
		).toEqual(["gold=2", "=1", "silver=1"])
		const proUsers = {
			metric: "users",
			groupBy: "event_name",
			userPropertyFilters: [{ key: "plan", mode: "equals", value: "pro" }],
		} as const
		expect(breakdown({ ...proUsers, eventNames: ["create_project"] })).toEqual(["create_project=2"])
		// Not pro: b, d, and the anonymous landing with no user at all.
		expect(
			breakdown({
				metric: "count",
				groupBy: "event_name",
				eventNames: ["signup", "landing"],
				userPropertyFilters: [{ key: "plan", mode: "equals", value: "pro", negated: true }],
			}),
		).toEqual(["signup=2", "landing=1"])
		expect(
			breakdown({
				metric: "groups",
				groupBy: "event_name",
				eventNames: ["signup"],
				groupPropertyFilters: [{ key: "tier", mode: "in", values: ["gold", "silver"] }],
				userPropertyFilters: [{ key: "plan", mode: "exists" }],
			}),
		).toEqual(["signup=2"])
	})

	const funnel = (opts: CH.ProductEventsFunnelOpts) =>
		Arr.map(
			decodeSteps(
				run(db, CH.compileUnsafe(Result.getOrThrow(CH.productEventsFunnelQuery(opts)), WINDOW).sql),
			),
			(row) => row.count,
		)

	test("a funnel keeps the persons whose property matches, with their anonymous steps", () => {
		const steps = [event("signup"), event("create_project"), event("invite")]
		const pro = [{ key: "plan", mode: "equals", value: "pro" }] as const
		expect(funnel({ steps, keyBy: "person", windowSeconds: 3600, userPropertyFilters: pro })).toEqual([
			2, 2, 1,
		])
		// dev-a's anonymous landing is a's, so it passes a's filter.
		expect(
			funnel({
				steps: [event("landing"), event("signup")],
				keyBy: "person",
				windowSeconds: 3600,
				userPropertyFilters: pro,
			}),
		).toEqual([1, 1])
		expect(
			funnel({
				steps: [event("signup"), event("create_project")],
				keyBy: "group",
				windowSeconds: 3600,
				groupPropertyFilters: [{ key: "tier", mode: "equals", value: "gold" }],
			}),
		).toEqual([1, 1])
	})

	test("an account filter keeps a person's steps before they joined the account", () => {
		// a's landing has no account; a is in gold acme, so the step stays.
		expect(
			funnel({
				steps: [event("landing"), event("signup")],
				keyBy: "person",
				windowSeconds: 3600,
				groupPropertyFilters: [{ key: "tier", mode: "equals", value: "gold" }],
			}),
		).toEqual([1, 1])
		expect(
			funnel({
				steps: [event("landing"), event("signup")],
				keyBy: "person",
				windowSeconds: 3600,
				groupPropertyFilters: [{ key: "tier", mode: "equals", value: "gold", negated: true }],
			}),
		).toEqual([0, 0])
	})

	const funnelGroups = (opts: CH.ProductEventsFunnelBreakdownOpts) =>
		Arr.map(
			decodeGroups(
				run(
					db,
					CH.compileUnsafe(Result.getOrThrow(CH.productEventsFunnelBreakdownQuery(opts)), WINDOW)
						.sql,
				),
			),
			(row) => `${row.group}:${row.step}=${row.count}`,
		)

	test("a person's anonymous steps are grouped under their user's property", () => {
		expect(
			funnelGroups({
				steps: [event("landing")],
				keyBy: "person",
				windowSeconds: 3600,
				breakdownBy: "user:plan",
			}),
		).toEqual(["pro:1=1"])
	})

	test("a host breakdown reads the host of a visit that entered on a session step", () => {
		expect(
			funnelGroups({
				steps: [{ kind: "session", dimension: "referrerHost", value: "google.com" }, event("signup")],
				keyBy: "visitor",
				windowSeconds: 3600,
				breakdownBy: "host",
			}),
		).toEqual(["app.example:1=1", "app.example:2=0"])
	})

	test("a negated filter keeps the people without the value", () => {
		const rows = decodeCohort(
			run(
				db,
				CH.compileUnsafe(
					Result.getOrThrow(
						CH.productEventsCohortQuery({
							did: event("signup"),
							didNotScope: "window",
							keyBy: "user",
							limit: 10,
							userPropertyFilters: [
								{ key: "plan", mode: "equals", value: "pro", negated: true },
							],
						}),
					),
					WINDOW,
				).sql,
			),
		)
		expect(
			Arr.sort(
				Arr.map(rows, (row) => row.key),
				Str.Order,
			),
		).toEqual(["b", "d"])
	})

	test("a funnel breaks down by the user's property", () => {
		const rows = decodeGroups(
			run(
				db,
				CH.compileUnsafe(
					Result.getOrThrow(
						CH.productEventsFunnelBreakdownQuery({
							steps: [event("signup"), event("create_project"), event("invite")],
							keyBy: "person",
							windowSeconds: 3600,
							breakdownBy: "user:plan",
						}),
					),
					WINDOW,
				).sql,
			),
		)
		expect(Arr.map(rows, (row) => `${row.group}:${row.step}=${row.count}`)).toEqual([
			":1=1",
			":2=1",
			":3=0",
			"free:1=1",
			"free:2=1",
			"free:3=0",
			"pro:1=2",
			"pro:2=2",
			"pro:3=1",
		])
	})

	test("a cohort keeps the members whose property matches", () => {
		const rows = decodeCohort(
			run(
				db,
				CH.compileUnsafe(
					Result.getOrThrow(
						CH.productEventsCohortQuery({
							did: event("signup"),
							didNot: event("invite"),
							didNotScope: "window",
							keyBy: "user",
							limit: 10,
							userPropertyFilters: [{ key: "plan", mode: "equals", value: "pro" }],
						}),
					),
					WINDOW,
				).sql,
			),
		)
		expect(Arr.map(rows, (row) => row.key)).toEqual(["c"])
	})

	const directory = (filter: CH.UsersListFilter, bound?: CH.UsersListBound) => {
		const scope: CH.UsersScope = { namespaces: [], services: [], serviceNamespaces: [], mcpServices: [] }
		const rows = decodeUserIds(
			run(db, CH.compileUnsafe(CH.usersListQuery(scope, filter, 10, bound), WINDOW).sql),
		)
		return Arr.sort(
			Arr.map(rows, (row) => row.userId),
			Str.Order,
		)
	}

	test("the users directory keeps the users whose property matches", () => {
		expect(directory({ userProperties: [{ key: "plan", mode: "equals", value: "pro" }] })).toEqual([
			"a",
			"c",
		])
		// Pushed down to the candidate rows, the page reads the same users.
		expect(
			directory(
				{ userProperties: [{ key: "plan", mode: "equals", value: "pro" }] },
				{ matching: true },
			),
		).toEqual(["a", "c"])
	})

	test("a negated directory filter keeps the users without the value, those with none included", () => {
		expect(
			directory({ userProperties: [{ key: "plan", mode: "equals", value: "pro", negated: true }] }),
		).toEqual(["b", "d"])
	})

	test("directory property filters all hold, and combine with the search", () => {
		expect(
			directory({
				userProperties: [
					{ key: "plan", mode: "exists" },
					{ key: "plan", mode: "equals", value: "free", negated: true },
				],
				search: "c",
			}),
		).toEqual(["c"])
	})

	test("a blank directory filter matches a blank value, not a cleared one", () => {
		expect(directory({ userProperties: [{ key: "note", mode: "equals", value: "" }] })).toEqual(["a"])
	})

	test("a numeric directory filter skips a text value", () => {
		expect(directory({ userProperties: [{ key: "seats", mode: "lt", value: "10" }] })).toEqual(["a"])
	})

	test("the profile's property states keep a cleared key, with when it was written", () => {
		const rows = decodeStates(
			run(db, CH.compileUnsafe(CH.personPropertyStatesQuery({ kind: "user", ids: ["b"] }), WINDOW).sql),
		)
		expect(Arr.map(rows, (row) => `${row.key}=${row.value} cleared=${row.cleared}`)).toEqual([
			"note= cleared=1",
			"plan=free cleared=0",
		])
		const note = Arr.findFirst(rows, (row) => row.key === "note")
		expect(Option.map(note, (row) => row.writtenAtMs)).toEqual(
			Option.some(Date.parse("2026-11-20T10:04:00Z")),
		)
	})
})
