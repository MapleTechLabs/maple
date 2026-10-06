import { ConfirmDialog } from "@maple/ui/components/ui/confirm-dialog"
import { TrashIcon } from "@/components/icons"

// Both destructive section actions offer the same shape of choice: keep the
// widgets somewhere sensible, or delete them along with their container. Naming
// the destination in the button label ("Move to Overview") is what stops the
// choice from reading as "delete" vs "delete differently" — the whole point is
// that one of these options is not destructive at all.

interface DeleteSectionDialogProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	sectionTitle: string
	widgetCount: number
	onConfirm: (action: "ungroup" | "delete") => void
}

export function DeleteSectionDialog({
	open,
	onOpenChange,
	sectionTitle,
	widgetCount,
	onConfirm,
}: DeleteSectionDialogProps) {
	const confirm = (action: "ungroup" | "delete") => {
		onConfirm(action)
		onOpenChange(false)
	}

	return (
		<ConfirmDialog
			open={open}
			onOpenChange={onOpenChange}
			icon={<TrashIcon className="text-destructive" />}
			title={<>Delete “{sectionTitle}”?</>}
			description={
				widgetCount === 0
					? "This group is empty, so nothing else will be removed."
					: `This group holds ${widgetCount === 1 ? "1 widget" : `${widgetCount} widgets`}. Keep them on the dashboard, or delete them with the group.`
			}
			secondaryAction={
				widgetCount > 0 ? { label: "Keep widgets", onClick: () => confirm("ungroup") } : undefined
			}
			confirmLabel={widgetCount === 0 ? "Delete group" : "Delete group & widgets"}
			onConfirm={() => confirm("delete")}
		/>
	)
}

interface DeleteTabDialogProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	tabTitle: string
	/** The tab widgets move into — named in the button so the choice is concrete. */
	destinationTitle: string
	widgetCount: number
	onConfirm: (action: "move" | "delete") => void
}

export function DeleteTabDialog({
	open,
	onOpenChange,
	tabTitle,
	destinationTitle,
	widgetCount,
	onConfirm,
}: DeleteTabDialogProps) {
	const confirm = (action: "move" | "delete") => {
		onConfirm(action)
		onOpenChange(false)
	}

	return (
		<ConfirmDialog
			open={open}
			onOpenChange={onOpenChange}
			icon={<TrashIcon className="text-destructive" />}
			title={<>Delete tab “{tabTitle}”?</>}
			description={
				widgetCount === 0
					? "This tab is empty, so nothing else will be removed."
					: `This tab holds ${widgetCount === 1 ? "1 widget" : `${widgetCount} widgets`}.`
			}
			secondaryAction={
				widgetCount > 0
					? { label: <>Move to “{destinationTitle}”</>, onClick: () => confirm("move") }
					: undefined
			}
			confirmLabel={widgetCount === 0 ? "Delete tab" : "Delete tab & widgets"}
			onConfirm={() => confirm("delete")}
		/>
	)
}
