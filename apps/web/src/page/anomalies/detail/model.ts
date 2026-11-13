import { ChartEnvFields } from "@maple/views/charts/chart-env"
import { AnomalyIncidentId } from "@maple/domain/http"
import { V2AnomalyIncident, V2AnomalyIncidentTimeseries, V2ErrorIssue } from "@maple/domain/http/v2"
import * as Policy from "@maple/domain/policy"
import { Schema } from "effect"
import * as Chart from "@maple/views/charts/chart"
import { KeyedSchema } from "@maple/views/data/keyed"
import { LoadFailure } from "@maple/views/data/load-failure"
import * as Combobox from "@maple/views/ui/combobox"
import * as Dialog from "@maple/views/ui/dialog"

export const Busy = Schema.NullOr(Schema.Literals(["resolve", "link", "unlink", "investigate"]))
export type Busy = typeof Busy.Type

export const Model = Schema.Struct({
	incidentId: AnomalyIncidentId,
	nowMs: Schema.Number,
	/** What the viewer may do; an analyst reads the anomaly and gets no resolve or link control. */
	grants: Schema.Array(Policy.PermissionName),
	incident: KeyedSchema(V2AnomalyIncident, LoadFailure),
	timeseries: KeyedSchema(V2AnomalyIncidentTimeseries, LoadFailure),
	/** Read once the incident names an issue. */
	linkedIssue: KeyedSchema(V2ErrorIssue, LoadFailure),
	busy: Busy,
	resolveDialog: Dialog.Model,
	linkDialog: Dialog.Model,
	linkCombobox: Combobox.Model,
	linkAllServices: Schema.Boolean,
	linkIssues: KeyedSchema(Schema.Array(V2ErrorIssue), LoadFailure),
	chart: Chart.Model,
	...ChartEnvFields,
})
export type Model = typeof Model.Type
