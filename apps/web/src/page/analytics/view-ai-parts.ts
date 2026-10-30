import type { AiCrawlPurpose, AiProduct } from "@maple/domain/ai-traffic"
import {
	type AiCrawlSummary,
	type AiReferralRank,
	type AiReferralSummary,
	productForCrawler,
	purposeForCrawler,
} from "../../components/analytics/ai/ai-traffic-model"
import { SPARK_COLOR } from "../../components/infra/severity-tokens"
import { formatNumber, formatPercent, pluralize } from "@maple/ui/lib/format"
import { formatRelativeTime, toEpochMs } from "@maple/ui/lib/time-format"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { emptyMessage } from "../../ui/empty"
import { icon, type IconName } from "../../ui/icon"
import { miniBars } from "../../ui/mini-bars"
import { panel, panelHeader, panelTitle } from "../../ui/panel"
import { statFigure } from "../../ui/stat-figure"
import { columnHead, dataTable } from "../infra/kit/data-table"
import { relativeTime } from "../kit/relative-time"
import { Message } from "./message"
import type { AiCrawlers } from "./model"

// The AI tab's building blocks: its sections and product icons.

type H = HtmlBuilder<Message>

export const plural = (count: number, one: string, many: string) =>
	`${formatNumber(count)} ${pluralize(count, one, many)}`

const PRODUCT_ICONS = new Map<string, IconName>([
	["chatgpt", "OpenAiIcon"],
	["claude", "ClaudeIcon"],
	["gemini", "GeminiIcon"],
	["perplexity", "PerplexityIcon"],
	["copilot", "MicrosoftColorIcon"],
	["meta", "MetaIcon"],
	["doubao", "ByteDanceIcon"],
	["deepseek", "DeepSeekIcon"],
	["grok", "GrokIcon"],
	["mistral", "MistralIcon"],
	["kimi", "KimiIcon"],
	["amazon", "AmazonIcon"],
	["cohere", "CohereIcon"],
])

const MONO = ["var(--foreground)", "var(--foreground)"] as const

const PRODUCT_COLORS = new Map<string, readonly [string, string]>([
	["chatgpt", ["oklch(0.6 0.12 170)", "oklch(0.72 0.13 170)"]],
	["claude", ["oklch(0.63 0.14 40)", "oklch(0.72 0.13 42)"]],
	["gemini", ["oklch(0.6 0.18 258)", "oklch(0.7 0.16 258)"]],
	["perplexity", ["oklch(0.56 0.09 205)", "oklch(0.74 0.11 205)"]],
	["copilot", ["oklch(0.62 0.15 235)", "oklch(0.72 0.14 235)"]],
	["meta", ["oklch(0.56 0.21 262)", "oklch(0.68 0.18 262)"]],
	["doubao", ["oklch(0.62 0.12 200)", "oklch(0.76 0.12 200)"]],
	["deepseek", ["oklch(0.56 0.2 274)", "oklch(0.68 0.17 274)"]],
	["grok", MONO],
	["mistral", ["oklch(0.65 0.19 48)", "oklch(0.72 0.17 50)"]],
	["kimi", MONO],
	["amazon", ["oklch(0.7 0.16 70)", "oklch(0.78 0.16 72)"]],
	["cohere", ["oklch(0.58 0.08 165)", "oklch(0.72 0.09 165)"]],
	["duckduckgo", ["oklch(0.62 0.18 38)", "oklch(0.7 0.16 38)"]],
])

const FALLBACK = ["var(--muted-foreground)", "var(--muted-foreground)"] as const

/** `AiProductIcon`: the brand mark in its own hue, a light and a dark variant. */
export const aiProductIcon = (h: H, product: string, size = 16, className?: string): Html => {
	const [light, dark] = PRODUCT_COLORS.get(product) ?? FALLBACK
	return icon(h, PRODUCT_ICONS.get(product) ?? "ChatBubbleSparkleIcon", {
		size,
		style: { "--ai-brand-light": light, "--ai-brand-dark": dark },
		className: cn(
			"shrink-0 text-(--ai-brand)",
			"[--ai-brand:var(--ai-brand-light)] dark:[--ai-brand:var(--ai-brand-dark)]",
			className,
		),
	})
}

/** `AiPanel`: a titled card, optionally with the capped table and its Expand button. */
export const aiPanel = (
	h: H,
	options: Readonly<{
		title: string
		hint?: string
		aside?: Html
		className?: string
		expand?: Readonly<{ id: string; count: string; table: Html }>
	}>,
	children: ReadonlyArray<Html> = [],
): Html =>
	panel(h, { className: cn("@container/panel", options.className) }, [
		panelHeader(h, {
			divided: false,
			className: "items-start pt-3 pb-2.5",
			action:
				options.aside === undefined
					? undefined
					: h.div([h.Class("shrink-0 text-2xs text-muted-foreground")], [options.aside]),
			children: [
				h.div(
					[h.Class("min-w-0")],
					[
						panelTitle(h, [options.title]),
						...(options.hint === undefined
							? []
							: [h.div([h.Class("mt-0.5 text-2xs text-muted-foreground/70")], [options.hint])]),
					],
				),
			],
		}),
		...children,
		...(options.expand === undefined
			? []
			: [
					options.expand.table,
					h.button(
						[
							h.Type("button"),
							h.OnClick(Message.ClickedExpandPanel({ panel: options.expand.id })),
							h.Class(
								"flex w-full items-center justify-between gap-2 rounded-b-md border-t border-border/60 px-4 py-2 text-2xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:bg-muted/50 focus-visible:outline-none",
							),
						],
						[
							h.span(
								[h.Class("flex items-center gap-1.5")],
								[icon(h, "MaximizeIcon", { size: 12 }), "Expand table"],
							),
							h.span([h.Class("font-mono tabular-nums")], [options.expand.count]),
						],
					),
				]),
	])

export const aiEmpty = (h: H, children: ReadonlyArray<Html | string>): Html =>
	emptyMessage(h, { className: "px-6 leading-relaxed" }, children)

const crawlLine = (
	product: AiProduct,
	crawl: AiCrawlSummary | undefined,
	nowMs: number,
): { text: string; title?: string } => {
	const top = crawl?.purposes[0]
	if (crawl !== undefined && top !== undefined)
		return {
			text: `Read ${plural(top.pages, "page", "pages")} for ${top.purpose}, ${formatRelativeTime(toEpochMs(top.lastSeen), nowMs)}`,
			title: crawl.purposes
				.map((activity) => `${plural(activity.pages, "page", "pages")} for ${activity.purpose}`)
				.join(" · "),
		}
	if (crawl !== undefined && crawl.requests > 0)
		return {
			text: `${plural(crawl.requests, "fetch", "fetches")}, none served`,
			title: "Every fetch got an error response. Scanners often borrow crawler user agents.",
		}
	if (product.crawlsAs)
		return {
			text: `Reads pages as ${product.crawlsAs}`,
			title: `${product.label} fetches pages with ${product.crawlsAs}, so its reads cannot be told apart from search indexing.`,
		}
	return { text: "No crawler fetches" }
}

const formatRatio = (ratio: number) => (ratio < 10 ? ratio.toFixed(1) : formatNumber(Math.round(ratio)))

/** `AiProductCard`. */
export const aiProductCard = (
	h: H,
	product: AiProduct,
	referrals: AiReferralSummary | undefined,
	crawl: AiCrawlSummary | undefined,
	delay: number,
	nowMs: number,
): Html => {
	const visits = referrals?.visits ?? 0
	const served = crawl === undefined ? 0 : crawl.requests - crawl.failedRequests
	const line = crawlLine(product, crawl, nowMs)
	return panel(
		h,
		{
			className: "px-4 py-3.5 animate-in fade-in slide-in-from-bottom-1 duration-500",
			attributes: [h.Style({ "animation-delay": `${delay}ms`, "animation-fill-mode": "backwards" })],
		},
		[
			h.div(
				[h.Class("flex items-center justify-between gap-3")],
				[
					h.div(
						[h.Class("flex min-w-0 items-center gap-2")],
						[
							aiProductIcon(h, product.id),
							h.span([h.Class("truncate text-sm font-medium")], [product.label]),
						],
					),
					...(visits > 0 && served > 0
						? [
								h.span(
									[
										h.Class(
											"shrink-0 font-mono text-3xs tabular-nums text-muted-foreground/80",
										),
										h.Title(
											"Crawler fetches the site served, per visit this product sent",
										),
									],
									[formatRatio(served / visits), " fetches / visit"],
								),
							]
						: []),
				],
			),
			statFigure(h, {
				value: formatNumber(visits),
				unit: pluralize(visits, "visit sent", "visits sent"),
				size: "sm",
				className: "mt-3",
			}),
			miniBars(h, {
				values: referrals?.spark ?? [],
				color: SPARK_COLOR.neutral,
				opacityRamp: true,
				className: cn("mt-3 h-8 w-full", visits === 0 && "opacity-40"),
			}),
			h.div(
				[
					h.Class("mt-3 truncate text-2xs text-muted-foreground"),
					...(line.title === undefined ? [] : [h.Title(line.title)]),
				],
				[line.text],
			),
		],
	)
}

export type TableSurface = Readonly<{ maxHeight: string; surfaceClass: string }>
export const CARD_SURFACE: TableSurface = { maxHeight: "360px", surfaceClass: "bg-card" }
export const DIALOG_SURFACE: TableSurface = { maxHeight: "min(62vh, 640px)", surfaceClass: "bg-popover" }

/** `shareBar`. */
const shareBarStyle = (share: number): Readonly<Record<string, string>> => {
	const pct = Math.min(100, share * 100)
	if (!Number.isFinite(pct) || pct < 0.5) return {}
	const fill = "color-mix(in oklab, var(--primary) 14%, transparent)"
	return {
		"background-image": `linear-gradient(to right, ${fill} 0%, ${fill} ${pct}%, transparent ${pct}%)`,
	}
}

const shareChange = (h: H, share: number, points: number | null): Html => {
	if (points === null)
		return h.span(
			[h.Class("text-muted-foreground/70"), h.Title("No visits from it in the previous period")],
			["New"],
		)
	const before = share - points / 100
	if (Math.abs(points) < 0.05) return h.span([h.Class("text-muted-foreground/70")], ["No change"])
	return h.span(
		[
			h.Title(
				`${formatPercent(before)} of AI visits in the previous period, ${formatPercent(share)} now`,
			),
			h.Class(points > 0 ? "text-severity-info" : "text-severity-error"),
		],
		[h.span([h.AriaHidden(true)], [points > 0 ? "↑" : "↓"]), " from ", formatPercent(before)],
	)
}

/** `AiReferralRanking`'s table. */
export const rankingTable = (h: H, ranks: ReadonlyArray<AiReferralRank>, surface: TableSurface): Html =>
	dataTable(
		h,
		{ ariaLabel: "AI referrers", maxHeight: surface.maxHeight, stickySurfaceClass: surface.surfaceClass },
		[
			columnHead(h, { label: "#", width: "w-5", align: "right" }),
			columnHead(h, { label: "Assistant", width: "w-0 flex-1 min-w-0" }),
			columnHead(h, { label: "Visits", width: "w-14", align: "right" }),
			columnHead(h, { label: "Share", width: "w-14", align: "right" }),
			columnHead(h, {
				label: "Change",
				width: "w-20",
				align: "right",
				hidden: "hidden @min-[360px]/panel:flex",
			}),
		],
		ranks.map((rank, index) =>
			h.div(
				[
					h.Key(rank.product.id),
					h.Style(shareBarStyle(rank.share)),
					h.Class("flex items-center gap-4 border-b border-border/60 px-4 py-2 last:border-0"),
				],
				[
					h.span(
						[h.Class("w-5 text-right font-mono text-2xs tabular-nums text-muted-foreground/60")],
						[String(index + 1)],
					),
					h.span(
						[h.Class("flex w-0 min-w-0 flex-1 items-center gap-2")],
						[
							aiProductIcon(h, rank.product.id),
							h.span([h.Class("truncate text-xs text-foreground/90")], [rank.product.label]),
						],
					),
					h.span(
						[h.Class("w-14 text-right font-mono text-2xs tabular-nums text-muted-foreground")],
						[formatNumber(rank.visits)],
					),
					h.span(
						[h.Class("w-14 text-right font-mono text-2xs tabular-nums")],
						[formatPercent(rank.share)],
					),
					h.span(
						[
							h.Class(
								"hidden w-20 justify-end font-mono text-3xs tabular-nums @min-[360px]/panel:flex",
							),
						],
						[shareChange(h, rank.share, rank.shareDeltaPoints)],
					),
				],
			),
		),
	)

const PURPOSES = {
	training: { color: "var(--chart-tok-reasoning)", description: "Collects pages to train models" },
	search: { color: "var(--chart-tok-input)", description: "Indexes pages for AI search results" },
	answers: { color: "var(--chart-ai-tool)", description: "Fetches a page live to answer a question" },
} satisfies Record<AiCrawlPurpose, { color: string; description: string }>

const purposeBadge = (h: H, purpose: AiCrawlPurpose): Html => {
	const { color, description } = PURPOSES[purpose]
	return h.span(
		[
			h.Title(description),
			h.Style({ color, "background-color": `color-mix(in oklab, ${color} 12%, transparent)` }),
			h.Class("rounded-sm px-1.5 py-px text-3xs font-medium"),
		],
		[purpose],
	)
}

/** `AiCrawlerTable`'s table. */
export const crawlerTable = (
	h: H,
	crawlers: AiCrawlers["crawlers"],
	surface: TableSurface,
	clock: Readonly<{ nowMs: number; timeZone: string }>,
): Html =>
	dataTable(
		h,
		{ ariaLabel: "AI crawlers", maxHeight: surface.maxHeight, stickySurfaceClass: surface.surfaceClass },
		[
			columnHead(h, { label: "Crawler", width: "w-0 flex-1 min-w-0" }),
			columnHead(h, { label: "Purpose", width: "w-[72px]" }),
			columnHead(h, { label: "Pages", width: "w-12", align: "right" }),
			columnHead(h, {
				label: "Fetches",
				width: "w-14",
				align: "right",
				hidden: "hidden @min-[380px]/panel:flex",
			}),
			columnHead(h, {
				label: "Last seen",
				width: "w-20",
				align: "right",
				hidden: "hidden @min-[460px]/panel:flex",
			}),
		],
		crawlers.map((row) => {
			const product = productForCrawler(row.crawler)
			const purpose = purposeForCrawler(row.crawler)
			return h.div(
				[
					h.Key(row.crawler),
					h.Class("flex items-center gap-4 border-b border-border/60 px-4 py-2 last:border-0"),
				],
				[
					h.span(
						[h.Class("flex w-0 min-w-0 flex-1 items-center gap-2")],
						[
							aiProductIcon(h, product?.id ?? ""),
							h.span([h.Class("truncate text-xs text-foreground/90")], [row.crawler]),
						],
					),
					h.span(
						[h.Class("flex w-[72px] shrink-0")],
						purpose === undefined ? [] : [purposeBadge(h, purpose)],
					),
					h.span(
						[
							h.Class(
								cn(
									"w-12 text-right font-mono text-2xs tabular-nums",
									row.pages === 0 && "text-muted-foreground/60",
								),
							),
						],
						[formatNumber(row.pages)],
					),
					h.span(
						[
							h.Class(
								"hidden w-14 text-right font-mono text-2xs tabular-nums text-muted-foreground @min-[380px]/panel:inline-block",
							),
							...(row.failedRequests > 0
								? [
										h.Title(
											`${plural(row.failedRequests, "fetch", "fetches")} got an error response`,
										),
									]
								: []),
						],
						[formatNumber(row.requests)],
					),
					relativeTime(h, {
						value: row.lastSeen,
						nowMs: clock.nowMs,
						timeZone: clock.timeZone,
						tooltip: "title",
						className:
							"hidden w-20 text-right text-2xs text-muted-foreground @min-[460px]/panel:inline-block",
					}),
				],
			)
		}),
	)

const FORMATS: ReadonlyArray<{
	format: "markdown" | "llms" | "html"
	label: string
	description: string
	icon: IconName
}> = [
	{ format: "markdown", label: "Markdown", description: ".md pages", icon: "MarkdownIcon" },
	{
		format: "llms",
		label: "llms.txt",
		description: "llms.txt and llms-full.txt",
		icon: "UnorderedListIcon",
	},
	{ format: "html", label: "HTML", description: "Regular web pages", icon: "FileCodeIcon" },
]

const crawlerMarks = (h: H, crawlers: ReadonlyArray<string>): Html => {
	const products = [
		...new Map(
			crawlers.flatMap((name) => {
				const product = productForCrawler(name)
				return product === undefined ? [] : [[product.id, product] as const]
			}),
		).values(),
	]
	return h.span(
		[h.Class("flex items-center gap-1")],
		[
			...products
				.slice(0, 6)
				.map((product) =>
					h.span([h.Key(product.id), h.Title(product.label)], [aiProductIcon(h, product.id, 12)]),
				),
			...(products.length > 6 ? [h.span([], ["+", String(products.length - 6)])] : []),
		],
	)
}

/** `AiContentFormats`: one card per format, then the other files. */
export const contentFormats = (h: H, formats: AiCrawlers["formats"]): Html => {
	const byFormat = new Map(formats.map((row) => [row.format, row]))
	const other = byFormat.get("other")
	return h.div(
		[h.Class("space-y-2")],
		[
			h.div(
				[h.Class("grid gap-3 @min-[720px]/page:grid-cols-3")],
				FORMATS.map((entry) => {
					const row = byFormat.get(entry.format)
					const requests = row?.requests ?? 0
					const pages = row?.pages ?? 0
					return panel(h, { className: "px-4 py-3.5" }, [
						h.div(
							[h.Class("flex items-center gap-2.5")],
							[
								h.span(
									[
										h.Class(
											"flex size-7 shrink-0 items-center justify-center rounded-sm border bg-muted/40 text-muted-foreground",
										),
									],
									[icon(h, entry.icon, { size: 14 })],
								),
								h.div(
									[h.Class("min-w-0")],
									[
										h.div([h.Class("text-sm font-medium leading-tight")], [entry.label]),
										h.div(
											[h.Class("truncate text-2xs text-muted-foreground")],
											[entry.description],
										),
									],
								),
							],
						),
						statFigure(h, {
							value: formatNumber(requests),
							unit: pluralize(requests, "fetch", "fetches"),
							size: "sm",
							className: "mt-3",
						}),
						h.div(
							[
								h.Class(
									"mt-3 flex min-h-4 items-center gap-1.5 text-2xs text-muted-foreground",
								),
							],
							requests === 0
								? ["Not fetched yet"]
								: pages === 0
									? [
											h.span(
												[
													h.Title(
														"Every fetch got an error response. Check that the file exists.",
													),
												],
												["Requested, none served"],
											),
										]
									: [
											h.span([], [plural(pages, "page", "pages"), ", read by"]),
											crawlerMarks(h, row?.crawlers ?? []),
										],
						),
					])
				}),
			),
			...(other !== undefined && other.requests > 0
				? [
						h.div(
							[h.Class("flex items-center gap-1.5 px-1 text-2xs text-muted-foreground/70")],
							[
								icon(h, "FileIcon", { size: 12 }),
								plural(other.requests, "other fetch", "other fetches"),
								" (images, scripts, feeds and other files)",
							],
						),
					]
				: []),
		],
	)
}
