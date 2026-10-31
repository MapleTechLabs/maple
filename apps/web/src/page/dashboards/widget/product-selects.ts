import { FunnelKeyBy, FunnelSessionDimension } from "@maple/query-model"
import { Option, Schema } from "effect"
import type { EditorState } from "./editor-state"
import { applyProductEdit } from "./product-apply"
import { ProductEdit, type StepScope, StepKind } from "./product-edit"

// The selects of the list, funnel and paths panels, by id: what a picked value edits.

export const BREAKDOWN_SELECT_ID = "funnel-breakdown"
export const BREAKDOWN_NONE = "__none__"
export const BREAKDOWN_ATTRIBUTE = "__attribute__"

export const listUnitSelectId = (index: number) => `list-unit:${index}`
export const listAlignSelectId = (index: number) => `list-align:${index}`
export const stepKindSelectId = (scope: StepScope, index: number) => `step-kind:${scope}:${index}`
export const stepDimensionSelectId = (scope: StepScope, index: number) => `step-dimension:${scope}:${index}`
export const keyBySelectId = (scope: StepScope) => `key-by:${scope}`
export const windowSelectId = (scope: StepScope) => `window:${scope}`

const decodeKind = Schema.decodeUnknownOption(StepKind)
const decodeDimension = Schema.decodeUnknownOption(FunnelSessionDimension)
const decodeKeyBy = Schema.decodeUnknownOption(FunnelKeyBy)
const decodeAlign = Schema.decodeUnknownOption(Schema.Literals(["left", "center", "right"]))

const scopeOf = (raw: string | undefined): StepScope => (raw === "paths" ? "paths" : "funnel")

/** A panel select's picked value as the edit it makes; `None` for another select. */
export const productSelectEdit = (id: string, value: string): Option.Option<ProductEdit> => {
	const [name, first, second] = id.split(":")
	const index = Number(first)
	switch (name) {
		case "list-unit":
			return Option.some(ProductEdit.SetListColumnUnit({ index, unit: value }))
		case "list-align":
			return Option.map(decodeAlign(value), (align) => ProductEdit.SetListColumnAlign({ index, align }))
		case "step-kind":
			return Option.map(decodeKind(value), (kind) =>
				ProductEdit.SetStepKind({ scope: scopeOf(first), index: Number(second), kind }),
			)
		case "step-dimension":
			return Option.map(decodeDimension(value), (dimension) =>
				ProductEdit.SetStepDimension({ scope: scopeOf(first), index: Number(second), dimension }),
			)
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
	const key = attributeKey.trim()
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
