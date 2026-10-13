/**
 * Markup-free core of the weekly web analytics email: prop types, formatters,
 * and the headline/subject derivation. Kept apart from the renderer so the
 * backend can build subjects and content checks without the compiled markup.
 */
import { deltaArrow, fmtDeltaAbs, fmtNum, type Delta } from "./weekly-digest-core"

export { computeDelta, fmtNum, type Delta } from "./weekly-digest-core"

/**
 * Hosted PNG icons (see scripts/icons.ts). Absolute, because a mail client has
 * no origin to resolve a relative path against.
 */
export const EMAIL_ICON_BASE = "https://maple.dev/email/icons"

export type EmailIconName =
	| "visitors"
	| "pageviews"
	| "bounce"
	| "session"
	| "page"
	| "source"
	| "direct"
	| "crawler"
	| "sparkle"
	| "ai"
	| "chatgpt"
	| "claude"
	| "gemini"
	| "perplexity"
	| "copilot"
	| "meta"
	| "doubao"
	| "deepseek"
	| "grok"
	| "mistral"
	| "kimi"
	| "amazon"
	| "cohere"

const BRAND_ICONS: ReadonlySet<string> = new Set<EmailIconName>([
	"chatgpt",
	"claude",
	"gemini",
	"perplexity",
	"copilot",
	"meta",
	"doubao",
	"deepseek",
	"grok",
	"mistral",
	"kimi",
	"amazon",
	"cohere",
])

export const emailIcon = (name: EmailIconName): string => `${EMAIL_ICON_BASE}/${name}.png`

/** An AI product's brand mark, or the generic AI mark for one without a shipped icon. */
export const aiProductIcon = (productId: string): string =>
	BRAND_ICONS.has(productId) ? `${EMAIL_ICON_BASE}/${productId}.png` : emailIcon("ai")

/**
 * A referrer's favicon as a PNG. The app's own favicon service answers with
 * SVG or ICO depending on the site, and neither renders in Gmail or Outlook.
 */
export const faviconIcon = (host: string): string =>
	`https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`

/** A ranked row. Labels arrive display-ready: "Direct", product names. */
export interface WebAnalyticsRankRow {
	/** Absolute PNG URL for the row's leading icon; null for rows that need none (pages). */
	icon: string | null
	label: string
	value: number
	/** Share of the list's population, 0–1. Drives the bar under the label. */
	share: number
	/** Week-over-week comparison; absent where the list shows share instead. */
	delta?: Delta
}

export interface WebAnalyticsDigestProps {
	orgName: string
	dateRange: { start: string; end: string }
	summary: {
		visitors: { value: number; delta: Delta }
		pageViews: { value: number; delta: Delta }
		/** Percentage (0–100) over sessions that report page views; null when none do. */
		bounceRate: { value: number | null; delta: Delta }
		avgSessionMs: { value: number; delta: Delta }
	}
	/** The top three, kept short: this email is a glance, the app has the rest. */
	topPages: Array<WebAnalyticsRankRow>
	sources: Array<WebAnalyticsRankRow>
	ai: {
		/** Human sessions an AI assistant sent (referrer or utm_source). */
		referrals: { sessions: number; delta: Delta; byProduct: Array<WebAnalyticsRankRow> }
		/**
		 * Server-side fetches by AI crawlers. Null when the org's warehouse has no
		 * crawler table, so the email can leave the tile out instead of showing 0.
		 */
		crawlers: {
			requests: number
			delta: Delta
			byCrawler: Array<WebAnalyticsRankRow>
		} | null
	}
	baseUrl: string
	analyticsUrl: string
	aiUrl: string
	unsubscribeUrl: string
}

export function fmtDuration(ms: number): string {
	const totalSeconds = Math.round(ms / 1000)
	if (totalSeconds < 60) return `${totalSeconds}s`
	const minutes = Math.floor(totalSeconds / 60)
	const seconds = totalSeconds % 60
	if (minutes < 60) return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

export function fmtShare(share: number): string {
	const pct = share * 100
	if (pct > 0 && pct < 1) return "<1%"
	return `${Math.round(pct)}%`
}

/** "up 18.2%", "down 4.0%", or null when there is nothing honest to say. */
function trendPhrase(delta: Delta): string | null {
	if (delta.kind !== "pct" || Math.abs(delta.value) < 0.05) return null
	return `${delta.value > 0 ? "up" : "down"} ${fmtDeltaAbs(delta.value)}`
}

export interface WebAnalyticsHeadline {
	/** One sentence for the banner. */
	headline: string
	/** Optional second line: the week's standout, or null. */
	standout: string | null
	subject: string
}

/**
 * The banner copy and the subject line, derived together so they never drift.
 * The standout prefers AI news (it is the part of the email nobody else sends
 * them), then the top page.
 */
export function deriveWebAnalyticsHeadline(props: WebAnalyticsDigestProps): WebAnalyticsHeadline {
	const { visitors } = props.summary
	const trend = trendPhrase(visitors.delta)
	const count = `${fmtNum(visitors.value)} visitor${visitors.value === 1 ? "" : "s"}`

	const headline =
		visitors.value === 0
			? "Quiet week: no human visitors recorded."
			: visitors.delta.kind === "new"
				? `${count} this week, your first week with visitor data.`
				: trend === null
					? `${count} this week, about the same as last week.`
					: `${count} this week, ${trend} on last week.`

	const topProduct = props.ai.referrals.byProduct[0]
	const topPage = props.topPages[0]
	const standout =
		topProduct !== undefined && topProduct.value > 0
			? `${topProduct.label} sent ${fmtNum(topProduct.value)} visit${topProduct.value === 1 ? "" : "s"}${
					topProduct.delta?.kind === "new" ? " for the first time" : ""
				}.`
			: topPage !== undefined
				? `Top page: ${topPage.label} (${fmtNum(topPage.value)} views).`
				: null

	const subjectTrend =
		visitors.delta.kind === "pct" && Math.abs(visitors.delta.value) >= 0.05
			? ` (${deltaArrow(visitors.delta.value)} ${fmtDeltaAbs(visitors.delta.value)})`
			: ""
	const subject = `${props.orgName} · Web analytics · ${count}${subjectTrend}`

	return { headline, standout, subject }
}

/**
 * True when the browser SDK reported visits this week. Every figure here but the
 * crawler card comes from the SDK's sessions and page views, so an org that never
 * installed it gets no email, even when AI crawlers (server spans) hit its site.
 */
export function hasWebAnalyticsContent(props: WebAnalyticsDigestProps): boolean {
	return (
		props.summary.visitors.value > 0 ||
		props.summary.pageViews.value > 0 ||
		props.ai.referrals.sessions > 0
	)
}
