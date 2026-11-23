import { toV2IngestRuleAction, type V2IngestRulePreviewParams } from "@maple/domain/http/v2"
import { Schema } from "effect"
import { draftProblems, specOf, type Draft } from "./form"

// The 24 hour dry run: the draft's conditions counted over stored logs and spans by the API.

const encodeParams = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

/** Wait this long after the last edit before asking, so typing a value runs one count. */
export const ESTIMATE_DEBOUNCE_MS = 600

/** The request body the draft previews as, or `null` while it cannot be saved or has nothing to count. */
export const estimateParamsOf = (draft: Draft): V2IngestRulePreviewParams | null => {
	// The name is not part of the count, so no name problem holds it back.
	if (draftProblems({ ...draft, name: "draft" }).length > 0) return null
	if (!draft.signals.includes("logs") && !draft.signals.includes("traces")) return null
	const spec = specOf(draft)
	return { signals: spec.signals, conditions: spec.conditions, action: toV2IngestRuleAction(spec.action) }
}

/** Identifies one draft's request: equal keys need no new count. `""` asks for none. */
export const estimateKeyOf = (draft: Draft): string => {
	const params = estimateParamsOf(draft)
	return params === null ? "" : encodeParams(params)
}
