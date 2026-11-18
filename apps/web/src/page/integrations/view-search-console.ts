import {
	searchConsoleSiteLabel,
	type SearchConsoleIntegrationStatus,
	SearchConsoleSiteChoice,
	type SearchConsoleSiteStatus,
} from "@maple/domain/http"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { Option, Array as Arr } from "effect"
import { heading } from "@maple/views/ui/heading"
import { button } from "@maple/views/ui/button"
import { choiceCard, choiceCheckClass } from "@maple/views/ui/choice-card"
import { badge } from "@maple/views/ui/display"
import { errorState } from "@maple/views/ui/error-state"
import { icon } from "@maple/views/ui/icon"
import { skeletonBlock } from "@maple/views/ui/skeleton"
import { typography } from "@maple/views/ui/typography"
import { hstack, vstack } from "@maple/views/ui/stack"
import {
	integrationEmpty,
	integrationEmptyCard,
	integrationEmptyFeatures,
	integrationEmptyFooter,
	integrationEmptyHint,
	integrationEmptyMedia,
} from "../kit/integration-empty"
import { Message } from "./message"
import { canManage, type Model } from "./model"
import { gatedControl } from "../kit/session-grants"
import {
	isDirty,
	permissionLabel,
	SearchConsoleMessage,
	selectionOf,
	unavailableSaved,
} from "./search-console"
import { connectedIntegrationCard, integrationStatusCard } from "./view-integration-card"
import { providerBrand } from "../kit/providers"

/** A Search Console message, as the hub carries it. */
const toHub = (message: SearchConsoleMessage): Message => Message.GotSearchConsoleMessage({ message })

type H = HtmlBuilder<Message>

const BRAND = providerBrand("google-search-console")

/**
 * From the click until the status re-read after Google's popup lands: the popup is out, or the
 * re-read that shows the new grant is in flight. Without it the card sat idle under the toast.
 */
const isConnecting = (model: Model): boolean =>
	model.connect.isStarting ||
	model.connect.active?.provider === "google-search-console" ||
	AsyncData.isRefreshing(model.statuses.searchConsole.data)

const notConnected = (h: H, model: Model, status: SearchConsoleIntegrationStatus): Html => {
	const connecting = isConnecting(model)
	return integrationEmpty(h, [
		integrationEmptyFeatures(h, [
			{
				label: "Queries",
				title: "What people search",
				description: "Clicks, impressions, CTR and position for every query that shows your site.",
			},
			{
				label: "Pages",
				title: "Where they land",
				description: "The pages Google sends people to, beside the web analytics Maple already has.",
			},
			{
				label: "History",
				title: "Imported daily",
				description: "Maple imports each finalized day and backfills what Google still keeps.",
			},
		]),
		integrationEmptyCard(h, [
			integrationEmptyMedia(h, BRAND),
			integrationEmptyHint(h, [
				!status.configured
					? "Google Search Console is not configured for this Maple deployment."
					: model.connect.isStarting || model.connect.active?.provider === "google-search-console"
						? "Finish signing in with Google in the popup. Your properties will appear here."
						: connecting
							? "Checking the connection with Google."
							: "Your Search Console properties will appear here after you connect a Google account.",
			]),
			gatedControl(h, model, "integrations:manage", (isLocked) =>
				button(
					h,
					{
						isDisabled: !status.configured || isLocked || model.disconnect.isPending,
						isLoading: connecting,
						attributes: [h.OnClick(Message.ClickedConnect())],
					},
					connecting ? ["Connecting to Google"] : [icon(h, "GoogleIcon"), "Connect Google"],
				),
			),
			integrationEmptyFooter(h, ["Maple asks for read-only access to your Search Console data."]),
		]),
	])
}

/** The row's second line: why it can't be picked, its import failure, or its permission. */
const siteDetail = (h: H, site: SearchConsoleSiteChoice, saved: SearchConsoleSiteStatus | undefined): Html =>
	!site.selectable
		? typography(h, { size: "2xs", tone: "muted" }, [
				"Unverified. Verify it in Search Console to import it.",
			])
		: saved !== undefined && saved.enabled && saved.lastError !== null
			? typography(h, { size: "2xs", tone: "error" }, [`Import failing: ${saved.lastError}`])
			: typography(h, { size: "2xs", tone: "muted" }, [permissionLabel(site.permissionLevel)])

const siteOption = (
	h: H,
	site: SearchConsoleSiteChoice,
	saved: SearchConsoleSiteStatus | undefined,
	isChecked: boolean,
	isLocked: boolean,
): Html => {
	const label = searchConsoleSiteLabel(site.siteUrl)
	return choiceCard(
		h,
		{
			type: "checkbox",
			isChecked,
			isDisabled: isLocked || !site.selectable,
			label,
			onChange: toHub(SearchConsoleMessage.ToggledSite({ siteUrl: site.siteUrl })),
			className: "items-center gap-3 px-3 py-2.5",
		},
		[
			hstack(
				h,
				{ as: "span", align: "center", justify: "center", className: choiceCheckClass(isChecked) },
				isChecked ? [icon(h, "CheckIcon", { size: 12 })] : [],
			),
			vstack(h, { gap: "0.5", grow: true, shrink: true, as: "span" }, [
				typography(h, { size: "sm", weight: "medium", mono: true, truncate: true }, [label]),
				siteDetail(h, site, saved),
			]),
		],
	)
}

/** Saved properties the account lost access to: they show here, and the next save stops importing them. */
const unavailableNote = (h: H, siteUrls: ReadonlyArray<string>): Html =>
	typography(h, { size: "xs", tone: "warning", as: "p" }, [
		`No longer available to this Google account, so saving stops importing ${Arr.join(
			Arr.map(siteUrls, searchConsoleSiteLabel),
			", ",
		)}.`,
	])

/**
 * What a viewer who cannot manage sees: the imported properties, from the status, or that there
 * are none yet. Google's own list is a manager's read.
 */
const importedList = (
	h: H,
	status: SearchConsoleIntegrationStatus,
	list: (sites: ReadonlyArray<SearchConsoleSiteChoice>) => Html,
): Html => {
	const imported = Arr.map(
		Arr.filter(status.sites, (site) => site.enabled),
		(site) =>
			new SearchConsoleSiteChoice({
				siteUrl: site.siteUrl,
				permissionLevel: site.permissionLevel,
				selectable: true,
				enabled: true,
			}),
	)
	return imported.length === 0
		? typography(h, { size: "xs", tone: "muted", as: "p" }, ["No properties are imported yet."])
		: list(imported)
}

const sitePicker = (h: H, model: Model, status: SearchConsoleIntegrationStatus): Html => {
	const card = model.searchConsoleCard
	const selection = selectionOf(card, status)
	const isLocked = !canManage(model) || card.isSaving
	const unavailable = unavailableSaved(card, status)
	const savedRow = (siteUrl: string) => Arr.findFirst(status.sites, (site) => site.siteUrl === siteUrl)
	const list = (sites: ReadonlyArray<SearchConsoleSiteChoice>): Html =>
		vstack(h, { gap: "2" }, [
			...(sites.length === 0
				? [
						typography(h, { size: "xs", tone: "muted", as: "p" }, [
							"This Google account has no Search Console properties. Add one in Search Console, then reload.",
						]),
					]
				: Arr.map(sites, (site) =>
						siteOption(
							h,
							site,
							Option.getOrUndefined(savedRow(site.siteUrl)),
							Arr.contains(selection, site.siteUrl),
							isLocked,
						),
					)),
			...(unavailable.length === 0 ? [] : [unavailableNote(h, unavailable)]),
		])
	return vstack(h, { gap: "3" }, [
		heading(h, { level: 4, variant: "subsection" }, ["Properties to import"]),
		canManage(model)
			? AsyncData.match(card.sites.data, {
					onIdle: () => skeletonBlock(h, { height: "32" }),
					onLoading: () => skeletonBlock(h, { height: "32" }),
					onFailure: (failure) =>
						errorState(h, {
							failure,
							title: "Couldn't load your Search Console properties",
							onRetry: toHub(SearchConsoleMessage.ClickedRetrySites()),
						}),
					onStale: ({ data }) => list(data.sites),
					onRefreshing: (data) => list(data.sites),
					onSuccess: (data) => list(data.sites),
				})
			: importedList(h, status, list),
		hstack(h, { gap: "2" }, [
			gatedControl(h, model, "integrations:manage", (isLocked) =>
				button(
					h,
					{
						size: "sm",
						isDisabled: isLocked || !isDirty(card, status) || card.isSaving,
						isLoading: card.isSaving,
						attributes: [h.OnClick(toHub(SearchConsoleMessage.ClickedSave()))],
					},
					["Save properties"],
				),
			),
		]),
	])
}

const connected = (h: H, model: Model, status: SearchConsoleIntegrationStatus): Html => {
	const reconnecting =
		model.connect.isStarting || model.connect.active?.provider === "google-search-console"
	const busy = reconnecting || model.disconnect.isPending
	return connectedIntegrationCard(h, model, {
		integration: "google-search-console",
		brand: BRAND,
		title: "Google Search Console",
		badge: status.revoked
			? badge(h, { variant: "warn" }, ["Revoked"])
			: badge(h, { variant: "ok" }, ["Connected"]),
		titleWraps: false,
		summary: [
			status.revoked
				? "Google rejected Maple's access, so Search Console data no longer imports. Reconnect to resume."
				: status.accountEmail === null
					? "Choose the properties Maple imports each day."
					: `Connected as ${status.accountEmail}. Choose the properties Maple imports each day.`,
		],
		summaryLayout: "stacked",
		body: status.revoked ? [] : [sitePicker(h, model, status)],
		actions: hstack(h, { gap: "2", align: "stretch", wrap: true }, [
			gatedControl(h, model, "integrations:manage", (isLocked) =>
				button(
					h,
					{
						size: "sm",
						variant: status.revoked ? "default" : "outline",
						isDisabled: isLocked || busy || !status.configured,
						isLoading: reconnecting,
						attributes: [h.OnClick(Message.ClickedConnect())],
					},
					["Reconnect"],
				),
			),
			gatedControl(h, model, "integrations:manage", (isLocked) =>
				button(
					h,
					{
						size: "sm",
						variant: "outline",
						isDisabled: isLocked || busy,
						isLoading: model.disconnect.isPending,
						attributes: [h.OnClick(Message.ClickedDisconnect())],
					},
					["Disconnect"],
				),
			),
		]),
		contentGap: "gap-4",
	})
}

const byState = (h: H, model: Model, data: SearchConsoleIntegrationStatus): Html =>
	data.connected ? connected(h, model, data) : notConnected(h, model, data)

export const searchConsoleCard = (h: H, model: Model): Html =>
	integrationStatusCard(h, model.statuses.searchConsole, {
		name: "searchConsole",
		failureTitle: "Couldn't load the Google Search Console integration",
		render: (data) => byState(h, model, data),
	})
