import { Submodel } from "foldkit"
import type { Html } from "foldkit/html"
import type { PageViewInputs } from "../../contract"
import { addTargetView } from "../kit/add-target-view"
import { securityLayout } from "../kit/layout"
import { gateState } from "../kit/parts"
import { activeRepositoriesOf, pageGateOf } from "./derive"
import { Message, type Model } from "./model"
import { findingsBody } from "./view-findings"
import { addTargetButton, overviewBody } from "./view-overview"
import { runsBody, startRunAction } from "./view-runs"

// The active tab inside the shared frame; a disabled org sees only the calm gate.

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) => {
	const gate = pageGateOf(model)
	if (gate !== null) return securityLayout(h, { active: model.tab }, [gateState(h, gate)])
	const overlay: ReadonlyArray<Html> = [
		h.submodel({
			slotId: "security-add-target-form",
			model: model.addTarget,
			view: addTargetView,
			viewInputs: { repositories: activeRepositoriesOf(model) },
			toParentMessage: (message) => Message.GotAddTargetMessage({ message }),
		}),
	]
	switch (model.tab) {
		case "overview":
			return securityLayout(
				h,
				{ active: "overview", actions: addTargetButton(h, model), overlay },
				overviewBody(h, model),
			)
		case "findings":
			return securityLayout(
				h,
				{
					active: "findings",
					description:
						"A finding is followed by its fingerprint from run to run. Findings are visible to org admins only.",
					overlay,
				},
				findingsBody(h, model, inputs.context.timeZone),
			)
		case "runs":
			return securityLayout(
				h,
				{ active: "runs", actions: startRunAction(h, model) ?? addTargetButton(h, model), overlay },
				runsBody(h, model, inputs.context.timeZone),
			)
	}
})
