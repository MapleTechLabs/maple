import { readdirSync } from "node:fs"
import type { FixtureWarehouse } from "../backend/warehouse.ts"
import type { Dataset, EndpointHandler, SyncedRow, SyncedTableName } from "./dataset.ts"

/**
 * One product area's fixtures, in `src/fixtures/areas/<area>.ts` exporting `fixtureArea`.
 * Discovered at startup so area agents never edit a shared file.
 */
export interface FixtureArea {
	readonly area: string
	/** Built-in answers for every dataset (a dataset's own `endpoints` still win). */
	readonly endpoints?: (warehouse: FixtureWarehouse) => Readonly<Record<string, EndpointHandler>>
	/** Rows appended to the `default` dataset's Electric tables. */
	readonly defaultSynced?: Partial<Record<SyncedTableName, ReadonlyArray<SyncedRow>>>
	/** Extra datasets this area's scenarios use (names must be unique). */
	readonly datasets?: ReadonlyArray<Dataset>
	/** Routes outside the HttpApis (raw `HttpRouter` routes such as chat SSE), matched before them. */
	readonly rawRoutes?: ReadonlyArray<RawRoute>
}

/** A raw API route: `answer` returns `undefined` when the request is not this route's. */
export interface RawRoute {
	/** Call-log tag for a matched request. */
	readonly tag: string
	readonly answer: (request: { readonly dataset: Dataset; readonly url: URL; readonly method: string }) => Response | undefined
}

const isFixtureArea = (value: unknown): value is FixtureArea =>
	typeof value === "object" && value !== null && "area" in value

const loadFixtureAreas = async (): Promise<ReadonlyArray<FixtureArea>> => {
	const dir = new URL("./areas/", import.meta.url)
	const files = readdirSync(dir)
		.filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
		.sort()
	const modules = await Promise.all(files.map((file) => import(new URL(file, dir).href)))
	return modules.flatMap((module: Record<string, unknown>) =>
		isFixtureArea(module.fixtureArea) ? [module.fixtureArea] : [],
	)
}

export const fixtureAreas: ReadonlyArray<FixtureArea> = await loadFixtureAreas()

type SyncedTables = Partial<Record<SyncedTableName, ReadonlyArray<SyncedRow>>>

const mergeSynced = (into: SyncedTables, extra: SyncedTables): SyncedTables => {
	const merged: SyncedTables = { ...into }
	for (const [table, rows] of entries(extra)) merged[table] = [...(into[table] ?? []), ...rows]
	return merged
}

const entries = (tables: SyncedTables): ReadonlyArray<readonly [SyncedTableName, ReadonlyArray<SyncedRow>]> => {
	const out: Array<readonly [SyncedTableName, ReadonlyArray<SyncedRow>]> = []
	const push = (table: SyncedTableName) => {
		const rows = tables[table]
		if (rows !== undefined) out.push([table, rows])
	}
	push("api_keys")
	push("dashboards")
	push("alert_rules")
	push("alert_rule_states")
	push("alert_incidents")
	push("alert_destinations")
	push("alert_destinations_v2")
	push("investigation_v2")
	return out
}

/** `default` gains every area's `defaultSynced` rows; area datasets are appended. */
export const withFixtureAreas = (datasets: ReadonlyArray<Dataset>): ReadonlyArray<Dataset> => [
	...datasets.map((dataset) =>
		dataset.name !== "default"
			? dataset
			: fixtureAreas.reduce<Dataset>(
					(acc, area) => ({ ...acc, synced: mergeSynced(acc.synced, area.defaultSynced ?? {}) }),
					dataset,
				),
	),
	...fixtureAreas.flatMap((area) => area.datasets ?? []),
]

export const fixtureAreaRawRoutes: ReadonlyArray<RawRoute> = fixtureAreas.flatMap((area) => area.rawRoutes ?? [])

export const fixtureAreaEndpoints = (warehouse: FixtureWarehouse): ReadonlyMap<string, EndpointHandler> =>
	new Map(fixtureAreas.flatMap((area) => Object.entries(area.endpoints?.(warehouse) ?? {})))
