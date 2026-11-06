import { isDialogOpen, isEditableTarget } from "@maple/ui/lib/keyboard"
import { Option, Schema, Stream } from "effect"
import { Dom, Subscription } from "foldkit"
import type { PageSubscriptionInput } from "../../contract"
import { MOBILE_QUERY } from "./command"
import { Message } from "./message"
import type { Model } from "./model"
import { allRows } from "./update"

// `useListNavigation` over the rows and `TracePeekSheet`'s keys (↑/↓/J/K step, Enter opens the
// page): document keys while no field has focus. The peek's keys work with its sheet open.

const KEYS = new Set(["j", "J", "k", "K", "ArrowDown", "ArrowUp", "Enter", "Escape", "f", "F"])

/** A focused control keeps its own Enter (`keepsEnter`). */
const keepsEnter = (target: EventTarget | null): boolean => {
	if (!(target instanceof HTMLElement)) return false
	const control = target.closest("a, button, [role='tab'], [role='menuitem'], [role='option'], tr")
	return control instanceof HTMLElement && control.tabIndex >= 0
}

const keys = (isPeeking: boolean): Stream.Stream<Message> =>
	Dom.streamFromEventFilterMapPreventDefault({
		target: () => document,
		type: "keydown",
		filterMapEvent: (event) => {
			if (!KEYS.has(event.key) || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey)
				return Option.none()
			if (isEditableTarget(event.target)) return Option.none()
			if (event.key === "Enter" && keepsEnter(event.target)) return Option.none()
			// The sheet's Escape is the Dialog's; without a peek, a dialog owns the keyboard.
			if (isPeeking ? event.key === "Escape" : isDialogOpen()) return Option.none()
			const isMobile = window.matchMedia(MOBILE_QUERY).matches
			return Option.some(Message.PressedListKey({ key: event.key, isMobile }))
		},
	})

export const subscriptions = Subscription.make<PageSubscriptionInput<Model>, Message>()((entry) => ({
	listKeys: entry(
		{ hasRows: Schema.Boolean, isPeeking: Schema.Boolean },
		{
			modelToDependencies: ({ model }) => ({
				hasRows: allRows(model).length > 0,
				isPeeking: model.search.peek !== undefined,
			}),
			dependenciesToStream: ({ hasRows, isPeeking }) =>
				hasRows || isPeeking ? keys(isPeeking) : Stream.empty,
		},
	),
}))
