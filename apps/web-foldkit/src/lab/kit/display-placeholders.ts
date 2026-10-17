import { cn } from "@maple/ui/lib/utils"
import { badgeVariants } from "@maple/ui/styles/ui/badge"
import { separatorStyles } from "@maple/ui/styles/ui/separator"
import type { VariantProps } from "class-variance-authority"
import type { Html, HtmlBuilder } from "foldkit/html"

// Static stand-ins for primitives other ports own, producing legacy's DOM for `/lab/kit/display`.

// TODO(app-shell): replace with src/ui/badge.ts
export const badgePlaceholder = <M>(
	h: HtmlBuilder<M>,
	variant: VariantProps<typeof badgeVariants>["variant"],
	children: ReadonlyArray<Html | string>,
): Html =>
	h.span(
		[
			h.Class(cn(badgeVariants({ mono: false, pill: false, size: undefined, variant }))),
			h.DataAttribute("slot", "badge"),
		],
		children,
	)

// TODO(app-shell): replace with src/ui/separator.ts
export const separatorPlaceholder = <M>(h: HtmlBuilder<M>, orientation: "horizontal" | "vertical"): Html =>
	h.div([
		h.AriaOrientation(orientation),
		h.Class(separatorStyles),
		h.DataAttribute("orientation", orientation),
		h.DataAttribute("slot", "separator"),
		h.Role("separator"),
	])
