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
import { Message } from "./message"
import type { Model, RemovableProvider } from "./model"
import { COST_PROVIDERS, type CostProviderEntry } from "./providers"
import { vercelStep } from "./view-add-vercel"

type H = HtmlBuilder<Message>

const CONNECT_AWS_HREF = hrefOf(AppRoute.SourcesNew({ search: { integration: "aws" } }))

/** Where an AWS connection and its Cost module are changed. */
export const AWS_INTEGRATION_HREF = hrefOf(AppRoute.Integrations({ search: { integration: "aws" } }))

const OPENROUTER_KEYS_URL = "https://openrouter.ai/settings/management-keys"

/** Whether the org has its source of a provider it can have one of at most. */
const hasSourceOf = (
	sources: ReadonlyArray<CostSourceSummary>,
	provider: CostSourceSummary["provider"],
): boolean => Arr.some(sources, (source) => source.provider === provider)

const mark = (h: H, provider: CostProviderEntry): Html =>
	icon(h, provider.icon, { size: 18, className: cn("shrink-0", provider.iconClassName) })

/** The providers to add: AWS goes to its connect flow, OpenRouter to the key form, Vercel to its team. */
const providers = (h: H, hasOpenRouter: boolean, hasVercel: boolean): Html =>
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
			hasOpenRouter
				? listRow(h, {
						divided: true,
						leading: mark(h, COST_PROVIDERS.openrouter),
						title: COST_PROVIDERS.openrouter.name,
						meta: "Replace its key in the Sources panel",
						trailing: badge(h, { variant: "muted", size: "sm" }, ["Already added"]),
					})
				: listRow(h, {
						divided: true,
						onClick: Message.ClickedAddOpenRouter(),
						leading: mark(h, COST_PROVIDERS.openrouter),
						title: COST_PROVIDERS.openrouter.name,
						meta: "Daily spend by model and serving provider",
						trailing: icon(h, "ChevronRightIcon", { size: 14 }),
					}),
			hasVercel
				? listRow(h, {
						leading: mark(h, COST_PROVIDERS.vercel),
						title: COST_PROVIDERS.vercel.name,
						meta: "Remove it in the Sources panel",
						trailing: badge(h, { variant: "muted", size: "sm" }, ["Already added"]),
					})
				: listRow(h, {
						onClick: Message.ClickedAddVercel(),
						leading: mark(h, COST_PROVIDERS.vercel),
						title: COST_PROVIDERS.vercel.name,
						meta: "Daily charges by product, project and region",
						trailing: icon(h, "ChevronRightIcon", { size: 14 }),
					}),
		]),
		typography(h, { size: "xs", tone: "muted", as: "p", className: "font-prose" }, [
			"AWS bills USD\u00a00.01 for each request Maple makes, a few dollars a month per account. OpenRouter and Vercel requests are free. ",
			textLink(h, { href: AWS_INTEGRATION_HREF, tone: "inherit", className: "underline" }, [
				"Turn on Cost for an AWS account that is connected",
			]),
			".",
		]),
	])

const KEY_IDS: FieldIds = {
	control: "cost-openrouter-key",
	label: "cost-openrouter-key-label",
	error: "cost-openrouter-key-error",
	description: "cost-openrouter-key-description",
}

const keyField = (h: H, model: Model): Html => {
	const state = Field.stateOf(model.keyDraft, model.keyError !== null)
	return field(h, { state }, [
		fieldLabel(h, { ids: KEY_IDS, state }, "Management key"),
		input(h, {
			ids: KEY_IDS,
			state,
			attributes: [
				h.Type("password"),
				h.Attribute("autocomplete", "off"),
				h.Placeholder("sk-or-v1-..."),
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
			"Create one under ",
			textLink(
				h,
				{
					href: OPENROUTER_KEYS_URL,
					tone: "inherit",
					className: "underline",
					attributes: [h.Target("_blank"), h.Rel("noreferrer")],
				},
				["Management keys"],
			),
			" in OpenRouter. A regular API key cannot read spend. Maple checks the key with OpenRouter, then stores it encrypted.",
		]),
	])
}

/**
 * Add a source, or replace the OpenRouter key: the providers first, then the chosen one's step.
 * Opened on the key form for a replace, which has no providers to go back to.
 */
export const addSourceDialog = (h: H, model: Model, sources: ReadonlyArray<CostSourceSummary>): Html => {
	const id = model.addDialog.id
	const isReplacing = hasSourceOf(sources, "openrouter")
	const isSaving = model.sourceWrite === "Saving"
	const canSubmit = !isSaving && Str.trim(model.keyDraft.value) !== ""
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
				model.addStep === "vercel"
					? vercelStep(h, model, id)
					: model.addStep === "pick"
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
								DialogView.dialogPanel(h, "dialog", id, [
									providers(h, isReplacing, hasSourceOf(sources, "vercel")),
								]),
								DialogView.dialogFooter(h, "dialog", [
									button(h, { variant: "outline", attributes: [...close] }, ["Close"]),
								]),
							]
						: [
								formDialogForm(h, canSubmit ? Message.SubmittedKey() : undefined, [
									DialogView.dialogHeader(h, "dialog", [
										DialogView.dialogTitle(
											h,
											"dialog",
											id,
											isReplacing ? "Replace the OpenRouter key" : "Add OpenRouter",
										),
										DialogView.dialogDescription(
											h,
											"dialog",
											id,
											isReplacing
												? "The source and its history stay. Use a key from the same OpenRouter account."
												: "Maple reads the last four weeks at once, then every day from here on.",
										),
									]),
									DialogView.dialogPanel(h, "dialog", id, [keyField(h, model)]),
									DialogView.dialogFooter(h, "dialog", [
										isReplacing
											? button(
													h,
													{
														variant: "outline",
														isDisabled: isSaving,
														attributes: isSaving ? [] : [...close],
													},
													["Cancel"],
												)
											: button(
													h,
													{
														variant: "outline",
														isDisabled: isSaving,
														attributes: [
															h.OnClick(Message.ClickedBackToProviders()),
														],
													},
													["Back"],
												),
										button(
											h,
											{
												type: "submit",
												isLoading: isSaving,
												isDisabled: !canSubmit,
											},
											[isReplacing ? "Replace key" : "Add source"],
										),
									]),
								]),
							],
		},
	})
}

/** What removing each provider's source takes away, and what adding it again brings back. */
const REMOVAL = {
	openrouter: {
		title: "Remove the OpenRouter source?",
		description:
			"Maple deletes the key and stops reading the account's spend, and its cost leaves this page. Adding OpenRouter again brings back the last four weeks only.",
	},
	vercel: {
		title: "Remove the Vercel source?",
		description:
			"Maple stops reading the team's charges, and its cost leaves this page. The Vercel connection stays as it is. Adding Vercel again reads the last eleven months again.",
	},
} as const satisfies Record<RemovableProvider, Readonly<{ title: string; description: string }>>

/** Removing a source the page added: what leaves the page, and what adding it again brings back. */
export const removeSourceDialog = (h: H, model: Model): Html =>
	confirmDialog(h, {
		slotId: "cost-remove-source",
		model: model.removeDialog,
		toParentMessage: (message) => Message.GotRemoveDialogMessage({ message }),
		...REMOVAL[model.removeProvider],
		confirmLabel: "Remove source",
		onConfirm: Message.ClickedConfirmRemove(),
		isPending: model.sourceWrite === "Removing",
	})
