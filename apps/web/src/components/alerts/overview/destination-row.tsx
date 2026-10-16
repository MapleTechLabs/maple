import { useState } from "react"

import type { AlertDeliveryEventDocument, AlertDestinationDocument } from "@maple/domain/http"
import { Button } from "@maple/ui/components/ui/button"
import { ConfirmDialog } from "@maple/ui/components/ui/confirm-dialog"
import { DropdownMenuItem, DropdownMenuSeparator } from "@maple/ui/components/ui/dropdown-menu"
import { RowActionsMenu } from "@maple/ui/components/ui/row-actions-menu"
import { StatusDot } from "@maple/ui/components/ui/status-dot"
import { Switch } from "@maple/ui/components/ui/switch"
import { Tooltip, TooltipContent, TooltipTrigger } from "@maple/ui/components/ui/tooltip"
import type { Tone } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"

import { destinationProvider, ProviderLogo } from "@/components/alerts/destination-provider"
import { RelativeTime } from "@/components/common/relative-time"
import { CheckIcon, PencilIcon, TrashIcon } from "@/components/icons"

/** How many recent attempts the health strip reads. */
export const HEALTH_WINDOW = 20

export const DESTINATION_ROW_GRID = "grid grid-cols-[minmax(0,1fr)_110px_140px_110px_auto] items-center gap-4"

function healthTone(
	destination: AlertDestinationDocument,
	recent: ReadonlyArray<AlertDeliveryEventDocument>,
): Tone {
	if (!destination.enabled) return destination.disabledAt != null ? "crit" : "neutral"
	if (recent[0]?.status === "failed") return "crit"
	if (recent.some((event) => event.status === "failed")) return "warn"
	return recent.length > 0 ? "ok" : "neutral"
}

/** One destination: provider, delivery health over the last attempts, last delivery, actions. */
export function DestinationRow({
	destination,
	recent,
	isAdmin,
	isTesting,
	isDeleting,
	onToggle,
	onTest,
	onEdit,
	onDelete,
}: {
	destination: AlertDestinationDocument
	/** This destination's latest delivery attempts, newest first, at most {@link HEALTH_WINDOW}. */
	recent: ReadonlyArray<AlertDeliveryEventDocument>
	isAdmin: boolean
	isTesting: boolean
	isDeleting: boolean
	onToggle: (destination: AlertDestinationDocument) => void
	onTest: (destination: AlertDestinationDocument) => void
	onEdit: (destination: AlertDestinationDocument) => void
	/** Resolves to whether it was deleted; the confirm dialog stays open on failure. */
	onDelete: (destination: AlertDestinationDocument) => Promise<boolean>
}) {
	const [confirmDelete, setConfirmDelete] = useState(false)
	const provider = destinationProvider(destination)
	const lastSuccess = recent.find((event) => event.status === "success")
	const failed = recent.filter((event) => event.status === "failed").length
	const problem =
		!destination.enabled && destination.disabledReason
			? `Maple stopped delivering here after repeated failures: ${destination.disabledReason}`
			: destination.lastTestError

	return (
		<li className="px-4 py-3">
			<div className={DESTINATION_ROW_GRID}>
				<div className={cn("flex min-w-0 items-center gap-3", !destination.enabled && "opacity-60")}>
					<StatusDot tone={healthTone(destination, recent)} size="lg" />
					<ProviderLogo
						type={destination.type}
						chatConnector={destination.chatConnector}
						size={28}
						bare
						className="flex shrink-0 items-center"
					/>
					<div className="min-w-0">
						<p className="truncate text-sm font-medium">{destination.name}</p>
						<p className="truncate font-mono text-xs text-muted-foreground">
							{destination.summary}
						</p>
					</div>
				</div>
				<span className="text-xs text-muted-foreground">{provider.label}</span>
				<DeliveryStrip recent={recent} failed={failed} />
				<span className="text-right text-xs text-muted-foreground tabular-nums">
					{!destination.enabled ? (
						<span className={destination.disabledAt != null ? "text-severity-error" : undefined}>
							{destination.disabledAt != null ? "auto-disabled" : "disabled"}
						</span>
					) : lastSuccess ? (
						<RelativeTime value={lastSuccess.scheduledAt} variant="short" tooltip="title" />
					) : (
						"never"
					)}
				</span>
				<div className="flex items-center justify-end gap-2">
					<Switch
						checked={destination.enabled}
						onCheckedChange={() => onToggle(destination)}
						disabled={!isAdmin}
						aria-label={destination.enabled ? "Disable destination" : "Enable destination"}
					/>
					<Button
						size="sm"
						variant="outline"
						onClick={() => onTest(destination)}
						disabled={!isAdmin}
						loading={isTesting}
					>
						<CheckIcon />
						Test
					</Button>
					{isAdmin && (
						<RowActionsMenu label={`Actions for ${destination.name}`}>
							<DropdownMenuItem onClick={() => onEdit(destination)}>
								<PencilIcon />
								Edit
							</DropdownMenuItem>
							<DropdownMenuSeparator />
							<DropdownMenuItem
								variant="destructive"
								onClick={() => setConfirmDelete(true)}
								disabled={isDeleting}
							>
								<TrashIcon />
								Delete
							</DropdownMenuItem>
						</RowActionsMenu>
					)}
				</div>
			</div>
			{problem && <p className="mt-2 break-words pl-5 text-xs text-severity-error">{problem}</p>}
			<ConfirmDialog
				open={confirmDelete}
				onOpenChange={setConfirmDelete}
				title={`Delete ${destination.name}?`}
				description="Alert rules will stop notifying this destination. This cannot be undone."
				confirmLabel="Delete destination"
				pending={isDeleting}
				onConfirm={() => onDelete(destination)}
			/>
		</li>
	)
}

const ATTEMPT_CLASS: Record<AlertDeliveryEventDocument["status"], string> = {
	success: "bg-severity-info",
	failed: "bg-severity-error",
	queued: "bg-muted-foreground/40",
	processing: "bg-muted-foreground/40",
} satisfies Record<AlertDeliveryEventDocument["status"], string>

/** Oldest to newest, one tick per attempt. */
function DeliveryStrip({
	recent,
	failed,
}: {
	recent: ReadonlyArray<AlertDeliveryEventDocument>
	failed: number
}) {
	if (recent.length === 0) return <span className="text-xs text-muted-foreground">No deliveries yet</span>
	return (
		<Tooltip>
			<TooltipTrigger render={<span className="flex h-3.5 cursor-default items-stretch gap-px" />}>
				{[...recent].reverse().map((event) => (
					<span key={event.id} className={cn("w-1 rounded-[1px]", ATTEMPT_CLASS[event.status])} />
				))}
			</TooltipTrigger>
			<TooltipContent>
				{failed === 0
					? `Last ${recent.length} attempts delivered`
					: `${failed} of the last ${recent.length} attempts failed`}
			</TooltipContent>
		</Tooltip>
	)
}
