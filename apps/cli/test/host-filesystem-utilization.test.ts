import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as CH from "@maple/query-engine/ch"
import { Effect, Schema } from "effect"
import schemaSql from "../src/server/schema/local-schema.sql" with { type: "text" }
import { Chdb } from "../src/server/chdb"
import { LOCAL_ORG_ID } from "../src/core/executor"
import { decodeJsonEachRow } from "../src/server/chdb-rows"
import { describeWithChdb } from "./libchdb-test-support"

const iso = (ms: number) => new Date(ms).toISOString().replace("T", " ").replace("Z", "")
const nowMs = Date.now()
const window = { startTime: iso(nowMs - 3_600_000).slice(0, 19), endTime: iso(nowMs).slice(0, 19) }

// The hostmetrics receiver emits utilization with no `state`; other shippers split it by state.
const point = (host: string, mount: string, fsType: string, value: number, state?: string) => {
	const attrs = `map('mountpoint', '${mount}', 'device', '/dev/${mount.length}', 'type', '${fsType}', 'mode', 'rw'${state === undefined ? "" : `, 'state', '${state}'`})`
	return `('${LOCAL_ORG_ID}', map('host.name', '${host}'), 'system.filesystem.utilization', ${attrs}, '${iso(nowMs - 60_000)}', ${value})`
}

const decodeHosts = decodeJsonEachRow(Schema.Struct({ hostName: Schema.String, diskPct: CH.CHNumber }))
const decodeMounts = decodeJsonEachRow(
	Schema.Struct({ mountpoint: Schema.String, usedAvg: CH.CHNumber, usedMax: CH.CHNumber }),
)
const decodeSeries = decodeJsonEachRow(
	Schema.Struct({ attributeValue: Schema.String, avgValue: CH.CHNumber }),
)

describeWithChdb("host filesystem utilization", () => {
	let root = ""
	let db: Chdb

	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "maple-host-fs-"))
		db = Chdb.open({ dataDir: join(root, "data"), schemaSql })
		const rows = [
			point("receiver-host", "/", "ext4", 0.42),
			point("receiver-host", "/snap/core", "squashfs", 1),
			point("split-host", "/", "ext4", 0.6, "used"),
			point("split-host", "/", "ext4", 0.4, "free"),
		]
		db.exec(
			`INSERT INTO metrics_gauge (OrgId, ResourceAttributes, MetricName, Attributes, TimeUnix, Value) VALUES ${rows.join(", ")}`,
		)
	})

	afterAll(() => {
		db?.close()
		if (root) rmSync(root, { recursive: true, force: true })
	})

	const run = async (compiled: Effect.Effect<{ readonly sql: string }, unknown>) => {
		const { sql } = await Effect.runPromise(compiled)
		return db.query(sql.replace(/\s+FORMAT\s+\w+\s*$/, "\nFORMAT JSONEachRow"))
	}
	const params = { orgId: LOCAL_ORG_ID, ...window }

	test("host disk % reads stateless points and keeps only the used share of split ones", async () => {
		const rows = decodeHosts(await run(CH.compile(CH.listHostsQuery({}), params)))
		const disk = Object.fromEntries(rows.map((row) => [row.hostName, Number(row.diskPct)]))
		expect(disk["receiver-host"]).toBeCloseTo(0.42)
		expect(disk["split-host"]).toBeCloseTo(0.6)
	})

	test("per-mount filesystems read stateless points", async () => {
		const rows = decodeMounts(
			await run(CH.compile(CH.hostFilesystemsQuery({ hostName: "receiver-host" }), params)),
		)
		const rootMount = rows.find((row) => row.mountpoint === "/")
		expect(Number(rootMount?.usedMax)).toBeCloseTo(0.42)
		const split = decodeMounts(
			await run(CH.compile(CH.hostFilesystemsQuery({ hostName: "split-host" }), params)),
		)
		expect(Number(split[0]?.usedAvg)).toBeCloseTo(0.6)
	})

	test("the filesystem chart series reads stateless points", async () => {
		const series = (hostName: string) =>
			CH.compile(
				CH.hostGaugeTimeseriesQuery({
					hostName,
					metricName: "system.filesystem.utilization",
					groupByAttributeKey: "mountpoint",
					attributeIn: { key: "state", values: CH.FILESYSTEM_USED_STATES },
				}),
				{ ...params, bucketSeconds: 3600 },
			)
		const receiver = decodeSeries(await run(series("receiver-host")))
		expect(Number(receiver.find((row) => row.attributeValue === "/")?.avgValue)).toBeCloseTo(0.42)
		const split = decodeSeries(await run(series("split-host")))
		expect(split.map((row) => Number(row.avgValue))).toEqual([0.6])
	})
})
