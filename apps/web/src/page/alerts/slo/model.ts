import * as Policy from "@maple/domain/policy"
import { SloId } from "@maple/domain"
import { V2Slo, V2SloHistory, V2SloStatus } from "@maple/domain/http/v2"
import { AlertDestinationRowSchema, AlertIncidentRowSchema } from "@maple/web-data/collections/alerts"
import { Schema } from "effect"
import * as Chart from "@maple/views/charts/chart"
import { ChartRuntime } from "@maple/views/charts/chart-runtime"
import { ThemeColors } from "@maple/views/charts/theme-colors"
import { KeyedSchema } from "@maple/views/data/keyed"
import { LoadFailure } from "@maple/views/data/load-failure"
import * as Dialog from "@maple/views/ui/dialog"

// `/alerts/slos/$sloId`: one SLO, its error budget, burn rates and incidents.

const Rows = <S extends Schema.Top>(row: S) => Schema.NullOr(Schema.Array(row))

export const Model = Schema.Struct({
	/** The URL segment as written; `sloId` is `null` when it is not an SLO id. */
	rawSloId: Schema.String,
	sloId: Schema.NullOr(SloId),
	nowMs: Schema.NullOr(Schema.Number),
	slo: KeyedSchema(V2Slo, LoadFailure),
	status: KeyedSchema(V2SloStatus, LoadFailure),
	history: KeyedSchema(V2SloHistory, LoadFailure),
	/** Synced destinations (the alerting panel's names) and incidents (those of the SLO's rule). */
	destinations: Rows(AlertDestinationRowSchema),
	incidents: Rows(AlertIncidentRowSchema),
	grants: Schema.Array(Policy.PermissionName),
	isTogglingAlerting: Schema.Boolean,
	isDeleting: Schema.Boolean,
	deleteDialog: Dialog.Model,
	budgetChart: Chart.Model,
	sliChart: Chart.Model,
	chartRuntime: ChartRuntime,
	themeColors: Schema.NullOr(ThemeColors),
})
export type Model = typeof Model.Type

/** The viewer may change SLOs (`alerts:manage`); the API refuses anyone else. */
export const canManage = (model: Pick<Model, "grants">): boolean => Policy.has(model.grants, "alerts:manage")
