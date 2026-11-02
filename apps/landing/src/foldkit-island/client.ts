import { Effect, Schema } from "effect"
import { Runtime } from "foldkit"
import { isIsland } from "./island"

let mounts = 0

/**
 * Astro's client half, called once the island's `client:*` directive fires. Foldkit hydrates one
 * application per document, so the first client render replaces the server markup (one DOM swap)
 * instead of adopting it; `client:only` islands, which have no server markup, get an empty root.
 */
export default (element: HTMLElement) =>
	(component: unknown, props: unknown): Promise<void> => {
		if (!isIsland(component)) return Promise.resolve()
		const server = element.firstElementChild
		const container = server instanceof HTMLElement ? server : element.appendChild(document.createElement("div"))
		mounts += 1
		container.id = `${component.name}-${mounts}`
		return Effect.runPromise(
			component.use((config) =>
				Schema.decodeUnknownEffect(config.Props)(props).pipe(
					Effect.map((decoded) => {
						const handle = Runtime.embed(
							Runtime.makeElement({
								Model: config.Model,
								init: () => config.init(decoded),
								update: config.update,
								view: config.view,
								container,
								devTools: false,
							}),
						)
						element.addEventListener("astro:unmount", handle.dispose, { once: true })
					}),
				),
			),
		)
	}
