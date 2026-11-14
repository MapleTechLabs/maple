import type { StatusPageVisibility } from "@maple/domain"
import type { V2StatusPage } from "@maple/domain/http/v2"
import {
	STATUS_PAGE_PASSWORD_MAX_LENGTH,
	STATUS_PAGE_PASSWORD_MIN_LENGTH,
} from "@maple/domain/status-page-access"
import { Option, Result } from "effect"
import type { LoadFailure } from "@maple/views/data/load-failure"
import { RemovePassword, SaveVisibility, SetPassword } from "./command"
import { type AccessAction, canChangeAccess, type Model } from "./model"
import { pageOf, type Return, toast } from "./reads"
import { withPage } from "./update-settings"

// The Settings tab's Access section: who can read the page, and its password. Each change saves
// at once through its own endpoint, admins only.

/** Why the typed password cannot be saved, or null when it can. */
export const passwordIssue = (draft: string): string | null =>
	draft.length < STATUS_PAGE_PASSWORD_MIN_LENGTH
		? `Use at least ${STATUS_PAGE_PASSWORD_MIN_LENGTH} characters`
		: draft.length > STATUS_PAGE_PASSWORD_MAX_LENGTH
			? `Use at most ${STATUS_PAGE_PASSWORD_MAX_LENGTH} characters`
			: null

const isIdle = (model: Model): model is Model & { pageId: NonNullable<Model["pageId"]> } =>
	model.pageId !== null && model.accessAction === null && canChangeAccess(model)

export const pickVisibility = (model: Model, visibility: StatusPageVisibility): Return => {
	const current = Option.map(pageOf(model), (page) => page.visibility)
	if (!isIdle(model) || Option.contains(current, visibility)) return { model }
	return {
		model: { ...model, accessAction: "visibility", accessFailure: null },
		commands: [SaveVisibility({ pageId: model.pageId, visibility })],
	}
}

export const openPassword = (model: Model): Return => ({
	model: { ...model, passwordDraft: "", accessFailure: null },
})

export const changePassword = (model: Model, value: string): Return =>
	model.passwordDraft === null ? { model } : { model: { ...model, passwordDraft: value } }

export const cancelPassword = (model: Model): Return => ({ model: { ...model, passwordDraft: null } })

export const submitPassword = (model: Model): Return => {
	const draft = model.passwordDraft
	if (!isIdle(model) || draft === null || passwordIssue(draft) !== null) return { model }
	return {
		model: { ...model, accessAction: "password", accessFailure: null },
		commands: [SetPassword(model.pageId, draft)],
	}
}

export const removePassword = (model: Model): Return =>
	isIdle(model)
		? {
				model: { ...model, accessAction: "removePassword", accessFailure: null },
				commands: [RemovePassword({ pageId: model.pageId })],
			}
		: { model }

const SAVED_COPY = {
	visibility: "Visibility saved",
	password: "Password saved",
	removePassword: "Password removed",
} as const satisfies Record<AccessAction, string>

export const changedAccess = (
	model: Model,
	action: AccessAction,
	result: Result.Result<V2StatusPage, LoadFailure>,
): Return =>
	Result.match(result, {
		onSuccess: (page): Return => ({
			model: {
				...withPage(model, page),
				accessAction: null,
				// The typed password is dropped once saved: nothing keeps it.
				passwordDraft: action === "password" ? null : model.passwordDraft,
			},
			outMessage: toast("success", SAVED_COPY[action]),
		}),
		onFailure: (accessFailure): Return => ({ model: { ...model, accessAction: null, accessFailure } }),
	})
