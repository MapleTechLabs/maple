import { SECURITY_AUDIT_MODELS } from "@maple/domain/security-audit"
import type { Html, HtmlBuilder } from "foldkit/html"
import type * as Select from "@maple/views/ui/select"
import * as SelectView from "@maple/views/ui/select-view"
import { modelLabel } from "./format"
import { typography } from "@maple/views/ui/typography"
import { vstack } from "@maple/views/ui/stack"
import { Array as Arr } from "effect"

// The two model pickers both dialogs show: which model hunts, and which one verifies.

export type ModelStage = "discovery" | "validation"

export const STAGE_LABEL = {
	discovery: "Hunts for bugs",
	validation: "Verifies findings",
} satisfies Record<ModelStage, string>

/** Every listed model hunts; only the ones that answered verifier prompts in the eval verify. */
const optionsFor = (stage: ModelStage) =>
	Arr.filter(SECURITY_AUDIT_MODELS, (model) => stage === "discovery" || model.verifies)

export const modelIdsFor = (stage: ModelStage): ReadonlyArray<string> =>
	Arr.map(optionsFor(stage), (model) => model.id)

const entriesFor = (stage: ModelStage): ReadonlyArray<SelectView.SelectEntry> =>
	Arr.map(optionsFor(stage), (model) => ({
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
	return vstack(h, { gap: "1.5", shrink: true }, [
		typography(h, { size: "xs", tone: "muted", attributes: [h.Id(labelId)] }, [
			STAGE_LABEL[options.stage],
		]),
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
					typography(h, { size: "xs", tone: "muted", className: "ml-2" }, [option.title ?? ""]),
				],
				toView: (parts) => h.div([h.Class("contents")], parts),
			},
			toParentMessage: options.wrap,
		}),
	])
}
