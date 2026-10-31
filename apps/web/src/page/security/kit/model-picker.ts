import { SECURITY_AUDIT_MODELS } from "@maple/domain/security-audit"
import type { Html, HtmlBuilder } from "foldkit/html"
import type * as Select from "../../../ui/select"
import * as SelectView from "../../../ui/select-view"
import { modelLabel } from "./format"

// The two model pickers both dialogs show: which model hunts, and which one verifies.

export type ModelStage = "discovery" | "validation"

export const STAGE_LABEL = {
	discovery: "Hunts for bugs",
	validation: "Verifies findings",
} satisfies Record<ModelStage, string>

/** Every listed model hunts; only the ones that answered verifier prompts in the eval verify. */
const optionsFor = (stage: ModelStage) =>
	SECURITY_AUDIT_MODELS.filter((model) => stage === "discovery" || model.verifies)

export const modelIdsFor = (stage: ModelStage): ReadonlyArray<string> =>
	optionsFor(stage).map((model) => model.id)

const entriesFor = (stage: ModelStage): ReadonlyArray<SelectView.SelectEntry> =>
	optionsFor(stage).map((model) => ({
		_tag: "Item",
		item: { value: model.id, label: model.label, title: model.provider },
	}))

/** One labelled picker; `wrap` lifts the Select's messages into the dialog's. */
export const modelPicker = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		stage: ModelStage
		model: Select.Model
		idPrefix: string
		wrap: (message: Select.Message) => M
	}>,
): Html => {
	const labelId = `${options.idPrefix}-${options.stage}-label`
	return h.div(
		[h.Class("flex min-w-0 flex-col gap-1.5")],
		[
			h.span([h.Id(labelId), h.Class("text-xs text-muted-foreground")], [STAGE_LABEL[options.stage]]),
			h.submodel({
				slotId: options.model.id,
				model: options.model,
				view: SelectView.view,
				viewInputs: {
					entries: entriesFor(options.stage),
					labelledBy: labelId,
					className: "w-full",
					renderValue: (value) => [modelLabel(value)],
					renderItem: (option) => [
						option.label,
						h.span([h.Class("ml-2 text-xs text-muted-foreground")], [option.title ?? ""]),
					],
					toView: (parts) => h.div([h.Class("contents")], parts),
				},
				toParentMessage: options.wrap,
			}),
		],
	)
}
