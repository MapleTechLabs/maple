import { Effect, Schema } from "effect"
import { renderToString } from "foldkit/experimental/server"
import { isIsland } from "./island"

/**
 * Astro's server half: the island's first view as static markup (nothing hydrates it; the
 * client entry replaces it with a live tree built from the same props).
 */
const check = (component: unknown): Promise<boolean> => Promise.resolve(isIsland(component))

const renderToStaticMarkup = (component: unknown, props: unknown): Promise<{ html: string }> =>
	isIsland(component)
		? Effect.runPromise(
				component.use((config) =>
					Schema.decodeUnknownEffect(config.Props)(props).pipe(
						Effect.flatMap((decoded) =>
							renderToString(
								{
									init: () => config.init(decoded),
									view: (model, h) => ({ title: "", body: config.view(model, h) }),
								},
								{ isHydratable: false },
							),
						),
						Effect.map(({ html }) => ({ html })),
					),
				),
			)
		: Promise.resolve({ html: "" })

export default { name: "foldkit-island", check, renderToStaticMarkup }
