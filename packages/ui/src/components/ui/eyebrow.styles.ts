import { cva } from "class-variance-authority"

// The small uppercase overline that titles a group of fields, a stat, or a table column.
// `overline` is the canonical section label; `label` is the slightly larger stat-tile caption.
export const eyebrowVariants = cva("font-medium uppercase text-muted-foreground", {
	defaultVariants: { variant: "overline" },
	variants: {
		variant: {
			overline: "text-3xs tracking-overline",
			label: "text-2xs tracking-caption",
			mono: "font-mono text-3xs tracking-overline text-foreground-subtle",
		},
	},
})
