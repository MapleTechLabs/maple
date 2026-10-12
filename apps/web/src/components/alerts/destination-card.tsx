import type { AlertDestinationDocument } from "@maple/domain/http"
import { destinationProvider, ProviderLogo } from "@/components/alerts/destination-provider"
import { useState } from "react"
import { RelativeTime } from "@/components/common/relative-time"
import { AlertWarningIcon, CheckIcon, PencilIcon, TrashIcon } from "@/components/icons"
import { Alert, AlertDescription } from "@maple/ui/components/ui/alert"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { Card } from "@maple/ui/components/ui/card"
import { ConfirmDialog } from "@maple/ui/components/ui/confirm-dialog"
import { DropdownMenuItem, DropdownMenuSeparator } from "@maple/ui/components/ui/dropdown-menu"
import { Eyebrow } from "@maple/ui/components/ui/eyebrow"
import { RowActionsMenu } from "@maple/ui/components/ui/row-actions-menu"
import { Switch } from "@maple/ui/components/ui/switch"
import { cn } from "@maple/ui/lib/utils"

interface DestinationCardProps {
	destination: AlertDestinationDocument
	isAdmin: boolean
	isTesting: boolean
	isDeleting: boolean
	onToggle: (destination: AlertDestinationDocument) => void
	onTest: (destination: AlertDestinationDocument) => void
	onEdit: (destination: AlertDestinationDocument) => void
	/** Resolves to whether it was deleted; the confirm dialog stays open on failure. */
	onDelete: (destination: AlertDestinationDocument) => Promise<boolean>
}

export function DestinationCard({
	destination,
	isAdmin,
	isTesting,
	isDeleting,
	onToggle,
	onTest,
	onEdit,
	onDelete,
}: DestinationCardProps) {
	const provider = destinationProvider(destination)
	const [confirmDelete, setConfirmDelete] = useState(false)

	return (
		<Card
			className={cn("group relative overflow-hidden p-0 transition-colors", "hover:border-border/80")}
		>
			<div className="relative flex flex-col gap-4 p-5 lg:flex-row lg:items-start lg:justify-between">
				<div
					className={cn(
						"flex min-w-0 items-start gap-4 transition-opacity",
						!destination.enabled && "opacity-60",
					)}
				>
					<ProviderLogo
						type={destination.type}
						chatConnector={destination.chatConnector}
						size={44}
					/>

					<div className="min-w-0 space-y-1.5">
						<div className="flex flex-wrap items-center gap-2">
							<span className="truncate text-sm font-semibold tracking-tight">
								{destination.name}
							</span>
							<Badge
								variant="tag"
								className="border"
								style={{
									// color-mix (not hex-alpha concat) so `light-dark()` accentText values work.
									borderColor: `color-mix(in srgb, ${provider.accentText ?? provider.accent} 33%, transparent)`,
									color: provider.accentText ?? provider.accent,
									backgroundColor: provider.accentBg,
								}}
							>
								{provider.label}
							</Badge>
						</div>

						<div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
							<span className="truncate font-mono text-xs text-foreground/70">
								{destination.summary}
							</span>
							<span aria-hidden className="text-muted-foreground/50">
								·
							</span>
							<span>
								tested{" "}
								{destination.lastTestedAt ? (
									<RelativeTime value={destination.lastTestedAt} />
								) : (
									"never"
								)}
							</span>
							{!destination.enabled && (
								<>
									<span aria-hidden className="text-muted-foreground/50">
										·
									</span>
									<Eyebrow variant="label">Disabled</Eyebrow>
								</>
							)}
						</div>

						{destination.lastTestError && (
							<Alert variant="crit" size="sm" className="mt-2 rounded-md">
								<AlertWarningIcon size={12} />
								<AlertDescription className="break-words text-severity-error">
									{destination.lastTestError}
								</AlertDescription>
							</Alert>
						)}
					</div>
				</div>

				<div className="flex shrink-0 items-center gap-2">
					<Switch
						checked={destination.enabled}
						onCheckedChange={() => onToggle(destination)}
						disabled={!isAdmin}
					/>
					<Button
						size="sm"
						variant="outline"
						onClick={() => onTest(destination)}
						disabled={!isAdmin}
						loading={isTesting}
					>
						<CheckIcon />
						Send test
					</Button>
					{isAdmin && (
						<RowActionsMenu label="Destination actions">
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
			<ConfirmDialog
				open={confirmDelete}
				onOpenChange={setConfirmDelete}
				title={`Delete ${destination.name}?`}
				description="Alert rules will stop notifying this destination. This cannot be undone."
				confirmLabel="Delete destination"
				pending={isDeleting}
				onConfirm={() => onDelete(destination)}
			/>
		</Card>
	)
}
