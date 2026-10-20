import { DigestSubscriptionResponse } from "@maple/domain/http"
import { Schema } from "effect"
import { AsyncData } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "../../../../data/load-failure"
import * as Combobox from "../../../../ui/combobox"
import { DraftState } from "../../kit/draft"

// The Email preferences tab: the weekly ops and web analytics digests this user gets for
// the active organization.

export const DigestDraft = Schema.Struct({
	dayOfWeek: Schema.Number,
	sendHour: Schema.Number,
	timezone: Schema.String,
	namespaces: Schema.Array(Schema.String),
	environments: Schema.Array(Schema.String),
})
export type DigestDraft = typeof DigestDraft.Type

/** `null`: never subscribed (the 404), so Maple's defaults apply. */
export const SubscriptionData = AsyncData.Schema(Schema.NullOr(DigestSubscriptionResponse), LoadFailure)

export const Facets = Schema.Struct({ namespaces: Schema.Array(Schema.String), environments: Schema.Array(Schema.String) })

export const Model = Schema.Struct({
	isLoaded: Schema.Boolean,
	email: Schema.NullOr(Schema.String),
	orgName: Schema.NullOr(Schema.String),
	/** `Intl`'s zones and the browser's own, read once (the picker's options). */
	supportedZones: Schema.Array(Schema.String),
	browserZone: Schema.NullOr(Schema.String),
	subscription: SubscriptionData.schema,
	facets: Facets,
	/** `ScopeFields` reads the facets once it mounts: when the ops digest's panel first shows. */
	isFacetsRequested: Schema.Boolean,
	draft: DraftState(DigestDraft),
	isTogglingOps: Schema.Boolean,
	isTogglingWeb: Schema.Boolean,
	isSaving: Schema.Boolean,
	previewing: Schema.NullOr(Schema.Literals(["ops", "web"])),
	namespacesBox: Combobox.Model,
	environmentsBox: Combobox.Model,
})
export type Model = typeof Model.Type

export const ScheduleField = Schema.Literals(["dayOfWeek", "sendHour", "timezone"])
export type ScheduleField = typeof ScheduleField.Type

const done = { result: Schema.Result(Schema.Void, LoadFailure) }

export const Message = defineMessageUnion({
	CompletedReadEntry: {
		email: Schema.NullOr(Schema.String),
		orgName: Schema.NullOr(Schema.String),
		supportedZones: Schema.Array(Schema.String),
		browserZone: Schema.NullOr(Schema.String),
	},
	CompletedFetchSubscription: { result: Schema.Result(Schema.NullOr(DigestSubscriptionResponse), LoadFailure) },
	CompletedFetchFacets: { facets: Facets },
	ClickedRetry: {},
	ToggledOps: {},
	ToggledWeb: {},
	CompletedToggle: { digest: Schema.Literals(["ops", "web"]), isOn: Schema.Boolean, ...done },
	ChangedSchedule: { field: ScheduleField, value: Schema.String },
	GotNamespacesMessage: { message: Combobox.Message },
	GotEnvironmentsMessage: { message: Combobox.Message },
	ClickedDiscard: {},
	ClickedSave: {},
	CompletedSave: { submitted: DigestDraft, ...done },
	ClickedPreview: { digest: Schema.Literals(["ops", "web"]) },
	CompletedPreview: { result: Schema.Result(Schema.String, LoadFailure) },
})
export type Message = typeof Message.Type
