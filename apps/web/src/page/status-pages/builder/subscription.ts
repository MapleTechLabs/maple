import { Schema, Stream } from "effect"
import { Subscription } from "foldkit"
import type { PageSubscriptionInput } from "../../contract"
import { componentDrags } from "../shared/component-drag"
import { Message } from "./message"
import { canManage, type Model } from "./model"

// A row's grip drags it within its group, while the list is shown and nothing is being created.

export const subscriptions = Subscription.make<PageSubscriptionInput<Model>, Message>()((entry) => ({
	rowDrag: entry(
		{ canDrag: Schema.Boolean },
		{
			modelToDependencies: ({ model }) => ({
				canDrag: model.isSeeded && canManage(model) && model.submitting === null,
			}),
			dependenciesToStream: ({ canDrag }) =>
				canDrag
					? componentDrags.pipe(
							Stream.map(({ kind, key, index }) =>
								kind === "group"
									? Message.DroppedGroup({ group: key === "" ? null : key, index })
									: Message.DroppedRow({ key, index }),
							),
						)
					: Stream.empty,
		},
	),
}))
