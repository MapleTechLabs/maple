import { OPENROUTER_BYOK_ADDON_ID } from "@maple/domain/billing"
import { AiTriageSettingsUpdateRequest, AttachRequest, OpenRouterKeyUpdateRequest } from "@maple/domain/http"
import { buildCheckoutSuccessUrl } from "../../../lib/billing/checkout-return"
import { limitsUpdate } from "../../../components/settings/ai-triage-limits"
import { Effect, Option, Result, Schema } from "effect"
import { AsyncData, Command } from "foldkit"
import { trackProduct } from "../../../data/analytics"
import { toLoadFailure } from "../../../data/load-failure"
import { MapleInternalApiClient } from "../../../platform/api-clients"
import * as Dialog from "../../../ui/dialog"
import * as Field from "../../../ui/field"
import { PageOutMessage, type PageReturn } from "../../contract"
import { revisitData } from "../kit/revisit"
import { type LimitsDraft, Message, type Model } from "./model"

type Return = PageReturn<Model, Message>

const settle = <A, B>(toMessage: (result: Result.Result<A, ReturnType<typeof toLoadFailure>>) => B) =>
	<E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.mapError(toLoadFailure), Effect.result, Effect.map(toMessage))

export const FetchOpenRouterKey = Command.define("FetchOpenRouterKey", {
	messages: [Message.CompletedFetchKey],
	execute: Effect.flatMap(MapleInternalApiClient, (client) => client.openRouterKey.get()).pipe(
		settle((result) => Message.CompletedFetchKey({ result })),
	),
})

export const FetchTriageSettings = Command.define("FetchAiTriageSettings", {
	messages: [Message.CompletedFetchTriage],
	execute: Effect.flatMap(MapleInternalApiClient, (client) => client.aiTriage.getSettings()).pipe(
		settle((result) => Message.CompletedFetchTriage({ result })),
	),
})

const SaveOpenRouterKey = Command.define("SaveOpenRouterKey", {
	args: { apiKey: Schema.String },
	messages: [Message.CompletedSaveKey],
	execute: ({ apiKey }) =>
		Effect.flatMap(MapleInternalApiClient, (client) =>
			client.openRouterKey.set({ payload: new OpenRouterKeyUpdateRequest({ apiKey }) }),
		).pipe(settle((result) => Message.CompletedSaveKey({ result }))),
})

const RemoveOpenRouterKey = Command.define("RemoveOpenRouterKey", {
	messages: [Message.CompletedRemoveKey],
	execute: Effect.flatMap(MapleInternalApiClient, (client) => client.openRouterKey.remove()).pipe(
		settle((result) => Message.CompletedRemoveKey({ result })),
	),
})

/** `attach({ planId: OPENROUTER_BYOK_ADDON_ID, successUrl })`: Stripe returns to this tab. */
const AttachAddOn = Command.define("AttachOpenRouterAddOn", {
	messages: [Message.CompletedAttachAddOn],
	execute: Effect.gen(function* () {
		const client = yield* MapleInternalApiClient
		const successUrl = yield* Effect.sync(() => buildCheckoutSuccessUrl(window.location.href))
		return yield* client.billing.attach({ payload: new AttachRequest({ planId: OPENROUTER_BYOK_ADDON_ID, successUrl }) })
	}).pipe(settle((result) => Message.CompletedAttachAddOn({ result }))),
})

/** `plan_checkout_started`, then the tab leaves for Stripe (`useBillingActions().attach`). */
const OpenAddOnCheckout = Command.define("OpenOpenRouterAddOnCheckout", {
	args: { url: Schema.String },
	messages: [Message.CompletedOpenAddOnCheckout],
	execute: ({ url }) =>
		trackProduct("plan_checkout_started", { plan_id: OPENROUTER_BYOK_ADDON_ID }).pipe(
			Effect.andThen(
				Effect.sync(() => {
					window.location.href = url
				}),
			),
			Effect.as(Message.CompletedOpenAddOnCheckout()),
		),
})

const UpdateTriage = Command.define("UpdateAiTriageSettings", {
	args: {
		enabled: Schema.optional(Schema.Boolean),
		maxRunsPerDay: Schema.optional(Schema.Number),
		maxPassesPerDay: Schema.optional(Schema.Number),
		purpose: Schema.Literals(["toggle", "limits"]),
	},
	messages: [Message.CompletedToggleTriage, Message.CompletedSaveLimits],
	execute: ({ enabled, maxRunsPerDay, maxPassesPerDay, purpose }) =>
		Effect.flatMap(MapleInternalApiClient, (client) =>
			client.aiTriage.updateSettings({
				payload: new AiTriageSettingsUpdateRequest({
					...(enabled !== undefined && { enabled }),
					...(maxRunsPerDay !== undefined && { maxRunsPerDay }),
					...(maxPassesPerDay !== undefined && { maxPassesPerDay }),
				}),
			}),
		).pipe(
			settle((result) =>
				purpose === "toggle"
					? Message.CompletedToggleTriage({ isEnabled: enabled ?? false, result })
					: Message.CompletedSaveLimits({ result }),
			),
		),
})

export const init = (isTriageAvailable: boolean): Return => ({
	model: {
		isTriageAvailable,
		key: AsyncData.Loading(),
		picked: null,
		isReplacing: false,
		keyDraft: Field.init(),
		isSavingKey: false,
		removeDialog: Dialog.init("openrouter-remove", "alert-dialog"),
		isRemoving: false,
		addOnDialog: Dialog.init("openrouter-add-on", "alert-dialog"),
		isAttachingAddOn: false,
		triage: isTriageAvailable ? AsyncData.Loading() : AsyncData.Idle(),
		isToggling: false,
		limits: null,
		committedOver: null,
		isSavingLimits: false,
		isAdvancedOpen: false,
	},
	commands: [FetchOpenRouterKey(), ...(isTriageAvailable ? [FetchTriageSettings()] : [])],
})

const toast = (type: "success" | "error", title: string, description = "") =>
	PageOutMessage.RequestedToast({ type, title, description })

/** `reactivityKeys`: a write refetches the document behind it, keeping it on screen. */
const refresh = <A, E>(data: AsyncData.AsyncData<A, E>) => Option.getOrElse(AsyncData.revalidate(data), () => data)

const liftRemoveDialog = (model: Model, step: ReturnType<typeof Dialog.update>): Return => ({
	model: { ...model, removeDialog: step.model },
	commands: Command.mapMessages(step.commands ?? [], (message) => Message.GotRemoveDialogMessage({ message })),
})

const liftAddOnDialog = (model: Model, step: ReturnType<typeof Dialog.update>): Return => ({
	model: { ...model, addOnDialog: step.model },
	commands: Command.mapMessages(step.commands ?? [], (message) => Message.GotAddOnDialogMessage({ message })),
})

const isKeyInUse = (model: Model): boolean =>
	AsyncData.getOrElse(AsyncData.map(model.key, (key) => key.entitled && key.configured), () => false)

/** The draft the form shows: the edits, else the saved ceilings. */
export const limitsDraftOf = (model: Model) =>
	model.limits ??
	AsyncData.getOrElse(
		AsyncData.map(model.triage, (triage) => ({
			maxRunsPerDay: String(triage.maxRunsPerDay),
			maxPassesPerDay: String(triage.maxPassesPerDay),
		})),
		() => ({ maxRunsPerDay: "", maxPassesPerDay: "" }),
	)

export const isLimitsDirty = (model: Model): boolean =>
	model.limits !== null &&
	model.committedOver === null &&
	AsyncData.getOrElse(
		AsyncData.map(
			model.triage,
			(triage) =>
				model.limits?.maxRunsPerDay !== String(triage.maxRunsPerDay) ||
				model.limits?.maxPassesPerDay !== String(triage.maxPassesPerDay),
		),
		() => false,
	)

const sameLimits = (a: LimitsDraft, b: LimitsDraft) =>
	a.maxRunsPerDay === b.maxRunsPerDay && a.maxPassesPerDay === b.maxPassesPerDay

const saveLimits = (model: Model): Return =>
	Option.match(AsyncData.getData(model.triage), {
		onNone: () => ({ model }),
		onSome: (triage) => {
			const update = limitsUpdate(limitsDraftOf(model), triage)
			if (!update.ok || model.isSavingLimits) return { model }
			return {
				model: { ...model, isSavingLimits: true },
				commands: [
					UpdateTriage({
						purpose: "limits",
						...(update.maxRunsPerDay !== null && { maxRunsPerDay: update.maxRunsPerDay }),
						...(update.maxPassesPerDay !== null && { maxPassesPerDay: update.maxPassesPerDay }),
					}),
				],
			}
		},
	})

/** Back on the tab: the key and triage settings stay up while they load again. */
export const revisit = (model: Model): Return => {
	const key = revisitData(model.key, FetchOpenRouterKey)
	const triage = model.isTriageAvailable ? revisitData(model.triage, FetchTriageSettings) : { data: model.triage, commands: [] }
	return { model: { ...model, key: key.data, triage: triage.data }, commands: [...key.commands, ...triage.commands] }
}

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		CompletedFetchKey: ({ result }) => ({ model: { ...model, key: AsyncData.settle(model.key, result) } }),
		CompletedFetchTriage: ({ result }) => {
			const triage = AsyncData.settle(model.triage, result)
			const fetched = AsyncData.getOrElse(
				AsyncData.map(triage, (doc) => ({ maxRunsPerDay: String(doc.maxRunsPerDay), maxPassesPerDay: String(doc.maxPassesPerDay) })),
				() => null,
			)
			// `isSaveSettled`: the committed edits go once the saved value moved off its base or reached them.
			const isSettled =
				model.committedOver !== null &&
				fetched !== null &&
				(!sameLimits(fetched, model.committedOver) || (model.limits !== null && sameLimits(fetched, model.limits)))
			return {
				model: isSettled ? { ...model, triage, limits: null, committedOver: null } : { ...model, triage },
			}
		},
		ClickedRetryKey: () => ({ model: { ...model, key: AsyncData.Loading() }, commands: [FetchOpenRouterKey()] }),
		ClickedRetryTriage: () => ({ model: { ...model, triage: AsyncData.Loading() }, commands: [FetchTriageSettings()] }),
		PickedProvider: ({ provider }) =>
			provider === "managed" && isKeyInUse(model)
				? liftRemoveDialog(model, Dialog.open(model.removeDialog))
				: { model: { ...model, picked: provider } },
		CompletedFocusProvider: () => ({ model }),
		ClickedReplace: () => ({ model: { ...model, isReplacing: true } }),
		ClickedCancelReplace: () => ({ model: { ...model, isReplacing: false, keyDraft: Field.init() } }),
		GotKeyDraftMessage: ({ message: child }) => ({ model: { ...model, keyDraft: Field.update(model.keyDraft, child).model } }),
		SubmittedKey: () => {
			const apiKey = model.keyDraft.value.trim()
			return apiKey === "" || model.isSavingKey
				? { model }
				: { model: { ...model, isSavingKey: true }, commands: [SaveOpenRouterKey({ apiKey })] }
		},
		CompletedSaveKey: ({ result }) =>
			Result.match(result, {
				onSuccess: () => ({
					model: { ...model, isSavingKey: false, isReplacing: false, keyDraft: Field.init(), key: refresh(model.key) },
					commands: [FetchOpenRouterKey()],
					outMessage: toast("success", "OpenRouter key saved"),
				}),
				onFailure: (error) => ({
					model: { ...model, isSavingKey: false },
					outMessage: toast("error", "Couldn't save the key", error.message),
				}),
			}),
		ClickedRemoveKey: () => liftRemoveDialog(model, Dialog.open(model.removeDialog)),
		GotRemoveDialogMessage: ({ message: child }) =>
			model.isRemoving ? { model } : liftRemoveDialog(model, Dialog.update(model.removeDialog, child)),
		ClickedConfirmRemove: () =>
			model.isRemoving ? { model } : { model: { ...model, isRemoving: true }, commands: [RemoveOpenRouterKey()] },
		CompletedRemoveKey: ({ result }) => {
			const closed = liftRemoveDialog({ ...model, isRemoving: false }, Dialog.close(model.removeDialog))
			return Result.match(result, {
				onSuccess: () => ({
					model: { ...closed.model, picked: null, key: refresh(closed.model.key) },
					commands: [...(closed.commands ?? []), FetchOpenRouterKey()],
					outMessage: toast("success", "Switched to Maple managed"),
				}),
				onFailure: (error) => ({ ...closed, outMessage: toast("error", "Couldn't remove the key", error.message) }),
			})
		},
		ClickedAddOn: () => (model.isAttachingAddOn ? { model } : liftAddOnDialog(model, Dialog.open(model.addOnDialog))),
		GotAddOnDialogMessage: ({ message: child }) =>
			model.isAttachingAddOn ? { model } : liftAddOnDialog(model, Dialog.update(model.addOnDialog, child)),
		ClickedConfirmAddOn: () =>
			model.isAttachingAddOn ? { model } : { model: { ...model, isAttachingAddOn: true }, commands: [AttachAddOn()] },
		// With a card on file the attach charges at once; otherwise checkout follows.
		CompletedAttachAddOn: ({ result }) => {
			const closed = liftAddOnDialog({ ...model, isAttachingAddOn: false }, Dialog.close(model.addOnDialog))
			return Result.match(result, {
				onSuccess: ({ paymentUrl }) =>
					paymentUrl !== undefined && paymentUrl !== null && paymentUrl !== ""
						? { ...closed, commands: [...(closed.commands ?? []), OpenAddOnCheckout({ url: paymentUrl })] }
						: {
								model: { ...closed.model, key: refresh(closed.model.key) },
								commands: [...(closed.commands ?? []), FetchOpenRouterKey()],
								// The add-on is on the app's customer too: the root re-reads it.
								outMessage: PageOutMessage.RequestedCustomerRefresh({
									toast: { type: "success", title: "Add-on added", description: "" },
								}),
							},
				onFailure: (error) => ({ ...closed, outMessage: toast("error", "Couldn't add the add-on", error.message) }),
			})
		},
		CompletedOpenAddOnCheckout: () => ({ model }),
		ToggledTriage: () =>
			Option.match(AsyncData.getData(model.triage), {
				onNone: () => ({ model }),
				onSome: (triage) =>
					model.isToggling
						? { model }
						: {
								model: { ...model, isToggling: true },
								commands: [UpdateTriage({ purpose: "toggle", enabled: !triage.enabled })],
							},
			}),
		CompletedToggleTriage: ({ isEnabled, result }) =>
			Result.match(result, {
				onSuccess: () => ({
					model: { ...model, isToggling: false, triage: refresh(model.triage) },
					commands: [FetchTriageSettings()],
					outMessage: toast("success", isEnabled ? "Auto-triage turned on" : "Auto-triage turned off"),
				}),
				onFailure: (error) => ({
					model: { ...model, isToggling: false },
					outMessage: toast("error", "Couldn't update auto-triage settings", error.message),
				}),
			}),
		ChangedLimit: ({ field, value }) => ({
			model: { ...model, limits: { ...limitsDraftOf(model), [field]: value }, committedOver: null },
		}),
		ToggledAdvanced: () => ({ model: { ...model, isAdvancedOpen: !model.isAdvancedOpen } }),
		ClickedDiscardLimits: () => ({ model: { ...model, limits: null, committedOver: null } }),
		ClickedSaveLimits: () => saveLimits(model),
		CompletedSaveLimits: ({ result }) =>
			Result.match(result, {
				onSuccess: () => ({
					model: {
						...model,
						isSavingLimits: false,
						committedOver: AsyncData.getOrElse(
							AsyncData.map(model.triage, (doc) => ({
								maxRunsPerDay: String(doc.maxRunsPerDay),
								maxPassesPerDay: String(doc.maxPassesPerDay),
							})),
							() => null,
						),
						triage: refresh(model.triage),
					},
					commands: [FetchTriageSettings()],
					outMessage: toast("success", "Auto-triage limits saved"),
				}),
				onFailure: (error) => ({
					model: { ...model, isSavingLimits: false },
					outMessage: toast("error", "Couldn't update auto-triage settings", error.message),
				}),
			}),
	})
