import { AsyncData, Submodel } from "foldkit"
import { errorState } from "@maple/views/ui/error-state"
import { vstack } from "@maple/views/ui/stack"
import type { PageViewInputs } from "../../contract"
import { aiCreditsBreakdown, aiCreditsBreakdownLoading } from "../../kit/billing/ai-credits"
import { dashboardPage } from "../../kit/dashboard-page"
import { Message } from "./message"
import type { Model } from "./model"

/** Where this cycle's AI credits went, under Settings › Billing. */
export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) =>
	dashboardPage(
		h,
		{
			title: "AI credits",
			description:
				"Where this cycle's AI credits went. Each model call is priced at what the model provider charged, plus 20%; one credit is one dollar.",
			width: "settings",
		},
		[
			vstack(
				h,
				{ gap: "6" },
				AsyncData.match(model.usage, {
					onIdle: () => [aiCreditsBreakdownLoading(h)],
					onLoading: () => [aiCreditsBreakdownLoading(h)],
					onStale: ({ data }) => aiCreditsBreakdown(h, data, inputs.context.timeZone),
					onRefreshing: (usage) => aiCreditsBreakdown(h, usage, inputs.context.timeZone),
					onFailure: (failure) => [
						errorState(h, {
							variant: "row",
							failure,
							title: "Couldn't load your AI credits",
							onRetry: Message.ClickedRetry(),
						}),
					],
					onSuccess: (usage) => aiCreditsBreakdown(h, usage, inputs.context.timeZone),
				}),
			),
		],
	),
)
