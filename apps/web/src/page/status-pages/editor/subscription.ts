import { isDialogOpen } from "@maple/ui/lib/keyboard"
import { Option, Schema, Stream } from "effect"
import { Dom, Subscription } from "foldkit"
import type { PageSubscriptionInput } from "../../contract"
import { previewSelections } from "../shared/preview"
import { Message } from "./message"
import type { Model } from "./model"
import { resolveView } from "./update"

// Escape closes the side panel, from its inputs too; an open dialog, menu or listbox keeps its own
// Escape. A click in the preview frame selects what it landed on.

/** An open popup owns Escape: a dialog, or a dropdown whose trigger or list has focus. */
const isPopupOpen = (target: EventTarget | null): boolean =>
	isDialogOpen() ||
	(target instanceof Element &&
		(target.getAttribute("aria-expanded") === "true" ||
			target.closest('[role="listbox"], [role="menu"]') !== null))

const escapes: Stream.Stream<Message> = Dom.streamFromEventFilterMap({
	target: () => document,
	type: "keydown",
	filterMapEvent: (event) =>
		event.key !== "Escape" || isPopupOpen(event.target)
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
			modelToDependencies: ({ model }) => ({ isCanvas: resolveView(model.search.view) === "page" }),
			dependenciesToStream: ({ isCanvas }) =>
				isCanvas
					? previewSelections().pipe(
							Stream.map((selection) => Message.ReceivedPreviewSelection(selection)),
						)
					: Stream.empty,
		},
	),
}))
