import { isPushSourcePlatform, type PushSourcePlatform } from "@maple/primitives"
import { Array as Arr, String as Str, Struct } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { cardButton } from "@maple/views/ui/card-button"
import { badge } from "@maple/views/ui/display"
import { eyebrow } from "@maple/views/ui/eyebrow"
import { revealIcon } from "@maple/views/ui/reveal-icon"
import { searchInput } from "@maple/views/ui/search-input"
import { filteredEmpty } from "@maple/views/ui/signal-empty-state"
import { vstack } from "@maple/views/ui/stack"
import { statusDot } from "@maple/views/ui/status-dot"
import { typography } from "@maple/views/ui/typography"
import { type DataIntegration, HEALTH_TONE, overviewOf } from "../../integrations/embed"
import { PLATFORMS, type PlatformMeta, platformTile } from "../kit/platforms"
import { Message } from "./message"
import type { Model } from "./model"

// The Source step: every source in one searchable picker, grouped by what it is.

type H = HtmlBuilder<Message>
type SourcePick = PushSourcePlatform | DataIntegration

/** WarpStream is a Prometheus target with its own setup, so it has no source platform of its own. */
const WARPSTREAM: PlatformMeta = {
	label: "WarpStream",
	description: "Cluster metrics via Prometheus",
	icon: "WarpStreamIcon",
}

export const integrationMeta = (integration: DataIntegration): PlatformMeta =>
	integration === "warpstream" ? WARPSTREAM : PLATFORMS[integration]

const GROUPS = ["code", "infrastructure", "cloud", "ai"] as const
type Group = (typeof GROUPS)[number]

const GROUP_TITLE = {
	code: "Your code",
	infrastructure: "Infrastructure",
	cloud: "Cloud and platforms",
	ai: "AI",
} as const satisfies Record<Group, string>

/** Where each source sits, in the order its group lists it. A new source does not compile until placed. */
const GROUP_OF = {
	nodejs: "code",
	python: "code",
	go: "code",
	java: "code",
	dotnet: "code",
	ruby: "code",
	php: "code",
	rust: "code",
	browser: "code",
	opentelemetry: "code",
	kubernetes: "infrastructure",
	docker: "infrastructure",
	host: "infrastructure",
	prometheus: "infrastructure",
	warpstream: "infrastructure",
	cloudflare: "cloud",
	aws: "cloud",
	gcp: "cloud",
	vercel: "cloud",
	railway: "cloud",
	planetscale: "cloud",
	supabase: "cloud",
	github: "cloud",
	claude_code: "ai",
	cloudflare_ai_gateway: "ai",
} as const satisfies Record<SourcePick, Group>

const PICKS: ReadonlyArray<SourcePick> = Struct.keys(GROUP_OF)

const metaOf = (pick: SourcePick): PlatformMeta =>
	isPushSourcePlatform(pick) ? PLATFORMS[pick] : integrationMeta(pick)

/** Push platforms create a source on their own page; integrations open their connect step. */
const selectOf = (pick: SourcePick): Message =>
	isPushSourcePlatform(pick)
		? Message.ClickedPushPlatform({ platform: pick })
		: Message.ClickedIntegration({ integration: pick })

/** The search matches a source's name and what it collects, so "metrics" finds Prometheus. */
const matches = (pick: SourcePick, query: string): boolean => {
	const meta = metaOf(pick)
	return Str.includes(query)(Str.toLowerCase(`${meta.label} ${meta.description}`))
}

/** "Connected" on an integration that already feeds a source, toned by its health. */
const connectedBadge = (h: H, model: Model, pick: SourcePick): Html | null => {
	if (isPushSourcePlatform(pick)) return null
	const overview = overviewOf(model.integrations.statuses, model.integrations.nowMs, pick)
	if (overview?.kind !== "connected") return null
	return badge(h, { variant: "meta", className: "shrink-0 gap-1.5" }, [
		statusDot(h, { tone: HEALTH_TONE[overview.health] }),
		"Connected",
	])
}

/** A language or SDK: its mark and name are the whole choice. */
const compactCard = (h: H, pick: SourcePick): Html =>
	cardButton(
		h,
		{
			onClick: selectOf(pick),
			className: "flex items-center gap-2.5 px-2.5 py-2",
			attributes: [h.Key(pick)],
		},
		[
			platformTile(h, metaOf(pick), "sm"),
			typography(h, { size: "sm", weight: "medium", truncate: true, className: "min-w-0 flex-1" }, [
				metaOf(pick).label,
			]),
		],
	)

/** Everything else says what it collects under its name. */
const card = (h: H, model: Model, pick: SourcePick): Html => {
	const meta = metaOf(pick)
	const connected = connectedBadge(h, model, pick)
	return cardButton(
		h,
		{
			onClick: selectOf(pick),
			className: "flex items-center gap-3 px-3 py-3",
			attributes: [h.Key(pick)],
		},
		[
			platformTile(h, meta),
			vstack(h, { gap: "0.5", shrink: true, grow: true, as: "span" }, [
				typography(h, { size: "sm", weight: "medium", truncate: true }, [meta.label]),
				typography(h, { size: "xs", tone: "muted", truncate: true, className: "font-prose" }, [
					meta.description,
				]),
			]),
			...(connected === null ? [] : [connected]),
			revealIcon(h, "ChevronRightIcon"),
		],
	)
}

const GRID = {
	compact: "grid grid-cols-2 gap-2 @2xl/page:grid-cols-3 @5xl/page:grid-cols-5",
	card: "grid gap-2 @2xl/page:grid-cols-2 @5xl/page:grid-cols-3",
} as const

const section = (h: H, model: Model, group: Group, picks: ReadonlyArray<SourcePick>): Html =>
	vstack(h, { gap: "3", as: "section", attributes: [h.Key(group)] }, [
		eyebrow(h, { as: "h2" }, [GROUP_TITLE[group]]),
		h.div(
			[h.Class(group === "code" ? GRID.compact : GRID.card)],
			Arr.map(picks, (pick) => (group === "code" ? compactCard(h, pick) : card(h, model, pick))),
		),
	])

export const platformPicker = (h: H, model: Model): Html => {
	const query = Str.toLowerCase(Str.trim(model.search))
	const shown = query === "" ? PICKS : Arr.filter(PICKS, (pick) => matches(pick, query))
	const clear = Message.ChangedSearch({ value: "" })
	return vstack(h, { gap: "6" }, [
		searchInput(h, {
			id: "sources-new-search",
			value: model.search,
			placeholder: `Search ${PICKS.length} sources…`,
			ariaLabel: "Search sources",
			size: "default",
			className: "max-w-sm",
			onInput: (value) => Message.ChangedSearch({ value }),
			onClear: clear,
		}),
		...(shown.length === 0
			? [
					filteredEmpty(h, {
						noun: "sources",
						title: "No sources match",
						description: "Any OpenTelemetry SDK or collector can send to Maple.",
						onClear: clear,
						clearLabel: "Clear search",
						className: "py-10 md:py-12",
					}),
				]
			: Arr.flatMap(GROUPS, (group) => {
					const picks = Arr.filter(shown, (pick) => GROUP_OF[pick] === group)
					return picks.length === 0 ? [] : [section(h, model, group, picks)]
				})),
	])
}
