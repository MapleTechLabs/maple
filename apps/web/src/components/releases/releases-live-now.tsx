import { Panel } from "@maple/ui/components/ui/panel"
import { Link } from "@tanstack/react-router"
import { ServiceDot } from "@maple/ui/components/service-dot"
import { cn } from "@maple/ui/lib/utils"
import { countLabel, pluralize } from "@maple/ui/lib/format"

import type { TimeRangeSearch } from "@/components/time-range-picker/search"
import { ROLLOUT_COMPLETE_SHARE, shortReleaseLabel, type LiveVersion } from "./release-model"
import { Eyebrow } from "@maple/ui/components/ui/eyebrow"
import { Button } from "@maple/ui/components/ui/button"

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
		<Panel className="gap-2 px-3 py-2.5">
			<div className="flex items-baseline justify-between gap-3">
				<Eyebrow>Live now</Eyebrow>
				{behind > 0 ? (
					<span className="text-2xs text-severity-warn">
						{countLabel(behind, "service")} not on the latest release
					</span>
				) : (
					<span className="text-2xs text-muted-foreground/70">
						Every service is on its latest release
					</span>
				)}
			</div>
			<div className="flex flex-wrap gap-1.5">
				{shown.map((version) => (
					<Button
						key={version.serviceName}
						variant="outline"
						size="xs"
						className={cn(
							"font-normal",
							version.behind > 0 && "border-severity-warn/40 bg-severity-warn/5",
						)}
						render={
							<Link
								to="/releases/$commitSha"
								params={{ commitSha: version.commitSha }}
								search={{ ...timeSearch, environments, service: version.serviceName }}
								title={
									version.behind > 0
										? `${version.behind} newer ${pluralize(version.behind, "release")} reached the services ${version.serviceName} usually ships with, but not ${version.serviceName}`
										: undefined
								}
							/>
						}
					>
						<ServiceDot serviceName={version.serviceName} />
						<span>{version.serviceName}</span>
						<span className="font-mono text-2xs text-muted-foreground">
							{shortReleaseLabel(version.commitSha)}
						</span>
						{version.share < ROLLOUT_COMPLETE_SHARE ? (
							<span className="font-mono text-3xs tabular-nums text-primary">
								{Math.round(version.share * 100)}%
							</span>
						) : null}
						{version.behind > 0 ? (
							<span className="font-mono text-3xs tabular-nums text-severity-warn">
								{version.behind} behind
							</span>
						) : null}
					</Button>
				))}
				{hidden > 0 ? (
					<span className="self-center px-1 text-2xs text-muted-foreground/70">+{hidden}</span>
				) : null}
			</div>
		</Panel>
	)
}
