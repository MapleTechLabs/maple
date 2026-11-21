/**
 * The status page's link preview (`og:image`): the page's own theme, its overall status and what
 * is wrong, drawn at 1200x630. Pure: `statusOgCard` reads the snapshot into a plain model, which
 * the meta tags hash into the image URL, and `statusOgCardNode` lays it out for takumi.
 * The status Worker rasterises it.
 */
import { container, image, text, type Node } from "@takumi-rs/helpers"
import {
	dayState,
	lastDays,
	overallStatus,
	type ResolvedStatusPageThemeTokens,
	STATUS_PAGE_WINDOW_DAYS,
	type StatusPageDayState,
	type StatusPageFreshness,
	type StatusPagePublicSnapshot,
	type StatusPageThemeFont,
	uptimePercent,
} from "@maple/domain/status-page"
import type { StatusPageComponentStatus } from "@maple/primitives"
import { Array as Arr, Schema } from "effect"
import { safeImageUrl } from "./escape"
import { MAPLE_MARK_PATH, STATUS_GLYPH } from "./icons"
import { COMPONENT_STATUS_LABEL, formatPercent, HERO_SENTENCE } from "./format"
import { activeIncidents } from "./select"
import { resolveSafeTheme, safeTheme } from "./theme"

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

export const OG_CARD_WIDTH = 1200
export const OG_CARD_HEIGHT = 630

/** Each theme font ships in these subsets, registered as one family per subset. */
export const OG_FONT_SUBSETS = ["latin", "latin-ext", "cyrillic"] as const
export type OgFontSubset = (typeof OG_FONT_SUBSETS)[number]

/** The family the renderer registers one font subset under. */
export const ogFontName = (font: StatusPageThemeFont, subset: OgFontSubset): string =>
	`Status ${font} ${subset}`

/** A theme font as a CSS family list: its subsets in order, so a glyph missing from one falls to the next. */
const fontStack = (font: StatusPageThemeFont): string =>
	Arr.join(
		Arr.map(OG_FONT_SUBSETS, (subset) => ogFontName(font, subset)),
		", ",
	)

/** Lines under the headline that fit with a one-line headline; the rest is counted, never implied. */
const MAX_DETAIL_LINES = 2

export interface StatusOgCard {
	readonly name: string
	/** Where the page lives, as the footer prints it: `status.acme.com`. */
	readonly host: string | null
	readonly status: StatusPageComponentStatus
	readonly headline: string
	/** Active incident titles, else the affected components; empty when all is well. */
	readonly details: ReadonlyArray<string>
	readonly moreDetails: number
	/** Live checks stopped reporting: the status shown is the last known one. */
	readonly delayed: boolean
	/** One state per day of the window across every component that shows uptime, oldest first. */
	readonly days: ReadonlyArray<StatusPageDayState>
	/** Over the same window, one decimal; null when nothing was checked. */
	readonly uptime: string | null
	readonly logoUrl: string | null
	readonly poweredBy: boolean
	readonly font: StatusPageThemeFont
	readonly radiusPx: number
	readonly tokens: ResolvedStatusPageThemeTokens
}

const DAY_RANK = { none: 0, ok: 1, degraded: 2, down: 3 } as const satisfies Record<
	StatusPageDayState,
	number
>

/** Each day's worst state across the components that show uptime; empty when none does. */
const overallDays = (
	snapshot: StatusPagePublicSnapshot,
): { readonly days: ReadonlyArray<StatusPageDayState>; readonly uptime: number | null } => {
	// The page's own rule: only a component with uptime shown and days recorded draws bars.
	const shown = Arr.filter(
		snapshot.components,
		(component) => component.showUptime && component.days.length > 0,
	)
	if (shown.length === 0) return { days: [], uptime: null }
	const window = new Set(lastDays(snapshot.generatedAt, STATUS_PAGE_WINDOW_DAYS))
	// Snapshots carry a year of days; the card shows and counts only the window.
	const bars = Arr.filter(
		Arr.flatMap(shown, (component) => component.days),
		(bar) => window.has(bar.day),
	)
	const worst = Arr.reduce(bars, new Map<string, StatusPageDayState>(), (byDay, bar) => {
		const state = dayState(bar)
		const seen = byDay.get(bar.day)
		return seen === undefined || DAY_RANK[state] > DAY_RANK[seen] ? byDay.set(bar.day, state) : byDay
	})
	return {
		days: Arr.map([...window], (day) => worst.get(day) ?? "none"),
		uptime: uptimePercent(bars),
	}
}

/**
 * The card for a page as it is now. A forced appearance draws that scheme; `auto` draws light,
 * which is what a visitor without a preference sees. The logo follows the same choice.
 */
export const statusOgCard = (
	snapshot: StatusPagePublicSnapshot,
	freshness: StatusPageFreshness,
	host: string | null,
): StatusOgCard => {
	const theme = safeTheme(snapshot.page.theme)
	const resolved = resolveSafeTheme(snapshot.page.theme)
	const dark = theme.appearance === "dark"
	const status = overallStatus(snapshot)
	const active = activeIncidents(snapshot)
	const affected = Arr.filter(snapshot.components, (component) => component.status !== "operational")
	const lines =
		active.length > 0
			? Arr.map(active, (incident) => incident.title)
			: Arr.map(
					affected,
					(component) => `${component.name}: ${COMPONENT_STATUS_LABEL[component.status]}`,
				)
	const { days, uptime } = overallDays(snapshot)
	const light = safeImageUrl(snapshot.page.logoUrl)
	const darkLogo = safeImageUrl(snapshot.page.logoDarkUrl)
	return {
		name: snapshot.page.name,
		host,
		status,
		headline: HERO_SENTENCE[status],
		// Past the budget, the counter takes the last line.
		details: lines.length <= MAX_DETAIL_LINES ? lines : lines.slice(0, MAX_DETAIL_LINES - 1),
		moreDetails: lines.length <= MAX_DETAIL_LINES ? 0 : lines.length - MAX_DETAIL_LINES + 1,
		delayed: freshness._tag === "delayed",
		days,
		uptime: uptime === null ? null : formatPercent(uptime),
		logoUrl: dark ? (darkLogo ?? light) : (light ?? darkLogo),
		poweredBy: snapshot.page.showPoweredBy,
		font: theme.font,
		radiusPx: resolved.radiusPx,
		tokens: dark ? resolved.dark : resolved.light,
	}
}

/** FNV-1a over the model: the image URL changes whenever anything drawn on it does. */
export const statusOgCardVersion = (card: StatusOgCard): string => {
	// A loop over char codes: an uploaded logo makes the input a few hundred KB, rendered per page view.
	const input = new TextEncoder().encode(encodeJson(card))
	let hash = 0x811c9dc5
	for (const byte of input) hash = Math.imul(hash ^ byte, 0x01000193)
	return (hash >>> 0).toString(36)
}

const STATUS_COLOR = {
	operational: "ok",
	degraded: "degraded",
	partial_outage: "partial",
	major_outage: "major",
	maintenance: "maint",
} as const satisfies Record<StatusPageComponentStatus, keyof ResolvedStatusPageThemeTokens>

const STATUS_TINT = {
	operational: "okTint",
	degraded: "degradedTint",
	partial_outage: "partialTint",
	major_outage: "majorTint",
	maintenance: "maintTint",
} as const satisfies Record<StatusPageComponentStatus, keyof ResolvedStatusPageThemeTokens>

const DAY_COLOR = {
	ok: "ok",
	degraded: "degraded",
	down: "major",
	none: "line",
} as const satisfies Record<StatusPageDayState, keyof ResolvedStatusPageThemeTokens>

/** The status disc as an SVG image; takumi's SVG path wants hex, which every token is. */
const statusDisc = (status: StatusPageComponentStatus, fill: string, glyph: string, size: number): Node =>
	image({
		src: `data:image/svg+xml;base64,${btoa(
			`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="8" fill="${fill}"/><path d="${STATUS_GLYPH[status]}" fill="none" stroke="${glyph}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
		)}`,
		width: size,
		height: size,
	})

const mapleMark = (size: number): Node =>
	image({
		src: `data:image/svg+xml;base64,${btoa(
			`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 739 739"><path fill-rule="evenodd" fill="#E86F00" d="${MAPLE_MARK_PATH}"/></svg>`,
		)}`,
		width: size,
		height: size,
	})

const PADDING = 64
const LOGO_HEIGHT = 56
const LOGO_MAX_WIDTH = 420

/** Room beside the status disc inside the banner. */
const HEADLINE_WIDTH = 930

/** Average semibold advance per font size, measured on the bundled faces with headroom. */
const ADVANCE = { sans: 0.54, serif: 0.5, mono: 0.62 } as const satisfies Record<StatusPageThemeFont, number>

/**
 * The largest size, up to 64px, at which the headline fits one line, so the banner's height and
 * everything under it is the same for every status. Nothing here can measure text.
 */
const headlineSize = (headline: string, font: StatusPageThemeFont): number =>
	Math.max(40, Math.min(64, Math.floor(HEADLINE_WIDTH / (headline.length * ADVANCE[font]))))

/** The logo when the Worker could load it, else the page name in the theme's type. */
const brand = (card: StatusOgCard, logoLoaded: boolean, family: string): Node =>
	logoLoaded && card.logoUrl !== null
		? image({
				src: card.logoUrl,
				style: { height: LOGO_HEIGHT, maxWidth: LOGO_MAX_WIDTH, objectFit: "contain" },
			})
		: text(card.name, {
				// As the page header draws the site name.
				color: card.tokens.secondary,
				fontSize: 40,
				fontWeight: 600,
				fontFamily: family,
				letterSpacing: -0.8,
				lineClamp: 1,
			})

const detailLine = (label: string, card: StatusOgCard, family: string): Node =>
	container({
		style: { display: "flex", alignItems: "center", gap: 16, height: 42 },
		children: [
			container({
				style: {
					width: 8,
					height: 8,
					borderRadius: 4,
					backgroundColor: card.tokens[STATUS_COLOR[card.status]],
				},
			}),
			text(label, { color: card.tokens.fg, fontSize: 28, fontFamily: family, lineClamp: 1 }),
		],
	})

const uptimeStrip = (card: StatusOgCard, family: string): ReadonlyArray<Node> =>
	card.days.length === 0
		? []
		: [
				container({
					style: { display: "flex", flexDirection: "column", gap: 14, marginTop: 28 },
					children: [
						container({
							style: { display: "flex", gap: 4, height: 44 },
							children: Arr.map(card.days, (state) =>
								container({
									style: {
										flexGrow: 1,
										borderRadius: Math.min(card.radiusPx, 3),
										backgroundColor: card.tokens[DAY_COLOR[state]],
									},
								}),
							),
						}),
						container({
							style: { display: "flex", justifyContent: "space-between" },
							children: [
								text(`${STATUS_PAGE_WINDOW_DAYS} days ago`, {
									color: card.tokens.muted,
									fontSize: 20,
									fontFamily: family,
								}),
								...(card.uptime === null
									? []
									: [
											text(`${card.uptime} uptime`, {
												color: card.tokens.muted,
												fontSize: 20,
												fontFamily: family,
											}),
										]),
								text("Today", { color: card.tokens.muted, fontSize: 20, fontFamily: family }),
							],
						}),
					],
				}),
			]

const footer = (card: StatusOgCard, family: string): Node =>
	container({
		style: {
			display: "flex",
			alignItems: "center",
			justifyContent: "space-between",
			gap: 32,
			marginTop: 28,
			height: 30,
		},
		children: [
			text(card.delayed ? "Live checks delayed · last known state" : (card.host ?? ""), {
				color: card.delayed ? card.tokens.degraded : card.tokens.muted,
				fontSize: 22,
				fontFamily: family,
				lineClamp: 1,
			}),
			...(card.poweredBy
				? [
						container({
							style: { display: "flex", alignItems: "center", gap: 10, flexShrink: 0 },
							children: [
								mapleMark(24),
								text("Powered by Maple", {
									color: card.tokens.muted,
									fontSize: 20,
									fontFamily: family,
								}),
							],
						}),
					]
				: []),
		],
	})

/** `logoLoaded`: the renderer has the logo's bytes; without them the card names the page instead. */
export const statusOgCardNode = (card: StatusOgCard, logoLoaded: boolean): Node => {
	const family = fontStack(card.font)
	const tokens = card.tokens
	const ok = card.status === "operational"
	const radius = card.radiusPx * 2
	const more = card.moreDetails === 0 ? [] : [`+${card.moreDetails} more`]
	return container({
		style: {
			width: OG_CARD_WIDTH,
			height: OG_CARD_HEIGHT,
			display: "flex",
			flexDirection: "column",
			padding: PADDING,
			backgroundColor: tokens.bg,
		},
		children: [
			container({
				style: { display: "flex", alignItems: "center", height: LOGO_HEIGHT },
				children: [brand(card, logoLoaded, family)],
			}),
			container({
				style: {
					display: "flex",
					flexDirection: "column",
					marginTop: 36,
					padding: "28px 32px",
					borderRadius: radius,
					border: `2px solid ${ok ? tokens.line : tokens[STATUS_COLOR[card.status]]}`,
					backgroundColor: ok ? tokens.card : tokens[STATUS_TINT[card.status]],
				},
				children: [
					container({
						style: { display: "flex", alignItems: "center", gap: 22 },
						children: [
							statusDisc(
								card.status,
								tokens[STATUS_COLOR[card.status]],
								ok ? tokens.card : tokens[STATUS_TINT[card.status]],
								52,
							),
							text(card.headline, {
								color: tokens.fg,
								fontSize: headlineSize(card.headline, card.font),
								fontWeight: 600,
								fontFamily: family,
								letterSpacing: card.font === "mono" ? -1 : -1.6,
								lineClamp: 1,
							}),
						],
					}),
					...(card.details.length === 0
						? []
						: [
								container({
									style: {
										display: "flex",
										flexDirection: "column",
										marginTop: 14,
										paddingLeft: 74,
									},
									children: [
										...Arr.map(card.details, (line) => detailLine(line, card, family)),
										...Arr.map(more, (line) =>
											text(line, {
												color: tokens.muted,
												fontSize: 24,
												fontFamily: family,
												height: 36,
												paddingLeft: 24,
											}),
										),
									],
								}),
							]),
				],
			}),
			container({ style: { flexGrow: 1 } }),
			...uptimeStrip(card, family),
			footer(card, family),
		],
	})
}

/** The card in words, for `og:image:alt`. */
export const statusOgAlt = (card: StatusOgCard): string =>
	`${card.name} status: ${card.headline}${card.details.length === 0 ? "" : `. ${Arr.join(card.details, ", ")}`}${card.delayed ? ". Live checks delayed, last known state" : ""}`
