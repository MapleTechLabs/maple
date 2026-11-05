import { FunnelKeyBy } from "@maple/query-model"
import { Option, Schema, String as Str } from "effect"
import type { EditorState } from "./editor-state"
import { applyProductEdit } from "./product-apply"
import { stepEditOf, type StepScope } from "../../kit/funnel-steps"
import { ProductEdit } from "./product-edit"

// The selects of the list, funnel and paths panels, by id: what a picked value edits.

export const BREAKDOWN_SELECT_ID = "funnel-breakdown"
export const BREAKDOWN_NONE = "__none__"
export const BREAKDOWN_ATTRIBUTE = "__attribute__"

export const listUnitSelectId = (index: number) => `list-unit:${index}`
export const listAlignSelectId = (index: number) => `list-align:${index}`
export const keyBySelectId = (scope: StepScope) => `key-by:${scope}`
export const windowSelectId = (scope: StepScope) => `window:${scope}`

const decodeKeyBy = Schema.decodeUnknownOption(FunnelKeyBy)
const decodeAlign = Schema.decodeUnknownOption(Schema.Literals(["left", "center", "right"]))

const scopeOf = (raw: string | undefined): StepScope => (raw === "paths" ? "paths" : "funnel")

/** A panel select's picked value as the edit it makes; `None` for another select. */
export const productSelectEdit = (id: string, value: string): Option.Option<ProductEdit> =>
	Option.orElse(
		Option.map(stepEditOf(id, value), (step) => ProductEdit.Step(step)),
		() => panelSelectEdit(id, value),
	)

const panelSelectEdit = (id: string, value: string): Option.Option<ProductEdit> => {
	const [name, first] = Str.split(":")(id)
	const index = Number(first)
	switch (name) {
		case "list-unit":
			return Option.some(ProductEdit.SetListColumnUnit({ index, unit: value }))
		case "list-align":
			return Option.map(decodeAlign(value), (align) => ProductEdit.SetListColumnAlign({ index, align }))
		case "key-by":
			return Option.map(decodeKeyBy(value), (keyBy) =>
				ProductEdit.SetKeyBy({ scope: scopeOf(first), keyBy }),
			)
		case "window":
			return Option.some(ProductEdit.SetWindow({ scope: scopeOf(first), seconds: Number(value) }))
		default:
			return Option.none()
	}
}

/** `BreakdownPicker`'s `onValueChange`: None clears, a dimension sets, "Attribute…" emits the typed key. */
export const breakdownPicked = (state: EditorState, value: string, attributeKey: string): EditorState => {
	const key = Str.trim(attributeKey)
	const next =
		value === BREAKDOWN_NONE
			? null
			: value === BREAKDOWN_ATTRIBUTE
				? key === ""
					? null
					: `attribute:${key}`
				: value
	return applyProductEdit(state, ProductEdit.SetBreakdown({ value: next }))
}
