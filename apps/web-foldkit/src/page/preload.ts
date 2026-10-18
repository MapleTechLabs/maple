import { Option, Predicate, Schema, Stream } from "effect"
import type { Command } from "foldkit"
import { Dom } from "foldkit"
import type { Resources } from "../platform/resources"
import { PageMessage } from "./registry"

/**
 * Intent preload (s8-pages.md "Preload"): TanStack's `defaultPreload: "intent"`. A link hovered or
 * focused for `PRELOAD_DELAY_MS` runs the target page's `preload`, and the answers seed the page's
 * slots when it opens, so each request is sent once.
 */

/** TanStack's `defaultPreloadDelay`. */
export const PRELOAD_DELAY_MS = 50
/** `PRELOAD_HOLD_MS` in `lib/effect-router`: an unused answer is released after this. */
export const PRELOAD_HOLD_MS = 30_000

const Entry = Schema.Struct({
	/** The answer, once it arrived. */
	result: Schema.NullOr(PageMessage),
	/** The open page asked for this key while it was in flight: forward the answer to it. */
	isAwaited: Schema.Boolean,
})

export const Model = Schema.Struct({
	/** Links under the pointer or focus, by href, with the version their delay timer carries. */
	intents: Schema.Record(Schema.String, Schema.Number),
	version: Schema.Number,
	/** Preloaded requests by request key. */
	entries: Schema.Record(Schema.String, Entry),
	/** The open page instance (`tag:key:org`) and every key it requested, like a mounted atom. */
	holder: Schema.String,
	heldKeys: Schema.Array(Schema.String),
})
export type Model = typeof Model.Type

export const init = (): Model => ({ intents: {}, version: 0, entries: {}, holder: "", heldKeys: [] })

type PageCommand = Command.Command<PageMessage, never, Resources>

/** The request key a fetch Command carries (S6: `args.key`), if any. */
export const keyOfCommand = (command: PageCommand): Option.Option<string> =>
	Option.filter(Option.fromNullishOr(command.args?.["key"]), Predicate.isString)

/** The request key a page's result Message carries back. */
export const keyOfMessage = (message: PageMessage): Option.Option<string> =>
	Predicate.hasProperty(message.message, "key") && Predicate.isString(message.message.key)
		? Option.some(message.message.key)
		: Option.none()

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

// REQUESTS

/** Starts the page's preload: Commands whose key is already preloaded or held are not sent again. */
export const started = (model: Model, commands: ReadonlyArray<PageCommand>) => {
	const isFresh = (key: string) => model.entries[key] === undefined && !model.heldKeys.includes(key)
	const fresh = commands.filter((command) => Option.exists(keyOfCommand(command), isFresh))
	const keys = fresh.flatMap((command) => Option.toArray(keyOfCommand(command)))
	const pending = Object.fromEntries(keys.map((key) => [key, { result: null, isAwaited: false }]))
	return { model: { ...model, entries: { ...model.entries, ...pending } }, commands: fresh, keys }
}

/** A preloaded answer: kept for the page, or `forward`ed when the open page is waiting on it. */
export const answered = (model: Model, message: PageMessage) =>
	Option.flatMap(keyOfMessage(message), (key) =>
		Option.map(Option.fromNullishOr(model.entries[key]), (entry) =>
			entry.isAwaited
				? { model: { ...model, entries: without(model.entries, key) }, forward: Option.some(message) }
				: {
						model: {
							...model,
							entries: { ...model.entries, [key]: { ...entry, result: message } },
						},
						forward: Option.none<PageMessage>(),
					},
		),
	)

/** Answers handed over by a page: kept like settled preloads, except keys the open page holds. */
export const handedOff = (model: Model, messages: ReadonlyArray<PageMessage>) => {
	const fresh = messages.flatMap((message) =>
		Option.toArray(
			Option.map(
				Option.filter(keyOfMessage(message), (key) => !model.heldKeys.includes(key)),
				(key) => [key, { result: message, isAwaited: false }] as const,
			),
		),
	)
	return {
		model: { ...model, entries: { ...model.entries, ...Object.fromEntries(fresh) } },
		keys: fresh.map(([key]) => key),
	}
}

/** The hold elapsed: unused answers are dropped; one the page awaits stays until it lands. */
export const expired = (model: Model, keys: ReadonlyArray<string>): Model => ({
	...model,
	entries: Object.fromEntries(
		Object.entries(model.entries).filter(([key, entry]) => entry.isAwaited || !keys.includes(key)),
	),
})

/**
 * A page step's Commands against the preloads: a settled key is `delivered` instead of fetched, an
 * in-flight one is awaited, the rest run. `holder` names the page instance the keys belong to.
 */
export const seeded = (model: Model, holder: string, commands: ReadonlyArray<PageCommand>) => {
	const heldKeys = holder === model.holder ? model.heldKeys : []
	const keys = commands.flatMap((command) => Option.toArray(keyOfCommand(command)))
	const entryOf = (command: PageCommand) =>
		Option.flatMap(keyOfCommand(command), (key) =>
			Option.map(Option.fromNullishOr(model.entries[key]), (entry) => ({ key, entry })),
		)
	const preloaded = commands.flatMap((command) => Option.toArray(entryOf(command)))
	const delivered = preloaded.flatMap(({ entry }) => (entry.result === null ? [] : [entry.result]))
	const entries = Object.fromEntries(
		Object.entries(model.entries).flatMap(([key, entry]) => {
			const isPreloaded = preloaded.some((found) => found.key === key)
			if (!isPreloaded) return [[key, entry]]
			return entry.result === null ? [[key, { ...entry, isAwaited: true }]] : []
		}),
	)
	return {
		model: {
			...model,
			entries,
			holder,
			heldKeys: [...heldKeys, ...keys.filter((key) => !heldKeys.includes(key))],
		},
		commands: commands.filter((command) => Option.isNone(entryOf(command))),
		delivered,
	}
}

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
