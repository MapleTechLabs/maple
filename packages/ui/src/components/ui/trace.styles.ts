export const traceStyles =
	"flex w-full min-w-0 flex-col gap-2 *:has-[>[data-slot=trace-line]]:flex *:has-[>[data-slot=trace-line]]:w-fit *:has-[>[data-slot=trace-line]]:max-w-full *:has-[>[data-slot=trace-line]]:min-w-0 *:has-[>[data-slot=trace-line]]:rounded-none *:has-[>[data-slot=trace-line]]:text-left *:has-[>[data-slot=trace-line]]:outline-none *:has-[>[data-slot=trace-line]]:focus-visible:ring-1 *:has-[>[data-slot=trace-line]]:focus-visible:ring-ring/50"

export const traceLineStyles =
	"flex w-fit max-w-full min-w-0 items-center gap-2 text-xs text-muted-foreground transition-colors in-[a,button]:cursor-pointer in-[a:hover,button:hover]:text-foreground data-[status=error]:text-destructive data-[status=error]:in-[a:hover,button:hover]:text-destructive data-[status=pending]:opacity-60 data-[status=running]:*:data-[slot=trace-title]:shimmer"

export const traceIconStyles =
	"flex size-3.5 shrink-0 items-center justify-center [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-3.5 [[data-slot=trace-title]~&]:-ml-1"

export const traceTitleStyles = "min-w-0 truncate motion-reduce:shimmer-none"

export const traceDescriptionStyles = "shrink-0 text-foreground-subtle tabular-nums"

export const traceCollapsibleStyles = "flex w-full min-w-0 flex-col"

export const traceCollapsibleTriggerStyles =
	"group/trace-collapsible-trigger flex w-fit max-w-full min-w-0 cursor-pointer items-center gap-1 rounded-none text-left text-muted-foreground outline-none hover:text-foreground active:text-foreground focus-visible:ring-1 focus-visible:ring-ring/50 has-[[data-status=error]]:text-destructive"

export const traceCollapsibleTriggerIconStyles =
	"transition-transform group-aria-expanded/trace-collapsible-trigger:rotate-90"

export const traceCollapsibleContentStyles =
	"mt-2 mb-1 ml-[calc(--spacing(1.75)-1px)] min-w-0 border-l pr-1 pl-3.75 leading-relaxed wrap-break-word text-muted-foreground"
