import { variants } from "@maple/ui/lib/variants"

// The small muted label that titles a group of fields, a stat, or a table column, in sentence case.
// `overline` is the canonical section label, `label` the slightly larger stat-tile caption and
// `mono` an uppercase machine tag.
export const eyebrowVariants = variants("font-medium text-muted-foreground", {
	defaultVariants: { variant: "overline" },
	variants: {
		variant: {
			overline: "text-2xs",
			label: "text-xs",
			mono: "font-mono text-3xs uppercase tracking-overline text-foreground-subtle",
		},
	},
})
