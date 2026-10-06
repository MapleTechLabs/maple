import { StatusDot } from "@maple/ui/components/ui/status-dot"
import { ERROR_INCIDENT_AUTO_RESOLVE_MINUTES, type ErrorIncidentDocument } from "@maple/domain/http"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@maple/ui/components/ui/empty"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@maple/ui/components/ui/table"
import { Tooltip, TooltipPopup, TooltipTrigger } from "@maple/ui/components/ui/tooltip"
import { cn } from "@maple/ui/lib/utils"
import { DocsLink } from "@/components/common/docs-link"
import { RelativeTime } from "@/components/common/relative-time"

interface IssueIncidentsTableProps {
	incidents: ReadonlyArray<ErrorIncidentDocument>
}

const REASON_LABEL: Record<ErrorIncidentDocument["reason"], string> = {
	first_seen: "First seen",
	regression: "Regression",
	manual: "Manual",
} satisfies Record<ErrorIncidentDocument["reason"], string>

// Nothing in the product asks you to close an incident, so `resolved` needs
// saying out loud: the error tick flips it after the silence window, and
// moving the issue to Done resolves whatever is still open.
const STATUS_EXPLANATION = {
	open: "Open until the error goes quiet, or you mark the issue Done.",
	resolved: `Incidents resolve on their own when the error goes quiet — no new occurrences for ${ERROR_INCIDENT_AUTO_RESOLVE_MINUTES} minutes after the last one. Marking the issue Done resolves its open incidents too.`,
} satisfies Record<ErrorIncidentDocument["status"], string>

export function IssueIncidentsTable({ incidents }: IssueIncidentsTableProps) {
	if (incidents.length === 0) {
		return (
			<Empty>
				<EmptyHeader>
					<EmptyTitle>No incidents yet</EmptyTitle>
					<EmptyDescription>Incidents open on first-seen or regression events.</EmptyDescription>
				</EmptyHeader>
				<DocsLink page="errors" />
			</Empty>
		)
	}

	return (
		<Table>
			<TableHeader>
				<TableRow>
					<TableHead className="w-8 p-0" aria-label="Status accent" />
					<TableHead>Status</TableHead>
					<TableHead>Reason</TableHead>
					<TableHead>Opened</TableHead>
					<TableHead>Last triggered</TableHead>
					<TableHead className="text-right">Events</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{incidents.map((incident) => {
					const isOpen = incident.status === "open"
					return (
						<TableRow key={incident.id}>
							<TableCell className="w-8 p-0">
								<span
									aria-hidden
									className={cn(
										"block h-full w-[3px]",
										isOpen ? "bg-severity-error" : "bg-border/60",
									)}
								/>
							</TableCell>
							<TableCell>
								<Tooltip>
									<TooltipTrigger
										render={
											<span className="inline-flex cursor-default items-center gap-2" />
										}
									>
										{isOpen ? <StatusDot tone="crit" /> : <StatusDot tone="neutral" />}
										<span
											className={cn(
												"text-xs font-medium uppercase tracking-wide",
												isOpen ? "text-severity-error" : "text-muted-foreground",
											)}
										>
											{incident.status}
										</span>
									</TooltipTrigger>
									<TooltipPopup className="max-w-[36ch]">
										{STATUS_EXPLANATION[incident.status]}
									</TooltipPopup>
								</Tooltip>
							</TableCell>
							<TableCell className="text-muted-foreground">
								{REASON_LABEL[incident.reason]}
							</TableCell>
							<TableCell className="tabular-nums text-muted-foreground">
								<RelativeTime value={incident.firstTriggeredAt} tooltip="title" />
							</TableCell>
							<TableCell className="tabular-nums">
								<RelativeTime value={incident.lastTriggeredAt} tooltip="title" />
							</TableCell>
							<TableCell className="text-right font-mono tabular-nums">
								{incident.occurrenceCount.toLocaleString()}
							</TableCell>
						</TableRow>
					)
				})}
			</TableBody>
		</Table>
	)
}
