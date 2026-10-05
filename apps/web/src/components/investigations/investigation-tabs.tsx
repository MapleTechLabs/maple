import { Link } from "@tanstack/react-router"
import type { V2Investigation } from "@maple/domain/http/v2"
import {
	UnderlineTabCount,
	UnderlineTabStrip,
	underlineTabClass,
} from "@/components/errors/underline-link-tabs"

export const INVESTIGATION_TABS = ["overview", "evidence", "chat", "transcript"] as const

export type InvestigationTab = (typeof INVESTIGATION_TABS)[number]

/**
 * The tabs are `<Link>`s, not a `Tabs` primitive. Three reasons: the strip is
 * pinned in `Sticky` while the panel scrolls in `Scroll`, so a single `Tabs` root
 * would have to straddle two layout regions; the active tab belongs in the URL so
 * a link to the Evidence tab survives a reload and a share; and links give
 * middle-click and browser history for free.
 */
export function InvestigationTabs({
	investigation,
	active,
}: {
	investigation: V2Investigation
	active: InvestigationTab
}) {
	const evidenceCount = investigation.report?.evidence.length ?? 0

	const tabs: ReadonlyArray<{ value: InvestigationTab; label: string; count?: number }> = [
		{ value: "overview", label: "Overview" },
		...(evidenceCount > 0
			? [{ value: "evidence" as const, label: "Evidence", count: evidenceCount }]
			: []),
		{ value: "chat", label: "Chat" },
		{ value: "transcript", label: "Transcript" },
	]

	return (
		<UnderlineTabStrip label="Investigation sections">
			{tabs.map((tab) => {
				const isActive = tab.value === active
				return (
					<Link
						key={tab.value}
						role="tab"
						aria-selected={isActive}
						to="/investigations/$id"
						params={{ id: investigation.id }}
						// `overview` is the default, so it drops out of the URL entirely.
						search={{ tab: tab.value === "overview" ? undefined : tab.value }}
						className={underlineTabClass(isActive)}
					>
						{tab.label}
						<UnderlineTabCount count={tab.count} />
					</Link>
				)
			})}
		</UnderlineTabStrip>
	)
}
