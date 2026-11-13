import type { CostSourceSummary, GithubCostInstallation } from "@maple/domain/http"
import { CostProvider } from "@maple/domain/cost"
import { Array as Arr, String as Str } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { failureMessage } from "@maple/views/data/load-failure"
import { button, linkButton } from "@maple/views/ui/button"
import { confirmDialog } from "@maple/views/ui/confirm-dialog"
import * as DialogView from "@maple/views/ui/dialog-view"
import { badge } from "@maple/views/ui/display"
import * as Field from "@maple/views/ui/field"
import { field, fieldDescription, fieldError, type FieldIds, fieldLabel, input } from "@maple/views/ui/field"
import { formDialogForm } from "@maple/views/ui/form-dialog"
import { icon } from "@maple/views/ui/icon"
import { listRow } from "@maple/views/ui/list-row"
import { spinner } from "@maple/views/ui/spinner"
import { hstack, vstack } from "@maple/views/ui/stack"
import { textLink } from "@maple/views/ui/text-link"
import { typography } from "@maple/views/ui/typography"
import { AppRoute, hrefOf } from "../../route"
import { CREDENTIAL_SOURCES, type CredentialSource } from "./credential-sources"
import { Message } from "./message"
import type { Model } from "./model"
import { COST_PROVIDERS, type CostProviderEntry, CredentialProvider } from "./providers"
import { PLANETSCALE_REMOVE, planetScaleStep } from "./view-add-planetscale"
import { providerMark, vercelStep } from "./view-add-vercel"

type H = HtmlBuilder<Message>

const CONNECT_AWS_HREF = hrefOf(AppRoute.SourcesNew({ search: { integration: "aws" } }))

/** Where an AWS connection and its Cost module are changed. */
export const AWS_INTEGRATION_HREF = hrefOf(AppRoute.Integrations({ search: { integration: "aws" } }))

/** Where a GitHub organization is connected to Maple. */
const CONNECT_GITHUB_HREF = hrefOf(AppRoute.SourcesNew({ search: { integration: "github" } }))

/** Whether the org has its source of a provider it can have one of at most. */
const hasSourceOf = (
	sources: ReadonlyArray<CostSourceSummary>,
	provider: CostSourceSummary["provider"],
): boolean => Arr.some(sources, (source) => source.provider === provider)

/**
 * A provider the org has one source of at most: a row to click while it has none, and one that
 * says where the source is changed once it does.
 */
const addableRow = (
	h: H,
	provider: CostProviderEntry,
	options: Readonly<{
		isAdded: boolean
		/** What the source brings in. */
		meta: string
		/** Where an added source is changed. */
		addedMeta: string
		onClick: Message
		divided?: boolean
	}>,
): Html =>
	options.isAdded
		? listRow(h, {
				divided: options.divided ?? false,
				leading: providerMark(h, provider),
				title: provider.name,
				meta: options.addedMeta,
				trailing: badge(h, { variant: "muted", size: "sm" }, ["Already added"]),
			})
		: listRow(h, {
				divided: options.divided ?? false,
				onClick: options.onClick,
				leading: providerMark(h, provider),
				title: provider.name,
				meta: options.meta,
				trailing: icon(h, "ChevronRightIcon", { size: 14 }),
			})

const nameList = new Intl.ListFormat("en-GB", { type: "conjunction" })

/** The providers whose requests cost their customer nothing, as one list: "A, B and C". */
const FREE_REQUESTS = nameList.format(
	Arr.map(
		Arr.filter(CostProvider.literals, (provider) => COST_PROVIDERS[provider].requestUsd === null),
		(provider) => COST_PROVIDERS[provider].name,
	),
)

/**
 * The providers to add: AWS goes to its connect flow, a pasted credential's to its form, GitHub to
 * its organizations, Vercel to its team, PlanetScale to its organization.
 */
const providers = (h: H, sources: ReadonlyArray<CostSourceSummary>): Html =>
	vstack(h, { gap: "3" }, [
		vstack(h, { gap: "0" }, [
			listRow(h, {
				divided: true,
				href: CONNECT_AWS_HREF,
				leading: providerMark(h, COST_PROVIDERS.aws),
				title: COST_PROVIDERS.aws.name,
				meta: "Daily cost by service, region and usage type",
				trailing: icon(h, "ChevronRightIcon", { size: 14 }),
			}),
			...Arr.map(CredentialProvider.literals, (provider) =>
				addableRow(h, COST_PROVIDERS[provider], {
					isAdded: hasSourceOf(sources, provider),
					...CREDENTIAL_SOURCES[provider].pick,
					onClick: Message.PickedProvider({ provider }),
					divided: true,
				}),
			),
			// An org can add several organizations, so the row stays open with sources on the page.
			listRow(h, {
				divided: true,
				onClick: Message.ClickedAddGithub(),
				leading: providerMark(h, COST_PROVIDERS.github),
				title: COST_PROVIDERS.github.name,
				meta: "Daily billed usage by product and repository",
				trailing: icon(h, "ChevronRightIcon", { size: 14 }),
			}),
			addableRow(h, COST_PROVIDERS.vercel, {
				isAdded: hasSourceOf(sources, "vercel"),
				meta: "Daily charges by product, project and region",
				addedMeta: "Remove it in the Sources panel",
				onClick: Message.ClickedAddVercel(),
				divided: true,
			}),
			addableRow(h, COST_PROVIDERS.planetscale, {
				isAdded: hasSourceOf(sources, "planetscale"),
				// Short enough to stand whole in the list: the step says the rest.
				meta: "Monthly invoices, spread over each branch's days",
				addedMeta: "Remove it in the Sources panel",
				onClick: Message.ClickedAddPlanetScale(),
			}),
		]),
		typography(h, { size: "xs", tone: "muted", as: "p", className: "font-prose" }, [
			`AWS bills USD\u00a00.01 for each request Maple makes, a few dollars a month per account. ${FREE_REQUESTS} requests are free. `,
			textLink(h, { href: AWS_INTEGRATION_HREF, tone: "inherit", className: "underline" }, [
				"Turn on Cost for an AWS account that is connected",
			]),
			".",
		]),
	])

const CREDENTIAL_IDS: FieldIds = {
	control: "cost-source-credential",
	label: "cost-source-credential-label",
	error: "cost-source-credential-error",
	description: "cost-source-credential-description",
}

const credentialField = (h: H, model: Model, { field: text }: CredentialSource): Html => {
	const state = Field.stateOf(model.credentialDraft, model.credentialError !== null)
	return field(h, { state }, [
		fieldLabel(h, { ids: CREDENTIAL_IDS, state }, text.label),
		input(h, {
			ids: CREDENTIAL_IDS,
			state,
			attributes: [
				h.Type("password"),
				h.Attribute("autocomplete", "off"),
				h.Placeholder(text.placeholder),
				...(model.sourceWrite === "Saving" ? [h.Disabled(true)] : []),
				...Field.controlAttributes(h, model.credentialDraft, (message) =>
					Message.GotCredentialDraftMessage({ message }),
				),
			],
		}),
		...(model.credentialError === null
			? []
			: [
					fieldError(h, { ids: CREDENTIAL_IDS, state, attributes: [h.Role("alert")] }, [
						model.credentialError,
					]),
				]),
		fieldDescription(h, { ids: CREDENTIAL_IDS, state }, [
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
	const source = CREDENTIAL_SOURCES[provider]
	const isReplacing = hasSourceOf(sources, provider)
	const isSaving = model.sourceWrite === "Saving"
	const canSubmit = !isSaving && Str.trim(model.credentialDraft.value) !== ""
	const text = isReplacing ? source.replace : source.add
	return formDialogForm(h, canSubmit ? Message.SubmittedCredential() : undefined, [
		DialogView.dialogHeader(h, "dialog", [
			DialogView.dialogTitle(h, "dialog", id, text.title),
			DialogView.dialogDescription(h, "dialog", id, text.description),
		]),
		DialogView.dialogPanel(h, "dialog", id, [credentialField(h, model, source)]),
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

/** Why an installation that is not offered cannot be a source. */
const GITHUB_STATE_NOTE = {
	available: undefined,
	added: undefined,
	user_account: "Only organization accounts have a billing report.",
	inactive: "Suspended or removed in GitHub. Reconnect it first.",
} as const satisfies Record<GithubCostInstallation["state"], string | undefined>

/** One installation: an organization that can be added, one that is, or why it cannot be. */
const githubInstallationRow = (h: H, model: Model, installation: GithubCostInstallation): Html => {
	const refusal =
		model.githubRefusal?.installationId === installation.installationId ? model.githubRefusal : undefined
	const row = listRow(h, {
		leading: providerMark(h, COST_PROVIDERS.github),
		title: installation.accountLogin,
		meta: GITHUB_STATE_NOTE[installation.state],
		wrapMeta: true,
		trailing:
			installation.state === "available"
				? button(
						h,
						{
							variant: "outline",
							size: "sm",
							isLoading: model.githubAdding === installation.installationId,
							isDisabled: model.sourceWrite !== "Idle",
							attributes: [
								h.AriaLabel(`Add ${installation.accountLogin}`),
								h.OnClick(
									Message.ClickedAddGithubInstallation({
										installationId: installation.installationId,
									}),
								),
							],
						},
						["Add"],
					)
				: installation.state === "added"
					? badge(h, { variant: "muted", size: "sm" }, ["Added"])
					: undefined,
	})
	return vstack(h, { as: "li", gap: "1", attributes: [h.Key(installation.installationId)] }, [
		row,
		...(refusal === undefined
			? []
			: [
					typography(
						h,
						{
							size: "xs",
							tone: "destructive",
							as: "p",
							className: "px-2 pb-2 font-prose",
							attributes: [h.Role("alert")],
						},
						[
							refusal.message,
							// Only a missing permission is fixed in GitHub: an outage or a missing role is not.
							...(refusal.needsPermission
								? [
										" ",
										textLink(
											h,
											{
												href: installation.settingsUrl,
												tone: "inherit",
												className: "underline",
												attributes: [h.Target("_blank"), h.Rel("noreferrer")],
											},
											["Open the GitHub App settings"],
										),
									]
								: []),
						],
					),
				]),
	])
}

/** The org's GitHub installations to pick from, or how to get one. */
const githubInstallations = (h: H, model: Model): Html =>
	AsyncData.matchDataSplitEmpty(model.githubInstallations, {
		onIdle: () => h.empty,
		onLoading: () =>
			hstack(h, { gap: "2", className: "py-2" }, [
				spinner(h, undefined, 14),
				typography(h, { size: "sm", tone: "muted" }, ["Reading your GitHub organizations"]),
			]),
		onFailure: (error) =>
			vstack(h, { gap: "2", align: "start" }, [
				typography(h, { size: "sm", tone: "destructive", as: "p", attributes: [h.Role("alert")] }, [
					failureMessage(error),
				]),
				button(
					h,
					{ variant: "outline", size: "sm", attributes: [h.OnClick(Message.ClickedAddGithub())] },
					["Try again"],
				),
			]),
		onData: ({ installations }) =>
			Arr.isReadonlyArrayNonEmpty(installations)
				? vstack(h, { gap: "3" }, [
						vstack(
							h,
							{ as: "ul", gap: "0" },
							Arr.map(installations, (installation) =>
								githubInstallationRow(h, model, installation),
							),
						),
						typography(h, { size: "xs", tone: "muted", as: "p", className: "font-prose" }, [
							"Missing an organization? ",
							textLink(
								h,
								{ href: CONNECT_GITHUB_HREF, tone: "inherit", className: "underline" },
								["Connect it to Maple"],
							),
							" first.",
						]),
					])
				: // The way on is the step's primary action, in the footer beside Back.
					typography(h, { size: "sm", tone: "muted", as: "p", className: "font-prose" }, [
						"No GitHub organization is connected to Maple yet. Connect one, then add it here as a cost source.",
					]),
	})

/** The GitHub step's primary action: connecting an organization, while the org has none to pick. */
const githubPrimary = (h: H, model: Model): ReadonlyArray<Html> =>
	AsyncData.matchData(model.githubInstallations, {
		onEmpty: () => [],
		onFailure: () => [],
		onData: ({ installations }) =>
			Arr.isReadonlyArrayNonEmpty(installations)
				? []
				: [linkButton(h, { href: CONNECT_GITHUB_HREF }, ["Connect GitHub"])],
	})

/**
 * Add a source, or replace a source's credential: the providers first, then the chosen one's
 * credential form, GitHub's organizations, Vercel's team or PlanetScale's organization. Opened on
 * the form for a replace.
 */
export const addSourceDialog = (h: H, model: Model, sources: ReadonlyArray<CostSourceSummary>): Html => {
	const id = model.addDialog.id
	const step = model.addStep
	const isSaving = model.sourceWrite === "Saving"
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
				step === "vercel"
					? vercelStep(h, model, id)
					: step === "planetscale"
						? planetScaleStep(h, model, id)
						: step === "github"
							? [
									DialogView.dialogHeader(h, "dialog", [
										DialogView.dialogTitle(h, "dialog", id, "Add GitHub"),
										DialogView.dialogDescription(
											h,
											"dialog",
											id,
											"Maple reads an organization's billed usage through the GitHub App it already has. No key is needed.",
										),
									]),
									DialogView.dialogPanel(h, "dialog", id, [githubInstallations(h, model)]),
									DialogView.dialogFooter(h, "dialog", [
										button(
											h,
											{
												variant: "outline",
												isDisabled: isSaving,
												attributes: [h.OnClick(Message.ClickedBackToProviders())],
											},
											["Back"],
										),
										...githubPrimary(h, model),
									]),
								]
							: step === "pick"
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
											button(h, { variant: "outline", attributes: [...close] }, [
												"Close",
											]),
										]),
									]
								: [credentialForm(h, model, step, sources, close)],
		},
	})
}

/** What removing a source says: what leaves the page, and what adding it again brings back. */
const removeCopy = (target: CostSourceSummary | null): Readonly<{ title: string; description: string }> => {
	switch (target?.provider) {
		case "github":
			return {
				title: "Remove the GitHub source?",
				description: `Maple stops reading the billed usage of ${target.accountId}, and its cost leaves this page. The GitHub connection stays and no key is deleted. Adding it again brings back this month and the three before it.`,
			}
		case "vercel":
			return {
				title: "Remove the Vercel source?",
				description:
					"Maple stops reading the team's charges, and its cost leaves this page. The Vercel connection stays as it is. Adding Vercel again reads the last eleven months again.",
			}
		case "planetscale":
			return PLANETSCALE_REMOVE
		case "openrouter":
		case "cloudflare":
			return CREDENTIAL_SOURCES[target.provider].remove
		// An AWS source has no Remove: it leaves with its connection's Cost module. The confirm is closed then.
		default:
			return { title: "Remove the source?", description: "Its cost leaves this page." }
	}
}

/** The confirm before a source is removed. */
export const removeSourceDialog = (h: H, model: Model): Html =>
	confirmDialog(h, {
		slotId: "cost-remove-source",
		model: model.removeDialog,
		toParentMessage: (message) => Message.GotRemoveDialogMessage({ message }),
		...removeCopy(model.removeTarget),
		confirmLabel: "Remove source",
		onConfirm: Message.ClickedConfirmRemove(),
		isPending: model.sourceWrite === "Removing",
	})
