import type { StatusPageVisibility } from "@maple/domain"
import type { V2StatusPage } from "@maple/domain/http/v2"
import {
	STATUS_PAGE_PASSWORD_MAX_LENGTH,
	STATUS_PAGE_PASSWORD_MIN_LENGTH,
} from "@maple/domain/status-page-access"
import { Option, Result } from "effect"
import { AsyncData } from "foldkit"
import type { LoadFailure } from "@maple/views/data/load-failure"
import { RemovePassword, SaveVisibility, SetPassword } from "./command"
import { type AccessAction, canChangeAccess, type Model } from "./model"
import { pageOf, type Return, toast } from "./reads"
import { customDomainOf } from "./update-domain"
import { withPage } from "./update-settings"

// Basic settings' Who can view: who can read the page, and its password, picked as a draft
// and saved together with the save bar, admins only. Each part saves through its own endpoint, in
// an order that never leaves the page behind a password it lacks.

/** Why the typed password cannot be saved, or null when it can. */
export const passwordIssue = (draft: string): string | null =>
	draft.length < STATUS_PAGE_PASSWORD_MIN_LENGTH
		? `Use at least ${STATUS_PAGE_PASSWORD_MIN_LENGTH} characters`
		: draft.length > STATUS_PAGE_PASSWORD_MAX_LENGTH
			? `Use at most ${STATUS_PAGE_PASSWORD_MAX_LENGTH} characters`
			: null

/** Who can view as picked: the draft, else the page's. */
export const draftVisibility = (model: Model, page: V2StatusPage): StatusPageVisibility =>
	model.visibilityDraft ?? page.visibility

/** Why an option cannot be picked or saved now, or null when it can. */
export const blockedReason = (
	model: Model,
	page: V2StatusPage,
	value: StatusPageVisibility,
): string | null => {
	if (value !== "internal" || page.visibility === "internal") return null
	// An internal page answers no custom domain, so one must be known to be absent first.
	return Option.match(customDomainOf(model), {
		onSome: (domain) => (domain.hostname === null ? null : "Remove the custom domain first."),
		onNone: () =>
			AsyncData.hasError(model.customDomain.data)
				? "Couldn't check for a custom domain. Try again above."
				: "Checking for a custom domain…",
	})
}

export const isAccessDirty = (model: Model): boolean =>
	model.visibilityDraft !== null || model.passwordDraft !== ""

/** Why the draft cannot be saved, or null when it can. A password page needs a password. */
export const accessIssue = (model: Model, page: V2StatusPage): string | null => {
	const visibility = draftVisibility(model, page)
	if (visibility !== "password") return blockedReason(model, page, visibility)
	if (model.passwordDraft === "") return page.has_password ? null : "Type a password for visitors."
	return passwordIssue(model.passwordDraft) === null ? null : "Fix the password above."
}

/** Saving leaves the page open with a stored password, which nothing shows outside password mode. */
export const removesPassword = (model: Model, page: V2StatusPage): boolean =>
	page.has_password && draftVisibility(model, page) !== "password"

const isIdle = (model: Model): boolean => model.accessAction === null && canChangeAccess(model)

export const pickVisibility = (model: Model, visibility: StatusPageVisibility): Return =>
	Option.match(pageOf(model), {
		onNone: (): Return => ({ model }),
		onSome: (page): Return =>
			isIdle(model)
				? {
						model: {
							...model,
							visibilityDraft: visibility === page.visibility ? null : visibility,
							// The password field leaves with Password-protected, and what was typed in it.
							passwordDraft: visibility === "password" ? model.passwordDraft : "",
						},
					}
				: { model },
	})

export const changePassword = (model: Model, value: string): Return =>
	isIdle(model) ? { model: { ...model, passwordDraft: value } } : { model }

export const discardAccess = (model: Model): Return => ({
	model: { ...model, visibilityDraft: null, passwordDraft: "", accessFailure: null },
})

/** The next part of the save: the typed password, then the visibility, then a password left over. */
const saveNext = (model: Model, page: V2StatusPage): Return => {
	if (model.passwordDraft !== "")
		return {
			model: { ...model, accessAction: "password" },
			commands: [SetPassword(page.id, model.passwordDraft)],
		}
	if (model.visibilityDraft !== null)
		return {
			model: { ...model, accessAction: "visibility" },
			commands: [SaveVisibility({ pageId: page.id, visibility: model.visibilityDraft })],
		}
	if (removesPassword(model, page))
		return {
			model: { ...model, accessAction: "removePassword" },
			commands: [RemovePassword({ pageId: page.id })],
		}
	return { model: { ...model, accessAction: null }, outMessage: toast("success", "Access saved") }
}

export const saveAccess = (model: Model): Return =>
	Option.match(pageOf(model), {
		onNone: (): Return => ({ model }),
		onSome: (page): Return =>
			isIdle(model) && isAccessDirty(model) && accessIssue(model, page) === null
				? saveNext({ ...model, accessFailure: null }, page)
				: { model },
	})

/** What a saved part takes off the draft. */
const SAVED = {
	password: { passwordDraft: "" },
	visibility: { visibilityDraft: null },
	removePassword: {},
} as const satisfies Record<AccessAction, Partial<Model>>

/** A part saved moves on to the next; a failure stops there, keeping what is still unsaved. */
export const changedAccess = (
	model: Model,
	action: AccessAction,
	result: Result.Result<V2StatusPage, LoadFailure>,
): Return =>
	Result.match(result, {
		onSuccess: (page): Return => saveNext({ ...withPage(model, page), ...SAVED[action] }, page),
		onFailure: (accessFailure): Return => ({ model: { ...model, accessAction: null, accessFailure } }),
	})
