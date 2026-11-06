import { cn } from "../../lib/utils"

export const calendarButtonStyles =
	"relative flex size-(--cell-size) text-base sm:text-sm items-center justify-center rounded-lg text-foreground not-in-data-selected:hover:bg-accent not-in-data-selected:active:bg-accent disabled:pointer-events-none disabled:opacity-64 [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0"

export const calendarClassNames = {
	button_next: calendarButtonStyles,
	button_previous: calendarButtonStyles,
	caption_label: "text-base sm:text-sm font-medium flex items-center gap-2 h-full",
	day: "size-(--cell-size) text-sm py-px",
	day_button: cn(
		calendarButtonStyles,
		"in-data-disabled:pointer-events-none in-[.range-middle]:rounded-none in-[.range-end:not(.range-start)]:rounded-s-none in-[.range-start:not(.range-end)]:rounded-e-none in-[.range-middle]:in-data-selected:bg-accent in-data-selected:bg-primary in-[.range-middle]:in-data-selected:text-foreground in-data-disabled:text-foreground-subtle in-data-outside:text-foreground-subtle in-data-selected:in-data-outside:text-primary-foreground in-data-selected:text-primary-foreground in-data-disabled:line-through outline-none in-[[data-selected]:not(.range-middle)]:transition-[color,background-color,border-radius,box-shadow] focus-visible:z-1 focus-visible:ring-[3px] focus-visible:ring-ring/50",
	),
	dropdown: "absolute bg-popover inset-0 opacity-0",
	dropdown_root:
		"relative has-focus:border-ring has-focus:ring-ring/50 has-focus:ring-[3px] border border-input shadow-raised rounded-lg px-[calc(--spacing(3)-1px)] h-9 sm:h-8 [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:-me-1",
	dropdowns:
		"w-full flex items-center text-base sm:text-sm justify-center h-(--cell-size) gap-1.5 *:[span]:font-medium",
	hidden: "invisible",
	month: "w-full",
	month_caption: "relative mx-(--cell-size) px-1 mb-1 flex h-(--cell-size) items-center justify-center z-2",
	months: "relative flex flex-col sm:flex-row gap-2",
	nav: "absolute top-0 flex w-full justify-between z-1",
	outside: "text-muted-foreground data-selected:bg-accent/50 data-selected:text-muted-foreground",
	range_end: "range-end",
	range_middle: "range-middle",
	range_start: "range-start",
	today: "*:after:pointer-events-none *:after:absolute *:after:bottom-1 *:after:start-1/2 *:after:z-1 *:after:size-[3px] *:after:-translate-x-1/2 *:after:rounded-full *:after:bg-primary [&[data-selected]:not(.range-middle)>*]:after:bg-background [&[data-disabled]>*]:after:bg-foreground/30 *:after:transition-colors",
	week_number: "size-(--cell-size) p-0 text-xs font-medium text-foreground-subtle",
	weekday: "size-(--cell-size) p-0 text-xs font-medium text-foreground-subtle",
}

export const calendarChevronStyles = "rtl:rotate-180"

export const calendarStyles = "w-fit [--cell-size:--spacing(10)] sm:[--cell-size:--spacing(9)]"
