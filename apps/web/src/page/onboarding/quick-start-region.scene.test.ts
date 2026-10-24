import type { Html, HtmlBuilder } from "foldkit/html"
import { change, click, Command, expect as expectView, given, Mount, role, scene, text } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import {
	ChooseRegion,
	FollowChosenRegion,
	init,
	Message,
	type Model,
	MountDitherField,
	update as updateWith,
} from "./quick-start"
import { DEFAULT_QUICK_START_STATE } from "./quick-start-state"
import * as QuickStartView from "./quick-start-view"

/** An org without a region holds no plan yet. */
const update = (model: Model, message: Message) => updateWith(model, message, false)

const loaded = (): Model => ({
	...init("maple-onboarding-v6-org_1", false, true).model,
	state: DEFAULT_QUICK_START_STATE,
})

const viewWith =
	(needsRegion: boolean) =>
	(model: Model, h: HtmlBuilder<Message>): Html =>
		QuickStartView.view(h, model, {
			accountCluster: (label) => label,
			teamStep: () => h.empty,
			planStep: h.empty,
			needsRegion,
			hasPlan: false,
			orgName: "Acme",
		}) ?? h.empty

describe("quick start region step", () => {
	test("an org without a region picks one first; Continue saves it and follows the answer", () => {
		scene(
			{ update, view: viewWith(true) },
			given(loaded()),
			Mount.resolve(MountDitherField, Message.CompletedMountDitherField()),
			expectView(role("heading", { name: "Where should your data live?" })).toExist(),
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

	test("once the region is set the wizard moves on to the plan", () => {
		scene(
			{ update, view: viewWith(false) },
			given(loaded()),
			Mount.resolve(MountDitherField, Message.CompletedMountDitherField()),
			expectView(role("heading", { name: "Where should your data live?" })).not.toExist(),
			expectView(text("Plan")).toExist(),
		)
	})
})
