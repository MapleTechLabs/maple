import { AlertDestinationId } from "@maple/domain/http"
import { V2UptimeMonitor, V2UptimeMonitorTestResult } from "@maple/domain/http/v2"
import { AlertDestinationRowSchema } from "@maple/web-data/collections/alerts"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "../../../data/load-failure"
import * as Menu from "../../../ui/menu"
import {
	AssertionType,
	EveryUnit,
	GraceUnit,
	HttpMethod,
	MonitorKind,
	RecordType,
	ScheduleMode,
	TextField,
} from "./form"

const outcome = <S extends Schema.Top>(success: S) => Schema.Result(success, LoadFailure)

/** The part of an "Up when" row that changed. */
export const AssertionPart = Schema.Literals(["op", "target", "value"])

export const Message = defineMessageUnion({
	CompletedFetchExisting: { key: Schema.String, result: outcome(V2UptimeMonitor) },
	UpdatedDestinations: { orgId: Schema.String, rows: Schema.Array(AlertDestinationRowSchema) },
	CompletedFetchServices: { services: Schema.Array(Schema.String) },
	CompletedReadTimeZones: { zones: Schema.Array(Schema.String) },
	CompletedFetchSession: { orgId: Schema.String, isAdmin: Schema.Boolean },
	PickedKind: { kind: MonitorKind },
	ChangedText: { field: TextField, value: Schema.String },
	ChangedMethod: { method: HttpMethod },
	ChangedRecordType: { recordType: RecordType },
	ChangedScheduleMode: { mode: ScheduleMode },
	ChangedEveryUnit: { unit: EveryUnit },
	ChangedGraceUnit: { unit: GraceUnit },
	PickedInterval: { seconds: Schema.Number },
	AddedAssertion: {},
	RemovedAssertion: { id: Schema.Number },
	ChangedAssertionType: { id: Schema.Number, type: AssertionType },
	ChangedAssertion: { id: Schema.Number, part: AssertionPart, value: Schema.String },
	RemovedDestination: { id: AlertDestinationId },
	GotDestinationMenuMessage: { message: Menu.Message },
	ClickedTest: {},
	CompletedTest: { result: outcome(V2UptimeMonitorTestResult) },
	ClickedSave: {},
	CompletedSave: { result: outcome(V2UptimeMonitor) },
})
export type Message = typeof Message.Type
