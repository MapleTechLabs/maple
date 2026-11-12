import type { CostSourceSummary } from "@maple/domain/http"
import { cn } from "@maple/ui/lib/utils"
import { Array as Arr, String as Str } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "@maple/views/ui/button"
import { confirmDialog } from "@maple/views/ui/confirm-dialog"
import * as DialogView from "@maple/views/ui/dialog-view"
import { badge } from "@maple/views/ui/display"
import * as Field from "@maple/views/ui/field"
import { field, fieldDescription, fieldError, type FieldIds, fieldLabel, input } from "@maple/views/ui/field"
import { formDialogForm } from "@maple/views/ui/form-dialog"
import { icon } from "@maple/views/ui/icon"
import { listRow } from "@maple/views/ui/list-row"
import { vstack } from "@maple/views/ui/stack"
import { textLink } from "@maple/views/ui/text-link"
import { typography } from "@maple/views/ui/typography"
import { AppRoute, hrefOf } from "../../route"
import { type CredentialSource, credentialSource } from "./credential-sources"
import { Message } from "./message"
import type { Model } from "./model"
import { COST_PROVIDERS, type CostProviderEntry, CredentialProvider } from "./providers"

type H = HtmlBuilder<Message>

const CONNECT_AWS_HREF = hrefOf(AppRoute.SourcesNew({ search: { integration: "aws" } }))

/** Where an AWS connection and its Cost module are changed. */
export const AWS_INTEGRATION_HREF = hrefOf(AppRoute.Integrations({ search: { integration: "aws" } }))

/** Whether the org has `provider`'s source, which there is at most one of. */
const hasSourceOf = (sources: ReadonlyArray<CostSourceSummary>, provider: CredentialProvider): boolean =>
	Arr.some(sources, (source) => source.provider === provider)

const mark = (h: H, provider: CostProviderEntry): Html =>
	icon(h, provider.icon, { size: 18, className: cn("shrink-0", provider.iconClassName) })

/** A provider added by pasting a credential: to its form, or named as added once its source exists. */
const credentialRow = (
	h: H,
	provider: CredentialProvider,
	sources: ReadonlyArray<CostSourceSummary>,
	isLast: boolean,
): Html => {
	const entry: CostProviderEntry = COST_PROVIDERS[provider]
	const { pick } = credentialSource(provider)
	return hasSourceOf(sources, provider)
		? listRow(h, {
				divided: !isLast,
				leading: mark(h, entry),
				title: entry.name,
				meta: pick.addedMeta,
				trailing: badge(h, { variant: "muted", size: "sm" }, ["Already added"]),
			})
		: listRow(h, {
				divided: !isLast,
				onClick: Message.PickedProvider({ provider }),
				leading: mark(h, entry),
				title: entry.name,
				meta: pick.meta,
				trailing: icon(h, "ChevronRightIcon", { size: 14 }),
			})
}

/** The providers to add: AWS goes to its connect flow, the others to their credential form. */
const providers = (h: H, sources: ReadonlyArray<CostSourceSummary>): Html =>
	vstack(h, { gap: "3" }, [
		vstack(h, { gap: "0" }, [
			listRow(h, {
				divided: true,
				href: CONNECT_AWS_HREF,
				leading: mark(h, COST_PROVIDERS.aws),
				title: COST_PROVIDERS.aws.name,
				meta: "Daily cost by service, region and usage type",
				trailing: icon(h, "ChevronRightIcon", { size: 14 }),
			}),
			...Arr.map(CredentialProvider.literals, (provider, index) =>
				credentialRow(h, provider, sources, index === CredentialProvider.literals.length - 1),
			),
		]),
		typography(h, { size: "xs", tone: "muted", as: "p", className: "font-prose" }, [
			"AWS bills USD\u00a00.01 for each request Maple makes, a few dollars a month per account. OpenRouter and Cloudflare requests are free. ",
			textLink(h, { href: AWS_INTEGRATION_HREF, tone: "inherit", className: "underline" }, [
				"Turn on Cost for an AWS account that is connected",
			]),
			".",
		]),
	])

const KEY_IDS: FieldIds = {
	control: "cost-source-credential",
	label: "cost-source-credential-label",
	error: "cost-source-credential-error",
	description: "cost-source-credential-description",
}

const keyField = (h: H, model: Model, { field: text }: CredentialSource): Html => {
	const state = Field.stateOf(model.keyDraft, model.keyError !== null)
	return field(h, { state }, [
		fieldLabel(h, { ids: KEY_IDS, state }, text.label),
		input(h, {
			ids: KEY_IDS,
			state,
			attributes: [
				h.Type("password"),
				h.Attribute("autocomplete", "off"),
				h.Placeholder(text.placeholder),
				...(model.sourceWrite === "Saving" ? [h.Disabled(true)] : []),
				...Field.controlAttributes(h, model.keyDraft, (message) =>
					Message.GotKeyDraftMessage({ message }),
				),
			],
		}),
		...(model.keyError === null
			? []
			: [fieldError(h, { ids: KEY_IDS, state, attributes: [h.Role("alert")] }, [model.keyError])]),
		fieldDescription(h, { ids: KEY_IDS, state }, [
			text.help.before,
			textLink(
				h,
				{
					href: text.help.href,
					tone: "inherit",
					className: "underline",
					attributes: [h.Target("_blank"), h.Rel("noreferrer")],
				},
				[text.help.link],
			),
			text.help.after,
		]),
	])
}

/** The chosen provider's credential form: adding its source, or replacing the credential of the one that exists. */
const credentialForm = (
	h: H,
	model: Model,
	provider: CredentialProvider,
	sources: ReadonlyArray<CostSourceSummary>,
	close: Parameters<DialogView.ViewInputs["toContent"]>[0],
): Html => {
	const id = model.addDialog.id
	const source = credentialSource(provider)
	const isReplacing = hasSourceOf(sources, provider)
	const isSaving = model.sourceWrite === "Saving"
	const canSubmit = !isSaving && Str.trim(model.keyDraft.value) !== ""
	const text = isReplacing ? source.replace : source.add
	return formDialogForm(h, canSubmit ? Message.SubmittedKey() : undefined, [
		DialogView.dialogHeader(h, "dialog", [
			DialogView.dialogTitle(h, "dialog", id, text.title),
			DialogView.dialogDescription(h, "dialog", id, text.description),
		]),
		DialogView.dialogPanel(h, "dialog", id, [keyField(h, model, source)]),
		DialogView.dialogFooter(h, "dialog", [
			// A replace has no providers to go back to.
			isReplacing
				? button(
						h,
						{ variant: "outline", isDisabled: isSaving, attributes: isSaving ? [] : [...close] },
						["Cancel"],
					)
				: button(
						h,
						{
							variant: "outline",
							isDisabled: isSaving,
							attributes: [h.OnClick(Message.ClickedBackToProviders())],
						},
						["Back"],
					),
			button(h, { type: "submit", isLoading: isSaving, isDisabled: !canSubmit }, [
				isReplacing ? source.replace.label : "Add source",
			]),
		]),
	])
}

/**
 * Add a source, or replace a source's credential: the providers first, then the chosen one's
 * form. Opened on the form for a replace.
 */
export const addSourceDialog = (h: H, model: Model, sources: ReadonlyArray<CostSourceSummary>): Html => {
	const id = model.addDialog.id
	const step = model.addStep
	return h.submodel({
		slotId: "cost-add-source",
		model: model.addDialog,
		view: DialogView.view,
		toParentMessage: (message) => Message.GotAddDialogMessage({ message }),
		viewInputs: {
			hasTrigger: false,
			hasDescription: true,
			toView: ({ portal }) => portal ?? h.empty,
			toContent: (close) =>
				step === "pick"
					? [
							DialogView.dialogHeader(h, "dialog", [
								DialogView.dialogTitle(h, "dialog", id, "Add a cost source"),
								DialogView.dialogDescription(
									h,
									"dialog",
									id,
									"Maple reads what the source bills each day and keeps it next to your telemetry.",
								),
							]),
							DialogView.dialogPanel(h, "dialog", id, [providers(h, sources)]),
							DialogView.dialogFooter(h, "dialog", [
								button(h, { variant: "outline", attributes: [...close] }, ["Close"]),
							]),
						]
					: [credentialForm(h, model, step, sources, close)],
		},
	})
}

/** Removing a credential's source: what leaves the page, and what adding it again brings back. */
export const removeSourceDialog = (h: H, model: Model): Html => {
	const { remove } = credentialSource(model.removeProvider)
	return confirmDialog(h, {
		slotId: "cost-remove-source",
		model: model.removeDialog,
		toParentMessage: (message) => Message.GotRemoveDialogMessage({ message }),
		title: remove.title,
		description: remove.description,
		confirmLabel: "Remove source",
		onConfirm: Message.ClickedConfirmRemove(),
		isPending: model.sourceWrite === "Removing",
	})
}
