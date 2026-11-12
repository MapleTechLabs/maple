import {
	CostBreakdownResponse,
	CostSourcesResponse,
	CostTimeseriesResponse,
	CostTotalsResponse,
} from "@maple/domain/http"
import * as Policy from "@maple/domain/policy"
import { Schema } from "effect"
import * as Chart from "@maple/views/charts/chart"
import { ChartEnvFields } from "@maple/views/charts/chart-env"
import { KeyedSchema } from "@maple/views/data/keyed"
import { LoadFailure } from "@maple/views/data/load-failure"
import * as Dialog from "@maple/views/ui/dialog"
import * as Field from "@maple/views/ui/field"
import { TimeWindow } from "../../data/time-range"
import { CostSearch } from "../../route/search"
import * as TimeRangePicker from "../kit/time-range-picker"

export type Search = typeof CostSearch.Type

/** The add-source dialog's two faces: the providers, then the chosen one's form. */
export const AddStep = Schema.Literals(["pick", "openrouter"])
export type AddStep = typeof AddStep.Type

export const Model = Schema.Struct({
	search: CostSearch,
	window: Schema.NullOr(TimeWindow),
	nowMs: Schema.Number,
	/** The org's cost sources: they decide between the on-ramp, the first-sync wait and the reads. */
	sources: KeyedSchema(CostSourcesResponse, LoadFailure),
	totals: KeyedSchema(CostTotalsResponse, LoadFailure),
	timeseries: KeyedSchema(CostTimeseriesResponse, LoadFailure),
	breakdown: KeyedSchema(CostBreakdownResponse, LoadFailure),
	timePicker: TimeRangePicker.Model,
	chart: Chart.Model,
	...ChartEnvFields,
	refreshVersion: Schema.Number,
	isReloading: Schema.Boolean,
	/** What the viewer's roles allow; empty until the session read answers. */
	grants: Schema.Array(Policy.PermissionName),
	addDialog: Dialog.Model,
	addStep: AddStep,
	/** The OpenRouter management key being typed; cleared whichever way the dialog closes. */
	keyDraft: Field.Model,
	/** Why the last save was refused, shown under the field until the key changes. */
	keyError: Schema.NullOr(Schema.String),
	removeDialog: Dialog.Model,
	sourceWrite: Schema.Literals(["Idle", "Saving", "Removing"]),
})
export type Model = typeof Model.Type

/** The saves need this permission: a viewer without it is offered no action that would be refused. */
export const canManageSources = (model: Pick<Model, "grants">): boolean =>
	Policy.has(model.grants, "integrations:manage")
