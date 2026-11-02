import { cva } from "class-variance-authority"

export const bubbleVariants = cva(
	"group/bubble relative flex w-fit max-w-[80%] min-w-0 flex-col gap-1 group-data-[align=end]/message:self-end data-[align=end]:self-end data-[variant=ghost]:max-w-full",
	{
		variants: {
			variant: {
				default:
					"*:data-[slot=bubble-content]:bg-primary *:data-[slot=bubble-content]:text-primary-foreground [&>[data-slot=bubble-content]:is(button,a):hover]:bg-primary/80",
				secondary:
					"*:data-[slot=bubble-content]:bg-secondary *:data-[slot=bubble-content]:text-secondary-foreground [&>[data-slot=bubble-content]:is(button,a):hover]:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)]",
				muted: "*:data-[slot=bubble-content]:bg-muted [&>[data-slot=bubble-content]:is(button,a):hover]:bg-[color-mix(in_oklch,var(--muted),var(--foreground)_5%)]",
				tinted: "*:data-[slot=bubble-content]:bg-bubble-tinted *:data-[slot=bubble-content]:text-foreground [&>[data-slot=bubble-content]:is(button,a):hover]:bg-bubble-tinted-hover",
				outline:
					"*:data-[slot=bubble-content]:border-border *:data-[slot=bubble-content]:bg-background [&>[data-slot=bubble-content]:is(button,a):hover]:bg-muted [&>[data-slot=bubble-content]:is(button,a):hover]:text-foreground dark:[&>[data-slot=bubble-content]:is(button,a):hover]:bg-input/30",
				ghost: "border-none *:data-[slot=bubble-content]:rounded-none *:data-[slot=bubble-content]:bg-transparent *:data-[slot=bubble-content]:p-0 [&>[data-slot=bubble-content]:is(button,a):hover]:bg-muted [&>[data-slot=bubble-content]:is(button,a):hover]:text-foreground dark:[&>[data-slot=bubble-content]:is(button,a):hover]:bg-surface-sunken",
				destructive:
					"*:data-[slot=bubble-content]:bg-destructive-a2 *:data-[slot=bubble-content]:text-destructive dark:*:data-[slot=bubble-content]:bg-destructive-a3 [&>[data-slot=bubble-content]:is(button,a):hover]:bg-destructive-a3 dark:[&>[data-slot=bubble-content]:is(button,a):hover]:bg-destructive-a3",
			},
		},
		defaultVariants: {
			variant: "default",
		},
	},
)

export const bubbleReactionsVariants = cva(
	"absolute z-10 flex w-fit shrink-0 items-center justify-center gap-1 rounded-none bg-muted px-1.5 py-0.5 text-xs ring-2 ring-card has-[button]:p-0",
	{
		variants: {
			side: {
				top: "top-0 -translate-y-3/4",
				bottom: "bottom-0 translate-y-3/4",
			},
			align: {
				start: "left-3",
				end: "right-3",
			},
		},
		defaultVariants: {
			side: "bottom",
			align: "end",
		},
	},
)

export const bubbleGroupStyles = "flex min-w-0 flex-col gap-2"

export const bubbleContentStyles =
	"w-fit max-w-full min-w-0 overflow-hidden rounded-none border border-transparent px-2.5 py-2 text-xs leading-relaxed wrap-break-word group-data-[align=end]/bubble:self-end [button]:text-left [button,a]:transition-colors [button,a]:outline-none [button,a]:focus-visible:border-ring [button,a]:focus-visible:ring-1 [button,a]:focus-visible:ring-ring/50"
