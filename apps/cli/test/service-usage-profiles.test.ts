// Profiles reach service_usage on a real ClickHouse engine: the view counts each stack row and
// estimates its bytes from its frames, per org, service and hour, beside the other signals.

import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as CH from "@maple/query-engine/ch"
import { Schema, Array as Arr, String as Str } from "effect"
import schemaSql from "@maple/local-server/schema/local-schema.sql" with { type: "text" }
import { Chdb } from "@maple/local-server/chdb"
import { decodeJsonEachRow } from "@maple/local-server/chdb-rows"
import { localSchemaSnapshot } from "@maple/local-server/local-schema-history"
import { describeWithChdb } from "./libchdb-test-support"
import { migrationStep, openStore } from "./local-store-step-test-support"

const ORG = "org_service_usage_profiles"
/** An hour ago on the hour: recent, so every TTL keeps it. */
const HOUR_MS = Math.floor(Date.now() / 3_600_000) * 3_600_000 - 3_600_000

const seconds = (ms: number) => Str.slice(0, 19)(Str.replace("T", " ")(new Date(ms).toISOString()))

const insertProfile = (db: Chdb, orgId: string, atMs: number, frames: ReadonlyArray<string>) => {
	const list = (items: ReadonlyArray<string>) => `[${Arr.join(items, ", ")}]`
	db.exec(
		`INSERT INTO profiles (OrgId, Timestamp, ServiceName, ProfileId, SampleType, SampleUnit, Value, Samples, Frames, FrameFiles, FrameLines) VALUES ('${orgId}', '${seconds(atMs)}', 'checkout', 'p1', 'cpu', 'nanoseconds', 10, 1, ${list(Arr.map(frames, (frame) => `'${frame}'`))}, ${list(Arr.map(frames, () => "''"))}, ${list(Arr.map(frames, () => "0"))})`,
	)
}

const UsageRow = Schema.Struct({
	hour: Schema.String,
	profileRows: CH.CHNumber,
	profileBytes: CH.CHNumber,
	logBytes: CH.CHNumber,
})

const usage = (db: Chdb, orgId: string) =>
	decodeJsonEachRow(UsageRow)(
		db.query(
			`SELECT toString(Hour) AS hour, sum(ProfileRowCount) AS profileRows, sum(ProfileSizeBytes) AS profileBytes, sum(LogSizeBytes) AS logBytes FROM service_usage WHERE OrgId = '${orgId}' AND ServiceName = 'checkout' GROUP BY Hour ORDER BY Hour`,
		),
	)

describeWithChdb("service_usage profiles view", () => {
	let root = ""
	let db: Chdb

	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "maple-service-usage-profiles-"))
		db = Chdb.open({ dataDir: join(root, "data"), schemaSql })
	})

	afterAll(() => {
		db.close()
		rmSync(root, { recursive: true, force: true })
	})

	test("counts each stack row and its frame-based bytes into its org's hour", () => {
		insertProfile(db, ORG, HOUR_MS + 60_000, ["main", "work"])
		insertProfile(db, ORG, HOUR_MS + 120_000, ["main", "work", "parse"])
		insertProfile(db, ORG, HOUR_MS + 3_600_000 + 60_000, ["main"])
		insertProfile(db, "org_someone_else", HOUR_MS + 60_000, ["main"])

		const rows = usage(db, ORG)
		// 16 bytes per frame plus 200 per row: (2 * 16 + 200) + (3 * 16 + 200), then 1 * 16 + 200.
		expect(rows).toEqual([
			{ hour: seconds(HOUR_MS), profileRows: 2, profileBytes: 480, logBytes: 0 },
			{ hour: seconds(HOUR_MS + 3_600_000), profileRows: 1, profileBytes: 216, logBytes: 0 },
		])
	})
})

describeWithChdb("v59 -> v60 service_usage profile columns", () => {
	const STEP_ID = "local-0059-to-0060-service-usage-profiles"
	const MIGRATED_ORG = "local"

	test("keeps existing usage hours and counts the profiles ingested after it", async () => {
		const root = await mkdtemp(join(tmpdir(), "maple-service-usage-profiles-step-"))
		const sourceDataDir = join(root, "source", "data")
		const targetDataDir = join(root, "target", "data")
		const db = Chdb.open({ dataDir: sourceDataDir, schemaSql: localSchemaSnapshot(59).sql })
		db.exec(
			`INSERT INTO service_usage (OrgId, ServiceName, Hour, LogCount, LogSizeBytes) VALUES ('${MIGRATED_ORG}', 'checkout', '${seconds(HOUR_MS)}', 3, 900)`,
		)
		db.close()

		const { migration, context } = migrationStep(STEP_ID, sourceDataDir, targetDataDir, Date.now())
		const state = await migration.preflight(context)
		await migration.prepareTarget(context, state)
		const progress = await migration.apply(context, state, undefined)
		await migration.verify(context, state, progress)

		const rows = await openStore(
			targetDataDir,
			(db) => {
				insertProfile(db, MIGRATED_ORG, HOUR_MS + 60_000, ["main"])
				return usage(db, MIGRATED_ORG)
			},
			{ schemaSql: localSchemaSnapshot(60).sql, bootstrapSchema: false },
		)
		await rm(root, { recursive: true, force: true })
		expect(rows).toEqual([{ hour: seconds(HOUR_MS), profileRows: 1, profileBytes: 216, logBytes: 900 }])
	})
})
