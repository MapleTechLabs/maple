import { Predicate, type Schema } from "effect"
import type { Runtime, Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"

/**
 * A Foldkit program an `.astro` file uses like a component: `<Island prop={..} client:visible />`.
 * The server renders `view(init(props))` to markup, the browser starts the same program over it.
 */
export type IslandConfig<Model, Message extends { readonly _tag: string }, Props> = Readonly<{
	name: string
	Props: Schema.Decoder<Props>
	Model: Schema.Codec<Model, unknown, unknown, unknown>
	init: (props: Props) => Update.Return<Model, Message>
	update: (model: Model, message: Message) => Update.Return<Model, Message>
	view: (model: Model, h: HtmlBuilder<Message>) => Html
	/** Renders the browser should animate between (`document.startViewTransition`). */
	viewTransition?: Runtime.ViewTransitionConfig<Model, Message>
}>

/** What the renderer holds: a program whose types it only needs to keep consistent. */
export type Island = Readonly<{
	kind: typeof ISLAND_KIND
	name: string
	use: <R>(
		f: <Model, Message extends { readonly _tag: string }, Props>(
			config: IslandConfig<Model, Message, Props>,
		) => R,
	) => R
}>

const ISLAND_KIND = "maple.foldkit-island"

export const makeIsland = <Model, Message extends { readonly _tag: string }, Props>(
	config: IslandConfig<Model, Message, Props>,
): Island => ({ kind: ISLAND_KIND, name: config.name, use: (f) => f(config) })

/** The one Message of an island that never updates. */
export type StaticMessage = Readonly<{ _tag: "Static" }>

/** An island with nothing to click: its props are its model. Use it without a `client:*` directive. */
export const makeStaticIsland = <Props>(
	config: Readonly<{
		name: string
		Props: Schema.Decoder<Props> & Schema.Codec<Props, unknown, unknown, unknown>
		view: (props: Props, h: HtmlBuilder<StaticMessage>) => Html
	}>,
): Island =>
	makeIsland<Props, StaticMessage, Props>({
		name: config.name,
		Props: config.Props,
		Model: config.Props,
		init: (props) => ({ model: props }),
		update: (model) => ({ model }),
		view: config.view,
	})

export const isIsland = (value: unknown): value is Island =>
	Predicate.hasProperty(value, "kind") && value.kind === ISLAND_KIND && Predicate.hasProperty(value, "use")
