// An audit detection's action filter on a real ClickHouse engine: an action matches its
// sub-actions, so a `push.forced` rule still counts force pushes to the default branch.

import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as CH from "@maple/query-engine/ch"
import { normalizeSqlForClickHouseClient } from "@maple/query-engine/execution"
import { compileUnsafe } from "@maple-dev/effect-orm/clickhouse"
import { Array as Arr, Schema, String as Str } from "effect"
import { OrgId } from "@maple/domain"
import schemaSql from "@maple/local-server/schema/local-schema.sql" with { type: "text" }
import { Chdb } from "@maple/local-server/chdb"
import { decodeJsonEachRow } from "@maple/local-server/chdb-rows"
import { describeWithChdb } from "./libchdb-test-support"

const ORG = "org_audit_action_family"
const ORG_ID = Schema.decodeSync(OrgId)(ORG)
/** An hour ago on the minute: recent, so the table's TTL keeps it. */
const AT_MS = Math.floor(Date.now() / 60_000) * 60_000 - 3_600_000

const seconds = (ms: number) => Str.slice(0, 19)(Str.replace("T", " ")(new Date(ms).toISOString()))

const ACTIONS = [
	"push.forced",
	"push.forced.default_branch",
	"push.forced.non_author",
	// Shares the prefix but is another action.
	"push.forcedx",
	"delete.branch",
]

describeWithChdb("audit trail action family", () => {
	let root = ""
	let db: Chdb

	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "maple-audit-action-family-"))
		db = Chdb.open({ dataDir: join(root, "data"), schemaSql })
		const values = Arr.map(
			ACTIONS,
			(action, i) =>
				`('${ORG}', 'evt_${i}', '${seconds(AT_MS)}', '${seconds(AT_MS)}', 'github', '${action}', 'resource', 'success')`,
		)
		db.exec(
			`INSERT INTO audit_trail_events (OrgId, Id, OccurredAt, IngestedAt, Provider, Action, Category, Outcome) VALUES ${Arr.join(values, ", ")}`,
		)
	})

	afterAll(() => {
		db.close()
		rmSync(root, { recursive: true, force: true })
	})

	const count = (action: string) => {
		const { sql } = compileUnsafe(CH.auditTrailCountQuery({ action: true }), {
			orgId: ORG_ID,
			...CH.auditTrailActionParams(action),
			start: seconds(AT_MS - 60_000),
			end: seconds(AT_MS + 60_000),
		})
		return decodeJsonEachRow(CH.auditTrailCountRowSchema)(
			db.query(normalizeSqlForClickHouseClient(sql)),
		)[0]?.events
	}

	test("counts an action with its sub-actions, and a sub-action alone", () => {
		expect(count("push.forced")).toBe(3)
		expect(count("push.forced.default_branch")).toBe(1)
		expect(count("push.forced.non_author")).toBe(1)
		expect(count("push")).toBe(4)
		expect(count("delete.branch")).toBe(1)
	})

	test("lists an action with its sub-actions", () => {
		const { sql } = compileUnsafe(CH.auditTrailEventsQuery({ action: true, limit: 10 }), {
			orgId: ORG_ID,
			...CH.auditTrailActionParams("push.forced"),
		})
		const rows = db.query(normalizeSqlForClickHouseClient(sql))
		const actions = Arr.map(Str.split("\n")(Str.trim(rows)), (line) => JSON.parse(line).action)
		expect(Arr.sort(actions, Str.Order)).toEqual([
			"push.forced",
			"push.forced.default_branch",
			"push.forced.non_author",
		])
	})
})
