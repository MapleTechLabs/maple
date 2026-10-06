import { ResourceAttributesCard } from "./primitives/resource-attributes-card"
import { DetailRail } from "@maple/ui/components/detail-rail"

import { ServerIcon } from "@/components/icons"
import type { HostDetailSummaryResponse } from "@maple/domain/http"
import { formatRelativeTime } from "@maple/ui/lib/time-format"
import { useTimezonePreference } from "@/hooks/use-timezone-preference"
import { formatTimestampInTimezone } from "@/lib/timezone-format"

interface HostMetadataPanelProps {
	summary: HostDetailSummaryResponse["data"]
}

interface SectionProps {
	title: string
	children: React.ReactNode
}

function Section({ title, children }: SectionProps) {
	return (
		<div className="space-y-0.5 py-2 first:pt-0 last:pb-0">
			<div className="text-2xs font-medium text-muted-foreground">{title}</div>
			<div>{children}</div>
		</div>
	)
}

export function HostMetadataPanel({ summary }: HostMetadataPanelProps) {
	const { effectiveTimezone } = useTimezonePreference()
	if (!summary) return null
	const absolute = (value: string) => formatTimestampInTimezone(value, { timeZone: effectiveTimezone })

	return (
		<ResourceAttributesCard icon={ServerIcon} contentClassName="divide-y divide-border/60">
			<Section title="Identity">
				<DetailRail.MetaRow copyable label="host.name" value={summary.hostName} />
			</Section>
			<Section title="Platform">
				<DetailRail.MetaRow copyable label="os.type" value={summary.osType} />
				<DetailRail.MetaRow copyable label="host.arch" value={summary.hostArch} />
			</Section>
			<Section title="Cloud">
				<DetailRail.MetaRow copyable label="cloud.provider" value={summary.cloudProvider} />
				<DetailRail.MetaRow copyable label="cloud.region" value={summary.cloudRegion} />
			</Section>
			<Section title="Lifecycle">
				<DetailRail.MetaRow
					label="first seen"
					value={formatRelativeTime(summary.firstSeen)}
					copyValue={summary.firstSeen}
					tooltip={absolute(summary.firstSeen)}
				/>
				<DetailRail.MetaRow
					label="last seen"
					value={formatRelativeTime(summary.lastSeen)}
					copyValue={summary.lastSeen}
					tooltip={absolute(summary.lastSeen)}
				/>
			</Section>
		</ResourceAttributesCard>
	)
}
