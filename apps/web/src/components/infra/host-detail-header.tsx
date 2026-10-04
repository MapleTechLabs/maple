import { Link } from "@tanstack/react-router"
import { Button } from "@maple/ui/components/ui/button"
import { Skeleton } from "@maple/ui/components/ui/skeleton"

import type { HostDetailSummaryResponse } from "@maple/domain/http"

import { HostStatusBadge } from "./status-badge"
import { PlatformLabel } from "./platform-label"
import { HeroChip, PageHero } from "./primitives/page-hero"
import { StatRail, StatRailItem, StatRailLoading } from "./primitives/stat-rail"
import { severityLevel } from "./format"
import { formatLoad, formatPercent } from "@maple/ui/lib/format"
import { formatRelativeTime } from "@maple/ui/lib/time-format"

interface HostDetailHeaderProps {
	summary: HostDetailSummaryResponse["data"]
	hostName: string
	/** Offered when the window is empty; omit when the range is already the widest. */
	onWidenRange?: () => void
}

export function HostDetailHeader({ summary, hostName, onWidenRange }: HostDetailHeaderProps) {
	if (!summary) {
		return (
			<PageHero
				title={<span className="font-mono">{hostName}</span>}
				description="This host sent no metrics in the selected time window. It may have stopped reporting earlier: try a wider range, or go back to the hosts list."
				actions={
					<>
						{onWidenRange ? (
							<Button variant="outline" size="sm" onClick={onWidenRange}>
								Show last 7 days
							</Button>
						) : null}
						<Button variant="outline" size="sm" render={<Link to="/infra/hosts" />}>
							Back to hosts
						</Button>
					</>
				}
			/>
		)
	}

	const meta = (
		<>
			{summary.osType && (
				<HeroChip>
					<PlatformLabel kind="os" value={summary.osType} />
				</HeroChip>
			)}
			{summary.hostArch && (
				<HeroChip>
					<PlatformLabel kind="arch" value={summary.hostArch} />
				</HeroChip>
			)}
			{summary.cloudProvider && (
				<HeroChip>
					<PlatformLabel kind="cloud" value={summary.cloudProvider} />
				</HeroChip>
			)}
			{summary.cloudRegion && <HeroChip>region {summary.cloudRegion}</HeroChip>}
			<span className="text-[11px] text-muted-foreground/80">
				last reported {formatRelativeTime(summary.lastSeen)}
			</span>
		</>
	)

	return (
		<div className="space-y-6">
			<PageHero
				title={<span className="font-mono">{summary.hostName}</span>}
				meta={meta}
				trailing={<HostStatusBadge lastSeen={summary.lastSeen} />}
			/>
			<StatRail>
				<StatRailItem
					eyebrow="CPU"
					value={formatPercent(summary.cpuPct)}
					tone={severityLevel(summary.cpuPct)}
					subline="warn ≥ 80%"
					compact
				/>
				<StatRailItem
					eyebrow="Memory"
					value={formatPercent(summary.memoryPct)}
					tone={severityLevel(summary.memoryPct)}
					subline="warn ≥ 80%"
					compact
				/>
				<StatRailItem
					eyebrow="Disk"
					value={formatPercent(summary.diskPct)}
					tone={severityLevel(summary.diskPct)}
					subline="warn ≥ 80%"
					compact
				/>
				<StatRailItem eyebrow="Load 15m" value={formatLoad(summary.load15)} compact />
			</StatRail>
		</div>
	)
}

export function HostDetailHeaderLoading() {
	return (
		<div className="space-y-6">
			<div>
				<Skeleton className="h-7 w-72" />
				<Skeleton className="mt-2 h-3 w-96" />
			</div>
			<StatRailLoading />
		</div>
	)
}
