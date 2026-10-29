import { Runtime } from "foldkit"
import type { Program } from "foldkit"

/**
 * A lab entry is a self-contained Foldkit program booted on `/lab/<path>` instead of the app,
 * mirroring `apps/web/src/lab`. Closing over the program keeps it typed; the registry holds `start`.
 */
export interface LabEntry {
	readonly title: string
	readonly start: (container: HTMLElement) => void
}

/**
 * Boots the Program `makeElement(container)` returns: `Program.makeElement` over the lab's root
 * Block (with `Flags` and `flags` when it reads the browser before init), then `.provide(ResourcesLive)`.
 */
export const defineLab = <Provided>(
	title: string,
	makeElement: (container: HTMLElement) => Program.Runnable<undefined, void, Provided, "Element">,
): LabEntry => ({
	title,
	start: (container) => {
		Runtime.run(makeElement(container))
	},
})
