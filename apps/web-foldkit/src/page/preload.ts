import { Option, Predicate, Schema, Stream } from "effect"
import type { Command } from "foldkit"
import { Dom } from "foldkit"
import type { Resources } from "../platform/resources"
import type { PageMessage } from "./registry"

/**
 * Intent preload (s8-pages.md "Preload"): TanStack's `defaultPreload: "intent"`. A link hovered or
 * focused for `PRELOAD_DELAY_MS` runs the target page's `preload`. Its Commands read through the
 * `ReadCache` (s6 "Read cache"), so the opening page joins or reuses those reads: one request each.
 */

/** TanStack's `defaultPreloadDelay`. */
export const PRELOAD_DELAY_MS = 50
/** `PRELOAD_HOLD_MS` in `lib/effect-router`: an unused preload is released after this. */
export const PRELOAD_HOLD_MS = 30_000

export const Model = Schema.Struct({
	/** Links under the pointer or focus, by href, with the version their delay timer carries. */
	intents: Schema.Record(Schema.String, Schema.Number),
	version: Schema.Number,
	/** The open page instance (`tag:key:org`) and every key it requested, like a mounted atom. */
	holder: Schema.String,
	heldKeys: Schema.Array(Schema.String),
})
export type Model = typeof Model.Type

export const init = (): Model => ({ intents: {}, version: 0, holder: "", heldKeys: [] })

type PageCommand = Command.Command<PageMessage, never, Resources>

/** The request key a fetch Command carries (S6: `args.key`), if any. */
export const keyOfCommand = (command: PageCommand): Option.Option<string> =>
	Option.filter(Option.fromNullishOr(command.args?.["key"]), Predicate.isString)

const without = <A>(record: Readonly<Record<string, A>>, key: string): Record<string, A> =>
	Object.fromEntries(Object.entries(record).filter(([entryKey]) => entryKey !== key))

// INTENT

/** `enqueuePreload`: one timer per link; a second hover or focus of the same link waits on it. */
export const intended = (model: Model, href: string): Option.Option<{ model: Model; version: number }> =>
	model.intents[href] !== undefined
		? Option.none()
		: Option.some({
				model: { ...model, version: model.version + 1, intents: { ...model.intents, [href]: model.version + 1 } },
				version: model.version + 1,
			})

/** `cancelPreload` on mouse leave or blur. */
export const ended = (model: Model, href: string): Model => ({ ...model, intents: without(model.intents, href) })

/** The delay elapsed: `Some` when the link is still intended (the timer was not cancelled). */
export const elapsed = (model: Model, href: string, version: number): Option.Option<Model> =>
	model.intents[href] === version ? Option.some(ended(model, href)) : Option.none()

// HOLDING

/** The keys a page step's Commands request (S6: `args.key`). */
export const keysOf = (commands: ReadonlyArray<PageCommand>): ReadonlyArray<string> =>
	commands.flatMap((command) => Option.toArray(keyOfCommand(command)))

/**
 * A page step's keys join its instance's held keys. A new instance (`holder`) releases what the
 * previous one held and no longer asks for: the read cache starts their idle TTL, as an unmount does.
 */
export const held = (model: Model, holder: string, commands: ReadonlyArray<PageCommand>) => {
	const keys = keysOf(commands)
	const isSameHolder = holder === model.holder
	const kept = isSameHolder ? model.heldKeys : []
	const heldKeys = [...kept, ...keys.filter((key) => !kept.includes(key))]
	const released = isSameHolder ? [] : model.heldKeys.filter((key) => !heldKeys.includes(key))
	return { model: { ...model, holder, heldKeys }, released, isNewHolder: !isSameHolder }
}

/** The hold elapsed: the preloaded keys the open page does not hold are released. */
export const expired = (model: Model, keys: ReadonlyArray<string>): ReadonlyArray<string> =>
	keys.filter((key) => !model.heldKeys.includes(key))

// LINK INTENT

export type LinkIntent =
	| { readonly _tag: "Intended"; readonly href: string; readonly isImmediate: boolean }
	| { readonly _tag: "Ended"; readonly href: string }

/** A link a router `<Link>` would preload: same origin, same tab, not a download. */
const internalLink = (target: EventTarget | null): Option.Option<HTMLAnchorElement> =>
	target instanceof Element
		? Option.filter(
				Option.fromNullishOr(target.closest("a")),
				(link) =>
					link.href !== "" &&
					(link.target === "" || link.target === "_self") &&
					!link.hasAttribute("download") &&
					new URL(link.href).origin === window.location.origin,
			)
		: Option.none()

const isInside = (link: Element, node: EventTarget | null) => node instanceof Node && link.contains(node)

const intent = (href: string, isImmediate: boolean): LinkIntent => ({ _tag: "Intended", href, isImmediate })
const end = (href: string): LinkIntent => ({ _tag: "Ended", href })

/** `onMouseEnter`/`onFocus` start a link's timer, `onMouseLeave`/`onBlur` cancel it, `onTouchStart` preloads now. */
export const linkIntents: Stream.Stream<LinkIntent> = Stream.mergeAll(
	[
		Dom.streamFromEventFilterMap({
			target: () => document,
			type: "mouseover",
			filterMapEvent: (event) =>
				Option.map(
					Option.filter(internalLink(event.target), (link) => !isInside(link, event.relatedTarget)),
					(link) => intent(link.href, false),
				),
		}),
		Dom.streamFromEventFilterMap({
			target: () => document,
			type: "mouseout",
			filterMapEvent: (event) =>
				Option.map(
					Option.filter(internalLink(event.target), (link) => !isInside(link, event.relatedTarget)),
					(link) => end(link.href),
				),
		}),
		Dom.streamFromEventFilterMap({
			target: () => document,
			type: "focusin",
			filterMapEvent: (event) => Option.map(internalLink(event.target), (link) => intent(link.href, false)),
		}),
		Dom.streamFromEventFilterMap({
			target: () => document,
			type: "focusout",
			filterMapEvent: (event) => Option.map(internalLink(event.target), (link) => end(link.href)),
		}),
		Dom.streamFromEventFilterMap({
			target: () => document,
			type: "touchstart",
			filterMapEvent: (event) => Option.map(internalLink(event.target), (link) => intent(link.href, true)),
		}),
	],
	{ concurrency: "unbounded" },
)
