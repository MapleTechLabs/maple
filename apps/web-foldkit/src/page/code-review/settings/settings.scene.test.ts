import { GithubPrReviewSettingsResponse, PrReviewRepositoryConfig, VcsRepositoryId } from "@maple/domain/http"
import { Option, Result, Schema } from "effect"
import { describe, expect, test } from "vitest"
import * as Select from "../../../ui/select"
import { context, githubStatusOf, names } from "../kit/test-fixtures"
import * as RulesForm from "../rules-form/form"
import { Message, type Model } from "./model"
import { init, update } from "./update"

const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const settings = Schema.decodeUnknownSync(GithubPrReviewSettingsResponse)({
	settings: {
		model: "anthropic/claude-sonnet-5.5",
		defaults: { instructions: "Check OrgId.", dailyLimit: 40 },
	},
})
const INFRA = Schema.decodeSync(VcsRepositoryId)("00000c01-0000-4000-8000-000000000001")

const loaded = () => {
	const entry = init({}, context).model
	const withSettings = pageUpdate(
		entry,
		Message.CompletedFetchSettings({ key: entry.settings.key ?? "", result: Result.succeed(settings) }),
	)
	return withSettings
}

describe("code review settings", () => {
	test("entry reads the settings; the repositories once the settings are in", () => {
		expect(names(init({}, context).commands)).toEqual(["FetchCodeReviewSettings"])
		expect(names(loaded().commands)).toEqual(["FetchCodeReviewSettingsStatus"])
		expect(loaded().model.defaultsForm?.state.instructions).toBe("Check OrgId.")
	})

	test("picking a model saves it with the defaults riding along", () => {
		const model = loaded().model
		const picked = pageUpdate(
			model,
			Message.GotModelSelectMessage({
				message: Select.Message.SelectedItem({ index: 8, value: "anthropic/claude-haiku-5.5" }),
			}),
		)
		expect(names(picked.commands)).toContain("SaveCodeReviewSettings")
		expect(picked.model.isSavingModel).toBe(true)
		expect(picked.model.modelSelect.value).toBe("anthropic/claude-sonnet-5.5")
	})

	test("a repository's switch sends one write while it is in flight", () => {
		const model = pageUpdate(
			loaded().model,
			Message.CompletedFetchStatus({
				key: loaded().model.githubStatus.key ?? "",
				result: Result.succeed(githubStatusOf([{ name: "infra", reviewed: false }])),
			}),
		).model
		const toggle = Message.ToggledRepo({
			repositoryId: INFRA,
			fullName: "acme-shop/infra",
			isEnabled: true,
		})
		const first = pageUpdate(model, toggle)
		expect(names(first.commands)).toEqual(["SetCodeReviewPrReview"])
		expect(names(pageUpdate(first.model, toggle).commands)).toEqual([])
	})
})

describe("review rules form", () => {
	const form = RulesForm.init(
		"defaults",
		"organization",
		new PrReviewRepositoryConfig({ dailyLimit: 40 }),
		null,
	)

	test("Save reports the config with built-in defaults left out", () => {
		const edited = RulesForm.update(
			form,
			RulesForm.Message.ChangedText({ field: "instructions", value: " Be terse. " }),
		)
		const saved = RulesForm.update(edited.model, RulesForm.Message.ClickedSave())
		expect(saved.outMessage?.config).toEqual(
			new PrReviewRepositoryConfig({ instructions: "Be terse.", dailyLimit: 40 }),
		)
		expect(saved.model.isSaving).toBe(true)
	})

	test("an edit made while saving survives the refetched config", () => {
		const saving = RulesForm.update(form, RulesForm.Message.ClickedSave()).model
		const editing = RulesForm.update(
			saving,
			RulesForm.Message.ChangedText({ field: "dailyLimit", value: "12" }),
		)
		const settled = RulesForm.completeSave(editing.model, Option.none())
		const synced = RulesForm.syncConfig(settled, new PrReviewRepositoryConfig({ dailyLimit: 40 }))
		expect(synced.state.dailyLimit).toBe("12")
	})

	test("Reset puts back what was saved", () => {
		const edited = RulesForm.update(form, RulesForm.Message.ToggledSwitch({ field: "reviewDrafts" }))
		expect(edited.model.state.reviewDrafts).toBe("on")
		expect(
			RulesForm.update(edited.model, RulesForm.Message.ClickedReset()).model.state.reviewDrafts,
		).toBe("off")
	})
})
