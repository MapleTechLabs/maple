import { GithubPrReviewSettingsResponse, PrReviewRepositoryConfig, VcsRepositoryId } from "@maple/domain/http"
import { Option, Result, Schema } from "effect"
import { expect as expectView, given, role, scene, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { toLoadFailure } from "../../../data/load-failure"
import { requestKey } from "../../../data/request-key"
import * as Select from "../../../ui/select"
import { emptyRetained } from "../kit/retained"
import { context, githubStatusOf, names, NOW } from "../kit/test-fixtures"
import * as RulesForm from "../rules-form/form"
import { Message, type Model } from "./model"
import { init, retainedOf, update } from "./update"
import { view as pageView } from "./view"

const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const settings = Schema.decodeUnknownSync(GithubPrReviewSettingsResponse)({
	settings: {
		model: "anthropic/claude-sonnet-5.5",
		defaults: { instructions: "Check OrgId.", dailyLimit: 40 },
	},
})
const INFRA = Schema.decodeSync(VcsRepositoryId)("00000c01-0000-4000-8000-000000000001")
const WEB = Schema.decodeSync(VcsRepositoryId)("00000c01-0000-4000-8000-000000000002")

const view = withViewInputs(pageView, { context })()

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

	test("a rules save during a model save waits for it, then writes both changes", () => {
		const settingsArgs = (result: {
			readonly commands?: ReadonlyArray<{ readonly name: string; readonly args?: unknown }>
		}) =>
			(result.commands ?? [])
				.filter((command) => command.name === "SaveCodeReviewSettings")
				.map((command) => command.args)
		const picked = pageUpdate(
			loaded().model,
			Message.GotModelSelectMessage({
				message: Select.Message.SelectedItem({ index: 8, value: "anthropic/claude-haiku-5.5" }),
			}),
		)
		const edited = pageUpdate(
			picked.model,
			Message.GotDefaultsFormMessage({
				message: RulesForm.Message.ChangedText({ field: "instructions", value: "Be terse." }),
			}),
		).model
		const queued = pageUpdate(
			edited,
			Message.GotDefaultsFormMessage({ message: RulesForm.Message.ClickedSave() }),
		)
		expect(settingsArgs(queued)).toEqual([])
		const modelSaved = pageUpdate(
			queued.model,
			Message.CompletedSaveSettings({ purpose: "model", label: "Claude Haiku", result: Result.void }),
		)
		expect(settingsArgs(modelSaved)).toEqual([
			{
				purpose: "defaults",
				label: "",
				settings: expect.objectContaining({
					model: "anthropic/claude-haiku-5.5",
					defaults: expect.objectContaining({ instructions: "Be terse." }),
				}),
			},
		])
		expect(names(modelSaved.commands)).not.toContain("FetchCodeReviewSettings")
		const rulesSaved = pageUpdate(
			modelSaved.model,
			Message.CompletedSaveSettings({ purpose: "defaults", label: "", result: Result.void }),
		)
		expect(names(rulesSaved.commands)).toEqual(["FetchCodeReviewSettings"])
	})

	test("a switch's re-read is sent even while the status read is still in flight", () => {
		const model = loaded().model
		const toggled = pageUpdate(
			model,
			Message.ToggledRepo({ repositoryId: INFRA, fullName: "acme-shop/infra", isEnabled: true }),
		).model
		const saved = pageUpdate(
			toggled,
			Message.CompletedSetPrReview({
				repositoryId: INFRA,
				fullName: "acme-shop/infra",
				isEnabled: true,
				result: Result.void,
			}),
		)
		expect(names(saved.commands)).toEqual(["FetchCodeReviewSettingsStatus"])
		const late = pageUpdate(
			saved.model,
			Message.CompletedFetchStatus({
				key: model.githubStatus.key ?? "",
				result: Result.succeed(githubStatusOf([{ name: "infra", reviewed: false }])),
			}),
		).model
		expect(late.githubStatus).toEqual(saved.model.githubStatus)
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

	test("a failed save rolls back to the last confirmed value, not the stale read", () => {
		const saves = (result: {
			readonly commands?: ReadonlyArray<{ readonly name: string; readonly args?: unknown }>
		}) =>
			(result.commands ?? [])
				.filter((command) => command.name === "SaveCodeReviewSettings")
				.map((command) => command.args)
		const form = (model: Model, message: RulesForm.Message) =>
			pageUpdate(model, Message.GotDefaultsFormMessage({ message }))
		const typed = (model: Model, value: string) =>
			form(model, RulesForm.Message.ChangedText({ field: "instructions", value })).model
		// A lands, then B goes out before the settings re-read answers, with a model pick queued behind it.
		const savingA = form(typed(loaded().model, "Rules A."), RulesForm.Message.ClickedSave()).model
		const savedA = pageUpdate(
			savingA,
			Message.CompletedSaveSettings({ purpose: "defaults", label: "", result: Result.void }),
		)
		const savingB = form(typed(savedA.model, "Rules B."), RulesForm.Message.ClickedSave()).model
		const picked = pageUpdate(
			savingB,
			Message.GotModelSelectMessage({
				message: Select.Message.SelectedItem({ index: 8, value: "anthropic/claude-haiku-5.5" }),
			}),
		).model
		const failedB = pageUpdate(
			picked,
			Message.CompletedSaveSettings({
				purpose: "defaults",
				label: "",
				result: Result.fail(toLoadFailure("boom")),
			}),
		)
		expect(saves(failedB)).toEqual([
			{
				purpose: "model",
				label: expect.any(String),
				settings: expect.objectContaining({
					model: "anthropic/claude-haiku-5.5",
					defaults: expect.objectContaining({ instructions: "Rules A." }),
				}),
			},
		])
	})

	test("repository A's late save neither re-keys nor settles repository B's open rules", () => {
		const listed = pageUpdate(
			loaded().model,
			Message.CompletedFetchStatus({
				key: loaded().model.githubStatus.key ?? "",
				result: Result.succeed(
					githubStatusOf([
						{ name: "infra", reviewed: true },
						{ name: "web", reviewed: true },
					]),
				),
			}),
		).model
		const onB = pageUpdate(
			pageUpdate(listed, Message.ClickedConfigure({ repositoryId: INFRA })).model,
			Message.ClickedConfigure({ repositoryId: WEB }),
		).model
		const late = pageUpdate(
			onB,
			Message.CompletedSaveRepoConfig({
				repositoryId: INFRA,
				fullName: "acme-shop/infra",
				result: Result.void,
			}),
		)
		expect(late.model.configuring).toBe(WEB)
		expect(late.model.repoConfig.key).toBe(onB.repoConfig.key)
		expect(late.model.repoForm).toBe(onB.repoForm)
		expect(names(late.commands)).toEqual([])
		expect(late.outMessage?._tag === "RequestedToast" ? late.outMessage.title : null).toBe(
			"Rules saved for acme-shop/infra",
		)
	})
})

describe("code review settings, entered from another tab", () => {
	const status = githubStatusOf([
		{ name: "infra", reviewed: false },
		{ name: "web", reviewed: true },
	])
	const carried = () => {
		const key = requestKey(context.orgId, "integrations.githubStatus", {})
		return init({}, context, {
			retained: { ...emptyRetained, githubStatus: { [key]: { value: status, usedAtMs: NOW } } },
			nowMs: NOW,
		})
	}

	test("the handed-over status pins the reviewed repositories on entry", () => {
		expect(carried().model.repoList.pinned).toEqual([WEB])
	})

	test("a status re-read after a switch is still handed over to the next entry", () => {
		const saved = pageUpdate(
			loaded().model,
			Message.CompletedSetPrReview({
				repositoryId: INFRA,
				fullName: "acme-shop/infra",
				isEnabled: true,
				result: Result.void,
			}),
		).model
		const reread = pageUpdate(
			saved,
			Message.CompletedFetchStatus({
				key: saved.githubStatus.key ?? "",
				result: Result.succeed(status),
			}),
		).model
		const entered = init({}, context, {
			retained: { ...emptyRetained, ...retainedOf(reread, NOW) },
			nowMs: NOW,
		})
		expect(entered.model.repoList.pinned).toEqual([WEB])
	})
})

describe("review model select", () => {
	test("is disabled for a non-admin and while a pick saves", () => {
		const model = loaded().model
		scene(
			{ update: pageUpdate, view },
			given({ ...model, isAdmin: false }),
			expectView(role("combobox", { name: "Review model" })).toBeDisabled(),
		)
		scene(
			{ update: pageUpdate, view },
			given({ ...model, isSavingModel: true }),
			expectView(role("combobox", { name: "Review model" })).toBeDisabled(),
		)
		scene(
			{ update: pageUpdate, view },
			given(model),
			expectView(role("combobox", { name: "Review model" })).toBeEnabled(),
		)
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
