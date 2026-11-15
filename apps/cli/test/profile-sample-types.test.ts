// The profile summary on a real ClickHouse engine: windows summed once per profile, however
// many stack rows each profile wrote.

import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as CH from "@maple/query-engine/ch"
import { normalizeSqlForClickHouseClient } from "@maple/query-engine/execution"
import { compileUnsafe } from "@maple-dev/effect-orm/clickhouse"
import { Schema, Array as Arr, String as Str } from "effect"
import schemaSql from "@maple/local-server/schema/local-schema.sql" with { type: "text" }
import { Chdb } from "@maple/local-server/chdb"
import { decodeJsonEachRow } from "@maple/local-server/chdb-rows"
import { describeWithChdb } from "./libchdb-test-support"

const ORG = "org_profile_summary"
const SECOND_NS = 1_000_000_000
/** An hour ago on the minute: recent, so the table's TTL keeps it. */
const AT_MS = Math.floor(Date.now() / 60_000) * 60_000 - 3_600_000

const seconds = (ms: number) => Str.slice(0, 19)(Str.replace("T", " ")(new Date(ms).toISOString()))

interface Row {
	readonly profileId: string
	readonly durationSeconds: number
	readonly frame: string
	readonly value: number
}

const insert = (db: Chdb, rows: ReadonlyArray<Row>) => {
	const values = Arr.map(
		rows,
		(row) =>
			`('${ORG}', '${seconds(AT_MS)}', 'checkout', '${row.profileId}', 'cpu', 'nanoseconds', ${row.value}, 1, ${row.durationSeconds * SECOND_NS}, ['${row.frame}'], [''], [0])`,
	)
	db.exec(
		`INSERT INTO profiles (OrgId, Timestamp, ServiceName, ProfileId, SampleType, SampleUnit, Value, Samples, DurationNano, Frames, FrameFiles, FrameLines) VALUES ${Arr.join(values, ", ")}`,
	)
}

const SummaryRow = Schema.Struct({
	sampleType: Schema.String,
	sampleUnit: Schema.String,
	profiles: CH.CHNumber,
	durationNano: CH.CHNumber,
})

describeWithChdb("profile sample types", () => {
	let root = ""
	let db: Chdb

	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "maple-profile-summary-"))
		db = Chdb.open({ dataDir: join(root, "data"), schemaSql })
	})

	afterAll(() => {
		db.close()
		rmSync(root, { recursive: true, force: true })
	})

	test("sums each profile's window once, whatever its row count", () => {
		insert(db, [
			{ profileId: "a", durationSeconds: 60, frame: "main", value: 10 },
			{ profileId: "a", durationSeconds: 60, frame: "work", value: 20 },
			{ profileId: "b", durationSeconds: 30, frame: "main", value: 5 },
			// Two profiles of one window are two windows, not one.
			{ profileId: "c", durationSeconds: 30, frame: "main", value: 5 },
		])
		const { sql } = compileUnsafe(CH.profileSampleTypesQuery({ service: true }), {
			orgId: ORG,
			serviceName: "checkout",
			startTime: seconds(AT_MS - 60_000),
			endTime: seconds(AT_MS + 60_000),
		})
		const rows = decodeJsonEachRow(SummaryRow)(db.query(normalizeSqlForClickHouseClient(sql)))
		expect(rows).toEqual([
			{ sampleType: "cpu", sampleUnit: "nanoseconds", profiles: 3, durationNano: 120 * SECOND_NS },
		])
	})
})
