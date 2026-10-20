import { V2GcpSetupScripts } from "@maple/domain/http/v2"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { KeyedSchema } from "../../data/keyed"
import { LoadFailure } from "../../data/load-failure"
import { Message as IntegrationsMessage } from "../../page/integrations/message"
import { Model as IntegrationsModel } from "../../page/integrations/model"
import * as ToggleGroup from "../../ui/toggle-group"
import { LAB_STATES } from "./fixture"

// `/lab/gcp-connect`: every step and run state of the Google
// Cloud connect dialog over fixture connectors. The dialog is the integrations page's own.

export const LabState = Schema.Literals(LAB_STATES)

export const Model = Schema.Struct({
	nowMs: Schema.Number,
	timeZone: Schema.String,
	state: LabState,
	stateGroup: ToggleGroup.Model,
	/** The page's Model; the dialog is open while its `gcpCard.configure` is set. */
	hub: IntegrationsModel,
	/** A run state's script read, held fixed; null on the interactive states. */
	pinnedScripts: Schema.NullOr(KeyedSchema(V2GcpSetupScripts, LoadFailure)),
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
	GotStateGroupMessage: { message: ToggleGroup.Message },
	ClickedReopen: {},
	GotHubMessage: { message: IntegrationsMessage },
})
export type Message = typeof Message.Type
