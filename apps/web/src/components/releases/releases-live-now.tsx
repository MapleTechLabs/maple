import { Link } from "@tanstack/react-router"
import { ServiceDot } from "@maple/ui/components/service-dot"
import { cn } from "@maple/ui/lib/utils"

import type { TimeRangeSearch } from "@/components/time-range-picker/search"
import { ROLLOUT_COMPLETE_SHARE, shortReleaseLabel, type LiveVersion } from "./release-model"

/** Services past this fold into a count; the behind ones sort first so they never fold. */
const MAX_SHOWN = 16

interface ReleasesLiveNowProps {
	live: ReadonlyArray<LiveVersion>
	timeSearch: TimeRangeSearch
	environments?: string[]
}

/** What every service is serving in the latest bucket, with the ones left behind called out. */
export function ReleasesLiveNow({ live, timeSearch, environments }: ReleasesLiveNowProps) {
	if (live.length === 0) return null
	const shown = live.slice(0, MAX_SHOWN)
	const hidden = live.length - shown.length
	const behind = live.filter((version) => version.behind > 0).length

	return (
		<div className="flex flex-col gap-2 rounded-md border bg-card px-3 py-2.5">
			<div className="flex items-baseline justify-between gap-3">
				<span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
					Live now
				</span>
				{behind > 0 ? (
					<span className="text-[11px] text-severity-warn">
						{behind === 1 ? "1 service" : `${behind} services`} not on the latest release
					</span>
				) : (
					<span className="text-[11px] text-muted-foreground/70">
						Every service is on its latest release
					</span>
				)}
			</div>
			<div className="flex flex-wrap gap-1.5">
				{shown.map((version) => (
					<Link
						key={version.serviceName}
						to="/releases/$commitSha"
						params={{ commitSha: version.commitSha }}
						search={{ ...timeSearch, environments, service: version.serviceName }}
						title={
							version.behind > 0
								? `${version.behind} newer ${version.behind === 1 ? "release" : "releases"} reached the services ${version.serviceName} usually ships with, but not ${version.serviceName}`
								: undefined
						}
						className={cn(
							"inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
							version.behind > 0 && "border-severity-warn/40 bg-severity-warn/5",
						)}
					>
						<ServiceDot serviceName={version.serviceName} />
						<span>{version.serviceName}</span>
						<span className="font-mono text-[11px] text-muted-foreground">
							{shortReleaseLabel(version.commitSha)}
						</span>
						{version.share < ROLLOUT_COMPLETE_SHARE ? (
							<span className="font-mono text-[10px] tabular-nums text-primary">
								{Math.round(version.share * 100)}%
							</span>
						) : null}
						{version.behind > 0 ? (
							<span className="font-mono text-[10px] tabular-nums text-severity-warn">
								{version.behind} behind
							</span>
						) : null}
					</Link>
				))}
				{hidden > 0 ? (
					<span className="self-center px-1 text-[11px] text-muted-foreground/70">+{hidden}</span>
				) : null}
			</div>
		</div>
	)
}
