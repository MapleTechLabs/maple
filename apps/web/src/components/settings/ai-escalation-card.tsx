import { Link } from "@tanstack/react-router"
import { Button } from "@maple/ui/components/ui/button"
import { BellIcon } from "@/components/icons"

/** Points from the AI tab to where triaged issues are routed, so the two halves read as one flow. */
export function AiEscalationCard() {
	return (
		<div className="flex items-start justify-between gap-4 rounded-md border border-dashed p-4">
			<div className="flex min-w-0 gap-3">
				<BellIcon size={16} className="mt-0.5 shrink-0 text-muted-foreground" />
				<div className="flex min-w-0 flex-col gap-0.5">
					<span className="text-sm font-medium text-foreground">Escalation routing</span>
					<span className="text-xs leading-relaxed text-muted-foreground">
						Route triaged issues by severity and confidence to your alert destinations.
					</span>
				</div>
			</div>
			<Button
				variant="outline"
				size="sm"
				className="shrink-0"
				render={<Link to="/settings" search={{ tab: "automation" }} />}
			>
				Open automation
			</Button>
		</div>
	)
}
