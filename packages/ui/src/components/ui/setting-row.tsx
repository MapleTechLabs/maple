"use client"

import { Field as FieldPrimitive } from "@base-ui/react/field"
import type * as React from "react"
import { cn } from "../../lib/utils"

export interface SettingRowProps {
	label: React.ReactNode
	description?: React.ReactNode
	/** Leading icon or logo plate. */
	icon?: React.ReactNode
	/** The Switch / Select / Button on the right. Base UI controls inside are labelled by `label`. */
	control: React.ReactNode
	/** Draws the bordered box (stand-alone rows); omit inside a `divide-y` list. */
	framed?: boolean
	/** Highlights the row while its setting is on. */
	active?: boolean
	disabled?: boolean
	/** Content under the row (an expanded sub-form while the toggle is on). */
	children?: React.ReactNode
	className?: string
}

/** Settings row: label and description on the left, the control on the right. */
export function SettingRow({
	label,
	description,
	icon,
	control,
	framed = false,
	active = false,
	disabled,
	children,
	className,
}: SettingRowProps): React.ReactElement {
	return (
		<FieldPrimitive.Root
			disabled={disabled}
			data-slot="setting-row"
			className={cn(
				"flex flex-col gap-3",
				framed && "rounded-lg border p-4 transition-colors",
				framed && active && "border-primary/20 bg-primary/[0.02]",
				className,
			)}
		>
			<div className="flex items-center justify-between gap-4">
				<div className="flex min-w-0 items-start gap-3">
					{icon ? <div className="shrink-0">{icon}</div> : null}
					<div className="min-w-0 space-y-0.5">
						<FieldPrimitive.Label className="text-sm font-medium text-foreground data-disabled:opacity-64">
							{label}
						</FieldPrimitive.Label>
						{description ? (
							<FieldPrimitive.Description className="text-xs text-muted-foreground">
								{description}
							</FieldPrimitive.Description>
						) : null}
					</div>
				</div>
				<div className="flex shrink-0 items-center gap-2">{control}</div>
			</div>
			{children}
		</FieldPrimitive.Root>
	)
}
