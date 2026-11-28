import { describe, expect, it } from "vitest"
import { Array as Arr, Option, Record as Rec } from "effect"
import { tinybirdProjectManifest } from "@maple/domain/generated/tinybird-project-manifest"
import {
	DEFAULT_RETENTION_DAYS,
	RETENTION_SIGNAL_DATASOURCES,
	RETENTION_SIGNALS,
} from "@maple/domain/retention"
import { DEFAULT_READ_HORIZON } from "@maple/backend/services/retention/RetentionService"
import { listTrustedReadDatasourceNames } from "@maple/backend/services/warehouse/warehouse-catalog"
import {
	READ_HORIZON_TABLES,
	readBoundsOf,
	readHorizonKey,
	TRACE_PROJECTION_TIME_COLUMNS,
} from "./tinybird-read-horizon"

const manifestContent = (datasource: string): string | undefined =>
	Option.getOrUndefined(
		Option.map(
			Arr.findFirst(tinybirdProjectManifest.datasources, (candidate) => candidate.name === datasource),
			(found) => found.content,
		),
	)

const boundsOf = (horizon: Parameters<typeof readBoundsOf>[0]) =>
	Option.map(readBoundsOf(horizon), (bounds) => Rec.fromEntries(bounds))

describe("read horizon tables", () => {
	it("bound each datasource by the column its own expiry is keyed on", () => {
		for (const table of READ_HORIZON_TABLES) {
			expect(manifestContent(table.datasource), table.datasource).toContain(
				`ENGINE_TTL "toDate(${table.column}) + `,
			)
		}
	})

	it("are all datasources the org token can list", () => {
		const listed = listTrustedReadDatasourceNames()
		expect(Arr.filter(READ_HORIZON_TABLES, (table) => !Arr.contains(listed, table.datasource))).toEqual(
			[],
		)
	})

	it("cover every raw table of every signal, and the trace projections under traces", () => {
		const tablesOf = (signal: string) =>
			Arr.map(
				Arr.filter(READ_HORIZON_TABLES, (table) => table.signal === signal),
				(table) => table.datasource,
			)
		expect(tablesOf("metrics")).toEqual([...RETENTION_SIGNAL_DATASOURCES.metrics])
		expect(tablesOf("traces")).toEqual([
			...RETENTION_SIGNAL_DATASOURCES.traces,
			...Rec.keys(TRACE_PROJECTION_TIME_COLUMNS),
		])
	})
})

describe("readBoundsOf", () => {
	it("bounds nothing for an organization that never set retention", () => {
		expect(boundsOf(DEFAULT_READ_HORIZON)).toEqual(Option.some({}))
	})

	it("bounds every raw table at its signal's horizon once the organization has a policy", () => {
		const bounds = Option.getOrThrow(
			boundsOf({ days: DEFAULT_RETENTION_DAYS, configured: RETENTION_SIGNALS }),
		)
		expect([bounds.logs, bounds.metrics_sum, bounds.profiles]).toEqual([
			{ column: "TimestampTime", days: DEFAULT_RETENTION_DAYS.logs },
			{ column: "TimeUnix", days: DEFAULT_RETENTION_DAYS.metrics },
			{ column: "Timestamp", days: DEFAULT_RETENTION_DAYS.profiles },
		])
	})

	it("bounds the raw tables of a bounded signal, and no other signal's", () => {
		expect(
			boundsOf({ days: { ...DEFAULT_RETENTION_DAYS, logs: 7, metrics: 400 }, configured: ["logs"] }),
		).toEqual(Option.some({ logs: { column: "TimestampTime", days: 7 } }))
	})

	it("bounds traces and each of its projections by its own column", () => {
		expect(boundsOf({ days: { ...DEFAULT_RETENTION_DAYS, traces: 7 }, configured: ["traces"] })).toEqual(
			Option.some({
				traces: { column: "Timestamp", days: 7 },
				trace_index: { column: "Bucket", days: 7, bucketMinutes: 5 },
				trace_list_mv: { column: "Timestamp", days: 7 },
				service_map_spans: { column: "Timestamp", days: 7 },
				service_map_children: { column: "Timestamp", days: 7 },
				service_overview_spans: { column: "Timestamp", days: 7 },
				ai_trace_index: { column: "Timestamp", days: 7 },
				ai_crawler_requests: { column: "Timestamp", days: 7 },
				scanner_requests: { column: "Timestamp", days: 7 },
			}),
		)
	})

	it.each([
		["a fraction of a day", 7.5],
		["no days", 0],
		["not a number", Number.NaN],
	])("refuses a period of %s instead of writing it into a filter", (_name, days) => {
		expect(
			readBoundsOf({ days: { ...DEFAULT_RETENTION_DAYS, traces: days }, configured: ["traces"] }),
		).toEqual(Option.none())
	})
})

describe("readHorizonKey", () => {
	it("is the same for every organization that set nothing", () => {
		expect(readHorizonKey(DEFAULT_READ_HORIZON)).toBe("")
	})

	it("changes with the period and with which signals are set", () => {
		const horizon = (traces: number, configured: ReadonlyArray<"traces" | "logs">) => ({
			days: { ...DEFAULT_RETENTION_DAYS, traces },
			configured,
		})
		const keys = [
			readHorizonKey(horizon(7, ["traces"])),
			readHorizonKey(horizon(8, ["traces"])),
			readHorizonKey(horizon(7, ["traces", "logs"])),
			readHorizonKey(DEFAULT_READ_HORIZON),
		]
		expect(Arr.dedupe(keys)).toHaveLength(keys.length)
	})
})
