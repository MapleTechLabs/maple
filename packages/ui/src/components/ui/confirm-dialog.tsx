"use client"

import * as React from "react"
import { AlertWarningIcon } from "../icons"
import { cn } from "../../lib/utils"
import { Button } from "./button"
import {
	AlertDialog,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogMedia,
	AlertDialogTitle,
} from "./alert-dialog"

export interface ConfirmDialogProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	title: React.ReactNode
	description?: React.ReactNode
	confirmLabel: React.ReactNode
	cancelLabel?: React.ReactNode
	/** `destructive` (default) shows the warning media and a red confirm button. */
	tone?: "destructive" | "default"
	/** Replaces the default warning icon; `null` drops the media block. */
	icon?: React.ReactNode | null
	/**
	 * A returned promise drives the pending state and closes the dialog when it
	 * resolves. Resolving to `false` (an Exit-style failure) or rejecting keeps it
	 * open so the user can retry after the caller's toast.
	 */
	onConfirm: () => void
	/** Externally owned pending state, for callers that track their own mutation. */
	pending?: boolean
	/** Keeps confirm disabled until a precondition holds (e.g. the typed name matches). */
	confirmDisabled?: boolean
	/** Third button between cancel and confirm (e.g. "Delete section only"). */
	secondaryAction?: { label: React.ReactNode; onClick: () => void }
	/** Extra body below the description (a typed-name check, a list of affected items). */
	children?: React.ReactNode
	className?: string
}

/** The confirm-before-acting dialog: title, consequence, cancel, confirm with a pending state. */
export function ConfirmDialog({
	open,
	onOpenChange,
	title,
	description,
	confirmLabel,
	cancelLabel = "Cancel",
	tone = "destructive",
	icon,
	onConfirm,
	pending: pendingProp = false,
	confirmDisabled = false,
	secondaryAction,
	children,
	className,
}: ConfirmDialogProps): React.ReactElement {
	const [running, setRunning] = React.useState(false)
	const pending = pendingProp || running

	// Typed `() => void` so async handlers are accepted as-is; a returned promise is detected at runtime.
	const run = (action: () => void) => {
		const result: unknown = action()
		if (!(result instanceof Promise)) return
		setRunning(true)
		result.then(
			(value: unknown) => {
				setRunning(false)
				if (value !== false) onOpenChange(false)
			},
			() => setRunning(false),
		)
	}

	const media =
		icon === null ? null : (
			<AlertDialogMedia className={cn(tone === "destructive" && "bg-destructive/10")}>
				{icon ?? <AlertWarningIcon className={cn(tone === "destructive" && "text-destructive")} />}
			</AlertDialogMedia>
		)

	return (
		<AlertDialog open={open} onOpenChange={(next) => (pending ? undefined : onOpenChange(next))}>
			<AlertDialogContent className={className}>
				<AlertDialogHeader>
					{media}
					<AlertDialogTitle>{title}</AlertDialogTitle>
					{description ? <AlertDialogDescription>{description}</AlertDialogDescription> : null}
				</AlertDialogHeader>
				{children}
				<AlertDialogFooter>
					<AlertDialogCancel disabled={pending}>{cancelLabel}</AlertDialogCancel>
					{secondaryAction ? (
						<Button variant="outline" disabled={pending} onClick={() => run(secondaryAction.onClick)}>
							{secondaryAction.label}
						</Button>
					) : null}
					<Button
						variant={tone === "destructive" ? "destructive" : "default"}
						loading={pending}
						disabled={pending || confirmDisabled}
						onClick={() => run(onConfirm)}
					>
						{confirmLabel}
					</Button>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	)
}
