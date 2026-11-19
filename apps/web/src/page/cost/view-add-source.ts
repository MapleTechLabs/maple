import type { CostSourceSummary, GithubCostInstallation } from "@maple/domain/http"
import { CostProvider } from "@maple/domain/cost"
import { Array as Arr, String as Str, Struct } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "@maple/views/ui/button"
import { icon } from "@maple/views/ui/icon"
import { confirmDialog } from "@maple/views/ui/confirm-dialog"
import * as DialogView from "@maple/views/ui/dialog-view"
import { badge } from "@maple/views/ui/display"
import * as Field from "@maple/views/ui/field"
import { field, fieldDescription, fieldError, type FieldIds, fieldLabel, input } from "@maple/views/ui/field"
import { formDialogForm } from "@maple/views/ui/form-dialog"
import { eyebrow } from "@maple/views/ui/eyebrow"
import { grid } from "@maple/views/ui/grid"
import { searchInput } from "@maple/views/ui/search-input"
import { filteredEmpty } from "@maple/views/ui/signal-empty-state"
import { listRow } from "@maple/views/ui/list-row"
import { vstack } from "@maple/views/ui/stack"
import { textLink } from "@maple/views/ui/text-link"
import { typography } from "@maple/views/ui/typography"
import { AppRoute, hrefOf } from "../../route"
import { connectionStep } from "../kit/connection-step"
import { pickerCard, type PickerCardOptions } from "../kit/picker-card"
import { platformTile } from "../sources/kit/platforms"
import { addTrail } from "./view-add-trail"
import { CREDENTIAL_SOURCES, type CredentialSource } from "./credential-sources"
import { Message } from "./message"
import type { Model } from "./model"
import { COST_PROVIDERS, type CredentialProvider } from "./providers"
import { PLANETSCALE_REMOVE, planetScaleStep } from "./view-add-planetscale"
import { providerMark, vercelStep } from "./view-add-vercel"
import { GCP_REMOVE, gcpStep } from "./view-add-gcp"
import { requestStep } from "./view-add-request"

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

const PICK_GROUPS = ["cloud", "ai"] as const
type PickGroup = (typeof PICK_GROUPS)[number]

const PICK_GROUP_TITLE = {
	cloud: "Cloud and platforms",
	ai: "AI",
} as const satisfies Record<PickGroup, string>

/** Where each provider sits, in the order its group lists it. A new provider does not compile until placed. */
const PICK_GROUP = {
	aws: "cloud",
	gcp: "cloud",
	cloudflare: "cloud",
	vercel: "cloud",
	planetscale: "cloud",
	github: "cloud",
	openrouter: "ai",
	anthropic: "ai",
	openai: "ai",
} as const satisfies Record<CostProvider, PickGroup>

const PICKS: ReadonlyArray<CostProvider> = Struct.keys(PICK_GROUP)

/**
 * What a provider's card says and does. AWS goes to its connect flow, a pasted credential's to its
 * form, GitHub to its organizations, Vercel to its team, PlanetScale to its organization, Google
 * Cloud to its connections and export table. A provider the org has one source of at most is
 * offered no more once added; the others stay open.
 */
const pickOf = (
	provider: CostProvider,
	sources: ReadonlyArray<CostSourceSummary>,
): Readonly<{ description: string; isAdded: boolean; action: PickerCardOptions<Message>["action"] }> => {
	const once = (
		description: string,
		onClick: Message,
		addedDescription = "Remove it in the Sources panel",
	) => {
		const isAdded = hasSourceOf(sources, provider)
		return {
			description: isAdded ? addedDescription : description,
			isAdded,
			action: { onClick, isDisabled: isAdded },
		}
	}
	const open = (description: string, onClick: Message) => ({
		description,
		isAdded: false,
		action: { onClick },
	})
	switch (provider) {
		case "aws":
			return {
				description: "Daily cost by service, region and usage type",
				isAdded: false,
				action: { href: CONNECT_AWS_HREF },
			}
		case "gcp":
			return open("Daily cost from the BigQuery billing export", Message.ClickedAddGcp())
		case "github":
			return open("Daily billed usage by product and repository", Message.ClickedAddGithub())
		case "vercel":
			return once("Daily charges by product, project and region", Message.ClickedAddVercel())
		case "planetscale":
			return once("Monthly invoices, spread over each branch's days", Message.ClickedAddPlanetScale())
		case "openrouter":
		case "cloudflare":
		case "anthropic":
		case "openai":
			return once(
				CREDENTIAL_SOURCES[provider].pick.meta,
				Message.PickedProvider({ provider }),
				CREDENTIAL_SOURCES[provider].pick.addedMeta,
			)
	}
}

const pickCard = (h: H, provider: CostProvider, sources: ReadonlyArray<CostSourceSummary>): Html => {
	const entry = COST_PROVIDERS[provider]
	const pick = pickOf(provider, sources)
	return pickerCard(h, {
		key: provider,
		leading: platformTile(h, { label: entry.name, description: pick.description, icon: entry.icon }),
		title: entry.name,
		description: pick.description,
		descriptionLines: 2,
		trailing: pick.isAdded ? badge(h, { variant: "muted", size: "sm" }, ["Added"]) : null,
		action: pick.action,
	})
}

const nameList = new Intl.ListFormat("en-GB", { type: "conjunction" })

/** The providers whose requests cost their customer nothing, as one list: "A, B and C". */
const FREE_REQUESTS = nameList.format(
	Arr.map(
		// Google Cloud has no request price, but BigQuery bills each sync's query: the step says so.
		Arr.filter(
			CostProvider.literals,
			(provider) => COST_PROVIDERS[provider].requestUsd === null && provider !== "gcp",
		),
		(provider) => COST_PROVIDERS[provider].name,
	),
)

/** The search matches a provider's name and what it brings in, so "invoice" finds PlanetScale. */
const matchesSearch = (provider: CostProvider, query: string, sources: ReadonlyArray<CostSourceSummary>) =>
	Str.includes(query)(
		Str.toLowerCase(`${COST_PROVIDERS[provider].name} ${pickOf(provider, sources).description}`),
	)

/** The providers to add, searchable and grouped by what they are, two cards a row. */
const providers = (h: H, model: Model, sources: ReadonlyArray<CostSourceSummary>): Html => {
	const query = Str.toLowerCase(Str.trim(model.providerSearch))
	const shown =
		query === "" ? PICKS : Arr.filter(PICKS, (provider) => matchesSearch(provider, query, sources))
	const clear = Message.ChangedProviderSearch({ value: "" })
	return vstack(h, { gap: "5" }, [
		searchInput(h, {
			id: "cost-provider-search",
			value: model.providerSearch,
			placeholder: `Search ${PICKS.length} providers…`,
			ariaLabel: "Search providers",
			size: "default",
			onInput: (value) => Message.ChangedProviderSearch({ value }),
			onClear: clear,
		}),
		...(shown.length === 0
			? [
					filteredEmpty(h, {
						noun: "providers",
						title: "No providers match",
						description: "Ask for it, and requests decide which source Maple reads next.",
						onClear: clear,
						clearLabel: "Clear search",
						// What the search found nothing for is what they can ask for.
						actions: [
							button(
								h,
								{ size: "sm", attributes: [h.OnClick(Message.ClickedRequestProvider())] },
								[icon(h, "PlusIcon"), `Request ${Str.trim(model.providerSearch)}`],
							),
						],
						className: "py-8",
					}),
				]
			: Arr.flatMap(PICK_GROUPS, (group) => {
					const picks = Arr.filter(shown, (provider) => PICK_GROUP[provider] === group)
					return picks.length === 0
						? []
						: [
								vstack(h, { gap: "2", as: "section", attributes: [h.Key(group)] }, [
									eyebrow(h, { as: "h3" }, [PICK_GROUP_TITLE[group]]),
									grid(
										h,
										{ sm: 2, gap: "2" },
										Arr.map(picks, (provider) => pickCard(h, provider, sources)),
									),
								]),
							]
				})),
		// After the cards, where someone who did not find theirs is still looking.
		...(shown.length === 0
			? []
			: [
					button(
						h,
						{
							variant: "dashed",
							size: "lg",
							className: "w-full",
							attributes: [h.OnClick(Message.ClickedRequestProvider())],
						},
						[icon(h, "PlusIcon"), "Don't see your provider? Request it"],
					),
				]),
		typography(h, { size: "xs", tone: "muted", as: "p", className: "font-prose" }, [
			`AWS bills USD\u00a00.01 for each request Maple makes, a few dollars a month per account. ${FREE_REQUESTS} requests are free. `,
			textLink(h, { href: AWS_INTEGRATION_HREF, tone: "inherit", className: "underline" }, [
				"Turn on Cost for an AWS account that is connected",
			]),
			".",
		]),
	])
}

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
			// A replace is one step: no trail.
			...(isReplacing ? [] : [addTrail(h, COST_PROVIDERS[provider].name)]),
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
const githubInstallations = (
	h: H,
	model: Model,
	installations: ReadonlyArray<GithubCostInstallation>,
): ReadonlyArray<Html> =>
	Arr.isReadonlyArrayNonEmpty(installations)
		? [
				vstack(h, { gap: "3" }, [
					vstack(
						h,
						{ as: "ul", gap: "0" },
						Arr.map(installations, (installation) =>
							githubInstallationRow(h, model, installation),
						),
					),
					typography(h, { size: "xs", tone: "muted", as: "p", className: "font-prose" }, [
						"Missing an organization? ",
						textLink(h, { href: CONNECT_GITHUB_HREF, tone: "inherit", className: "underline" }, [
							"Connect it to Maple",
						]),
						" first.",
					]),
				]),
			]
		: // The way on is the step's primary action, in the footer beside Back.
			[
				typography(h, { size: "sm", tone: "muted", as: "p", className: "font-prose" }, [
					"No GitHub organization is connected to Maple yet. Connect one, then add it here as a cost source.",
				]),
			]

/**
 * The dialog's GitHub step: the organizations the GitHub App is installed on, each added with a
 * click. Its primary action connects one, while the org has none to pick.
 */
const githubStep = (h: H, model: Model, id: string): ReadonlyArray<Html> =>
	connectionStep(h, {
		dialogId: id,
		title: "Add GitHub",
		trail: addTrail(h, "GitHub"),
		description:
			"Maple reads an organization's billed usage through the GitHub App it already has. No key is needed.",
		read: model.githubInstallations,
		readingLabel: "Reading your GitHub organizations",
		onRetry: Message.ClickedAddGithub(),
		content: ({ installations }) => githubInstallations(h, model, installations),
		primary: ({ installations }) =>
			Arr.isReadonlyArrayNonEmpty(installations)
				? null
				: { label: "Connect GitHub", href: CONNECT_GITHUB_HREF },
		onBack: Message.ClickedBackToProviders(),
		isBusy: model.sourceWrite === "Saving",
	})

/**
 * Add a source, or replace a source's credential: the providers first, then the chosen one's
 * credential form, GitHub's organizations, Vercel's team or PlanetScale's organization. Opened on
 * the form for a replace.
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
			// The providers take two cards a row; every later step is a narrow form.
			className: step === "pick" ? "sm:max-w-2xl" : "",
			toView: ({ portal }) => portal ?? h.empty,
			toContent: (close) =>
				step === "request"
					? requestStep(h, model, id)
					: step === "gcp"
						? gcpStep(h, model, id)
						: step === "vercel"
							? vercelStep(h, model, id)
							: step === "planetscale"
								? planetScaleStep(h, model, id)
								: step === "github"
									? githubStep(h, model, id)
									: step === "pick"
										? [
												DialogView.dialogHeader(h, "dialog", [
													DialogView.dialogTitle(
														h,
														"dialog",
														id,
														"Add a cost source",
													),
													addTrail(h, null),
													DialogView.dialogDescription(
														h,
														"dialog",
														id,
														"Maple reads what the source bills each day and keeps it next to your telemetry.",
													),
												]),
												DialogView.dialogPanel(h, "dialog", id, [
													providers(h, model, sources),
												]),
												DialogView.dialogFooter(h, "dialog", [
													button(
														h,
														{ variant: "outline", attributes: [...close] },
														["Close"],
													),
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
		case "gcp":
			return GCP_REMOVE
		case "openrouter":
		case "cloudflare":
		case "anthropic":
		case "openai":
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
