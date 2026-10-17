import type { LabEntry } from "./define"

/**
 * One module per lab page in `./entries/<path>.ts` (`/lab/bench/logs` is `entries/bench/logs.ts`).
 * Lazy, so lab code never reaches the app's startup bundle.
 */
const entries = import.meta.glob<{ lab: LabEntry }>("./entries/**/*.ts")

export const labEnabled = import.meta.env.DEV || import.meta.env.VITE_MAPLE_LAB === "on"

export const labPathOf = (pathname: string): string | undefined =>
	pathname.match(/^\/lab\/(.+?)\/?$/)?.[1]

export const startLab = (path: string, container: HTMLElement): Promise<void> => {
	const load = entries[`./entries/${path}.ts`]
	if (load === undefined) {
		container.textContent = `Unknown lab page: ${path}. Known: ${Object.keys(entries).join(", ")}`
		return Promise.resolve()
	}
	return load().then((module) => module.lab.start(container))
}
