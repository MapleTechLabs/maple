"use client"

import type { ComponentProps } from "react"

import { Button } from "@maple/ui/components/ui/button"
import { cn } from "@/lib/utils"
import { useCallback } from "react"

export type SuggestionsProps = ComponentProps<"div">

export const Suggestions = ({ className, children, ...props }: SuggestionsProps) => (
	<div className={cn("flex flex-wrap items-center gap-2", className)} {...props}>
		{children}
	</div>
)

export type SuggestionProps = Omit<ComponentProps<typeof Button>, "onClick"> & {
	suggestion: string
	onClick?: (suggestion: string) => void
}

export const Suggestion = ({
	suggestion,
	onClick,
	className,
	variant = "outline",
	size = "sm",
	children,
	...props
}: SuggestionProps) => {
	const handleClick = useCallback(() => {
		onClick?.(suggestion)
	}, [onClick, suggestion])

	return (
		<Button
			className={cn(
				"h-auto min-h-7 max-w-full cursor-pointer whitespace-normal rounded-full px-4 py-1.5 text-left",
				className,
			)}
			onClick={handleClick}
			size={size}
			type="button"
			variant={variant}
			{...props}
		>
			{children || suggestion}
		</Button>
	)
}
