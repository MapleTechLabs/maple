import type { ReactNode } from "react"
import { DetailRail } from "@maple/ui/components/detail-rail"
import { formatBytes, formatNumber } from "@maple/ui/lib/format"
import { EyeIcon, GlobeIcon, ShieldCheckIcon, StopwatchIcon, UserIcon } from "@maple/ui/components/icons"
import type { IconComponent } from "@maple/ui/components/icons"

import { ArrowUpDownIcon, TagIcon } from "@/components/icons"

import type { CloudflareZoneRow } from "@/api/warehouse/cloudflare-infra"

export interface ZoneRailDns {
	queries: number
	/** Names that answered NXDOMAIN to every query in the window. */
	alwaysNxdomain: number
}

/** The zone page's right rail: identity, what the plan hides, and the other datasets in one line each. */
export function CloudflareZoneRail({
	serviceName,
	accountName,
	zoneRow,
	dns,
	firewallEvents,
	onOpenTab,
}: {
	serviceName: string
	accountName: string | null
	zoneRow: CloudflareZoneRow | null
	/** Null while loading or when the zone has no DNS analytics. */
	dns: ZoneRailDns | null
	/** Null while loading; zero means the dataset is live but quiet. */
	firewallEvents: number | null
	onOpenTab: (tab: "dns" | "security") => void
}) {
	const hasLatency = zoneRow !== null && (zoneRow.ttfbP99Ms > 0 || zoneRow.originP99Ms > 0)
	return (
		<div className="flex flex-col">
			<DetailRail.Group label="Zone">
				<DetailRail.MetaRow icon={TagIcon} copyable label="service" value={serviceName} />
				<DetailRail.MetaRow icon={UserIcon} label="account" value={accountName} />
				<DetailRail.MetaRow
					icon={ArrowUpDownIcon}
					label="bandwidth"
					value={zoneRow ? formatBytes(zoneRow.bytes) : null}
				/>
				<DetailRail.MetaRow
					icon={EyeIcon}
					label="visits"
					value={zoneRow ? formatNumber(zoneRow.visits) : null}
				/>
				<DetailRail.MetaRow
					icon={StopwatchIcon}
					label="latency"
					value={hasLatency ? "reported" : "not on this plan"}
				/>
			</DetailRail.Group>
			{dns === null ? null : (
				<DetailRail.Group label="DNS">
					<RailLink icon={GlobeIcon} onClick={() => onOpenTab("dns")}>
						{formatNumber(dns.queries)} queries
					</RailLink>
					<p className="text-2xs leading-relaxed text-muted-foreground">
						{dns.alwaysNxdomain === 0
							? "Every listed name resolves."
							: `${dns.alwaysNxdomain} ${dns.alwaysNxdomain === 1 ? "name answers" : "names answer"} NXDOMAIN every time.`}
					</p>
				</DetailRail.Group>
			)}
			<DetailRail.Group label="Security">
				{firewallEvents === null || firewallEvents === 0 ? (
					<p className="text-2xs leading-relaxed text-muted-foreground">
						No firewall events in this window.
					</p>
				) : (
					<RailLink icon={ShieldCheckIcon} onClick={() => onOpenTab("security")}>
						{formatNumber(firewallEvents)} firewall events
					</RailLink>
				)}
			</DetailRail.Group>
		</div>
	)
}

function RailLink({
	icon: Icon,
	onClick,
	children,
}: {
	icon: IconComponent
	onClick: () => void
	children: ReactNode
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className="flex items-center gap-1.5 text-left font-mono text-xs text-primary transition-colors hover:text-primary/80"
		>
			<Icon className="size-3.5 shrink-0" aria-hidden />
			{children}
		</button>
	)
}
