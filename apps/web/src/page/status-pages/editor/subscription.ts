import { isDialogOpen, isEditableTarget } from "@maple/ui/lib/keyboard"
import { Option, Schema, Stream } from "effect"
import { Dom, Subscription } from "foldkit"
import type { PageSubscriptionInput } from "../../contract"
import { previewSelections } from "../shared/preview"
import { Message } from "./message"
import type { Model } from "./model"
import { resolveView } from "./update"

// Escape closes the side panel (a field or an open dialog keeps its own Escape), and a click in
// the preview frame selects what it landed on.

const escapes: Stream.Stream<Message> = Dom.streamFromEventFilterMap({
	target: () => document,
	type: "keydown",
	filterMapEvent: (event) =>
		event.key !== "Escape" || isEditableTarget(event.target) || isDialogOpen()
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
