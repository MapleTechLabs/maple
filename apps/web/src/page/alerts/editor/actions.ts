import {
	buildRuleCreateParamsV2,
	buildRuleTestParamsV2,
	isRulePreviewReady,
} from "@maple/web-data/alerts/form-utils"
import { Result } from "effect"
import { PageOutMessage } from "../../contract"
import { alertsHref } from "../shared/links"
import { RunRuleTest, SaveRule, TrackRuleCreated } from "./command"
import { previewIdentityKey, saveIssues } from "./derive"
import { draftPreviewOf } from "./derive-rows"
import type { Message } from "./message"
import type { Model } from "./model"
import type { Return } from "./steps"

// The writes: Dry run and Send test (`runTest`), and Create / Save changes (`handleSave`).

const errorToast = (title: string, description = ""): PageOutMessage =>
	PageOutMessage.RequestedToast({ type: "error", title, description })

/** `runTest`: a form that cannot be previewed yet says so instead of asking. */
export const runTest = (model: Model, isSending: boolean): Return => {
	const form = model.form
	if (form === null || model.isDryRunning || model.isSendingTest) return { model }
	if (!isRulePreviewReady(form))
		return { model, outMessage: errorToast("Complete the rule name, query, and threshold before testing") }
	return {
		model: isSending ? { ...model, isSendingTest: true } : { ...model, isDryRunning: true },
		commands: [RunRuleTest({ key: previewIdentityKey(form), payload: buildRuleTestParamsV2(form, isSending) })],
	}
}

export const completeTest = (model: Model, message: Extract<Message, { _tag: "CompletedTest" }>): Return => {
	const settled: Model = message.isSending ? { ...model, isSendingTest: false } : { ...model, isDryRunning: false }
	return Result.match(message.result, {
		onSuccess: (dryRun) => ({
			model: { ...settled, dryRun },
			outMessage: PageOutMessage.RequestedToast({
				type: "success",
				title: message.isSending ? "Preview ran and sent a test notification" : "Preview updated",
				description: "",
			}),
		}),
		onFailure: (error) => ({ model: settled, outMessage: errorToast("Failed to preview rule", error.message) }),
	})
}

/** `handleSave`: the ready form as create (or update) params; success lands on `/alerts`. */
export const save = (model: Model): Return => {
	const form = model.form
	if (form === null || model.isSaving) return { model }
	if (saveIssues(form, draftPreviewOf(model, form).preview?.queryTiming ?? null).length > 0) return { model }
	return {
		model: { ...model, isSaving: true },
		commands: [SaveRule({ ruleId: model.editingRuleId, payload: buildRuleCreateParamsV2(form) })],
	}
}

export const completeSave = (model: Model, message: Extract<Message, { _tag: "CompletedSave" }>): Return =>
	Result.match(message.result, {
		onSuccess: () => ({
			model: { ...model, isSaving: false },
			commands:
				model.editingRuleId === null && model.form !== null ? [TrackRuleCreated({ signal: model.form.signalType })] : [],
			outMessage: PageOutMessage.RequestedNavigation({
				url: alertsHref({}),
				isReplace: false,
				toast: {
					type: "success",
					title: model.editingRuleId === null ? "Rule created" : "Rule updated",
					description: "",
				},
			}),
		}),
		onFailure: (error) => ({
			model: { ...model, isSaving: false },
			outMessage: errorToast("Failed to save rule", error.message),
		}),
	})
