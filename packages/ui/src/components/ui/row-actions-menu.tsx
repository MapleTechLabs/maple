"use client"

import type React from "react"
import { DotsVerticalIcon } from "../icons"
import { Button } from "./button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "./dropdown-menu"

export interface RowActionsMenuProps {
	/** Trigger aria-label. */
	label?: string
	align?: "start" | "center" | "end"
	disabled?: boolean
	className?: string
	/** DropdownMenuItem, DropdownMenuSeparator, etc. */
	children: React.ReactNode
}

/** The kebab menu at the end of a row: one trigger size, one icon size. */
export function RowActionsMenu({
	label = "More actions",
	align = "end",
	disabled,
	className,
	children,
}: RowActionsMenuProps): React.ReactElement {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				disabled={disabled}
				render={
					<Button
						aria-label={label}
						className={className}
						data-slot="row-actions-trigger"
						size="icon-sm"
						variant="ghost"
					/>
				}
			>
				<DotsVerticalIcon className="size-4" />
			</DropdownMenuTrigger>
			<DropdownMenuContent align={align} className="w-auto min-w-40">
				{children}
			</DropdownMenuContent>
		</DropdownMenu>
	)
}
