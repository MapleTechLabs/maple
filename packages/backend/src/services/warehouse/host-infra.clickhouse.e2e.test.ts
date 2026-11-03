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
	readonly delta?: boolean
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
const dataFs = { mountpoint: "/data", type: "ext4", mode: "rw" }
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
	// /data moved from sdc1 (95% at the first scrape) to sdd1; only the current mounts count.
	...usage("remount-host", scrapeA, { ...dataFs, device: "/dev/sdc1" }, "state", {
		used: 95,
		free: 5,
		reserved: 0,
	}),
	...usage("remount-host", scrapeB, { ...dataFs, device: "/dev/sdd1" }, "state", {
		used: 10,
		free: 90,
		reserved: 0,
	}),
	...usage("remount-host", scrapeB, rootFs, "state", { used: 20, free: 80, reserved: 0 }),
	// Utilization stopped at 95% after the first scrape; usage still reports 40%.
	...usage("mixed-host", scrapeB, rootFs, "state", { used: 40, free: 60, reserved: 0 }),
	// macOS reports devfs with nothing free next to the real APFS volume.
	...usage(
		"mac-host",
		scrapeB,
		{ device: "devfs", mountpoint: "/dev", type: "devfs", mode: "rw" },
		"state",
		{
			used: 100,
			free: 0,
			reserved: 0,
		},
	),
	...usage(
		"mac-host",
		scrapeB,
		{ device: "/dev/disk3s1", mountpoint: "/", type: "apfs", mode: "rw" },
		"state",
		{
			used: 30,
			free: 70,
			reserved: 0,
		},
	),
	// Another tenant's full disk on the same host name must not leak in.
	...usage("receiver-host", scrapeB, rootFs, "state", { used: 99, free: 1, reserved: 0 }, "org_other"),
]

// system.network.io samples every minute, offset by 30s, from one bucket before the window
// to its end. eth0 receives 6000 B/min (100 B/s) and transmits 12000 B/min (200 B/s); lo
// receives 600 B/min (10 B/s), which the chart leaves out. eth0's receive counter restarts 32.5 minutes in, 30s
// before a sample, which then reads the 3000 B since the restart.
const RESET_INDEX = 42
const networkPoints: ReadonlyArray<Point> = Array.from({ length: 70 }, (_, index) => {
	const ms = START_MS - 10 * MINUTE_MS + 30_000 + index * MINUTE_MS
	const restarted = index >= RESET_INDEX
	const eth0Start = restarted
		? START_MS - 10 * MINUTE_MS + RESET_INDEX * MINUTE_MS
		: START_MS - 120 * MINUTE_MS
	const eth0Received = restarted ? 3000 + 6000 * (index - RESET_INDEX) : 6000 * index
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

// Current semconv attribute names: semconv-host receives 3000 B/min (50 B/s) on eth0.
const semconvNetworkPoints: ReadonlyArray<Point> = Array.from({ length: 70 }, (_, index) => ({
	host: "semconv-host",
	metric: "system.network.io",
	ms: START_MS - 10 * MINUTE_MS + 30_000 + index * MINUTE_MS,
	value: 3000 * index,
	attrs: { "system.device": "eth0", "network.io.direction": "receive" },
}))

// Delta temporality: delta-host transmits 6000 B per one-minute point (100 B/s), and its
// points for minutes 20-39 of the window were lost.
const deltaNetworkPoints: ReadonlyArray<Point> = Array.from({ length: 60 }, (_, index) => index)
	.filter((index) => index < 20 || index >= 40)
	.map((index) => ({
		host: "delta-host",
		metric: "system.network.io",
		ms: START_MS + 30_000 + index * MINUTE_MS,
		startMs: START_MS + 30_000 + (index - 1) * MINUTE_MS,
		value: 6000,
		attrs: { device: "eth0", direction: "transmit" },
		delta: true,
	}))

// A sender that flips the order of eth0's attributes every scrape: still one 100 B/s series.
const reorderedNetworkPoints: ReadonlyArray<Point> = Array.from({ length: 70 }, (_, index) => ({
	host: "reorder-host",
	metric: "system.network.io",
	ms: START_MS - 10 * MINUTE_MS + 30_000 + index * MINUTE_MS,
	value: 6000 * index,
	attrs:
		index % 2 === 0
			? { device: "eth0", direction: "transmit" }
			: { direction: "transmit", device: "eth0" },
}))

// Every host reports CPU, which is what lists it; utilization-host sends the opt-in gauge.
const gaugePoints: ReadonlyArray<Point> = [
	...["receiver-host", "semconv-host", "utilization-host", "remount-host", "mixed-host", "mac-host"].map(
		(host) => ({
			host,
			metric: "system.cpu.utilization",
			ms: scrapeB,
			value: 0.9,
			attrs: { cpu: "cpu0", state: "idle" },
		}),
	),
	{
		host: "utilization-host",
		metric: "system.filesystem.utilization",
		ms: scrapeB,
		value: 0.42,
		attrs: rootFs,
	},
	{ host: "mixed-host", metric: "system.filesystem.utilization", ms: scrapeA, value: 0.95, attrs: rootFs },
]

const sumRow = (point: Point) => {
	const isNetwork = point.metric === "system.network.io"
	return `(${quote(point.org ?? ORG)}, '', ${quote(point.metric)}, ${quote(chDateTime(point.startMs ?? START_MS - 120 * MINUTE_MS))}, ${quote(chDateTime(point.ms))}, ${point.value}, ${point.delta ? 1 : 2}, ${isNetwork}, ${mapLiteral(point.attrs)}, ${mapLiteral({ "host.name": point.host })})`
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
			`INSERT INTO metrics_sum (OrgId, ServiceName, MetricName, StartTimeUnix, TimeUnix, Value, AggregationTemporality, IsMonotonic, Attributes, ResourceAttributes) VALUES\n${[...filesystemPoints, ...networkPoints, ...semconvNetworkPoints, ...deltaNetworkPoints, ...reorderedNetworkPoints].map(sumRow).join(",\n")}`,
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

	it("reads disk % as used / (used + free) of the fullest real mount's latest scrape", async () => {
		const rows = await run(compileUnsafe(CH.listHostsQuery(), window))
		const disk = Object.fromEntries(rows.map((row) => [row.hostName, row.diskPct]))
		assert.closeTo(disk["receiver-host"]!, 60 / 90, 1e-9)
		assert.closeTo(disk["semconv-host"]!, 25 / 95, 1e-9)
		assert.closeTo(disk["utilization-host"]!, 0.42, 1e-9)

		const [detail] = await run(
			compileUnsafe(CH.hostDetailSummaryQuery({ hostName: "receiver-host" }), window),
		)
		assert.closeTo(detail!.diskPct, 60 / 90, 1e-9)
	})

	it("reads disk % from each host's current mounts and their newest reading", async () => {
		const rows = await run(compileUnsafe(CH.listHostsQuery(), window))
		const disk = Object.fromEntries(rows.map((row) => [row.hostName, row.diskPct]))
		assert.closeTo(disk["remount-host"]!, 0.2, 1e-9)
		assert.closeTo(disk["mixed-host"]!, 0.4, 1e-9)
		assert.closeTo(disk["mac-host"]!, 0.3, 1e-9)
	})

	it("lists a remounted mountpoint once per device", async () => {
		const rows = await run(compileUnsafe(CH.hostFilesystemsQuery({ hostName: "remount-host" }), window))
		const usedMax = Object.fromEntries(
			rows.map((row) => [`${row.mountpoint} ${row.device}`, row.usedMax]),
		)
		assert.closeTo(usedMax["/data /dev/sdc1"]!, 0.95, 1e-9)
		assert.closeTo(usedMax["/data /dev/sdd1"]!, 0.1, 1e-9)
		assert.closeTo(usedMax["/ /dev/sda1"]!, 0.2, 1e-9)
	})

	it("reads disk % for every host on the page and only those", async () => {
		const [first] = await run(compileUnsafe(CH.listHostsQuery({ limit: 1 }), window))
		const [second] = await run(compileUnsafe(CH.listHostsQuery({ limit: 1, offset: 1 }), window))
		const all = await run(compileUnsafe(CH.listHostsQuery(), window))
		const diskOf = Object.fromEntries(all.map((row) => [row.hostName, row.diskPct]))
		assert.strictEqual(first!.diskPct, diskOf[first!.hostName])
		assert.strictEqual(second!.diskPct, diskOf[second!.hostName])
	})

	it("lists each real mount with its average and peak used fraction", async () => {
		const receiver = await run(
			compileUnsafe(CH.hostFilesystemsQuery({ hostName: "receiver-host" }), window),
		)
		assert.deepEqual(
			receiver.map((row) => [row.mountpoint, row.device]),
			[["/", "/dev/sda1"]],
		)
		assert.closeTo(receiver[0]!.usedAvg, (40 / 90 + 60 / 90) / 2, 1e-9)
		assert.closeTo(receiver[0]!.usedMax, 60 / 90, 1e-9)

		const semconv = await run(
			compileUnsafe(CH.hostFilesystemsQuery({ hostName: "semconv-host" }), window),
		)
		assert.deepEqual(
			semconv.map((row) => [row.mountpoint, row.device]),
			[["/data", "/dev/sdb1"]],
		)
		assert.closeTo(semconv[0]!.usedMax, 25 / 95, 1e-9)
	})

	it("charts each mount's used fraction per bucket", async () => {
		const rows = await run(
			compileUnsafe(CH.hostFilesystemTimeseriesQuery({ hostName: "receiver-host" }), {
				...window,
				bucketSeconds: 600,
			}),
		)
		assert.deepEqual(
			rows.map((row) => row.attributeValue),
			["/", "/"],
		)
		assert.closeTo(rows[0]!.avgValue, 40 / 90, 1e-9)
		assert.closeTo(rows[1]!.avgValue, 60 / 90, 1e-9)
	})

	it("charts network I/O as bytes per second, across a counter reset, without loopback", async () => {
		const rows = await run(
			compileUnsafe(CH.hostNetworkTimeseriesQuery({ hostName: "receiver-host" }), {
				...window,
				bucketSeconds: 600,
			}),
		)
		const byDirection = (direction: string) =>
			rows.filter((row) => row.attributeValue === direction).map((row) => Math.round(row.rateValue))
		assert.deepEqual(byDirection("receive"), [100, 100, 100, 100, 100, 100])
		assert.deepEqual(byDirection("transmit"), [200, 200, 200, 200, 200, 200])
	})

	it("reads the direction under its current semconv name", async () => {
		const rows = await run(
			compileUnsafe(CH.hostNetworkTimeseriesQuery({ hostName: "semconv-host" }), {
				...window,
				bucketSeconds: 600,
			}),
		)
		assert.deepEqual(
			rows.map((row) => [row.attributeValue, Math.round(row.rateValue)]),
			Array.from({ length: 6 }, () => ["receive", 50]),
		)
	})

	it("divides a delta point by its own interval, across lost points", async () => {
		const rows = await run(
			compileUnsafe(CH.hostNetworkTimeseriesQuery({ hostName: "delta-host" }), {
				...window,
				bucketSeconds: 60,
			}),
		)
		assert.strictEqual(rows.length, 40)
		assert.deepEqual([...new Set(rows.map((row) => Math.round(row.rateValue)))], [100])
	})

	it("keeps one series when a sender reorders its attributes", async () => {
		const rows = await run(
			compileUnsafe(CH.hostNetworkTimeseriesQuery({ hostName: "reorder-host" }), {
				...window,
				bucketSeconds: 600,
			}),
		)
		assert.deepEqual(
			rows.map((row) => Math.round(row.rateValue)),
			[100, 100, 100, 100, 100, 100],
		)
	})

	it("keeps the true rate in buckets narrower than the scrape interval", async () => {
		const rows = await run(
			compileUnsafe(CH.hostNetworkTimeseriesQuery({ hostName: "receiver-host" }), {
				...window,
				bucketSeconds: 15,
			}),
		)
		const transmit = rows.filter((row) => row.attributeValue === "transmit")
		// One bucket per minute's scrape, from the first one in the window.
		assert.strictEqual(transmit.length, 60)
		assert.deepEqual([...new Set(transmit.map((row) => Math.round(row.rateValue)))], [200])
	})
})
