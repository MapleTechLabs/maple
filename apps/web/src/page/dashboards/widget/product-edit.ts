import { FunnelKeyBy, FunnelVariant, PathsDirection, PathsInclude } from "@maple/query-model"
import { Schema } from "effect"
import { defineTaggedUnion } from "foldkit/schema"
import { StepEdit, StepScope } from "../../kit/funnel-steps"
import { ListDataSource } from "./editor-state"

/**
 * The edits of the list, funnel and paths panels (`ListConfigPanel`, `FunnelQueryPanel`,
 * `PathsQueryPanel` and the `FunnelStepBuilder` they mount), as data for one Message.
 * `scope` names the step list: the funnel's steps, or the paths widget's single anchor.
 */

export const ListColumnText = Schema.Literals(["field", "header"])

export const FunnelAddOn = Schema.Literals(["keyBy", "window", "breakdown"])
export const PathsAddOn = Schema.Literals(["keyBy", "window", "include", "exclude"])

export const ProductEdit = defineTaggedUnion({
	SetListSource: { source: ListDataSource },
	ToggledListRootOnly: {},
	ChangedListWhere: { value: Schema.String },
	ChangedListLimit: { value: Schema.String },
	ChangedListColumnText: { index: Schema.Number, field: ListColumnText, value: Schema.String },
	PickedListField: { index: Schema.Number, field: Schema.String },
	SetListColumnUnit: { index: Schema.Number, unit: Schema.String },
	SetListColumnAlign: { index: Schema.Number, align: Schema.Literals(["left", "center", "right"]) },
	RemovedListColumn: { index: Schema.Number },
	AddedListColumn: {},
	MovedListColumn: { index: Schema.Number, delta: Schema.Number },
	/** The step builder's edit: the funnel's steps, or the paths widget's anchor. */
	Step: { scope: StepScope, edit: StepEdit },
	ChangedPopulationFilter: { scope: StepScope, value: Schema.String },
	ToggledFunnelAddOn: { key: FunnelAddOn },
	ToggledPathsAddOn: { key: PathsAddOn },
	SetKeyBy: { scope: StepScope, keyBy: FunnelKeyBy },
	SetWindow: { scope: StepScope, seconds: Schema.Number },
	SetBreakdown: { value: Schema.NullOr(Schema.String) },
	SetFunnelVariant: { variant: FunnelVariant },
	SetFunnelStepPercent: { value: Schema.Literals(["auto", "conversion", "off"]) },
	SetPathsDirection: { direction: PathsDirection },
	SetPathsDepth: { depth: Schema.Number },
	SetPathsBranches: { branches: Schema.Number },
	SetPathsInclude: { include: PathsInclude },
	ChangedPathsExclude: { value: Schema.String },
})
export type ProductEdit = typeof ProductEdit.Type
