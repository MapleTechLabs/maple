import { StatusPageAutoIncidents } from "@maple/domain"
import type {
	V2StatusPage,
	V2StatusPageBreakGlassToken,
	V2StatusPagePublishResult,
} from "@maple/domain/http/v2"
import { Option, Result, Schema, String as Str } from "effect"
import { AsyncData, Command as FoldkitCommand, File } from "foldkit"
import type { LoadFailure } from "@maple/views/data/load-failure"
import * as CopyButton from "@maple/views/ui/copy-button"
import * as Dialog from "@maple/views/ui/dialog"
import { type PageContext, PageOutMessage } from "../../contract"
import { statusPageHref, statusPagesHref } from "../shared/commands"
import { SLUG_TAKEN } from "../shared/slug"
import {
	DeletePage,
	PickBrandingImage,
	PublishPage,
	ReadBrandingImage,
	RevokeToken,
	RotateToken,
	SaveSettings,
} from "./command"
import {
	type BrandingField,
	hasSettingsIssues,
	httpsIssue,
	imageUploadIssue,
	isSameSettings,
	type SettingsForm,
	type SettingsTextField,
	type ThemeForm,
	settingsFormOf,
	settingsPayload,
} from "../shared/form"
import { Message } from "./message"
import { canBreakGlass, canManage, type BreakGlassAction, type Model } from "./model"
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
				[field]: field === "slug" ? Str.toLowerCase(Str.trim(value)) : value,
			}))

export const changeTheme = (model: Model, change: Partial<ThemeForm>): Return =>
	withSettings(model, (form) => ({ ...form, theme: { ...form.theme, ...change } }))

export const togglePoweredBy = (model: Model): Return =>
	withSettings(model, (form) => ({ ...form, showPoweredBy: !form.showPoweredBy }))

export const pickBrandingImage = (model: Model, field: BrandingField): Return =>
	canManage(model) ? { model, commands: [PickBrandingImage({ field })] } : { model }

/** A dropped or picked logo or favicon: read into the form when the API would take it. */
export const takeBrandingImage = (
	model: Model,
	field: BrandingField,
	files: ReadonlyArray<File.File>,
): Return => {
	const settled = { ...model, brandingDrag: null }
	const file = files[0]
	if (file === undefined || !canManage(model)) return { model: settled }
	const issue = imageUploadIssue({ type: File.mimeType(file), size: File.size(file) })
	const read = model.brandingRead + 1
	return issue === null
		? { model: { ...settled, brandingRead: read }, commands: [ReadBrandingImage({ field, read, file })] }
		: { model: settled, outMessage: toast("error", "Couldn't use that image", issue) }
}

export const brandingDialog = (model: Model, step: ReturnType<typeof Dialog.update>): Return =>
	liftDialog(
		model,
		step,
		(next, brandingDialog) => ({ ...next, brandingDialog }),
		(message) => Message.GotBrandingDialogMessage({ message }),
	)

/** Opens the upload-or-link dialog on the image, its link prefilled when it is one. */
export const editBrandingImage = (model: Model, field: BrandingField): Return => {
	if (!canManage(model)) return { model }
	const current = Option.match(settingsOf(model), { onNone: () => "", onSome: (form) => Str.trim(form[field]) })
	const link = Str.startsWith("https://")(current) ? current : ""
	return brandingDialog(
		{
			...model,
			brandingDialogField: field,
			brandingLink: link,
			brandingDrag: null,
			brandingRead: model.brandingRead + 1,
		},
		Dialog.open(model.brandingDialog),
	)
}

/** The image takes the value, and the dialog closes if it was open. */
const applyBrandingImage = (model: Model, field: BrandingField, value: string): Return => {
	const changed = changeSetting(model, field, value)
	return changed.model.brandingDialog.isOpen
		? brandingDialog(changed.model, Dialog.close(changed.model.brandingDialog))
		: changed
}

/** A finished file read; one superseded by a later upload, link, removal or discard is dropped. */
export const readBrandingImage = (
	model: Model,
	field: BrandingField,
	read: number,
	dataUrl: string | null,
): Return =>
	read !== model.brandingRead
		? { model }
		: dataUrl === null
			? { model, outMessage: toast("error", "Couldn't read that image") }
			: applyBrandingImage(model, field, dataUrl)

export const removeBrandingImage = (model: Model, field: BrandingField): Return =>
	changeSetting({ ...model, brandingRead: model.brandingRead + 1 }, field, "")

export const submitBrandingLink = (model: Model): Return => {
	const link = Str.trim(model.brandingLink)
	return link === "" || httpsIssue(link) !== null
		? { model }
		: applyBrandingImage({ ...model, brandingRead: model.brandingRead + 1 }, model.brandingDialogField, link)
}

export const saveSettings = (model: Model): Return => {
	const edits = model.settingsEdits
	return model.pageId === null ||
		edits === null ||
		model.isSavingSettings ||
		model.isApplyingJson ||
		!canManage(model) ||
		hasSettingsIssues(edits)
		? { model }
		: {
				model: { ...model, isSavingSettings: true, settingsFailure: null },
				commands: [SaveSettings({ pageId: model.pageId, payload: settingsPayload(edits) })],
			}
}

/** The saved page replaces the read; edits made while it was in flight stay. */
export const withPage = (model: Model, page: V2StatusPage): Model => ({
	...model,
	page: { ...model.page, data: AsyncData.map(model.page.data, () => page) },
})

export const savedSettings = (model: Model, result: Result.Result<V2StatusPage, LoadFailure>): Return =>
	Result.match(result, {
		onSuccess: (page): Return => {
			const next = withPage({ ...model, isSavingSettings: false, takenSlug: null }, page)
			const isCaughtUp =
				next.settingsEdits !== null && isSameSettings(next.settingsEdits, settingsFormOf(page))
			return {
				model: isCaughtUp ? { ...next, settingsEdits: null } : next,
				outMessage: toast("success", "Settings saved"),
			}
		},
		// A taken address is the field's error, not the form's.
		onFailure: (settingsFailure): Return => ({
			model:
				settingsFailure.code === SLUG_TAKEN && model.settingsEdits !== null
					? { ...model, isSavingSettings: false, takenSlug: model.settingsEdits.slug }
					: { ...model, isSavingSettings: false, settingsFailure },
		}),
	})

export const publish = (model: Model): Return =>
	model.pageId === null || model.isPublishing || !canManage(model)
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
	const wasDraft = Option.match(pageOf(model), { onNone: () => false, onSome: (page) => page.draft })
	return Result.match(result, {
		// A draft going public gets the live screen; a published page a toast.
		onSuccess: (outcome): Return =>
			wasDraft && model.pageId !== null
				? {
						...readPage(context, "Supersede")(settled),
						outMessage: PageOutMessage.RequestedNavigation({
							url: statusPageHref(model.pageId, "live"),
							isReplace: false,
						}),
					}
				: {
						...readPage(context, "Supersede")(settled),
						outMessage: toast(
							"success",
							PUBLISH_COPY[outcome.outcome],
							outcome.outcome === "queued" ? "It goes out with the next minutely publish." : "",
						),
					},
		onFailure: (failure): Return => ({
			model: settled,
			outMessage: errorToast("Couldn't publish", failure),
		}),
	})
}

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
	if (!canBreakGlass(model)) return { model }
	const hasToken = Option.match(pageOf(model), {
		onNone: () => false,
		onSome: (page) => page.break_glass_token_suffix !== null,
	})
	if (action === "rotate" && !hasToken) return runBreakGlass({ ...model, breakGlassAction: "rotate" })
	return breakGlassDialog({ ...model, breakGlassAction: action }, Dialog.open(model.breakGlassDialog))
}

export const runBreakGlass = (model: Model): Return => {
	const action = model.breakGlassAction
	return model.pageId === null || action === null || model.isChangingBreakGlass || !canBreakGlass(model)
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

export const deletePageDialog = (model: Model, step: ReturnType<typeof Dialog.update>): Return =>
	liftDialog(
		model,
		step,
		(next, deletePageDialog) => ({ ...next, deletePageDialog }),
		(message) => Message.GotDeletePageDialogMessage({ message }),
	)

export const confirmDeletePage = (model: Model): Return =>
	model.pageId === null || model.isDeletingPage || !canManage(model)
		? { model }
		: { model: { ...model, isDeletingPage: true }, commands: [DeletePage({ pageId: model.pageId })] }

export const deletedPage = (model: Model, result: Result.Result<void, LoadFailure>): Return => {
	const settled = { ...model, isDeletingPage: false }
	return Result.match(result, {
		onSuccess: (): Return => ({
			...deletePageDialog(settled, Dialog.close(settled.deletePageDialog)),
			outMessage: PageOutMessage.RequestedNavigation({
				url: statusPagesHref(),
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
