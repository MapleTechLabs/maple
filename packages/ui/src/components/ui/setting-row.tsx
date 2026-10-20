"use client"

import { Field as FieldPrimitive } from "@base-ui/react/field"
import type * as React from "react"
import { cn } from "../../lib/utils"
import {
	settingRowControlStyles,
	settingRowDescriptionStyles,
	settingRowFramedActiveStyles,
	settingRowFramedStyles,
	settingRowHeaderStyles,
	settingRowIconStyles,
	settingRowLabelStyles,
	settingRowLeadStyles,
	settingRowStyles,
	settingRowTextStyles,
} from "./setting-row.styles"

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
				settingRowStyles,
				framed && settingRowFramedStyles,
				framed && active && settingRowFramedActiveStyles,
				className,
			)}
		>
			<div className={settingRowHeaderStyles}>
				<div className={settingRowLeadStyles}>
					{icon ? <div className={settingRowIconStyles}>{icon}</div> : null}
					<div className={settingRowTextStyles}>
						<FieldPrimitive.Label className={settingRowLabelStyles}>{label}</FieldPrimitive.Label>
						{description ? (
							<FieldPrimitive.Description className={settingRowDescriptionStyles}>
								{description}
							</FieldPrimitive.Description>
						) : null}
					</div>
				</div>
				<div className={settingRowControlStyles}>{control}</div>
			</div>
			{children}
		</FieldPrimitive.Root>
	)
}
