import {
	SECURITY_AUDIT_INTELLIGENCE_SOURCE,
	SECURITY_AUDIT_MODELS,
	SECURITY_AUDIT_RATING_LEVELS,
	securityAuditIntelligenceLevel,
	securityAuditModelOption,
	securityAuditPriceLevel,
	type SecurityAuditModelOption,
} from "@maple/domain/security-audit"
import type { Html, HtmlBuilder } from "foldkit/html"
import type * as Select from "@maple/views/ui/select"
import { icon } from "@maple/views/ui/icon"
import { levelMeter, type LevelRamp } from "@maple/views/ui/meter"
import * as SelectView from "@maple/views/ui/select-view"
import { modelLabel } from "./format"
import { typography } from "@maple/views/ui/typography"
import { hstack, vstack } from "@maple/views/ui/stack"
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

/** What a row's tooltip spells out behind its pips: the benchmark score and the list price. */
const ratingTitle = (model: SecurityAuditModelOption): string =>
	`Intelligence ${model.intelligenceIndex} (${SECURITY_AUDIT_INTELLIGENCE_SOURCE}) · ` +
	`$${model.inputUsd} in, $${model.outputUsd} out per million tokens (list price)`

const entriesFor = (stage: ModelStage): ReadonlyArray<SelectView.SelectEntry> =>
	Arr.map(optionsFor(stage), (model) => ({
		_tag: "Item",
		item: { value: model.id, label: model.label, title: ratingTitle(model) },
	}))

/** One rating: its icon, then its level as pips. */
const rating = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		name: string
		glyph: "SquareSparkleIcon" | "CircleDollarIcon"
		level: number
		ramp: LevelRamp
	}>,
): Html =>
	hstack(h, { gap: "1", align: "center" }, [
		icon(h, options.glyph, {
			size: 12,
			className: "text-muted-foreground",
			attributes: [h.AriaHidden(true)],
		}),
		levelMeter(h, {
			value: options.level,
			max: SECURITY_AUDIT_RATING_LEVELS,
			ramp: options.ramp,
			label: `${options.name} ${options.level} of ${SECURITY_AUDIT_RATING_LEVELS}`,
		}),
	])

/** A picker row: the model and its provider, then its intelligence and price as pips. */
const modelRow = <M>(h: HtmlBuilder<M>, option: SelectView.SelectOption): ReadonlyArray<Html> => {
	const model = securityAuditModelOption(option.value)
	if (model === undefined) return [typography(h, {}, [option.label])]
	return [
		hstack(h, { gap: "4", align: "center", justify: "between" }, [
			hstack(h, { gap: "2", align: "baseline" }, [
				typography(h, {}, [model.label]),
				typography(h, { size: "xs", tone: "muted" }, [model.provider]),
			]),
			hstack(h, { gap: "3", align: "center" }, [
				rating(h, {
					name: "Intelligence",
					glyph: "SquareSparkleIcon",
					level: securityAuditIntelligenceLevel(model),
					ramp: "high-is-good",
				}),
				rating(h, {
					name: "Price",
					glyph: "CircleDollarIcon",
					level: securityAuditPriceLevel(model),
					ramp: "low-is-good",
				}),
			]),
		]),
	]
}

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
				renderItem: (option) => modelRow(h, option),
				toView: (parts) => h.div([h.Class("contents")], parts),
			},
			toParentMessage: options.wrap,
		}),
	])
}
