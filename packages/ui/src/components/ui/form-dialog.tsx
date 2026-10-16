"use client"

import * as React from "react"
import { cn } from "../../lib/utils"
import { Button } from "./button"
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogPanel,
	DialogTitle,
} from "./dialog"

export interface FormDialogProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	title: React.ReactNode
	description?: React.ReactNode
	/** Runs on submit (button click or Enter in a field). */
	onSubmit: () => void
	submitLabel: React.ReactNode
	cancelLabel?: React.ReactNode
	/** Disables the form controls' close paths and shows the submit spinner. */
	pending?: boolean
	/** Keeps submit disabled until the form is valid. */
	submitDisabled?: boolean
	submitVariant?: "default" | "destructive"
	/** Left-aligned footer content (a secondary link, a hint, a step counter). */
	footerStart?: React.ReactNode
	/** The fields. Rendered inside a scrolling `DialogPanel`. */
	children?: React.ReactNode
	className?: string
	panelClassName?: string
}

/**
 * A dialog that collects input: header, fields, Cancel + submit. The body is a real `<form>`, so
 * Enter in a field submits, and the submit button carries the pending spinner.
 */
export function FormDialog({
	open,
	onOpenChange,
	title,
	description,
	onSubmit,
	submitLabel,
	cancelLabel = "Cancel",
	pending = false,
	submitDisabled = false,
	submitVariant = "default",
	footerStart,
	children,
	className,
	panelClassName,
}: FormDialogProps): React.ReactElement {
	return (
		<Dialog open={open} onOpenChange={(next) => (pending ? undefined : onOpenChange(next))}>
			<DialogContent className={className}>
				<form
					className="contents"
					onSubmit={(event) => {
						event.preventDefault()
						if (!pending && !submitDisabled) onSubmit()
					}}
				>
					<DialogHeader>
						<DialogTitle>{title}</DialogTitle>
						{description ? <DialogDescription>{description}</DialogDescription> : null}
					</DialogHeader>
					{children ? <DialogPanel className={cn("space-y-4", panelClassName)}>{children}</DialogPanel> : null}
					<DialogFooter>
						{footerStart ? <div className="me-auto flex items-center">{footerStart}</div> : null}
						<DialogClose render={<Button variant="outline" type="button" />} disabled={pending}>
							{cancelLabel}
						</DialogClose>
						<Button
							type="submit"
							variant={submitVariant}
							loading={pending}
							disabled={pending || submitDisabled}
						>
							{submitLabel}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	)
}
