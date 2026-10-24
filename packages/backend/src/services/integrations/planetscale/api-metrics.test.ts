import { describe, expect, it } from "vitest"
import { apiMetricRows, type ApiMetricBranch, type ApiMetricSeries } from "./api-metrics"

const postgres: ApiMetricBranch = {
	organization: "acme",
	database: "ledger",
	kind: "postgresql",
	branch: "main",
	branchId: "br_1",
	serviceName: "PlanetScale (acme)",
}

const T0 = 1_792_797_840
const window = { fromSeconds: T0, untilSeconds: T0 + 60 }

const valuesOf = (rows: ReturnType<typeof apiMetricRows>, name: string) =>
	rows.filter((row) => row.metric_name === name).map((row) => row.value)

describe("apiMetricRows", () => {
	it("lands Postgres branch metrics under the names the infra queries read", () => {
		const response: ApiMetricSeries = {
			series: [
				{ metric: "planetscale_pods_cpu_util_percentages", label: "CPU usage", points: [[T0, 5.1]] },
				{
					metric: "planetscale_pgbouncer_current_connections",
					label: "Connections",
					points: [[T0, 7]],
				},
				{ metric: "planetscale_replica_lag_seconds", label: "replica-a", points: [[T0, 0.4]] },
				{ metric: "planetscale_replica_lag_seconds", label: "replica-b", points: [[T0, 1.2]] },
			],
		}
		const rows = apiMetricRows(postgres, response, window)

		expect(valuesOf(rows, "planetscale_pods_cpu_util_percentages")).toEqual([5.1])
		expect(valuesOf(rows, "planetscale_api_connections")).toEqual([7])
		const lag = rows.filter((row) => row.metric_name === "planetscale_postgres_replica_lag_seconds")
		expect(lag.map((row) => [row.metric_attributes.planetscale_series, row.value])).toEqual([
			["replica-a", 0.4],
			["replica-b", 1.2],
		])
		expect(rows[0]?.metric_attributes).toMatchObject({
			planetscale_database_name: "ledger",
			planetscale_branch_name: "main",
			planetscale_database_branch_id: "br_1",
			planetscale_organization_name: "acme",
		})
		expect(rows[0]?.service_name).toBe("PlanetScale (acme)")
	})

	it("derives volume capacity and free space from used bytes and used percent", () => {
		// A real branch: 2507161600 bytes used at 23.3497...% of a 10 GiB volume.
		const rows = apiMetricRows(
			postgres,
			{
				series: [
					{
						metric: "planetscale_storage_usage_bytes",
						label: "Storage",
						points: [[T0, 2_507_161_600]],
					},
					{
						metric: "planetscale_volume_usage_percentages",
						label: "Disk usage",
						points: [[T0, 23.349761962890625]],
					},
				],
			},
			window,
		)

		expect(valuesOf(rows, "planetscale_volume_capacity_bytes")).toEqual([10_737_418_240])
		expect(valuesOf(rows, "planetscale_volume_available_bytes")).toEqual([10_737_418_240 - 2_507_161_600])
		expect(valuesOf(rows, "planetscale_storage_usage_bytes")).toEqual([])
	})

	it("keeps only points inside the window that carry a value", () => {
		const rows = apiMetricRows(
			{ ...postgres, kind: "mysql" },
			{
				series: [
					{
						metric: "connections",
						label: "Connections",
						points: [
							[T0 - 60, 1],
							[T0, 2],
							[T0 + 60, null],
							[T0 + 120, 4],
						],
					},
				],
			},
			window,
		)

		expect(valuesOf(rows, "planetscale_api_connections")).toEqual([2])
	})
})
