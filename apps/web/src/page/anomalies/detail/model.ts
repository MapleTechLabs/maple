import { AnomalyIncidentId } from "@maple/domain/http"
import { V2AnomalyIncident, V2AnomalyIncidentTimeseries, V2ErrorIssue } from "@maple/domain/http/v2"
import { Schema } from "effect"
import * as Chart from "../../../charts/chart"
import { ChartRuntime } from "../../../charts/chart-runtime"
import { ThemeColors } from "../../../charts/theme-colors"
import { KeyedSchema } from "../../../data/keyed"
import { LoadFailure } from "../../../data/load-failure"
import * as Combobox from "../../../ui/combobox"
import * as Dialog from "../../../ui/dialog"

// `/anomalies/$incidentId`.

/** The write in flight: resolving, linking, unlinking or investigating. */
export const Busy = Schema.NullOr(Schema.Literals(["resolve", "link", "unlink", "investigate"]))
export type Busy = typeof Busy.Type

export const Model = Schema.Struct({
	incidentId: AnomalyIncidentId,
	nowMs: Schema.Number,
	incident: KeyedSchema(V2AnomalyIncident, LoadFailure),
	timeseries: KeyedSchema(V2AnomalyIncidentTimeseries, LoadFailure),
	/** `LinkedIssueBody`'s `errorIssues.retrieve`, once the incident names an issue. */
	linkedIssue: KeyedSchema(V2ErrorIssue, LoadFailure),
	busy: Busy,
	resolveDialog: Dialog.Model,
	linkDialog: Dialog.Model,
	/** The link dialog's `Command` input (its search text) and scope (`allServices`). */
	linkCombobox: Combobox.Model,
	linkAllServices: Schema.Boolean,
	linkIssues: KeyedSchema(Schema.Array(V2ErrorIssue), LoadFailure),
	chart: Chart.Model,
	chartRuntime: ChartRuntime,
	themeColors: Schema.NullOr(ThemeColors),
})
export type Model = typeof Model.Type
