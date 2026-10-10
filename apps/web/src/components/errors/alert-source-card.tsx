import { Link } from "@tanstack/react-router"
import type { ErrorIssueDocument } from "@maple/domain/http"
import { Panel } from "@maple/ui/components/ui/panel"
import { SectionHeading } from "@/components/common/section-heading"

/**
 * Source panel for alert-backed issues: links back to the alert rule that
 * opens incidents into this issue. Replaces the occurrence sparkline /
 * occurrences sections, which only make sense for fingerprint issues.
 */
export function AlertSourceCard({ issue }: { issue: ErrorIssueDocument }) {
	const sourceRef = issue.sourceRef
	const ruleId = typeof sourceRef?.ruleId === "string" ? sourceRef.ruleId : null
	const signalType = typeof sourceRef?.signalType === "string" ? sourceRef.signalType : null
	const groupKey = typeof sourceRef?.groupKey === "string" ? sourceRef.groupKey : null

	return (
		<Panel className="shrink-0 gap-2 px-5 py-4">
			<SectionHeading title="Alert source" />
			<p className="text-sm text-muted-foreground">
				This issue is fed by alert rule incidents
				{signalType ? ` (${signalType})` : ""}
				{groupKey && groupKey !== "__total__" ? ` for group "${groupKey}"` : ""}.
			</p>
			{ruleId ? (
				<Link
					to="/alerts/$ruleId"
					params={{ ruleId }}
					className="text-sm text-primary underline-offset-4 hover:underline"
				>
					View alert rule &rarr;
				</Link>
			) : null}
		</Panel>
	)
}
