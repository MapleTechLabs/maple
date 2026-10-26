import type { ChatConnectorManifest } from "@maple/chat-platform/manifests"
import { isClerkAuthEnabled } from "../../lib/services/common/auth-mode"
import { Array as Arr, Option, Schema } from "effect"
import { DashboardId } from "@maple/domain/http"
import { CATALOG } from "../../page/integrations/catalog"
import { AppRoute, hrefOf } from "../../route"
import type { IconName } from "../../ui/icon"
import type { PinnedDashboardRow } from "../dashboards-shape"
import type { Theme } from "../message"
import { navGroups } from "../nav"

// The palette's entries.

export const GROUP_ORDER = ["Navigation", "Services", "Dashboards", "Integrations", "Actions"] as const
export type Group = (typeof GROUP_ORDER)[number]

export const PaletteAction = Schema.Literals(["AskMapleAi", "ToggleTheme", "ShowShortcuts"])
export type PaletteAction = typeof PaletteAction.Type

export type Glyph =
	| Readonly<{ _tag: "Icon"; name: IconName }>
	| Readonly<{ _tag: "Manifest"; icon: ChatConnectorManifest["icon"] }>
	| Readonly<{ _tag: "Service"; serviceName: string }>

export type Target =
	| Readonly<{ _tag: "Href"; href: string }>
	| Readonly<{ _tag: "Action"; action: PaletteAction }>

export type PaletteEntry = Readonly<{
	id: string
	title: string
	group: Group
	keywords: string
	glyph: Glyph
	target: Target
	shortcut?: string
	/** A provider only advertised while browsing when it is new (`catalogEntry(id).isNew`). */
	isAdvertised?: boolean
	/** Releases is a flagged row: searchable only while the org's flag is on. */
	isFlagged?: boolean
}>

/** What the entries are built from: the palette's own services read and the shell's state. */
export type EntryInputs = Readonly<{
	serviceNames: ReadonlyArray<string>
	dashboards: ReadonlyArray<PinnedDashboardRow>
	favorites: ReadonlyArray<string>
	theme: Theme
}>

/** What fuse indexes (`FUSE_OPTIONS.keys`), sent to the search Command. */
export const SearchEntry = Schema.Struct({ id: Schema.String, title: Schema.String, keywords: Schema.String })
export type SearchEntry = typeof SearchEntry.Type

/** Nav rows an org rollout flag can hide; the shell passes the ones it shows. */
export const FLAGGED_HREFS: ReadonlySet<string> = new Set(["/releases", "/security"])

const icon = (name: IconName): Glyph => ({ _tag: "Icon", name })
const href = (url: string): Target => ({ _tag: "Href", href: url })

/** `paletteNavItems`: every section, its children and their views, deduplicated by title and href. */
const navigationEntries = (): ReadonlyArray<PaletteEntry> => {
	const rows = navGroups({ releases: true, securityAudit: true }).flatMap((group) =>
		group.items.flatMap((item) => [
			{ id: `nav:${item.title}`, title: item.title, href: item.href, icon: item.icon },
			...(item.subItems ?? []).flatMap((sub) => [
				{
					id: `nav:${item.title}:${sub.title}`,
					title: sub.paletteTitle ?? sub.title,
					href: sub.href,
					icon: sub.icon ?? item.icon,
				},
				...(sub.views ?? []).map((view) => ({
					id: `nav:${item.title}:${sub.title}:${view.title}`,
					title: view.paletteTitle ?? `${sub.title} ${view.title}`,
					href: view.href,
					icon: view.paletteIcon ?? sub.icon ?? item.icon,
				})),
			]),
		]),
	)
	// One row per page, titled by its most specific row ("Traces", not its "Explore" parent);
	// every title that opens the same page stays searchable as a keyword.
	const unique = Arr.reverse(Arr.dedupeWith(Arr.reverse(rows), (a, b) => a.href === b.href))
	const titlesByHref = (target: string) => rows.filter((row) => row.href === target).map((row) => row.title)
	return unique.map((row) => ({
		id: row.id,
		title: row.title,
		group: "Navigation",
		keywords: `go to ${titlesByHref(row.href).join(" ")}`,
		glyph: icon(row.icon),
		target: href(row.href),
		isFlagged: FLAGGED_HREFS.has(row.href),
	}))
}

const footerEntries: ReadonlyArray<PaletteEntry> = [
	{
		id: "nav:/sources",
		title: "Sources",
		group: "Navigation",
		keywords: "go to sources connect sdk collector ingest tokens",
		glyph: icon("ConnectionIcon"),
		target: href("/sources"),
	},
	{
		id: "nav:/integrations",
		title: "Integrations",
		group: "Navigation",
		keywords: "go to integrations connect providers sources add",
		glyph: icon("GridIcon"),
		target: href("/integrations"),
	},
	{
		id: "nav:/settings",
		title: "Settings",
		group: "Navigation",
		keywords: "go to settings preferences",
		glyph: icon("GearIcon"),
		target: href("/settings"),
	},
	// `/account` redirects away in self-hosted mode, where there is no user record to manage.
	...(isClerkAuthEnabled
		? [
				{
					id: "nav:/account",
					title: "Account",
					group: "Navigation" as const,
					keywords:
						"account profile picture name password two-factor 2fa mfa passkey email security sessions devices",
					glyph: icon("UserIcon"),
					target: href("/account"),
				},
			]
		: []),
]

/** `entry.monoIcon ?? entry.icon`: the chat marks and Google Cloud have a single-colour variant. */
const integrationGlyph = (entry: (typeof CATALOG)[number]): Glyph =>
	entry.icon._tag === "Manifest"
		? entry.icon
		: entry.id === "gcp"
			? icon("GoogleCloudMonoIcon")
			: icon(entry.icon.name)

// Every provider is typeable as "Connect <name>", so trying "railway" finds it from anywhere.
const integrationEntries = (): ReadonlyArray<PaletteEntry> =>
	CATALOG.map((entry) => ({
		id: `integration:${entry.id}`,
		title: `Connect ${entry.name}`,
		group: "Integrations",
		keywords: `integration connect add source ${entry.name} ${entry.category}`,
		glyph: integrationGlyph(entry),
		target: href(hrefOf(AppRoute.Integrations({ search: { integration: entry.id } }))),
		isAdvertised: entry.isNew ?? false,
	}))

const decodeDashboardId = Schema.decodeUnknownOption(DashboardId)

/** Favourites first, each half newest first (`useDashboardsRead`'s order). */
const dashboardEntries = (inputs: EntryInputs): ReadonlyArray<PaletteEntry> => {
	const favorites = inputs.dashboards.filter((row) => inputs.favorites.includes(row.id))
	const others = inputs.dashboards.filter((row) => !inputs.favorites.includes(row.id))
	return [...favorites, ...others].flatMap((row) =>
		Option.match(decodeDashboardId(row.id), {
			onNone: () => [],
			onSome: (dashboardId): ReadonlyArray<PaletteEntry> => [
				{
					id: `dashboard:${row.id}`,
					title: row.name,
					group: "Dashboards",
					keywords: "dashboard",
					glyph: icon("GridSquareCirclePlusIcon"),
					target: href(hrefOf(AppRoute.Dashboard({ dashboardId, search: {} }))),
				},
			],
		}),
	)
}

const actionEntries = (theme: Theme): ReadonlyArray<PaletteEntry> => {
	const isDark = theme === "dark"
	return [
		{
			id: "action:ask-maple-ai",
			title: "Ask Maple AI",
			group: "Actions",
			keywords: "chat ai assistant maple ask question",
			glyph: icon("ChatBubbleSparkleIcon"),
			target: { _tag: "Action", action: "AskMapleAi" },
			shortcut: "C",
		},
		{
			id: "action:toggle-theme",
			title: isDark ? "Switch to light mode" : "Switch to dark mode",
			group: "Actions",
			keywords: "theme dark light mode toggle appearance",
			glyph: icon(isDark ? "SunIcon" : "MoonIcon"),
			target: { _tag: "Action", action: "ToggleTheme" },
			shortcut: "T",
		},
		{
			id: "action:keyboard-shortcuts",
			title: "Keyboard shortcuts",
			group: "Actions",
			keywords: "help hotkeys keys bindings",
			glyph: icon("KeyboardIcon"),
			target: { _tag: "Action", action: "ShowShortcuts" },
			shortcut: "?",
		},
	]
}

export const MAX_RESULTS = 12

/** Every entry fuse searches, flagged rows included (the view drops those the org lacks). */
export const paletteEntries = (inputs: EntryInputs): ReadonlyArray<PaletteEntry> => [
	...navigationEntries(),
	...footerEntries,
	...inputs.serviceNames.map((name): PaletteEntry => ({
		id: `service:${name}`,
		title: name,
		group: "Services",
		keywords: `service ${name}`,
		glyph: { _tag: "Service", serviceName: name },
		target: href(hrefOf(AppRoute.Service({ serviceName: name, search: {} }))),
	})),
	...dashboardEntries(inputs),
	...integrationEntries(),
	...actionEntries(inputs.theme),
]

export const searchEntriesOf = (entries: ReadonlyArray<PaletteEntry>): ReadonlyArray<SearchEntry> =>
	entries.map(({ id, title, keywords }) => ({ id, title, keywords }))

/** Browse mode: five services, and only the new providers; the rest stay a search away. */
export const browseEntries = (entries: ReadonlyArray<PaletteEntry>): ReadonlyArray<PaletteEntry> => {
	const services = entries.filter((entry) => entry.group === "Services").slice(0, 5)
	return entries.filter((entry) =>
		entry.group === "Services" ? services.includes(entry) : entry.isAdvertised !== false,
	)
}

/** `groupEntries`: the groups in `GROUP_ORDER`, each keeping its entries' order. */
export const groupEntries = (
	entries: ReadonlyArray<PaletteEntry>,
): ReadonlyArray<Readonly<{ group: Group; entries: ReadonlyArray<PaletteEntry> }>> =>
	GROUP_ORDER.map((group) => ({ group, entries: entries.filter((entry) => entry.group === group) })).filter(
		(section) => section.entries.length > 0,
	)
