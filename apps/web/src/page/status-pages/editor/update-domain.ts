import type { V2StatusPage, V2StatusPageCustomDomain } from "@maple/domain/http/v2"
import { customDomainIssue, normalizeCustomDomain } from "@maple/domain/status-page"
import { Option, Result } from "effect"
import { AsyncData, Command as FoldkitCommand } from "foldkit"
import * as Keyed from "@maple/views/data/keyed"
import type { LoadFailure } from "@maple/views/data/load-failure"
import { requestKey } from "@maple/views/data/request-key"
import * as CopyButton from "@maple/views/ui/copy-button"
import * as Dialog from "@maple/views/ui/dialog"
import type { PageContext } from "../../contract"
import { canonicalUrl } from "../shared/commands"
import { CheckCustomDomain, FetchCustomDomain, RemoveCustomDomain, SetCustomDomain } from "./command"
import { Message } from "./message"
import { canManage, type Model } from "./model"
import { errorToast, liftDialog, type Return, toast } from "./reads"

// The Settings tab's Custom domain section: set, check and remove the page's domain.

const customDomainKey = (context: PageContext, pageId: string) =>
	requestKey(context.orgId, "statusPages.getCustomDomain", { pageId })

export const readCustomDomain =
	(context: PageContext, mode: Keyed.ReadMode) =>
	(model: Model): Return => {
		const id = model.pageId
		if (id === null) return { model }
		return Option.match(Keyed.requestFor(model.customDomain, customDomainKey(context, id), mode), {
			onNone: () => ({ model }),
			onSome: (customDomain) => ({
				model: { ...model, customDomain },
				commands: [FetchCustomDomain({ key: customDomain.key, pageId: id })],
			}),
		})
	}

export const customDomainOf = (model: Model): Option.Option<V2StatusPageCustomDomain> =>
	AsyncData.getData(model.customDomain.data)

/** The custom domain serving the page, once it is active. */
export const activeCustomDomain = (model: Model): string | null =>
	Option.match(customDomainOf(model), {
		onNone: () => null,
		onSome: (domain) => (domain.status === "active" ? domain.hostname : null),
	})

/** Where visitors read the page: its active custom domain, else its Maple address; null with neither. */
export const pageUrlOf = (model: Model, page: Pick<V2StatusPage, "slug">): string | null =>
	canonicalUrl(model.publicBaseUrl, page.slug, activeCustomDomain(model))

/** The hostname field: the draft, else the saved domain. */
export const customDomainInput = (model: Model): string =>
	model.customDomainDraft ??
	Option.match(customDomainOf(model), {
		onNone: () => "",
		onSome: (domain) => domain.hostname ?? "",
	})

/** Why the typed hostname cannot be saved yet, or null; an untouched field shows nothing. */
export const customDomainDraftIssue = (model: Model): string | null =>
	model.customDomainDraft === null
		? null
		: customDomainIssue(normalizeCustomDomain(model.customDomainDraft))

/** The answer replaces the read, so the section shows the domain as the server left it. */
const withDomain = (model: Model, domain: V2StatusPageCustomDomain): Model => ({
	...model,
	customDomain: {
		...model.customDomain,
		data: AsyncData.isSuccess(model.customDomain.data)
			? AsyncData.map(model.customDomain.data, () => domain)
			: AsyncData.Success({ data: domain }),
	},
})

export const changeCustomDomain = (model: Model, value: string): Return => ({
	model: { ...model, customDomainDraft: value, customDomainFailure: null },
})

export const submitCustomDomain = (model: Model): Return => {
	const draft = model.customDomainDraft
	if (
		model.pageId === null ||
		draft === null ||
		model.customDomainAction !== null ||
		!canManage(model) ||
		customDomainDraftIssue(model) !== null
	)
		return { model }
	return {
		model: { ...model, customDomainAction: "set", customDomainFailure: null },
		commands: [SetCustomDomain({ pageId: model.pageId, hostname: normalizeCustomDomain(draft) })],
	}
}

export const savedCustomDomain = (
	model: Model,
	result: Result.Result<V2StatusPageCustomDomain, LoadFailure>,
): Return => {
	const settled = { ...model, customDomainAction: null }
	return Result.match(result, {
		onSuccess: (domain): Return => ({
			model: { ...withDomain(settled, domain), customDomainDraft: null },
			outMessage: toast("success", "Custom domain saved", "Add the DNS records below."),
		}),
		onFailure: (customDomainFailure): Return => ({ model: { ...settled, customDomainFailure } }),
	})
}

export const checkCustomDomain = (model: Model): Return =>
	model.pageId === null || model.customDomainAction !== null || !canManage(model)
		? { model }
		: {
				model: { ...model, customDomainAction: "check", customDomainFailure: null },
				commands: [CheckCustomDomain({ pageId: model.pageId })],
			}

const CHECK_COPY = {
	pending_dns: "Still waiting for DNS",
	pending_ssl: "DNS found, the certificate is on its way",
	active: "Your custom domain is live",
	failed: "The domain needs attention",
} as const satisfies Record<NonNullable<V2StatusPageCustomDomain["status"]>, string>

export const checkedCustomDomain = (
	model: Model,
	result: Result.Result<V2StatusPageCustomDomain, LoadFailure>,
): Return => {
	const settled = { ...model, customDomainAction: null }
	return Result.match(result, {
		onSuccess: (domain): Return => ({
			model: withDomain(settled, domain),
			outMessage: toast(
				domain.status === "failed" ? "error" : "success",
				domain.status === null ? "Checked" : CHECK_COPY[domain.status],
			),
		}),
		onFailure: (failure): Return => ({
			model: settled,
			outMessage: errorToast("Couldn't check the domain", failure),
		}),
	})
}

export const removeCustomDomainDialog = (model: Model, step: ReturnType<typeof Dialog.update>): Return =>
	liftDialog(
		model,
		step,
		(next, removeCustomDomainDialog) => ({ ...next, removeCustomDomainDialog }),
		(message) => Message.GotRemoveCustomDomainDialogMessage({ message }),
	)

export const confirmRemoveCustomDomain = (model: Model): Return =>
	model.pageId === null || model.customDomainAction !== null || !canManage(model)
		? { model }
		: {
				model: { ...model, customDomainAction: "remove" },
				commands: [RemoveCustomDomain({ pageId: model.pageId })],
			}

export const removedCustomDomain = (
	model: Model,
	result: Result.Result<V2StatusPageCustomDomain, LoadFailure>,
): Return => {
	const settled = { ...model, customDomainAction: null }
	return Result.match(result, {
		onSuccess: (domain): Return => ({
			...removeCustomDomainDialog(
				{ ...withDomain(settled, domain), customDomainDraft: null, customDomainFailure: null },
				Dialog.close(settled.removeCustomDomainDialog),
			),
			outMessage: toast("success", "Custom domain removed"),
		}),
		onFailure: (failure): Return => ({
			model: settled,
			outMessage: errorToast("Couldn't remove the domain", failure),
		}),
	})
}

/** One copy status for every DNS value: a click on another row starts it afresh for that row. */
export const updateDnsCopy = (model: Model, key: string, message: CopyButton.Message): Return => {
	const isOther = model.dnsCopyKey !== key
	if (isOther && message._tag !== "ClickedCopy") return { model }
	const step = CopyButton.update(isOther ? CopyButton.init() : model.dnsCopy, message)
	return {
		model: { ...model, dnsCopy: step.model, dnsCopyKey: key },
		commands: FoldkitCommand.mapMessages(step.commands ?? [], (child) =>
			Message.GotDnsCopyMessage({ key, message: child }),
		),
	}
}
