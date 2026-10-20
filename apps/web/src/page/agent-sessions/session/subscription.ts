import { isDialogOpen, isEditableTarget } from "@maple/ui/lib/keyboard"
import { Option, Schema, Stream } from "effect"
import { AsyncData, Dom, Subscription } from "foldkit"
import type { PageSubscriptionInput } from "../../contract"
import { viewOf } from "./derive"
import { Message } from "./message"
import type { SpanKey } from "./navigation"
import type { Model, SessionView } from "./model"

// The `session.view*` hotkeys: 1/2/3/4 switch views from anywhere on the page.

const VIEW_KEYS = new Map<string, SessionView>([
	["1", "overview"],
	["2", "trace"],
	["3", "flow"],
	["4", "transcript"],
])

const viewKeys: Stream.Stream<Message> = Dom.streamFromEventFilterMapPreventDefault({
	target: () => document,
	type: "keydown",
	filterMapEvent: (event) => {
		const view = VIEW_KEYS.get(event.key)
		if (view === undefined || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey)
			return Option.none()
		if (isEditableTarget(event.target) || isDialogOpen()) return Option.none()
		return Option.some(Message.PressedViewKey({ view }))
	},
})

const SPAN_KEYS = new Map<string, SpanKey>([
	["j", "Next"],
	["J", "Next"],
	["ArrowDown", "Next"],
	["k", "Previous"],
	["K", "Previous"],
	["ArrowUp", "Previous"],
	["Enter", "Open"],
	["Escape", "Escape"],
])

const isInteractiveTarget = (target: EventTarget | null): boolean =>
	target instanceof HTMLElement &&
	target.closest("button, a, [role='button'], [role='menuitem'], [role='option']") !== null

/** The waterfall's `useListNavigation`: suspended while a dialog owns the keyboard. */
const spanKeys: Stream.Stream<Message> = Dom.streamFromEventFilterMap({
	target: () => document,
	type: "keydown",
	filterMapEvent: (event) => {
		const key = SPAN_KEYS.get(event.key)
		if (key === undefined || event.metaKey || event.ctrlKey || event.altKey) return Option.none()
		if ((key === "Next" || key === "Previous") && event.shiftKey) return Option.none()
		if (isEditableTarget(event.target) || isDialogOpen()) return Option.none()
		if (key === "Open" && isInteractiveTarget(event.target)) return Option.none()
		// j/k and the arrows are taken from the page; Enter and Escape are left to bubble.
		if (key === "Next" || key === "Previous" || key === "Open") event.preventDefault()
		return Option.some(Message.PressedSpanKey({ key }))
	},
})

export const subscriptions = Subscription.make<PageSubscriptionInput<Model>, Message>()((entry) => ({
	spanKeys: entry(
		{ isWaterfall: Schema.Boolean },
		{
			modelToDependencies: ({ model }) => ({
				isWaterfall:
					viewOf(model.search.view) === "trace" &&
					Option.exists(AsyncData.getData(model.firstPage.data), (page) => page.data.length > 0),
			}),
			dependenciesToStream: ({ isWaterfall }) => (isWaterfall ? spanKeys : Stream.empty),
		},
	),
	/** Only once the views are on the page: the loading and not-found states have no switcher. */
	viewKeys: entry(
		{ hasViews: Schema.Boolean },
		{
			modelToDependencies: ({ model }) => ({
				hasViews: Option.exists(
					AsyncData.getData(model.firstPage.data),
					(page) => page.data.length > 0,
				),
			}),
			dependenciesToStream: ({ hasViews }) => (hasViews ? viewKeys : Stream.empty),
		},
	),
}))
