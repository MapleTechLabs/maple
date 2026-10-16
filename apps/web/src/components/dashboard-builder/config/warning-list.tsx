import { Alert, AlertDescription } from "@maple/ui/components/ui/alert"
import { CircleWarningIcon } from "@/components/icons"

/** Compact warning callout for query and filter validation messages. */
export function WarningList({ warnings }: { warnings: ReadonlyArray<string> }) {
	if (warnings.length === 0) return null
	return (
		<Alert variant="warn" size="sm">
			<CircleWarningIcon size={14} />
			<AlertDescription className="text-severity-warn">
				<ul className="space-y-1">
					{warnings.map((warning) => (
						<li key={warning}>{warning}</li>
					))}
				</ul>
			</AlertDescription>
		</Alert>
	)
}
