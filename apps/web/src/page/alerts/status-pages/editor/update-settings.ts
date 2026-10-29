import { StatusPageAutoIncidents } from "@maple/domain"
import type {
	V2StatusPage,
	V2StatusPageBreakGlassToken,
	V2StatusPagePublishResult,
} from "@maple/domain/http/v2"
import { Option, Result, Schema } from "effect"
import { AsyncData, Command as FoldkitCommand } from "foldkit"
import type { LoadFailure } from "../../../../data/load-failure"
import * as CopyButton from "../../../../ui/copy-button"
import * as Dialog from "../../../../ui/dialog"
import { type PageContext, PageOutMessage } from "../../../contract"
import { statusPagesTabHref } from "../../shared/status-page-commands"
import { DeletePage, PublishPage, RevokeToken, RotateToken, SaveSettings } from "./command"
import {
	hasSettingsIssues,
	isSameSettings,
	type SettingsForm,
	type SettingsTextField,
	type ThemeForm,
	settingsFormOf,
	settingsPayload,
} from "./form"
import { Message } from "./message"
import type { BreakGlassAction, Model } from "./model"
import { errorToast, liftDialog, pageOf, readPage, type Return, toast } from "./reads"

// The Settings tab: the page's fields behind a save bar, Publish now, the break-glass token, delete.

const decodeAutoIncidents = Schema.decodeUnknownOption(StatusPageAutoIncidents)

/** What the form shows: the edits, else the saved page. */
export const settingsOf = (model: Model): Option.Option<SettingsForm> =>
	model.settingsEdits === null
		? Option.map(pageOf(model), settingsFormOf)
		: Option.some(model.settingsEdits)

export const isSettingsDirty = (model: Model): boolean =>
	model.settingsEdits !== null &&
	Option.match(pageOf(model), {
		onNone: () => false,
		onSome: (page) =>
			model.settingsEdits !== null && !isSameSettings(model.settingsEdits, settingsFormOf(page)),
	})

const withSettings = (model: Model, change: (form: SettingsForm) => SettingsForm): Return =>
	Option.match(settingsOf(model), {
		onNone: () => ({ model }),
		onSome: (form) => ({ model: { ...model, settingsEdits: change(form) } }),
	})

export const changeSetting = (model: Model, field: SettingsTextField, value: string): Return =>
	field === "autoIncidents"
		? Option.match(decodeAutoIncidents(value), {
				onNone: () => ({ model }),
				onSome: (autoIncidents) => withSettings(model, (form) => ({ ...form, autoIncidents })),
			})
		: withSettings(model, (form) => ({
				...form,
				[field]: field === "slug" ? value.trim().toLowerCase() : value,
			}))

export const changeTheme = (model: Model, change: Partial<ThemeForm>): Return =>
	withSettings(model, (form) => ({ ...form, theme: { ...form.theme, ...change } }))

export const togglePoweredBy = (model: Model): Return =>
	withSettings(model, (form) => ({ ...form, showPoweredBy: !form.showPoweredBy }))

export const saveSettings = (model: Model): Return => {
	const edits = model.settingsEdits
	return model.pageId === null ||
		edits === null ||
		model.isSavingSettings ||
		model.isApplyingJson ||
		!model.isAdmin ||
		hasSettingsIssues(edits)
		? { model }
		: {
				model: { ...model, isSavingSettings: true, settingsFailure: null },
				commands: [SaveSettings({ pageId: model.pageId, payload: settingsPayload(edits) })],
			}
}

/** The saved page replaces the read; edits made while it was in flight stay. */
const withPage = (model: Model, page: V2StatusPage): Model => ({
	...model,
	page: { ...model.page, data: AsyncData.map(model.page.data, () => page) },
})

export const savedSettings = (model: Model, result: Result.Result<V2StatusPage, LoadFailure>): Return =>
	Result.match(result, {
		onSuccess: (page): Return => {
			const next = withPage({ ...model, isSavingSettings: false }, page)
			const isCaughtUp =
				next.settingsEdits !== null && isSameSettings(next.settingsEdits, settingsFormOf(page))
			return {
				model: isCaughtUp ? { ...next, settingsEdits: null } : next,
				outMessage: toast("success", "Settings saved"),
			}
		},
		onFailure: (settingsFailure): Return => ({
			model: { ...model, isSavingSettings: false, settingsFailure },
		}),
	})

export const publish = (model: Model): Return =>
	model.pageId === null || model.isPublishing || !model.isAdmin
		? { model }
		: { model: { ...model, isPublishing: true }, commands: [PublishPage({ pageId: model.pageId })] }

const PUBLISH_COPY = {
	published: "Published",
	unchanged: "Already up to date",
	queued: "Publish queued",
} as const satisfies Record<V2StatusPagePublishResult["outcome"], string>

export const published = (
	model: Model,
	result: Result.Result<V2StatusPagePublishResult, LoadFailure>,
	context: PageContext,
): Return => {
	const settled = { ...model, isPublishing: false }
	return Result.match(result, {
		onSuccess: (outcome): Return => ({
			...readPage(context, "Supersede")(settled),
			outMessage: toast(
				"success",
				PUBLISH_COPY[outcome.outcome],
				outcome.outcome === "queued" ? "It goes out with the next minutely publish." : "",
			),
		}),
		onFailure: (failure): Return => ({
			model: settled,
			outMessage: errorToast("Couldn't publish", failure),
		}),
	})
}

// BREAK-GLASS

export const breakGlassDialog = (model: Model, step: ReturnType<typeof Dialog.update>): Return => {
	const lifted = liftDialog(
		model,
		step,
		(next, breakGlassDialog) => ({ ...next, breakGlassDialog }),
		(message) => Message.GotBreakGlassDialogMessage({ message }),
	)
	return step.outMessage?._tag === "Closed"
		? { ...lifted, model: { ...lifted.model, breakGlassAction: null } }
		: lifted
}

/** The first token is issued at once; replacing or revoking one asks first. */
export const askBreakGlass = (model: Model, action: BreakGlassAction): Return => {
	const hasToken = Option.match(pageOf(model), {
		onNone: () => false,
		onSome: (page) => page.break_glass_token_suffix !== null,
	})
	if (action === "rotate" && !hasToken) return runBreakGlass({ ...model, breakGlassAction: "rotate" })
	return breakGlassDialog({ ...model, breakGlassAction: action }, Dialog.open(model.breakGlassDialog))
}

export const runBreakGlass = (model: Model): Return => {
	const action = model.breakGlassAction
	return model.pageId === null || action === null || model.isChangingBreakGlass || !model.isAdmin
		? { model }
		: {
				model: { ...model, isChangingBreakGlass: true },
				commands: [
					action === "rotate"
						? RotateToken({ pageId: model.pageId })
						: RevokeToken({ pageId: model.pageId }),
				],
			}
}

const closeBreakGlass = (model: Model): Return =>
	model.breakGlassDialog.isOpen
		? breakGlassDialog(model, Dialog.close(model.breakGlassDialog))
		: { model: { ...model, breakGlassAction: null } }

export const rotated = (
	model: Model,
	result: Result.Result<V2StatusPageBreakGlassToken, LoadFailure>,
	context: PageContext,
): Return => {
	const settled = { ...model, isChangingBreakGlass: false }
	return Result.match(result, {
		onSuccess: (token): Return => {
			const closed = closeBreakGlass({
				...settled,
				revealedToken: { token: token.token, suffix: token.token_suffix },
				tokenCopy: CopyButton.init(),
			})
			const refreshed = readPage(context, "Supersede")(closed.model)
			return {
				model: refreshed.model,
				commands: [...(closed.commands ?? []), ...(refreshed.commands ?? [])],
			}
		},
		onFailure: (failure): Return => ({
			model: settled,
			outMessage: errorToast("Couldn't issue a token", failure),
		}),
	})
}

export const revoked = (model: Model, result: Result.Result<V2StatusPage, LoadFailure>): Return => {
	const settled = { ...model, isChangingBreakGlass: false }
	return Result.match(result, {
		onSuccess: (page): Return => ({
			...closeBreakGlass(withPage({ ...settled, revealedToken: null }, page)),
			outMessage: toast("success", "Break-glass token revoked"),
		}),
		onFailure: (failure): Return => ({
			model: settled,
			outMessage: errorToast("Couldn't revoke the token", failure),
		}),
	})
}

export const updateTokenCopy = (model: Model, message: CopyButton.Message): Return => {
	const step = CopyButton.update(model.tokenCopy, message)
	return {
		model: { ...model, tokenCopy: step.model },
		commands: FoldkitCommand.mapMessages(step.commands ?? [], (child) =>
			Message.GotTokenCopyMessage({ message: child }),
		),
	}
}

// DELETE

export const deletePageDialog = (model: Model, step: ReturnType<typeof Dialog.update>): Return =>
	liftDialog(
		model,
		step,
		(next, deletePageDialog) => ({ ...next, deletePageDialog }),
		(message) => Message.GotDeletePageDialogMessage({ message }),
	)

export const confirmDeletePage = (model: Model): Return =>
	model.pageId === null || model.isDeletingPage || !model.isAdmin
		? { model }
		: { model: { ...model, isDeletingPage: true }, commands: [DeletePage({ pageId: model.pageId })] }

export const deletedPage = (model: Model, result: Result.Result<void, LoadFailure>): Return => {
	const settled = { ...model, isDeletingPage: false }
	return Result.match(result, {
		onSuccess: (): Return => ({
			...deletePageDialog(settled, Dialog.close(settled.deletePageDialog)),
			outMessage: PageOutMessage.RequestedNavigation({
				url: statusPagesTabHref(),
				isReplace: true,
				toast: { type: "success", title: "Status page deleted", description: "" },
			}),
		}),
		onFailure: (failure): Return => ({
			model: settled,
			outMessage: errorToast("Couldn't delete the status page", failure),
		}),
	})
}
