import { Link } from "@tanstack/react-router"

import type { ErrorIssueId } from "@maple/domain/http"
import { UnderlineTabCount, UnderlineTabStrip, underlineTabClass } from "./underline-link-tabs"

export const ISSUE_TABS = ["overview", "occurrences", "activity"] as const

export type IssueTab = (typeof ISSUE_TABS)[number]

/**
 * The page's three questions, split.
 *
 * The body was seven sections in one `space-y-8` stack, each titled with the
 * same 10px eyebrow — so the sample traces, which is where you go the moment you
 * have read the message, sat below the activity log, the incidents table and the
 * anomalies list. Splitting them puts each one tab-click from the header instead
 * of a scroll away, and lets the Overview stop competing with itself.
 *
 * `<Link>`s rather than the `Tabs` primitive, for the reasons
 * `investigations/investigation-tabs.tsx` gives: the strip is pinned in `Sticky`
 * while the panel scrolls in `Scroll`, so one `Tabs` root would straddle two
 * layout regions; the active tab belongs in the URL; and links give middle-click
 * and history for free.
 */
export function IssueTabs({
	issueId,
	active,
	occurrenceCount,
	activityCount,
	showOccurrences,
}: {
	issueId: ErrorIssueId
	active: IssueTab
	/** Omitted while the detail query is still in flight — the tab renders
	 *  without its count rather than with a placeholder zero. */
	occurrenceCount?: number
	activityCount?: number
	/** Alert- and integration-backed issues have no fingerprint samples to show,
	 *  so the tab is absent rather than empty. */
	showOccurrences: boolean
}) {
	const tabs: ReadonlyArray<{ value: IssueTab; label: string; count?: number }> = [
		{ value: "overview", label: "Overview" },
		...(showOccurrences
			? [{ value: "occurrences" as const, label: "Occurrences", count: occurrenceCount }]
			: []),
		{ value: "activity", label: "Activity", count: activityCount },
	]

	return (
		<UnderlineTabStrip label="Issue sections">
			{tabs.map((tab) => {
				const isActive = tab.value === active
				return (
					<Link
						key={tab.value}
						role="tab"
						aria-selected={isActive}
						to="/errors/issues/$issueId"
						params={{ issueId }}
						// Merged, not replaced: the time range lives in the same search
						// object, and a tab switch that dropped it would silently reset the
						// window the chart and the samples are scoped to.
						search={(prev: Record<string, unknown>) => ({
							...prev,
							// `overview` is the default, so it drops out of the URL entirely.
							tab: tab.value === "overview" ? undefined : tab.value,
						})}
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
