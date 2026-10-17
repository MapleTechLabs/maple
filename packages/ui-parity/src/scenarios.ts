import { readdirSync } from "node:fs"
import type { AreaModule, Scenario } from "./scenarios/types.ts"

export * from "./scenarios/types.ts"

const isAreaModule = (value: unknown): value is AreaModule =>
	typeof value === "object" && value !== null && "area" in value && "scenarios" in value

/** Every `AreaModule` exported from `src/scenarios/<area>.ts`, discovered so area files never share an edit. */
const loadAreas = async (): Promise<ReadonlyArray<AreaModule>> => {
	const dir = new URL("./scenarios/", import.meta.url)
	const files = readdirSync(dir)
		.filter((file) => file.endsWith(".ts") && file !== "types.ts" && !file.endsWith(".test.ts"))
		.sort()
	const modules = await Promise.all(files.map((file) => import(new URL(file, dir).href)))
	return modules.flatMap((module: Record<string, unknown>) => Object.values(module).filter(isAreaModule))
}

export const areas: ReadonlyArray<AreaModule> = await loadAreas()

const uniqueBy = <A>(items: ReadonlyArray<A>, key: (item: A) => string, kind: string) => {
	const seen = new Set<string>()
	for (const item of items) {
		if (seen.has(key(item))) throw new Error(`ui-parity: duplicate ${kind} "${key(item)}"`)
		seen.add(key(item))
	}
	return items
}

export const scenarios: ReadonlyArray<Scenario> = uniqueBy(
	areas.flatMap((area) => area.scenarios),
	(scenario) => scenario.id,
	"scenario",
)
