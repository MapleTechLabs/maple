import { AiTriageSettingsDocument, AttachResult, OpenRouterKeyDocument } from "@maple/domain/http"
import { Result, Schema, Array as Arr } from "effect"
import { expect as expectView, given, role, scene, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { Message } from "./model"
import { init, isLimitsDirty, update } from "./update"
import { view as aiView } from "./view"

const triage = Schema.decodeSync(AiTriageSettingsDocument)({
	enabled: true,
	maxRunsPerDay: 50,
	maxPassesPerDay: 300,
	usage: { runs: 6, passes: 31 },
	ordinaryPaused: false,
	priorityPaused: false,
	pausedDimension: null,
	resumesAt: null,
	updatedAt: null,
	updatedBy: null,
})

const loaded = () =>
	update(init(true).model, Message.CompletedFetchTriage({ result: Result.succeed(triage) })).model

describe("ai tab", () => {
	test("entry reads the key and, when available, the triage settings", () => {
		expect(Arr.map(init(true).commands ?? [], (command) => command.name)).toContain(
			"FetchAiTriageSettings",
		)
		expect(Arr.map(init(false).commands ?? [], (command) => command.name)).toEqual(["FetchOpenRouterKey"])
	})

	test("a changed ceiling is dirty, saves only that ceiling and stays shown until the refetch moves", () => {
		const edited = update(loaded(), Message.ChangedLimit({ field: "maxRunsPerDay", value: "80" })).model
		expect(isLimitsDirty(edited)).toBe(true)
		const saving = update(edited, Message.ClickedSaveLimits())
		expect(saving.commands?.[0]).toMatchObject({
			name: "UpdateAiTriageSettings",
			args: { maxRunsPerDay: 80 },
		})
		const saved = update(
			saving.model,
			Message.CompletedSaveLimits({ result: Result.succeed(triage) }),
		).model
		expect(isLimitsDirty(saved)).toBe(false)
		expect(saved.limits?.maxRunsPerDay).toBe("80")
	})

	test("edits typed while the limits save wait, so the save's echo cannot drop them", () => {
		const edited = update(loaded(), Message.ChangedLimit({ field: "maxRunsPerDay", value: "80" })).model
		const saving = update(edited, Message.ClickedSaveLimits()).model
		const typed = update(saving, Message.ChangedLimit({ field: "maxRunsPerDay", value: "90" })).model
		expect(typed.limits?.maxRunsPerDay).toBe("80")
		expect(update(typed, Message.ClickedDiscardLimits()).model.limits?.maxRunsPerDay).toBe("80")
	})

	test("a key save and a key remove never run together", () => {
		const key = new OpenRouterKeyDocument({
			entitled: true,
			configured: true,
			keyHint: "sk-...abcd",
			updatedAt: null,
			updatedBy: null,
		})
		const withKey = update(init(false).model, Message.CompletedFetchKey({ result: Result.succeed(key) })).model
		const typed = update(
			withKey,
			Message.GotKeyDraftMessage({ message: { _tag: "ChangedValue", value: "sk-new" } }),
		).model
		const saving = update(typed, Message.SubmittedKey()).model
		expect(update(saving, Message.ClickedConfirmRemove()).commands ?? []).toEqual([])
		const saved = update(saving, Message.CompletedSaveKey({ result: Result.succeed(key) })).model
		const removing = update(saved, Message.ClickedConfirmRemove())
		expect(Arr.map(removing.commands ?? [], (command) => command.name)).toEqual(["RemoveOpenRouterKey"])
		const again = update(
			removing.model,
			Message.GotKeyDraftMessage({ message: { _tag: "ChangedValue", value: "sk-other" } }),
		).model
		expect(update(again, Message.SubmittedKey()).commands ?? []).toEqual([])
	})

	test("an invalid ceiling blocks the save", () => {
		const edited = update(loaded(), Message.ChangedLimit({ field: "maxRunsPerDay", value: "0" })).model
		expect(update(edited, Message.ClickedSaveLimits()).commands ?? []).toEqual([])
	})

	test("an org without the add-on can add it: confirm, attach, then checkout or a refetch", () => {
		const key = new OpenRouterKeyDocument({
			entitled: false,
			configured: false,
			keyHint: null,
			updatedAt: null,
			updatedBy: null,
		})
		const unentitled = update(
			init(false).model,
			Message.CompletedFetchKey({ result: Result.succeed(key) }),
		).model
		const picked = update(unentitled, Message.PickedProvider({ provider: "openrouter" })).model
		scene(
			{ update, view: withViewInputs(aiView, {})() },
			given(picked),
			expectView(role("button", { name: "Add to plan" })).toExist(),
		)
		const attaching = update(update(picked, Message.ClickedAddOn()).model, Message.ClickedConfirmAddOn())
		expect(Arr.map(attaching.commands ?? [], (command) => command.name)).toEqual([
			"AttachOpenRouterAddOn",
		])
		expect(update(attaching.model, Message.ClickedConfirmAddOn()).commands ?? []).toEqual([])
		const checkout = update(
			attaching.model,
			Message.CompletedAttachAddOn({
				result: Result.succeed(new AttachResult({ paymentUrl: "https://checkout.stripe.com/x" })),
			}),
		)
		expect(Arr.map(checkout.commands ?? [], (command) => command.name)).toContain(
			"OpenOpenRouterAddOnCheckout",
		)
		const attached = update(
			attaching.model,
			Message.CompletedAttachAddOn({ result: Result.succeed(new AttachResult({})) }),
		)
		expect(Arr.map(attached.commands ?? [], (command) => command.name)).toContain("FetchOpenRouterKey")
		expect(attached.outMessage).toMatchObject({
			_tag: "RequestedCustomerRefresh",
			toast: { type: "success", title: "Add-on added" },
		})
	})
})
