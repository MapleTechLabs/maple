import type { Html, HtmlBuilder } from "foldkit/html"
import { change, click, Command, expect as expectView, given, role, scene, text } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { ChooseRegion, FollowChosenRegion, init, Message, type Model, update } from "./quick-start"
import { DEFAULT_QUICK_START_STATE } from "./quick-start-state"
import * as QuickStartView from "./quick-start-view"

const loaded = (): Model => ({ ...init("maple-onboarding-v6-org_1", false, true).model, state: DEFAULT_QUICK_START_STATE })

const viewWith =
	(needsRegion: boolean) =>
	(model: Model, h: HtmlBuilder<Message>): Html =>
		QuickStartView.view(h, model, {
			accountCluster: (label) => label,
			teamStep: () => h.empty,
			planStep: h.empty,
			needsRegion,
		}) ?? h.empty

describe("quick start region step", () => {
	test("an org without a region picks one first; Continue saves it and follows the answer", () => {
		scene(
			{ update, view: viewWith(true) },
			given(loaded()),
			expectView(role("heading", { name: "Where should your data live?" })).toExist(),
			expectView(text("Step 1 of 5")).toExist(),
			change(role("radio", { name: "European Union" }), "on"),
			click(role("button", { name: /^Continue/ })),
			Command.expectExact(ChooseRegion({ region: "eu" })),
			Command.resolve(ChooseRegion, Message.SucceededChooseRegion({ region: "eu" })),
			Command.expectExact(FollowChosenRegion({ region: "eu" })),
			Command.resolve(FollowChosenRegion, Message.CompletedLeaveForRegion()),
		)
	})

	test("a refused save shows the API's message and frees the button", () => {
		const saving = update(loaded(), Message.ClickedRegionContinue()).model
		expect(update(saving, Message.ClickedRegionContinue()).commands ?? []).toEqual([])
		const failed = update(saving, Message.FailedChooseRegion({ message: "Region is locked" })).model
		expect(failed.region).toEqual({ selected: "us", isSaving: false, errorMessage: "Region is locked" })
	})

	test("once the region is set the wizard counts the region step it showed", () => {
		scene(
			{ update, view: viewWith(false) },
			given(loaded()),
			expectView(role("heading", { name: "What's your role?" })).toExist(),
			expectView(text("Step 2 of 5")).toExist(),
		)
	})
})
