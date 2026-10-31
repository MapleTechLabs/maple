import { PAGES } from "../gcp-workload-fixture"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import * as Workload from "../../page/infra-integrations/gcp/workload/model"

// `/lab/gcp-workload`: the workload page over fixture series,
// a Cloud Run burst and a Cloud SQL instance, picked from the floating lab bar.

export const LabPage = Schema.Literals(PAGES)
export type LabPage = typeof LabPage.Type

/** What the peek's span read returns in the lab. */
export const SPAN_STATES = ["data", "loading", "failed"] as const
export const SpanState = Schema.Literals(SPAN_STATES)
export type SpanState = typeof SpanState.Type

export const Model = Schema.Struct({
	page: LabPage,
	spanState: SpanState,
	timeZone: Schema.String,
	/** The page's own Model; its slots hold the fixture, so it never fetches. */
	workload: Workload.Model,
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
	ClickedLabPage: { page: Schema.String },
	ClickedSpanState: { state: Schema.String },
	GotWorkloadMessage: { message: Workload.Message },
})
export type Message = typeof Message.Type

export const GcpWorkloadLabFlags = Schema.Struct({ timeZone: Schema.String })
export type GcpWorkloadLabFlags = typeof GcpWorkloadLabFlags.Type
