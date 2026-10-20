import { isDialogOpen, isEditableTarget } from "@maple/ui/lib/keyboard"
import { Option, Schema, Stream } from "effect"
import { Dom, Subscription } from "foldkit"
import type { PageSubscriptionInput } from "../../contract"
import { listStatusOf } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"

// `useListNavigation` + `useAppHotkey("issue.status" | "issue.severity")`: the list's keys, from
// anywhere on the page, while no dialog is open and no field has focus.

const LIST_KEYS = new Set([
	"j",
	"J",
	"k",
	"K",
	"ArrowDown",
	"ArrowUp",
	"Enter",
	"x",
	"X",
	"Escape",
	"s",
	"S",
	"p",
	"P",
])

const isInteractive = (target: EventTarget | null): boolean =>
	target instanceof HTMLElement &&
	target.closest("button, a, [role='button'], [role='menuitem'], [role='option']") !== null

const listKeys: Stream.Stream<Message> = Dom.streamFromEventFilterMapPreventDefault({
	target: () => document,
	type: "keydown",
	filterMapEvent: (event) => {
		if (!LIST_KEYS.has(event.key) || event.metaKey || event.ctrlKey || event.altKey) return Option.none()
		// Shift only extends `x`; Shift with any other key is not a list key.
		if (event.shiftKey && event.key !== "X" && event.key !== "x") return Option.none()
		if (isEditableTarget(event.target) || isDialogOpen()) return Option.none()
		if (event.key === "Enter" && isInteractive(event.target)) return Option.none()
		return Option.some(Message.PressedListKey({ key: event.key, isShift: event.shiftKey }))
	},
})

export const subscriptions = Subscription.make<PageSubscriptionInput<Model>, Message>()((entry) => ({
	listKeys: entry(
		{ hasRows: Schema.Boolean },
		{
			modelToDependencies: ({ model }) => ({ hasRows: listStatusOf(model) === "ready" }),
			dependenciesToStream: ({ hasRows }) => (hasRows ? listKeys : Stream.empty),
		},
	),
}))
