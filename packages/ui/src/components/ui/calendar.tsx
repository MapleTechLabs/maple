"use client"

import { ChevronLeftIcon, ChevronRightIcon, ChevronExpandYIcon } from "../icons"
import type * as React from "react"
import { DayPicker } from "react-day-picker"
import { cn } from "../../lib/utils"
import { calendarChevronStyles, calendarClassNames, calendarStyles } from "./calendar.styles"

export function Calendar({
	className,
	classNames,
	showOutsideDays = true,
	components: userComponents,
	mode = "single",
	...props
}: React.ComponentProps<typeof DayPicker>): React.ReactElement {
	const defaultClassNames = calendarClassNames
	const mergedClassNames: typeof defaultClassNames = Object.keys(defaultClassNames).reduce(
		(acc, key) => {
			const userClass = classNames?.[key as keyof typeof classNames]
			const baseClass = defaultClassNames[key as keyof typeof defaultClassNames]

			acc[key as keyof typeof defaultClassNames] = userClass ? cn(baseClass, userClass) : baseClass

			return acc
		},
		{ ...defaultClassNames } as typeof defaultClassNames,
	)

	const defaultComponents = {
		Chevron: ({
			className,
			orientation,
			...props
		}: {
			className?: string
			orientation?: "left" | "right" | "up" | "down"
		}): React.ReactElement => {
			if (orientation === "left") {
				return (
					<ChevronLeftIcon
						className={cn(className, calendarChevronStyles)}
						{...props}
						aria-hidden="true"
					/>
				)
			}

			if (orientation === "right") {
				return (
					<ChevronRightIcon
						className={cn(className, calendarChevronStyles)}
						{...props}
						aria-hidden="true"
					/>
				)
			}

			return <ChevronExpandYIcon className={className} {...props} aria-hidden="true" />
		},
	}

	const mergedComponents = {
		...defaultComponents,
		...userComponents,
	}

	const dayPickerProps = {
		className: cn(calendarStyles, className),
		classNames: mergedClassNames,
		components: mergedComponents,
		"data-slot": "calendar",
		formatters: {
			formatMonthDropdown: (date: Date) => date.toLocaleString("default", { month: "short" }),
		} as React.ComponentProps<typeof DayPicker>["formatters"],
		mode,
		showOutsideDays,
		...props,
	}

	return <DayPicker {...(dayPickerProps as React.ComponentProps<typeof DayPicker>)} />
}
