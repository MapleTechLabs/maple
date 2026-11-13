import { V2UptimeMonitor } from "@maple/domain/http/v2"
import { AlertIncidentRowSchema } from "@maple/web-data/collections/alerts"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "@maple/views/data/load-failure"
import { SignalPresences } from "@maple/views/data/signal-presence"
import { SloRow, TopError } from "./model"

/** The sections whose read can be asked again from their error state. */
export const RetryTarget = Schema.Literals(["Monitors", "Slos", "Errors"])
export type RetryTarget = typeof RetryTarget.Type

const result = <A extends Schema.Top>(schema: A) => ({
	key: Schema.String,
	result: Schema.Result(schema, LoadFailure),
})

export const Message = defineMessageUnion({
	/** The page is on screen: its reads start here, since the role can arrive after `init`. */
	Entered: {},
	CompletedReadClock: { nowMs: Schema.Number },
	/** Reload's clock: every read is asked again against it. */
	CompletedResolveClock: { nowMs: Schema.Number },
	UpdatedIncidents: { orgId: Schema.String, rows: Schema.Array(AlertIncidentRowSchema) },
	FailedLoadIncidents: { orgId: Schema.String },
	UpdatedRules: { orgId: Schema.String, count: Schema.Number },
	FailedLoadRules: { orgId: Schema.String },
	CompletedFetchMonitors: result(Schema.Array(V2UptimeMonitor)),
	CompletedFetchSlos: result(Schema.Array(SloRow)),
	CompletedFetchErrors: result(Schema.Array(TopError)),
	CompletedLoadSignalPresence: { result: Schema.Result(SignalPresences, LoadFailure) },
	ClickedReload: {},
	CompletedReloadSpin: { version: Schema.Number },
	ClickedRetry: { target: RetryTarget },
})
export type Message = typeof Message.Type
