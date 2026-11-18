import type { PageContext } from "../../contract"
import type { Message } from "./message"
import type { Model } from "./model"
import { isRunnablePromql, type PromqlDraft, type PromqlState } from "./promql"
import { planPreview, type Return } from "./update"

export const PROMQL_TEXTAREA_ID = "widget-editor-promql"

type PromqlMessage = Extract<
	Message,
	{ readonly _tag: "ChangedPromql" | "ChangedPromqlLegend" | "ChangedPromqlMinStep" }
>

const withDraft = (model: Model, change: (draft: PromqlDraft) => PromqlDraft): Model =>
	model.promql === null
		? model
		: { ...model, promql: { ...model.promql, draft: change(model.promql.draft) } }

/** The min step input: empty is auto, anything else at least one second. */
const minStepOf = (value: string): number | null => {
	const parsed = Number(value)
	return value === "" || !Number.isFinite(parsed) ? null : Math.max(1, parsed)
}

export const promqlStep = (model: Model, message: PromqlMessage): Return => {
	switch (message._tag) {
		case "ChangedPromql":
			return { model: withDraft(model, (draft) => ({ ...draft, query: message.value })) }
		case "ChangedPromqlLegend":
			return { model: withDraft(model, (draft) => ({ ...draft, legendFormat: message.value })) }
		case "ChangedPromqlMinStep":
			return {
				model: withDraft(model, (draft) => ({ ...draft, minStepSeconds: minStepOf(message.value) })),
			}
	}
}

/** The draft taken as the opened one, so a discarded or saved draft no longer reads as dirty. */
export const savedPromql = (model: Model): PromqlState | null =>
	model.promql === null ? null : { ...model.promql, initial: model.promql.draft }

/** Run preview in PromQL: the draft is staged and the preview re-planned, unless the query is empty. */
export const runPromqlPreview = (model: Model, context: PageContext): Return =>
	model.promql === null || !isRunnablePromql(model.promql)
		? { model }
		: planPreview({ ...model, promql: { ...model.promql, staged: model.promql.draft } }, context)
