import { ruleFormIsGrouped } from "@maple/web-data/alerts/form-utils"
import { createLazy, type Html, type HtmlBuilder } from "foldkit/html"
import { card } from "../../../ui/card"
import { eyebrow } from "../../../ui/eyebrow"
import { settingRow } from "../../../ui/setting-row"
import { switchControl } from "../../../ui/switch"
import type { RuleForm } from "./form"
import { Message } from "./message"
import type { Model } from "./model"
import { NOISE_CONTROL_CLASS, numberField } from "./view-fields"

// `RuleNoiseSection`: how an open incident behaves.

type H = HtmlBuilder<Message>

const NO_DATA_IDS = { control: "rule-no-data-input", label: "rule-no-data-label", description: "rule-no-data-description" }

const noise = (h: H, mounted: Model["mountedForm"], form: RuleForm): Html => {
	const isGrouped = ruleFormIsGrouped(form)
	const noiseRow = (
		id: string,
		label: string,
		unit: string,
		pick: (form: RuleForm) => string,
		field: "consecutiveHealthyRequired" | "renotifyIntervalMinutes",
	) =>
		numberField(h, {
			id,
			label,
			unit,
			value: pick(form),
			mounted: mounted === null ? undefined : pick(mounted),
			inputMode: "numeric",
			min: "1",
			controlClassName: NOISE_CONTROL_CLASS,
			onInput: (value) => Message.ChangedField({ field, value }),
		})
	return card(
		h,
		[
			h.div(
				[h.Class("space-y-3 p-4")],
				[
					eyebrow(h, { as: "h3" }, ["After it fires"]),
					h.div(
						[h.Class("grid items-start gap-4 md:grid-cols-3")],
						[
							noiseRow(
								"rule-consecutive-healthy",
								"Resolve after",
								"healthy checks",
								(f) => f.consecutiveHealthyRequired,
								"consecutiveHealthyRequired",
							),
							noiseRow(
								"rule-renotify",
								"Remind while open, every",
								"min",
								(f) => f.renotifyIntervalMinutes,
								"renotifyIntervalMinutes",
							),
							settingRow(h, {
								ids: NO_DATA_IDS,
								label: "Alert when there is no data",
								description: isGrouped
									? "Not available on split rules: a quiet group keeps its incident open until data returns."
									: "Count an empty window as a breach. Off, those windows are skipped.",
								disabled: isGrouped,
								control: switchControl(h, {
									id: "rule-no-data",
									inputId: NO_DATA_IDS.control,
									isChecked: form.alertOnNoData && !isGrouped,
									isDisabled: isGrouped,
									labelledBy: NO_DATA_IDS.label,
									describedBy: NO_DATA_IDS.description,
									onToggle: Message.ToggledAlertOnNoData(),
								}),
							}),
						],
					),
				],
			),
		],
		"gap-0 p-0",
	)
}

const slot = createLazy()

/** "After it fires"; `form` is the evaluated draft (`evaluatedFormOf`). */
export const noiseSection = (h: H, model: Model, form: RuleForm): Html =>
	slot(noise, [h, model.mountedForm, form])
