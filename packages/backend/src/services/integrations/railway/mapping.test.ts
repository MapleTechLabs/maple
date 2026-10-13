import { assert, describe, it } from "@effect/vitest"
import { mapRailwayMetrics, METRIC_CPU_USAGE, METRIC_MEMORY_USAGE, METRIC_NETWORK_IO } from "./mapping"

const context = {
	projectId: "prj_1",
	projectName: "shop",
	environmentId: "env_1",
	environmentName: "production",
	services: { svc_api: "api" },
}

const t0 = Date.UTC(2026, 9, 3, 12, 0, 0)

describe("mapRailwayMetrics", () => {
	it("maps one resource per service replica with Railway identity attributes", () => {
		const rows = mapRailwayMetrics(
			context,
			[
				{
					measurement: "CPU_USAGE",
					tags: { serviceId: "svc_api", deploymentInstanceId: "rep_1", region: "us-west2" },
					values: [{ ts: t0 / 1000, value: 0.25 }],
				},
			],
			{ startMs: t0, endMs: t0 + 60_000 },
		)
		assert.strictEqual(rows.length, 1)
		const row = rows[0]!
		assert.strictEqual(row.metric_name, METRIC_CPU_USAGE)
		assert.strictEqual(row.value, 0.25)
		assert.strictEqual(row.service_name, "api")
		assert.strictEqual(row.timestamp, "2026-10-03 12:00:00.000")
		assert.deepStrictEqual(row.resource_attributes, {
			"service.name": "api",
			"cloud.provider": "railway",
			"cloud.region": "us-west2",
			"deployment.environment": "production",
			"deployment.environment.name": "production",
			"railway.project.id": "prj_1",
			"railway.project.name": "shop",
			"railway.environment.id": "env_1",
			"railway.environment.name": "production",
			"railway.service.id": "svc_api",
			"railway.service.name": "api",
			"railway.replica.id": "rep_1",
		})
	})

	it("converts GB to bytes and splits network direction into an attribute", () => {
		const rows = mapRailwayMetrics(
			context,
			[
				{
					measurement: "MEMORY_USAGE_GB",
					tags: { serviceId: "svc_api" },
					values: [{ ts: t0 / 1000, value: 0.5 }],
				},
				{
					measurement: "NETWORK_TX_GB",
					tags: { serviceId: "svc_api" },
					values: [{ ts: t0 / 1000, value: 1 }],
				},
			],
			{ startMs: t0, endMs: t0 + 60_000 },
		)
		const memory = rows.find((row) => row.metric_name === METRIC_MEMORY_USAGE)!
		assert.strictEqual(memory.value, 512 * 1024 ** 2)
		assert.strictEqual(memory.metric_unit, "By")
		const network = rows.find((row) => row.metric_name === METRIC_NETWORK_IO)!
		assert.deepStrictEqual(network.metric_attributes, { "network.io.direction": "transmit" })
	})

	it("keeps only samples inside [start, end) so adjacent windows never overlap", () => {
		const rows = mapRailwayMetrics(
			context,
			[
				{
					measurement: "CPU_USAGE",
					tags: { serviceId: "svc_api" },
					values: [
						{ ts: t0 / 1000 - 60, value: 1 },
						{ ts: t0 / 1000, value: 2 },
						{ ts: t0 / 1000 + 60, value: 3 },
					],
				},
			],
			{ startMs: t0, endMs: t0 + 60_000 },
		)
		assert.deepStrictEqual(
			rows.map((row) => row.value),
			[2],
		)
	})

	it("drops project-level series and unknown measurements, and falls back to the service id", () => {
		const rows = mapRailwayMetrics(
			context,
			[
				{ measurement: "CPU_USAGE", tags: {}, values: [{ ts: t0 / 1000, value: 1 }] },
				{
					measurement: "AGENT_SPEND_USD",
					tags: { serviceId: "svc_api" },
					values: [{ ts: t0 / 1000, value: 1 }],
				},
				{
					measurement: "CPU_LIMIT",
					tags: { serviceId: "svc_new" },
					values: [{ ts: t0 / 1000, value: 8 }],
				},
			],
			{ startMs: t0, endMs: t0 + 60_000 },
		)
		assert.strictEqual(rows.length, 1)
		assert.strictEqual(rows[0]!.service_name, "svc_new")
		assert.strictEqual(rows[0]!.resource_attributes["railway.replica.id"], undefined)
	})
})
