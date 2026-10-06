import { Link } from "@tanstack/react-router"
import type { CloudflareServiceUsage, CloudflareUsageResponse } from "@maple/domain/http"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { cn } from "@maple/ui/lib/utils"

import { StatRail, StatRailItem } from "@/components/common/stat-rail"
import { ArrowRightIcon } from "@/components/icons"

import { formatNumber } from "@maple/ui/lib/format"
import { CLOUDFLARE_ACCENT } from "./integration-catalog"
import { toRowUsage } from "./cloudflare-zone-board"

/** The "+12% vs previous 24h" caption — quiet unless traffic actually moved up. */
function TrafficDelta({ usage }: { usage: CloudflareUsageResponse }) {
	const previous = usage.previousTotalRequests
	// Old API during the deploy window — no comparison to show.
	if (previous == null) return <>Requests · last 24h</>
	if (previous === 0) {
		return usage.totalRequests > 0 ? <>First 24h of traffic</> : <>Requests · last 24h</>
	}
	const pct = Math.round(((usage.totalRequests - previous) / previous) * 100)
	if (pct === 0) return <>Flat vs previous 24h</>
	return (
		<span className={cn(pct > 0 && "text-severity-info")}>
			{pct > 0 ? "+" : ""}
			{pct}% vs previous 24h
		</span>
	)
}

/**
 * The drill-in's 24h readout band: traffic (with previous-window delta), active
 * Workers, and org-wide mitigated firewall events. Renders skeletons until the
 * warehouse usage settles; a failed usage fetch keeps the band hidden entirely
 * (callers pass `usage: null`).
 */
export function CloudflareStatCards({
	usage,
	workerServices,
}: {
	usage: CloudflareUsageResponse | null
	/** Pre-filtered `kind === "worker"` services from the same usage response. */
	workerServices: ReadonlyArray<CloudflareServiceUsage>
}) {
	if (usage === null) {
		return (
			<div className="flex flex-col gap-3 sm:flex-row">
				<Skeleton className="h-[104px] flex-1 rounded-md" />
				<Skeleton className="h-[104px] flex-1 rounded-md" />
				<Skeleton className="h-[104px] flex-1 rounded-md" />
			</div>
		)
	}

	const totalPoints = usage.totalRequests > 0 ? toRowUsage(usage, usage.services).points : null
	const activeWorkers = workerServices.filter((service) => service.totalRequests > 0)
	const workerInvocations = workerServices.reduce((sum, service) => sum + service.totalRequests, 0)
	const workerPoints = workerInvocations > 0 ? toRowUsage(usage, workerServices).points : null

	return (
		<StatRail columns={3}>
			<StatRailItem
				eyebrow="Traffic · 24h"
				value={formatNumber(usage.totalRequests)}
				spark={totalPoints?.map((point) => point.v)}
				sparkColor={CLOUDFLARE_ACCENT}
				subline={<TrafficDelta usage={usage} />}
			/>
			<StatRailItem
				eyebrow="Workers"
				value={`${activeWorkers.length} active`}
				spark={workerPoints?.map((point) => point.v)}
				sparkColor={CLOUDFLARE_ACCENT}
				subline={
					workerInvocations > 0
						? `${formatNumber(workerInvocations)} invocations · on service map`
						: "Scripts appear once they serve traffic"
				}
			/>
			<StatRailItem
				compact
				eyebrow="Firewall · 24h"
				value={`${formatNumber(usage.firewallBlockedEvents ?? 0)} blocked`}
				subline="DNS analytics alongside traces"
				action={
					<Link
						to="/infra/cloudflare"
						className="inline-flex shrink-0 items-center gap-1 text-2xs text-muted-foreground hover:text-foreground"
					>
						Open
						<ArrowRightIcon size={11} />
					</Link>
				}
			/>
		</StatRail>
	)
}
