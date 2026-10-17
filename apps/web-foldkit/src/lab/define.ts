import { Runtime } from "foldkit"
import { type Resources, ResourcesLive } from "../platform/resources"

/**
 * A lab entry is a self-contained Foldkit program booted on `/lab/<path>` instead of the app,
 * mirroring `apps/web/src/lab`. Closing over the program keeps it typed; the registry holds `start`.
 */
export interface LabEntry {
	readonly title: string
	readonly start: (container: HTMLElement) => void
}

export const defineLab = <Model, Message extends { _tag: string }>(
	title: string,
	program: Omit<Runtime.ElementConfig<Model, Message, Resources>, "container" | "resources">,
): LabEntry => ({
	title,
	start: (container) => {
		Runtime.run(Runtime.makeElement<Model, Message, Resources>({ ...program, container, resources: ResourcesLive }))
	},
})
