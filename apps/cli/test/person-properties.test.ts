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
import { Array as Arr, Option, Record as Rec, String as Str } from "effect"
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
