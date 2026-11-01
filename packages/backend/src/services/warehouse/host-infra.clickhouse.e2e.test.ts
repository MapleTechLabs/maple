// SAFETY-FILE: JSON is emitted by the isolated ClickHouse fixture and decoded by the real query schema.
// Host disk % and network throughput, seeded the way the hostmetrics receiver sends them:
// filesystem usage as bytes split by state (utilization is opt-in) and network I/O as a
// cumulative counter per device and direction.

import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest"
import { Schema } from "effect"
import { compileUnsafe } from "@maple-dev/effect-orm/clickhouse"
import { OrgId } from "@maple/domain"
import { CH } from "@maple/query-engine"
import { normalizeSqlForClickHouseClient } from "@maple/query-engine/execution"
import {
	applyRealMigrations,
	clickhouseE2eEnabled,
	clickhouseExec,
	uniqueDatabase,
} from "./clickhouse-e2e-support"

const database = uniqueDatabase("maple_host_infra_e2e")
const ORG = "org_hosts"

const MINUTE_MS = 60_000
const BUCKET_MS = 10 * MINUTE_MS
// Bucket-aligned and anchored to now so the table TTL never drops the seed.
const START_MS = Math.floor(Date.now() / BUCKET_MS) * BUCKET_MS - 70 * MINUTE_MS
const END_MS = START_MS + 60 * MINUTE_MS
const chDateTime = (epochMs: number): string => new Date(epochMs).toISOString().replace("T", " ").slice(0, 19)

const quote = (value: string): string => `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`
const mapLiteral = (attrs: Record<string, string>) =>
	`map(${Object.entries(attrs)
		.flatMap(([key, value]) => [quote(key), quote(value)])
		.join(", ")})`

interface Point {
	readonly org?: string
	readonly host: string
	readonly metric: string
	readonly ms: number
	readonly startMs?: number
	readonly value: number
	readonly attrs: Record<string, string>
}

// One scrape of system.filesystem.usage: a row per state, all at the same time.
const usage = (
	host: string,
	ms: number,
	attrs: Record<string, string>,
	stateKey: string,
	bytes: { used: number; free: number; reserved: number },
	org?: string,
): ReadonlyArray<Point> =>
	(["used", "free", "reserved"] as const).map((state) => ({
		org,
		host,
		metric: "system.filesystem.usage",
		ms,
		value: bytes[state],
		attrs: { ...attrs, [stateKey]: state },
	}))

const rootFs = { device: "/dev/sda1", mountpoint: "/", type: "ext4", mode: "rw" }
const snapFs = { device: "/dev/loop0", mountpoint: "/snap/core", type: "squashfs", mode: "ro" }
const semconvFs = {
	"system.device": "/dev/sdb1",
	"system.filesystem.mountpoint": "/data",
	"system.filesystem.type": "xfs",
	"system.filesystem.mode": "rw",
}

const scrapeA = START_MS + 5 * MINUTE_MS
const scrapeB = START_MS + 25 * MINUTE_MS

const filesystemPoints: ReadonlyArray<Point> = [
	// Receiver attribute names: / is 40% then 60% used; the read-only snap mount is always full.
	...usage("receiver-host", scrapeA, rootFs, "state", { used: 40, free: 50, reserved: 10 }),
	...usage("receiver-host", scrapeB, rootFs, "state", { used: 60, free: 30, reserved: 10 }),
	...usage("receiver-host", scrapeB, snapFs, "state", { used: 100, free: 0, reserved: 0 }),
	// Current semconv attribute names.
	...usage("semconv-host", scrapeA, semconvFs, "system.filesystem.state", {
		used: 25,
		free: 70,
		reserved: 5,
	}),
	// Another tenant's full disk on the same host name must not leak in.
	...usage("receiver-host", scrapeB, rootFs, "state", { used: 99, free: 1, reserved: 0 }, "org_other"),
]

// system.network.io samples every minute, offset by 30s, from one bucket before the window
// to its end. eth0 receives 6000 B/min (100 B/s) and transmits 12000 B/min (200 B/s); lo
// receives 600 B/min (10 B/s). eth0's receive counter resets 32.5 minutes in.
const RESET_INDEX = 42
const networkPoints: ReadonlyArray<Point> = Array.from({ length: 70 }, (_, index) => {
	const ms = START_MS - 10 * MINUTE_MS + 30_000 + index * MINUTE_MS
	const restarted = index >= RESET_INDEX
	const eth0Start = restarted
		? START_MS - 10 * MINUTE_MS + RESET_INDEX * MINUTE_MS
		: START_MS - 120 * MINUTE_MS
	const eth0Received = restarted ? 6000 * (index - RESET_INDEX + 1) : 6000 * index
	return [
		{
			host: "receiver-host",
			metric: "system.network.io",
			ms,
			startMs: eth0Start,
			value: eth0Received,
			attrs: { device: "eth0", direction: "receive" },
		},
		{
			host: "receiver-host",
			metric: "system.network.io",
			ms,
			value: 12_000 * index,
			attrs: { device: "eth0", direction: "transmit" },
		},
		{
			host: "receiver-host",
			metric: "system.network.io",
			ms,
			value: 600 * index,
			attrs: { device: "lo", direction: "receive" },
		},
	]
}).flat()

// Every host reports CPU, which is what lists it; utilization-host sends the opt-in gauge.
const gaugePoints: ReadonlyArray<Point> = [
	...["receiver-host", "semconv-host", "utilization-host"].map((host) => ({
		host,
		metric: "system.cpu.utilization",
		ms: scrapeB,
		value: 0.9,
		attrs: { cpu: "cpu0", state: "idle" },
	})),
	{
		host: "utilization-host",
		metric: "system.filesystem.utilization",
		ms: scrapeB,
		value: 0.42,
		attrs: rootFs,
	},
]

const sumRow = (point: Point) => {
	const isNetwork = point.metric === "system.network.io"
	return `(${quote(point.org ?? ORG)}, '', ${quote(point.metric)}, ${quote(chDateTime(point.startMs ?? START_MS - 120 * MINUTE_MS))}, ${quote(chDateTime(point.ms))}, ${point.value}, 2, ${isNetwork}, ${mapLiteral(point.attrs)}, ${mapLiteral({ "host.name": point.host })})`
}
const gaugeRow = (point: Point) => {
	const at = quote(chDateTime(point.ms))
	return `(${quote(point.org ?? ORG)}, '', ${quote(point.metric)}, ${at}, ${at}, ${point.value}, ${mapLiteral(point.attrs)}, ${mapLiteral({ "host.name": point.host })})`
}

const window = {
	orgId: OrgId.make(ORG),
	startTime: chDateTime(START_MS),
	endTime: chDateTime(END_MS),
}

describe.skipIf(!clickhouseE2eEnabled)("host infra queries against ClickHouse", () => {
	beforeAll(async () => {
		await clickhouseExec(`CREATE DATABASE ${database}`)
		await applyRealMigrations(database)
		await clickhouseExec(
			`INSERT INTO metrics_sum (OrgId, ServiceName, MetricName, StartTimeUnix, TimeUnix, Value, AggregationTemporality, IsMonotonic, Attributes, ResourceAttributes) VALUES\n${[...filesystemPoints, ...networkPoints].map(sumRow).join(",\n")}`,
			database,
		)
		await clickhouseExec(
			`INSERT INTO metrics_gauge (OrgId, ServiceName, MetricName, StartTimeUnix, TimeUnix, Value, Attributes, ResourceAttributes) VALUES\n${gaugePoints.map(gaugeRow).join(",\n")}`,
			database,
		)
	}, 120_000)

	afterAll(async () => {
		await clickhouseExec(`DROP DATABASE IF EXISTS ${database}`)
	})

	const run = async <R>(compiled: {
		readonly sql: string
		readonly rowSchema?: Schema.Codec<R, unknown>
	}) => {
		const body = JSON.parse(
			await clickhouseExec(normalizeSqlForClickHouseClient(compiled.sql), database, {
				default_format: "JSON",
				output_format_json_quote_64bit_integers: "0",
			}),
		)
		assert.isDefined(compiled.rowSchema)
		return Schema.decodeUnknownSync(Schema.Array(compiled.rowSchema!))(body.data)
	}

	it("reads disk % as used / (used + free + reserved) of the fullest real mount", async () => {
		const rows = await run(compileUnsafe(CH.listHostsQuery(), window))
		const disk = Object.fromEntries(rows.map((row) => [row.hostName, row.diskPct]))
		assert.closeTo(disk["receiver-host"]!, 0.6, 1e-9)
		assert.closeTo(disk["semconv-host"]!, 0.25, 1e-9)
		assert.closeTo(disk["utilization-host"]!, 0.42, 1e-9)

		const [detail] = await run(
			compileUnsafe(CH.hostDetailSummaryQuery({ hostName: "semconv-host" }), window),
		)
		assert.closeTo(detail!.diskPct, 0.25, 1e-9)
	})

	it("lists each real mount with its average and peak used fraction", async () => {
		const receiver = await run(
			compileUnsafe(CH.hostFilesystemsQuery({ hostName: "receiver-host" }), window),
		)
		assert.deepEqual(
			receiver.map((row) => [row.mountpoint, row.device]),
			[["/", "/dev/sda1"]],
		)
		assert.closeTo(receiver[0]!.usedAvg, 0.5, 1e-9)
		assert.closeTo(receiver[0]!.usedMax, 0.6, 1e-9)

		const semconv = await run(
			compileUnsafe(CH.hostFilesystemsQuery({ hostName: "semconv-host" }), window),
		)
		assert.deepEqual(
			semconv.map((row) => [row.mountpoint, row.device, row.usedMax]),
			[["/data", "/dev/sdb1", 0.25]],
		)
	})

	it("charts each mount's used fraction per bucket", async () => {
		const rows = await run(
			compileUnsafe(CH.hostFilesystemTimeseriesQuery({ hostName: "receiver-host" }), {
				...window,
				bucketSeconds: 600,
			}),
		)
		assert.deepEqual(
			rows.map((row) => [row.attributeValue, row.avgValue]),
			[
				["/", 0.4],
				["/", 0.6],
			],
		)
	})

	it("charts network I/O as bytes per second, across devices and a counter reset", async () => {
		const rows = await run(
			compileUnsafe(CH.hostNetworkTimeseriesQuery({ hostName: "receiver-host" }), {
				...window,
				bucketSeconds: 600,
			}),
		)
		const byDirection = (direction: string) =>
			rows.filter((row) => row.attributeValue === direction).map((row) => Math.round(row.rateValue))
		assert.deepEqual(byDirection("receive"), [110, 110, 110, 110, 110, 110])
		assert.deepEqual(byDirection("transmit"), [200, 200, 200, 200, 200, 200])
	})
})
