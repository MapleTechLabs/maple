import * as React from "react"

import { cn } from "../../lib/utils"
import { ChevronExpandYIcon } from "../icons"
import { nativeSelectIconStyles, nativeSelectStyles, nativeSelectWrapperStyles } from "./native-select.styles"

type NativeSelectProps = Omit<React.ComponentProps<"select">, "size"> & {
	size?: "sm" | "default"
}

function NativeSelect({ className, size = "default", ...props }: NativeSelectProps) {
	return (
		<div
			className={cn(nativeSelectWrapperStyles, className)}
			data-slot="native-select-wrapper"
			data-size={size}
		>
			<select data-slot="native-select" data-size={size} className={nativeSelectStyles} {...props} />
			<ChevronExpandYIcon
				strokeWidth={2}
				className={nativeSelectIconStyles}
				aria-hidden="true"
				data-slot="native-select-icon"
			/>
		</div>
	)
}

function NativeSelectOption({ ...props }: React.ComponentProps<"option">) {
	return <option data-slot="native-select-option" {...props} />
}

function NativeSelectOptGroup({ className, ...props }: React.ComponentProps<"optgroup">) {
	return <optgroup data-slot="native-select-optgroup" className={cn(className)} {...props} />
}

export { NativeSelect, NativeSelectOptGroup, NativeSelectOption }
