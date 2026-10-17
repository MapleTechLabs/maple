import { labArea } from "./scenarios/lab.ts"
import { routesArea } from "./scenarios/routes.ts"
import { shellArea } from "./scenarios/shell.ts"
import type { AreaModule, Scenario } from "./scenarios/types.ts"

export * from "./scenarios/types.ts"

/** Every area module. Scenarios live in `src/scenarios/<area>.ts`; only this list is shared. */
export const areas: ReadonlyArray<AreaModule> = [labArea, routesArea, shellArea]

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
