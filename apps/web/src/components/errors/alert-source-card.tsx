import { Link } from "@tanstack/react-router"
import type { ErrorIssueDocument } from "@maple/domain/http"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@maple/ui/components/ui/card"

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
		<Card>
			<CardHeader className="space-y-1">
				<CardTitle className="text-sm">Alert source</CardTitle>
				<CardDescription>
					This issue is fed by alert rule incidents
					{signalType ? ` (${signalType})` : ""}
					{groupKey && groupKey !== "__total__" ? ` for group "${groupKey}"` : ""}.
				</CardDescription>
			</CardHeader>
			{ruleId ? (
				<CardContent className="text-sm">
					<Link
						to="/alerts/$ruleId"
						params={{ ruleId }}
						className="text-primary underline-offset-4 hover:underline"
					>
						View alert rule →
					</Link>
				</CardContent>
			) : null}
		</Card>
	)
}
