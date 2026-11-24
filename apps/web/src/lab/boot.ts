import type { LabEntry } from "./define"
import { Array as Arr, Option, Record as Rec, String as Str } from "effect"

export const labEnabled = import.meta.env.DEV || import.meta.env.VITE_MAPLE_LAB === "on"

/**
 * One module per lab page in `./entries/<path>.ts` (`/lab/bench/logs` is `entries/bench/logs.ts`).
 * Lazy, and empty when the lab is off, so neither lab code nor its loader map reach a prod build.
 */
const entries: Record<string, () => Promise<{ lab: LabEntry }>> = labEnabled
	? import.meta.glob<{ lab: LabEntry }>("./entries/**/*.ts")
	: {}

/** `/lab` itself is the index entry (`entries/index.ts`). */
export const labPathOf = (pathname: string): string | undefined => {
	return Option.getOrUndefined(
		Option.map(Str.match(/^\/lab(?:\/(.+?))?\/?$/)(pathname), (match) => match[1] ?? "index"),
	)
}

/** Every lab page's path, `/lab/bench/logs` for `entries/bench/logs.ts`, read without loading any. */
export const labEntryPaths = (): ReadonlyArray<string> =>
	Arr.map(
		Arr.filter(Rec.keys(entries), (key) => !Str.endsWith(".test.ts")(key)),
		(key) => Str.replace(/\.ts$/, "")(Str.replace(/^\.\/entries/, "/lab")(key)),
	)

export const startLab = (path: string, container: HTMLElement): Promise<void> => {
	const load = entries[`./entries/${path}.ts`]
	if (load === undefined) {
		container.textContent = `Unknown lab page: ${path}. Known: ${Arr.join(Rec.keys(entries), ", ")}`
		return Promise.resolve()
	}
	return load().then((module) => module.lab.start(container))
}
