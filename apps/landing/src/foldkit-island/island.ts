import { Predicate, type Schema } from "effect"
import type { Update } from "foldkit"
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
}>

/** What the renderer holds: a program whose types it only needs to keep consistent. */
export type Island = Readonly<{
	kind: typeof ISLAND_KIND
	name: string
	use: <R>(f: <Model, Message extends { readonly _tag: string }, Props>(config: IslandConfig<Model, Message, Props>) => R) => R
}>

const ISLAND_KIND = "maple.foldkit-island"

export const makeIsland = <Model, Message extends { readonly _tag: string }, Props>(
	config: IslandConfig<Model, Message, Props>,
): Island => ({ kind: ISLAND_KIND, name: config.name, use: (f) => f(config) })

export const isIsland = (value: unknown): value is Island =>
	Predicate.hasProperty(value, "kind") && value.kind === ISLAND_KIND && Predicate.hasProperty(value, "use")
