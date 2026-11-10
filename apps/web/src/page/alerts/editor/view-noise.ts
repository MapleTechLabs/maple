import { ruleFormIsGrouped } from "@maple/web-data/alerts/form-utils"
import { createLazy, type Html, type HtmlBuilder } from "foldkit/html"
import { label } from "@maple/views/ui/label"
import { switchControl } from "@maple/views/ui/switch"
import { typography } from "@maple/views/ui/typography"
import { sentenceClause, sentenceRow, sentenceSection } from "../../kit/sentence-card"
import type { RuleForm } from "./form"
import { Message } from "./message"
import type { Model } from "./model"
import { invalidFieldsOf } from "./derive-rows"
import { inlineNumber, wasLine } from "./view-fields"
import { String as Str } from "effect"

type H = HtmlBuilder<Message>

const NO_DATA_IDS = {
	control: "rule-no-data-input",
	label: "rule-no-data-label",
	description: "rule-no-data-description",
}

const noise = (
	h: H,
	mounted: Model["mountedForm"],
	saved: Model["savedForm"],
	form: RuleForm,
	invalidIds: string,
): Html => {
	const isGrouped = ruleFormIsGrouped(form)
	const invalid = new Set(Str.split(invalidIds, ","))
	const values = (pick: (form: RuleForm) => string) => ({
		value: pick(form),
		mounted: mounted === null ? undefined : pick(mounted),
		previous: saved !== null && Str.trim(pick(saved)) !== Str.trim(pick(form)) ? pick(saved) : null,
	})
	const healthy = values((f) => f.consecutiveHealthyRequired)
	const renotify = values((f) => f.renotifyIntervalMinutes)
	return sentenceSection(h, { title: "After it fires" }, [
		sentenceClause(
			h,
			sentenceRow(h, {}, [
				"Resolve after",
				inlineNumber(h, {
					id: "rule-consecutive-healthy",
					ariaLabel: "Resolve after",
					inputMode: "numeric",
					min: "1",
					isInvalid: invalid.has("rule-consecutive-healthy"),
					onInput: (value) => Message.ChangedField({ field: "consecutiveHealthyRequired", value }),
					...healthy,
				}),
				"healthy checks.",
			]),
			wasLine(h, [{ label: "Resolve after", previous: healthy.previous }]),
		),
		sentenceClause(
			h,
			sentenceRow(h, {}, [
				"Remind every",
				inlineNumber(h, {
					id: "rule-renotify",
					ariaLabel: "Remind while open, every",
					inputMode: "numeric",
					min: "1",
					isInvalid: invalid.has("rule-renotify"),
					onInput: (value) => Message.ChangedField({ field: "renotifyIntervalMinutes", value }),
					...renotify,
				}),
				"min while open.",
			]),
			wasLine(h, [{ label: "Remind interval", previous: renotify.previous, unit: "min" }]),
		),
		sentenceClause(
			h,
			sentenceRow(h, {}, [
				// The label wraps the switch: its whole line toggles, at the row's control height.
				label(
					h,
					{
						className: "inline-flex min-h-9 items-center gap-2 sm:min-h-8",
						attributes: [h.Id(NO_DATA_IDS.label), h.For(NO_DATA_IDS.control)],
					},
					[
						...switchControl(h, {
							id: "rule-no-data",
							inputId: NO_DATA_IDS.control,
							isChecked: form.alertOnNoData && !isGrouped,
							isDisabled: isGrouped,
							labelledBy: NO_DATA_IDS.label,
							describedBy: NO_DATA_IDS.description,
							onToggle: Message.ToggledAlertOnNoData(),
						}),
						"Alert when there is no data",
					],
				),
			]),
			[
				typography(
					h,
					{ size: "xs", tone: "muted", as: "p", attributes: [h.Id(NO_DATA_IDS.description)] },
					[
						isGrouped
							? "Not available on split rules: a quiet group keeps its incident open until data returns."
							: "Count an empty window as a breach. Off, those windows are skipped.",
					],
				),
			],
		),
	])
}

const slot = createLazy()

/** "After it fires"; `form` is the evaluated draft (`evaluatedFormOf`). */
export const noiseSection = (h: H, model: Model, form: RuleForm): Html =>
	slot(noise, [h, model.mountedForm, model.savedForm, form, invalidFieldsOf(model, form)])
