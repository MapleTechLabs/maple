import { AiTriageSettingsDocument, AttachResult, OpenRouterKeyDocument } from "@maple/domain/http"
import { Schema } from "effect"
import { AsyncData } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "../../../data/load-failure"
import * as Dialog from "../../../ui/dialog"
import * as Field from "../../../ui/field"

// The AI tab: `ModelProviderSection`, `AutoTriageSection` and `AiEscalationCard`.

export const Provider = Schema.Literals(["managed", "openrouter"])
export type Provider = typeof Provider.Type

export const KeyData = AsyncData.Schema(OpenRouterKeyDocument, LoadFailure)
export const TriageData = AsyncData.Schema(AiTriageSettingsDocument, LoadFailure)

/** The two daily ceilings as typed, `null` while the form shows the saved values. */
export const LimitsDraft = Schema.Struct({ maxRunsPerDay: Schema.String, maxPassesPerDay: Schema.String })
export type LimitsDraft = typeof LimitsDraft.Type

export const Model = Schema.Struct({
	/** Orgs outside the auto-triage rollout see the teaser. */
	isTriageAvailable: Schema.Boolean,
	key: KeyData.schema,
	/** A pick only opens a card; the provider changes when a key is saved or removed. */
	picked: Schema.NullOr(Provider),
	isReplacing: Schema.Boolean,
	keyDraft: Field.Model,
	isSavingKey: Schema.Boolean,
	removeDialog: Dialog.Model,
	isRemoving: Schema.Boolean,
	/** `AddOnUpsell`: the confirm before attaching the OpenRouter add-on, and the attach in flight. */
	addOnDialog: Dialog.Model,
	isAttachingAddOn: Schema.Boolean,
	triage: TriageData.schema,
	isToggling: Schema.Boolean,
	limits: Schema.NullOr(LimitsDraft),
	/** After a save, the saved ceilings it started from: the edits show until the refetch moves off them. */
	committedOver: Schema.NullOr(LimitsDraft),
	isSavingLimits: Schema.Boolean,
	isAdvancedOpen: Schema.Boolean,
})
export type Model = typeof Model.Type

export const LimitField = Schema.Literals(["maxRunsPerDay", "maxPassesPerDay"])
export type LimitField = typeof LimitField.Type

const done = <A extends Schema.Top>(schema: A) => ({ result: Schema.Result(schema, LoadFailure) })

export const Message = defineMessageUnion({
	CompletedFetchKey: done(OpenRouterKeyDocument),
	CompletedFetchTriage: done(AiTriageSettingsDocument),
	ClickedRetryKey: {},
	ClickedRetryTriage: {},
	PickedProvider: { provider: Provider },
	CompletedFocusProvider: {},
	ClickedReplace: {},
	ClickedCancelReplace: {},
	GotKeyDraftMessage: { message: Field.Message },
	SubmittedKey: {},
	CompletedSaveKey: done(OpenRouterKeyDocument),
	ClickedRemoveKey: {},
	GotRemoveDialogMessage: { message: Dialog.Message },
	ClickedConfirmRemove: {},
	CompletedRemoveKey: done(OpenRouterKeyDocument),
	ClickedAddOn: {},
	GotAddOnDialogMessage: { message: Dialog.Message },
	ClickedConfirmAddOn: {},
	CompletedAttachAddOn: done(AttachResult),
	CompletedOpenAddOnCheckout: {},
	ToggledTriage: {},
	CompletedToggleTriage: { isEnabled: Schema.Boolean, ...done(AiTriageSettingsDocument) },
	ChangedLimit: { field: LimitField, value: Schema.String },
	ToggledAdvanced: {},
	ClickedDiscardLimits: {},
	ClickedSaveLimits: {},
	CompletedSaveLimits: done(AiTriageSettingsDocument),
})
export type Message = typeof Message.Type
