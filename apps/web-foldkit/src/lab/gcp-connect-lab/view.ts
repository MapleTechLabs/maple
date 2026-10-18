import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { Message as IntegrationsMessage } from "../../page/integrations/message"
import type { Model as IntegrationsModel } from "../../page/integrations/model"
import { gcpConfigure } from "../../page/integrations/view-gcp-configure"
import { button } from "../../ui/button"
import * as ToggleGroup from "../../ui/toggle-group"
import { LAB_STATES, STATES } from "./fixture"
import { Message, type Model } from "./model"

type H = HtmlBuilder<Message>

/** `GcpConfigure` / `GcpConfigureFrame`: the page's dialog, open while the wizard is. */
const dialogView = Submodel.defineView<
	IntegrationsModel,
	IntegrationsMessage,
	Readonly<{ timeZone: string }>
>((hub, inputs, h) => h.div([h.Class("contents")], gcpConfigure(h, hub, inputs.timeZone)))

export const view = (model: Model, h: H): Html => {
	const isOpen = model.hub.gcpCard.configure !== null
	return h.div(
		[h.Class("flex flex-col gap-4 p-6")],
		[
			h.div(
				[h.Class("flex flex-col gap-1")],
				[
					h.h1([h.Class("text-lg font-medium")], ["Google Cloud connect flow"]),
					h.p([h.Class("text-sm text-muted-foreground")], [STATES[model.state].note]),
				],
			),
			h.div(
				[h.Class("flex flex-wrap items-center gap-3")],
				[
					ToggleGroup.view(h, {
						model: model.stateGroup,
						toParentMessage: (message) => Message.GotStateGroupMessage({ message }),
						items: LAB_STATES.map((state) => ({ value: state, label: STATES[state].label })),
						variant: "outline",
						isConnected: false,
					}),
					...(isOpen
						? []
						: [
								button(
									h,
									{
										size: "sm",
										variant: "outline",
										attributes: [h.OnClick(Message.ClickedReopen())],
									},
									["Reopen"],
								),
							]),
				],
			),
			...(isOpen
				? [
						h.submodel({
							slotId: "gcp-connect-lab-dialog",
							model: model.hub,
							view: dialogView,
							viewInputs: { timeZone: model.timeZone },
							toParentMessage: (message) => Message.GotHubMessage({ message }),
						}),
					]
				: []),
		],
	)
}
