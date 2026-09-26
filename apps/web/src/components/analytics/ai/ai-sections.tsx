import type { ReactNode } from "react"

import { cn } from "@maple/ui/lib/utils"
import { formatNumber, formatPercent } from "@maple/ui/lib/format"
import { formatRelativeTime } from "@maple/ui/lib/time-format"
import type { AiContentFormat, AiProduct } from "@maple/domain/ai-traffic"

import { ColumnHead, DataTable } from "../../infra/primitives/data-table"
import { shareBar } from "../../infra/primitives/share-bar"
import { BarSpark } from "../../infra/primitives/stat-rail"
import { SPARK_COLOR } from "../../infra/severity-tokens"
import {
	FileCodeIcon,
	FileIcon,
	MarkdownIcon,
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

/** Card frame for the AI tab's panels: an 11px title, an optional hint, then the body. */
export function AiPanel({
	title,
	hint,
	aside,
	children,
	className,
}: {
	title: string
	hint?: ReactNode
	aside?: ReactNode
	children: ReactNode
	className?: string
}) {
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
	return (
		<AiPanel title="Share of AI visits" hint="Change in share since the previous period">
			{ranks.length === 0 ? (
				<AiEmpty>
					No visits from AI assistants in this window. When someone follows a link from ChatGPT,
					Perplexity, Claude or another assistant, it shows up here.
				</AiEmpty>
			) : (
				<DataTable.Root ariaLabel="AI referrers" maxHeight={360} stickySurfaceClass="bg-card">
					<DataTable.Head>
						<ColumnHead label="#" width="w-5" align="right" />
						<ColumnHead label="Assistant" width="w-0 flex-1 min-w-0" />
						<ColumnHead label="Visits" width="w-14" align="right" />
						<ColumnHead label="Share" width="w-14" align="right" />
						<ColumnHead
							label="Change"
							width="w-16"
							align="right"
							hidden="hidden @min-[360px]/panel:flex"
						/>
					</DataTable.Head>
					{ranks.map((rank, index) => (
						<div
							key={rank.product.id}
							style={shareBar(rank.share)}
							className="flex items-center gap-3 border-b border-border/40 px-4 py-2 last:border-0"
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
							<span className="hidden w-16 justify-end font-mono text-[10px] tabular-nums @min-[360px]/panel:flex">
								<ShareChange points={rank.shareDeltaPoints} />
							</span>
						</div>
					))}
				</DataTable.Root>
			)}
		</AiPanel>
	)
}

function ShareChange({ points }: { points: number | null }) {
	if (points === null) return <span className="text-muted-foreground/70">New</span>
	const flat = Math.abs(points) < 0.05
	return (
		<span
			className={cn(
				flat
					? "text-muted-foreground/70"
					: points > 0
						? "text-[var(--severity-info)]"
						: "text-[var(--severity-error)]",
			)}
		>
			<span aria-hidden>{flat ? "→" : points > 0 ? "↑" : "↓"}</span>
			{Math.abs(points).toFixed(1)} pts
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

	return (
		<AiPanel
			title="AI crawlers"
			hint="Pages served to each crawler. Error responses are not counted as reads."
			aside={
				failed > 0 ? (
					<span title="User agents are easy to spoof: scanners borrow crawler names and mostly get 404s.">
						{formatPercent(failed / Math.max(requests, 1))} of fetches failed
					</span>
				) : undefined
			}
		>
			{crawlers.length === 0 ? (
				<AiEmpty>{emptyMessage}</AiEmpty>
			) : (
				<DataTable.Root ariaLabel="AI crawlers" maxHeight={360} stickySurfaceClass="bg-card">
					<DataTable.Head>
						<ColumnHead label="Crawler" width="w-0 flex-1 min-w-0" />
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
								className="flex items-center gap-3 border-b border-border/40 px-4 py-2 last:border-0"
							>
								<span className="flex w-0 min-w-0 flex-1 items-center gap-2">
									<AiProductIcon product={product?.id ?? ""} />
									<span className="truncate text-[12px] text-foreground/90">
										{row.crawler}
									</span>
									{purpose ? (
										<span className="shrink-0 text-[11px] text-muted-foreground/70">
											{purpose}
										</span>
									) : null}
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
			)}
		</AiPanel>
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
