import { Option, Predicate, Schema, Stream } from "effect"
import type { Command } from "foldkit"
import { Dom } from "foldkit"
import { baseKey } from "../data/keyed"
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

/**
 * The request key a fetch Command carries (S6: `args.key`), if any, without a superseding
 * re-read's generation: the read cache holds the entry under the plain request key.
 */
export const keyOfCommand = (command: PageCommand): Option.Option<string> =>
	Option.map(Option.filter(Option.fromNullishOr(command.args?.["key"]), Predicate.isString), baseKey)

const without = <A>(record: Readonly<Record<string, A>>, key: string): Record<string, A> =>
	Object.fromEntries(Object.entries(record).filter(([entryKey]) => entryKey !== key))

// INTENT

/** `enqueuePreload`: one timer per link; a second hover or focus of the same link waits on it. */
export const intended = (model: Model, href: string): Option.Option<{ model: Model; version: number }> =>
	model.intents[href] !== undefined
		? Option.none()
		: Option.some({
				model: {
					...model,
					version: model.version + 1,
					intents: { ...model.intents, [href]: model.version + 1 },
				},
				version: model.version + 1,
			})

/** `cancelPreload` on mouse leave or blur. */
export const ended = (model: Model, href: string): Model => ({
	...model,
	intents: without(model.intents, href),
})

/** The delay elapsed: `Some` when the link is still intended (the timer was not cancelled). */
export const elapsed = (model: Model, href: string, version: number): Option.Option<Model> =>
	model.intents[href] === version ? Option.some(ended(model, href)) : Option.none()

// HOLDING

/** The keys a page step's Commands request (S6: `args.key`). */
export const keysOf = (commands: ReadonlyArray<PageCommand>): ReadonlyArray<string> =>
	commands.flatMap((command) => Option.toArray(keyOfCommand(command)))

/** A `Keyed` slot's key: `{ key: string, data: AsyncData }`. */
const slotKeyOf = (value: { readonly [x: PropertyKey]: unknown }): Option.Option<string> => {
	const key = value["key"]
	const data = value["data"]
	return Predicate.isString(key) && Predicate.isReadonlyObject(data) && Predicate.isString(data["_tag"])
		? Option.some(baseKey(key))
		: Option.none()
}

/** The keys a page Model's `Keyed` slots stand on (their `data` is not walked: rows hold no slots). */
export const liveKeysOf = (value: unknown): ReadonlyArray<string> =>
	Array.isArray(value)
		? value.flatMap(liveKeysOf)
		: Predicate.isReadonlyObject(value)
			? Option.match(slotKeyOf(value), {
					onSome: (key) => [key],
					onNone: () => Object.values(value).flatMap(liveKeysOf),
				})
			: []

/**
 * A page step's keys join its instance's held keys. A new instance (`holder`) releases what the
 * previous one held and no longer asks for: the read cache starts their idle TTL, as an unmount does.
 * A step that asks for new keys also releases held keys no slot in `liveKeys` stands on any more
 * (a superseded window: the atom it read unmounted).
 */
export const held = (
	model: Model,
	holder: string,
	commands: ReadonlyArray<PageCommand>,
	/** Walks the page Model, so it is only called when the step asks for new keys. */
	liveKeys: () => ReadonlyArray<string> = () => [],
) => {
	const keys = keysOf(commands)
	const isSameHolder = holder === model.holder
	const added = keys.filter((key) => !model.heldKeys.includes(key))
	const isPruning = isSameHolder && added.length > 0
	const stillLive = (live: ReadonlyArray<string>) =>
		model.heldKeys.filter((key) => live.includes(key) || keys.includes(key))
	const kept = !isSameHolder ? [] : isPruning ? stillLive(liveKeys()) : model.heldKeys
	const heldKeys = [...kept, ...keys.filter((key) => !kept.includes(key))]
	const released = isSameHolder && !isPruning ? [] : model.heldKeys.filter((key) => !heldKeys.includes(key))
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

type Position = Readonly<{ x: number; y: number }>
type PointerSample = Readonly<{ x: number; y: number; href: string | null }>

/**
 * `onMouseEnter` needs a pointer that moved onto the link: one appearing under a resting pointer
 * (an overlay unmounting) gets a `mouseover` at the last position, which does not count.
 */
export const isPointerEntry = (last: Option.Option<Position>, x: number, y: number): boolean =>
	!Option.exists(last, (position) => position.x === x && position.y === y)

const pointerEntries: Stream.Stream<LinkIntent> = Stream.mergeAll(
	[
		Dom.streamFromEventFilterMap({
			target: () => document,
			type: "mousemove",
			filterMapEvent: (event) =>
				Option.some<PointerSample>({ x: event.clientX, y: event.clientY, href: null }),
		}),
		Dom.streamFromEventFilterMap({
			target: () => document,
			type: "mouseover",
			filterMapEvent: (event) =>
				Option.map(
					Option.filter(internalLink(event.target), (link) => !isInside(link, event.relatedTarget)),
					(link): PointerSample => ({ x: event.clientX, y: event.clientY, href: link.href }),
				),
		}),
	],
	{ concurrency: "unbounded" },
).pipe(
	Stream.mapAccum(
		() => Option.none<Position>(),
		(last, sample): readonly [Option.Option<Position>, ReadonlyArray<LinkIntent>] => [
			Option.some({ x: sample.x, y: sample.y }),
			sample.href !== null && isPointerEntry(last, sample.x, sample.y)
				? [intent(sample.href, false)]
				: [],
		],
	),
)

/** `onMouseEnter`/`onFocus` start a link's timer, `onMouseLeave`/`onBlur` cancel it, `onTouchStart` preloads now. */
export const linkIntents: Stream.Stream<LinkIntent> = Stream.mergeAll(
	[
		pointerEntries,
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
			filterMapEvent: (event) =>
				Option.map(internalLink(event.target), (link) => intent(link.href, false)),
		}),
		Dom.streamFromEventFilterMap({
			target: () => document,
			type: "focusout",
			filterMapEvent: (event) => Option.map(internalLink(event.target), (link) => end(link.href)),
		}),
		Dom.streamFromEventFilterMap({
			target: () => document,
			type: "touchstart",
			filterMapEvent: (event) =>
				Option.map(internalLink(event.target), (link) => intent(link.href, true)),
		}),
	],
	{ concurrency: "unbounded" },
)
