import * as Policy from "@maple/domain/policy"
import { SloLatencyThresholdMs, SloWindowDays } from "@maple/domain"
import { AlertDestinationId } from "@maple/domain/http"
import { V2Slo } from "@maple/domain/http/v2"
import { AlertDestinationRowSchema } from "@maple/web-data/collections/alerts"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "@maple/views/data/load-failure"
import * as Menu from "@maple/views/ui/menu"
import { SliType, TargetPick, TextField, Tier } from "./form"

const outcome = <S extends Schema.Top>(success: S) => Schema.Result(success, LoadFailure)

export const Message = defineMessageUnion({
	CompletedFetchExisting: { key: Schema.String, result: outcome(V2Slo) },
	UpdatedDestinations: { orgId: Schema.String, rows: Schema.Array(AlertDestinationRowSchema) },
	CompletedFetchServices: { services: Schema.Array(Schema.String) },
	CompletedFetchSession: { orgId: Schema.String, grants: Schema.Array(Policy.PermissionName) },
	ChangedText: { field: TextField, value: Schema.String },
	PickedSliType: { sliType: SliType },
	PickedThreshold: { thresholdMs: SloLatencyThresholdMs },
	PickedTarget: { target: TargetPick },
	PickedWindow: { windowDays: SloWindowDays },
	ToggledAlerting: {},
	RemovedDestination: { tier: Tier, id: AlertDestinationId },
	GotDestinationMenuMessage: { tier: Tier, message: Menu.Message },
	ClickedSave: {},
	CompletedSave: { result: outcome(V2Slo) },
})
export type Message = typeof Message.Type
