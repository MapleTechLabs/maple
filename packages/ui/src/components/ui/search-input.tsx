// Controlled magnifier + clear-button search input for filtering already-loaded
// content (attribute tables, in-panel lists). Deliberately not debounced —
// `ToolbarSearch` in ../toolbar.tsx is the debounced sibling for inputs whose
// value fans out into queries.

import type React from "react"
import { MagnifierIcon, XmarkIcon } from "../icons"
import type { InputProps } from "./input"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "./input-group"

export interface SearchInputProps extends Omit<InputProps, "value" | "onChange" | "size" | "className"> {
	value: string
	onValueChange: (value: string) => void
	className?: string
	/** Extra trailing addon content rendered before the clear button (e.g. a syntax-help popover). */
	trailing?: React.ReactNode
	/** Runs after the clear button empties the value (e.g. to also drop an applied filter). */
	onClear?: () => void
	clearLabel?: string
}

export function SearchInput({
	value,
	onValueChange,
	className,
	trailing,
	onClear,
	clearLabel = "Clear search",
	type = "text",
	...inputProps
}: SearchInputProps) {
	return (
		<InputGroup className={className}>
			<InputGroupAddon>
				<MagnifierIcon />
			</InputGroupAddon>
			<InputGroupInput
				{...inputProps}
				size="sm"
				type={type}
				value={value}
				onChange={(e) => onValueChange(e.target.value)}
			/>
			{value || trailing ? (
				<InputGroupAddon align="inline-end">
					{trailing}
					{value ? (
						<InputGroupButton
							aria-label={clearLabel}
							onClick={() => {
								onValueChange("")
								onClear?.()
							}}
						>
							<XmarkIcon />
						</InputGroupButton>
					) : null}
				</InputGroupAddon>
			) : null}
		</InputGroup>
	)
}
