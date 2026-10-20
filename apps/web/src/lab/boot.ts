import type { LabEntry } from "./define"

/**
 * One module per lab page in `./entries/<path>.ts` (`/lab/bench/logs` is `entries/bench/logs.ts`).
 * Lazy, so lab code never reaches the app's startup bundle.
 */
const entries = import.meta.glob<{ lab: LabEntry }>("./entries/**/*.ts")

export const labEnabled = import.meta.env.DEV || import.meta.env.VITE_MAPLE_LAB === "on"

/** `/lab` itself is the index entry (`entries/index.ts`). */
export const labPathOf = (pathname: string): string | undefined => {
	const match = pathname.match(/^\/lab(?:\/(.+?))?\/?$/)
	return match === null ? undefined : (match[1] ?? "index")
}

/** Every lab page's path, `/lab/bench/logs` for `entries/bench/logs.ts`, read without loading any. */
export const labEntryPaths = (): ReadonlyArray<string> =>
	Object.keys(entries)
		.filter((key) => !key.endsWith(".test.ts"))
		.map((key) => key.replace(/^\.\/entries/, "/lab").replace(/\.ts$/, ""))

export const startLab = (path: string, container: HTMLElement): Promise<void> => {
	const load = entries[`./entries/${path}.ts`]
	if (load === undefined) {
		container.textContent = `Unknown lab page: ${path}. Known: ${Object.keys(entries).join(", ")}`
		return Promise.resolve()
	}
	return load().then((module) => module.lab.start(container))
}
