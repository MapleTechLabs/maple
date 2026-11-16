import { isDialogOpen } from "@maple/ui/lib/keyboard"
import { Option, Schema, Stream } from "effect"
import { Dom, Subscription } from "foldkit"
import type { PageSubscriptionInput } from "../../contract"
import { previewSelections } from "../shared/preview"
import { Message } from "./message"
import type { Model } from "./model"
import { resolveView } from "./update"

// Escape closes the open component, from its inputs too; an open dialog (the sheet included), menu
// or listbox keeps its own Escape. A click in the live page's frame opens what it landed on.

/** What Escape's owner is read from on the focused element. */
export type Focused = Readonly<{
	getAttribute: (name: string) => string | null
	isInside: (selector: string) => boolean
}>

/**
 * A focused popup owns Escape: an open popup trigger, or a list or menu. A disclosure such as a
 * component's row is expanded but no popup, so Escape still closes it.
 */
export const popupOwnsEscape = (focused: Focused): boolean =>
	(focused.getAttribute("aria-expanded") === "true" && focused.getAttribute("aria-haspopup") !== null) ||
	focused.isInside('[role="listbox"], [role="menu"]')

const focusedOf = (element: Element): Focused => ({
	getAttribute: (name) => element.getAttribute(name),
	isInside: (selector) => element.closest(selector) !== null,
})

const escapes: Stream.Stream<Message> = Dom.streamFromEventFilterMap({
	target: () => document,
	type: "keydown",
	filterMapEvent: (event) =>
		event.key !== "Escape" ||
		isDialogOpen() ||
		(event.target instanceof Element && popupOwnsEscape(focusedOf(event.target)))
			? Option.none()
			: Option.some(Message.PressedEscape()),
})

export const subscriptions = Subscription.make<PageSubscriptionInput<Model>, Message>()((entry) => ({
	escapeClosesPanel: entry(
		{ hasPanel: Schema.Boolean },
		{
			modelToDependencies: ({ model }) => ({ hasPanel: model.panel !== null }),
			dependenciesToStream: ({ hasPanel }) => (hasPanel ? escapes : Stream.empty),
		},
	),
	previewSelection: entry(
		{ isCanvas: Schema.Boolean },
		{
			modelToDependencies: ({ model }) => ({ isCanvas: resolveView(model.search).tab === "page" }),
			dependenciesToStream: ({ isCanvas }) =>
				isCanvas
					? previewSelections.pipe(
							Stream.map((selection) => Message.ReceivedPreviewSelection(selection)),
						)
					: Stream.empty,
		},
	),
}))
