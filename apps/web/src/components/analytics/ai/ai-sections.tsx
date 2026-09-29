import { useState, type ReactNode } from "react"

import { cn } from "@maple/ui/lib/utils"
import {
	Dialog,
	DialogDescription,
	DialogHeader,
	DialogPopup,
	DialogTitle,
} from "@maple/ui/components/ui/dialog"
import { formatNumber, formatPercent } from "@maple/ui/lib/format"
import { formatRelativeTime } from "@maple/ui/lib/time-format"
import type { AiContentFormat, AiCrawlPurpose, AiProduct } from "@maple/domain/ai-traffic"

import { ColumnHead, DataTable } from "../../infra/primitives/data-table"
import { shareBar } from "../../infra/primitives/share-bar"
import { BarSpark } from "../../infra/primitives/stat-rail"
import { SPARK_COLOR } from "../../infra/severity-tokens"
import {
	FileCodeIcon,
	FileIcon,
	MarkdownIcon,
	MaximizeIcon,
	UnorderedListIcon,
	type IconComponent,
} from "@/components/icons"
import type { WebAnalyticsAiCrawler, WebAnalyticsAiCrawlerFormat } from "@/api/warehouse/web-analytics"
import { AiProductIcon } from "./ai-product-icon"
import {
	productForCrawler,
	purposeForCrawler,
	type AiCrawlSummary,
	type AiReferralRank,
	type AiReferralSummary,
} from "./ai-traffic-model"

const plural = (count: number, one: string, many: string) =>
	`${formatNumber(count)} ${count === 1 ? one : many}`

/** Where a panel's table is drawn: capped inside the card, taller in the expand dialog. */
interface AiTableSurface {
	readonly maxHeight: number | string
	readonly surfaceClass: string
}

const CARD_SURFACE: AiTableSurface = { maxHeight: 360, surfaceClass: "bg-card" }
const DIALOG_SURFACE: AiTableSurface = { maxHeight: "min(62vh, 640px)", surfaceClass: "bg-popover" }

/**
 * Card frame for the AI tab's panels: an 11px title, an optional hint, then the body.
 * With `expand`, the body is a table that also reopens in a dialog, like the Overview breakdowns.
 */
export function AiPanel({
	title,
	hint,
	aside,
	children,
	expand,
	className,
}: {
	title: string
	hint?: ReactNode
	aside?: ReactNode
	children?: ReactNode
	expand?: { count: string; table: (surface: AiTableSurface) => ReactNode }
	className?: string
}) {
	const [expanded, setExpanded] = useState(false)
	return (
		<div className={cn("@container/panel rounded-md border bg-card", className)}>
			<div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 px-4 pt-3 pb-2.5">
				<div className="min-w-0">
					<div className="text-[11px] font-medium text-muted-foreground">{title}</div>
					{hint ? <div className="mt-0.5 text-[11px] text-muted-foreground/70">{hint}</div> : null}
				</div>
				{aside ? <div className="shrink-0 text-[11px] text-muted-foreground">{aside}</div> : null}
			</div>
			{children}
			{expand ? (
				<>
					{expand.table(CARD_SURFACE)}
					<button
						type="button"
						onClick={() => setExpanded(true)}
						className="flex w-full items-center justify-between gap-2 rounded-b-md border-t border-border/40 px-4 py-2 text-[11px] text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground focus-visible:bg-muted/40 focus-visible:outline-none"
					>
						<span className="flex items-center gap-1.5">
							<MaximizeIcon size={12} />
							Expand table
						</span>
						<span className="font-mono tabular-nums">{expand.count}</span>
					</button>
					<Dialog open={expanded} onOpenChange={setExpanded}>
						<DialogPopup className="w-[900px] max-w-[92vw] gap-0 p-0 max-sm:w-full">
							<DialogHeader className="pb-3">
								<div className="flex flex-col gap-1 pe-8">
									<DialogTitle className="text-base">{title}</DialogTitle>
									{hint ? <DialogDescription>{hint}</DialogDescription> : null}
								</div>
							</DialogHeader>
							{/* Its own `/panel` container, so the columns the card sheds come back at dialog width. */}
							<div className="@container/panel">{expand.table(DIALOG_SURFACE)}</div>
						</DialogPopup>
					</Dialog>
				</>
			) : null}
		</div>
	)
}

export function AiEmpty({ children }: { children: ReactNode }) {
	return (
		<div className="px-6 pt-4 pb-8 text-center text-[12px] leading-relaxed text-muted-foreground">
			{children}
		</div>
	)
}

// Product cards

/** What the product's crawlers did, as one line under its card. */
function crawlLine(product: AiProduct, crawl: AiCrawlSummary | undefined): { text: string; title?: string } {
	const top = crawl?.purposes[0]
	if (crawl && top) {
		return {
			text: `Read ${plural(top.pages, "page", "pages")} for ${top.purpose}, ${formatRelativeTime(top.lastSeen)}`,
			title: crawl.purposes
				.map((activity) => `${plural(activity.pages, "page", "pages")} for ${activity.purpose}`)
				.join(" · "),
		}
	}
	if (crawl && crawl.requests > 0) {
		return {
			text: `${plural(crawl.requests, "fetch", "fetches")}, none served`,
			title: "Every fetch got an error response. Scanners often borrow crawler user agents.",
		}
	}
	if (product.crawlsAs) {
		return {
			text: `Reads pages as ${product.crawlsAs}`,
			title: `${product.label} fetches pages with ${product.crawlsAs}, so its reads cannot be told apart from search indexing.`,
		}
	}
	return { text: "No crawler fetches" }
}

export function AiProductCard({
	product,
	referrals,
	crawl,
	delay,
}: {
	product: AiProduct
	referrals: AiReferralSummary | undefined
	crawl: AiCrawlSummary | undefined
	delay: number
}) {
	const visits = referrals?.visits ?? 0
	const served = crawl ? crawl.requests - crawl.failedRequests : 0
	const line = crawlLine(product, crawl)

	return (
		<div
			className="rounded-md border bg-card px-4 py-3.5 animate-in fade-in slide-in-from-bottom-1 duration-500"
			style={{ animationDelay: `${delay}ms`, animationFillMode: "backwards" }}
		>
			<div className="flex items-center justify-between gap-3">
				<div className="flex min-w-0 items-center gap-2">
					<AiProductIcon product={product.id} />
					<span className="truncate text-[13px] font-medium">{product.label}</span>
				</div>
				{visits > 0 && served > 0 ? (
					<span
						className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground/80"
						title="Crawler fetches the site served, per visit this product sent"
					>
						{formatRatio(served / visits)} fetches / visit
					</span>
				) : null}
			</div>
			<div className="mt-3 flex items-baseline gap-1.5">
				<span className="font-mono text-[22px] font-semibold tabular-nums leading-none">
					{formatNumber(visits)}
				</span>
				<span className="text-[11px] text-muted-foreground">
					{visits === 1 ? "visit sent" : "visits sent"}
				</span>
			</div>
			<BarSpark
				values={referrals?.spark ?? []}
				color={SPARK_COLOR.neutral}
				className={cn("mt-3 h-8 w-full", visits === 0 && "opacity-40")}
			/>
			<div className="mt-3 truncate text-[11px] text-muted-foreground" title={line.title}>
				{line.text}
			</div>
		</div>
	)
}

const formatRatio = (ratio: number) => (ratio < 10 ? ratio.toFixed(1) : formatNumber(Math.round(ratio)))

// Referral ranking

export function AiReferralRanking({ ranks }: { ranks: ReadonlyArray<AiReferralRank> }) {
	const title = "Share of AI visits"
	const hint = "Change in share since the previous period"
	if (ranks.length === 0) {
		return (
			<AiPanel title={title} hint={hint}>
				<AiEmpty>
					No visits from AI assistants in this window. When someone follows a link from ChatGPT,
					Perplexity, Claude or another assistant, it shows up here.
				</AiEmpty>
			</AiPanel>
		)
	}
	return (
		<AiPanel
			title={title}
			hint={hint}
			expand={{
				count: plural(ranks.length, "assistant", "assistants"),
				table: ({ maxHeight, surfaceClass }) => (
					<DataTable.Root
						ariaLabel="AI referrers"
						maxHeight={maxHeight}
						stickySurfaceClass={surfaceClass}
					>
						<DataTable.Head>
							<ColumnHead label="#" width="w-5" align="right" />
							<ColumnHead label="Assistant" width="w-0 flex-1 min-w-0" />
							<ColumnHead label="Visits" width="w-14" align="right" />
							<ColumnHead label="Share" width="w-14" align="right" />
							<ColumnHead
								label="Change"
								width="w-20"
								align="right"
								hidden="hidden @min-[360px]/panel:flex"
							/>
						</DataTable.Head>
						{ranks.map((rank, index) => (
							<div
								key={rank.product.id}
								style={shareBar(rank.share)}
								className="flex items-center gap-4 border-b border-border/40 px-4 py-2 last:border-0"
							>
								<span className="w-5 text-right font-mono text-[11px] tabular-nums text-muted-foreground/60">
									{index + 1}
								</span>
								<span className="flex w-0 min-w-0 flex-1 items-center gap-2">
									<AiProductIcon product={rank.product.id} />
									<span className="truncate text-[12px] text-foreground/90">
										{rank.product.label}
									</span>
								</span>
								<span className="w-14 text-right font-mono text-[11px] tabular-nums text-muted-foreground">
									{formatNumber(rank.visits)}
								</span>
								<span className="w-14 text-right font-mono text-[11px] tabular-nums">
									{formatPercent(rank.share)}
								</span>
								<span className="hidden w-20 justify-end font-mono text-[10px] tabular-nums @min-[360px]/panel:flex">
									<ShareChange share={rank.share} points={rank.shareDeltaPoints} />
								</span>
							</div>
						))}
					</DataTable.Root>
				),
			}}
		/>
	)
}

/**
 * The share this assistant had in the previous period, not a signed delta: "from 64%"
 * reads on its own, where "12.5 pts" (percentage points) needed explaining.
 */
function ShareChange({ share, points }: { share: number; points: number | null }) {
	if (points === null) {
		return (
			<span className="text-muted-foreground/70" title="No visits from it in the previous period">
				New
			</span>
		)
	}
	const before = share - points / 100
	if (Math.abs(points) < 0.05) return <span className="text-muted-foreground/70">No change</span>
	return (
		<span
			title={`${formatPercent(before)} of AI visits in the previous period, ${formatPercent(share)} now`}
			className={points > 0 ? "text-[var(--severity-info)]" : "text-[var(--severity-error)]"}
		>
			<span aria-hidden>{points > 0 ? "↑" : "↓"}</span> from {formatPercent(before)}
		</span>
	)
}

// Crawler table

export function AiCrawlerTable({
	crawlers,
	emptyMessage,
}: {
	crawlers: ReadonlyArray<WebAnalyticsAiCrawler>
	emptyMessage: ReactNode
}) {
	const requests = crawlers.reduce((sum, row) => sum + row.requests, 0)
	const failed = crawlers.reduce((sum, row) => sum + row.failedRequests, 0)

	const title = "AI crawlers"
	const hint = "Pages served to each crawler. Error responses are not counted as reads."
	if (crawlers.length === 0) {
		return (
			<AiPanel title={title} hint={hint}>
				<AiEmpty>{emptyMessage}</AiEmpty>
			</AiPanel>
		)
	}
	return (
		<AiPanel
			title={title}
			hint={hint}
			aside={
				failed > 0 ? (
					<span title="User agents are easy to spoof: scanners borrow crawler names and mostly get 404s.">
						{formatPercent(failed / Math.max(requests, 1))} of fetches failed
					</span>
				) : undefined
			}
			expand={{
				count: plural(crawlers.length, "crawler", "crawlers"),
				table: ({ maxHeight, surfaceClass }) => (
					<DataTable.Root
						ariaLabel="AI crawlers"
						maxHeight={maxHeight}
						stickySurfaceClass={surfaceClass}
					>
						<DataTable.Head>
							<ColumnHead label="Crawler" width="w-0 flex-1 min-w-0" />
							<ColumnHead label="Purpose" width="w-[72px]" />
							<ColumnHead label="Pages" width="w-12" align="right" />
							<ColumnHead
								label="Fetches"
								width="w-14"
								align="right"
								hidden="hidden @min-[380px]/panel:flex"
							/>
							<ColumnHead
								label="Last seen"
								width="w-20"
								align="right"
								hidden="hidden @min-[460px]/panel:flex"
							/>
						</DataTable.Head>
						{crawlers.map((row) => {
							const product = productForCrawler(row.crawler)
							const purpose = purposeForCrawler(row.crawler)
							return (
								<div
									key={row.crawler}
									className="flex items-center gap-4 border-b border-border/40 px-4 py-2 last:border-0"
								>
									<span className="flex w-0 min-w-0 flex-1 items-center gap-2">
										<AiProductIcon product={product?.id ?? ""} />
										<span className="truncate text-[12px] text-foreground/90">
											{row.crawler}
										</span>
									</span>
									<span className="flex w-[72px] shrink-0">
										{purpose ? <PurposeBadge purpose={purpose} /> : null}
									</span>
									<span
										className={cn(
											"w-12 text-right font-mono text-[11px] tabular-nums",
											row.pages === 0 && "text-muted-foreground/60",
										)}
									>
										{formatNumber(row.pages)}
									</span>
									<span
										className="hidden w-14 text-right font-mono text-[11px] tabular-nums text-muted-foreground @min-[380px]/panel:inline-block"
										title={
											row.failedRequests > 0
												? `${plural(row.failedRequests, "fetch", "fetches")} got an error response`
												: undefined
										}
									>
										{formatNumber(row.requests)}
									</span>
									<span className="hidden w-20 text-right text-[11px] text-muted-foreground @min-[460px]/panel:inline-block">
										{formatRelativeTime(row.lastSeen)}
									</span>
								</div>
							)
						})}
					</DataTable.Root>
				),
			}}
		/>
	)
}

/** One hue per purpose, from the chart tokens, so the column scans by colour. */
const PURPOSES = {
	training: { color: "var(--chart-tok-reasoning)", description: "Collects pages to train models" },
	search: { color: "var(--chart-tok-input)", description: "Indexes pages for AI search results" },
	answers: { color: "var(--chart-ai-tool)", description: "Fetches a page live to answer a question" },
} satisfies Record<AiCrawlPurpose, { color: string; description: string }>

function PurposeBadge({ purpose }: { purpose: AiCrawlPurpose }) {
	const { color, description } = PURPOSES[purpose]
	return (
		<span
			title={description}
			style={{ color, backgroundColor: `color-mix(in oklab, ${color} 12%, transparent)` }}
			className="rounded-sm px-1.5 py-px text-[10px] font-medium"
		>
			{purpose}
		</span>
	)
}

// Content formats

const FORMATS: ReadonlyArray<{
	format: Exclude<AiContentFormat, "other">
	label: string
	description: string
	icon: IconComponent
}> = [
	{ format: "markdown", label: "Markdown", description: ".md pages", icon: MarkdownIcon },
	{ format: "llms", label: "llms.txt", description: "llms.txt and llms-full.txt", icon: UnorderedListIcon },
	{ format: "html", label: "HTML", description: "Regular web pages", icon: FileCodeIcon },
]

export function AiContentFormats({ formats }: { formats: ReadonlyArray<WebAnalyticsAiCrawlerFormat> }) {
	const byFormat = new Map(formats.map((row) => [row.format, row]))
	const other = byFormat.get("other")

	return (
		<div className="space-y-2">
			<div className="grid gap-3 @min-[720px]/page:grid-cols-3">
				{FORMATS.map((entry) => (
					<FormatCard key={entry.format} {...entry} row={byFormat.get(entry.format)} />
				))}
			</div>
			{other && other.requests > 0 ? (
				<div className="flex items-center gap-1.5 px-1 text-[11px] text-muted-foreground/70">
					<FileIcon size={12} />
					{plural(other.requests, "other fetch", "other fetches")} (images, scripts, feeds and other
					files)
				</div>
			) : null}
		</div>
	)
}

function FormatCard({
	label,
	description,
	icon: Icon,
	row,
}: {
	label: string
	description: string
	icon: IconComponent
	row: WebAnalyticsAiCrawlerFormat | undefined
}) {
	const requests = row?.requests ?? 0
	const pages = row?.pages ?? 0

	return (
		<div className="rounded-md border bg-card px-4 py-3.5">
			<div className="flex items-center gap-2.5">
				<span className="flex size-7 shrink-0 items-center justify-center rounded-sm border bg-muted/40 text-muted-foreground">
					<Icon size={14} />
				</span>
				<div className="min-w-0">
					<div className="text-[13px] font-medium leading-tight">{label}</div>
					<div className="truncate text-[11px] text-muted-foreground">{description}</div>
				</div>
			</div>
			<div className="mt-3 flex items-baseline gap-1.5">
				<span className="font-mono text-[22px] font-semibold tabular-nums leading-none">
					{formatNumber(requests)}
				</span>
				<span className="text-[11px] text-muted-foreground">
					{requests === 1 ? "fetch" : "fetches"}
				</span>
			</div>
			<div className="mt-3 flex min-h-4 items-center gap-1.5 text-[11px] text-muted-foreground">
				{requests === 0 ? (
					"Not fetched yet"
				) : pages === 0 ? (
					<span title="Every fetch got an error response. Check that the file exists.">
						Requested, none served
					</span>
				) : (
					<>
						<span>{plural(pages, "page", "pages")}, read by</span>
						<CrawlerMarks crawlers={row?.crawlers ?? []} />
					</>
				)}
			</div>
		</div>
	)
}

/** One mark per product whose crawlers fetched the format. */
function CrawlerMarks({ crawlers }: { crawlers: ReadonlyArray<string> }) {
	const products = [
		...new Map(
			crawlers.flatMap((name) => {
				const product = productForCrawler(name)
				return product ? [[product.id, product] as const] : []
			}),
		).values(),
	]
	return (
		<span className="flex items-center gap-1">
			{products.slice(0, 6).map((product) => (
				<span key={product.id} title={product.label}>
					<AiProductIcon product={product.id} size={12} />
				</span>
			))}
			{products.length > 6 ? <span>+{products.length - 6}</span> : null}
		</span>
	)
}
