import { describe, expect, it } from "vitest"
import type { GcpSqlInstanceData } from "./api"
import { gcpSqlSettings } from "./cloud-sql"

const instance = (name: string, data: Partial<GcpSqlInstanceData> = {}) => ({
	name: `//cloudsql.googleapis.com/projects/acme-prod/instances/${name}`,
	data: { name, project: "acme-prod", databaseVersion: "POSTGRES_15", ...data },
})

describe("gcpSqlSettings", () => {
	it("reads the size off the tier and PostgreSQL's default connection limit for it", () => {
		const [[name, settings]] = gcpSqlSettings([
			instance("orders-db", {
				settings: {
					tier: "db-custom-4-16384",
					edition: "ENTERPRISE",
					availabilityType: "REGIONAL",
					dataDiskSizeGb: "100",
					insightsConfig: { queryInsightsEnabled: true },
				},
			}),
		])
		expect(name).toBe("//cloudsql.googleapis.com/projects/acme-prod/instances/orders-db")
		expect(settings).toEqual({
			databaseVersion: "POSTGRES_15",
			edition: "ENTERPRISE",
			tier: "db-custom-4-16384",
			cpus: 4,
			memoryGb: 16,
			availabilityType: "REGIONAL",
			primary: null,
			diskSizeGb: 100,
			queryInsightsEnabled: true,
			maxConnections: 500,
			maxConnectionsSource: "default",
		})
	})

	it("takes the max_connections flag over the default", () => {
		const [[, settings]] = gcpSqlSettings([
			instance("orders-db", {
				settings: {
					tier: "db-custom-1-3840",
					databaseFlags: [{ name: "max_connections", value: "250" }],
				},
			}),
		])
		expect(settings).toMatchObject({ maxConnections: 250, maxConnectionsSource: "flag" })
	})

	it("gives a small replica its larger primary's default", () => {
		const settings = new Map(
			gcpSqlSettings([
				instance("orders-db", { settings: { tier: "db-custom-8-32768" } }),
				instance("orders-db-replica", {
					masterInstanceName: "acme-prod:orders-db",
					settings: { tier: "db-custom-1-3840" },
				}),
			]).map(([name, value]) => [name.slice(name.lastIndexOf("/") + 1), value]),
		)
		expect(settings.get("orders-db-replica")).toMatchObject({
			primary: "acme-prod:orders-db",
			memoryGb: 3.75,
			maxConnections: 600,
		})
	})

	it("knows no limit for an unknown tier or another engine", () => {
		const settings = gcpSqlSettings([
			instance("custom", { settings: { tier: "db-unknown-2" } }),
			instance("mysql", { databaseVersion: "MYSQL_8_0", settings: { tier: "db-custom-2-7680" } }),
		]).map(([, value]) => [value.cpus, value.maxConnections, value.maxConnectionsSource])
		expect(settings).toEqual([
			[null, null, null],
			[2, null, null],
		])
	})
})
