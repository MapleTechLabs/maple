import { AiTriageSettingsDocument, AttachResult, OpenRouterKeyDocument } from "@maple/domain/http"
import { Result, Schema } from "effect"
import { expect as expectView, given, role, scene, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { Message } from "./model"
import { init, isLimitsDirty, update } from "./update"
import { view as aiView } from "./view"

const triage = Schema.decodeUnknownSync(AiTriageSettingsDocument)({
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
		expect(init(true).commands?.map((command) => command.name)).toContain("FetchAiTriageSettings")
		expect(init(false).commands?.map((command) => command.name)).toEqual(["FetchOpenRouterKey"])
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
		expect(attaching.commands?.map((command) => command.name)).toEqual(["AttachOpenRouterAddOn"])
		expect(update(attaching.model, Message.ClickedConfirmAddOn()).commands ?? []).toEqual([])
		const checkout = update(
			attaching.model,
			Message.CompletedAttachAddOn({
				result: Result.succeed(new AttachResult({ paymentUrl: "https://checkout.stripe.com/x" })),
			}),
		)
		expect(checkout.commands?.map((command) => command.name)).toContain("OpenOpenRouterAddOnCheckout")
		const attached = update(
			attaching.model,
			Message.CompletedAttachAddOn({ result: Result.succeed(new AttachResult({})) }),
		)
		expect(attached.commands?.map((command) => command.name)).toContain("FetchOpenRouterKey")
		expect(attached.outMessage).toMatchObject({
			_tag: "RequestedCustomerRefresh",
			toast: { type: "success", title: "Add-on added" },
		})
	})
})
