import { cn } from "@maple/ui/lib/utils"
import {
	alertActionStyles,
	alertDescriptionStyles,
	alertTitleStyles,
	alertVariants,
} from "@maple/ui/styles/ui/alert"
import type { VariantProps } from "class-variance-authority"
import type { Html, HtmlBuilder } from "foldkit/html"

// Port of packages/ui/src/components/ui/alert.tsx.

// The shared `info` variant reuses the green severity hue of `ok`; info reads blue here.
const variantOverride = (variant: AlertOptions["variant"]): string | undefined =>
	variant === "info" ? "border-info/32 bg-info/4 [&>svg]:text-info" : undefined

type Children = ReadonlyArray<Html | string>

export type AlertOptions = VariantProps<typeof alertVariants> & {
	readonly className?: string
	/** `role` override (`role="status"` for a progress or informational notice). */
	readonly role?: string
}

export const alert = <M>(h: HtmlBuilder<M>, options: AlertOptions, children: Children): Html =>
	h.div(
		[
			h.Class(
				cn(
					alertVariants({ size: options.size, variant: options.variant }),
					variantOverride(options.variant),
					options.className,
				),
			),
			h.DataAttribute("slot", "alert"),
			h.Role(options.role ?? "alert"),
		],
		children,
	)

const part =
	(styles: string, slot: string) =>
	<M>(h: HtmlBuilder<M>, children: Children, className?: string): Html =>
		h.div([h.Class(cn(styles, className)), h.DataAttribute("slot", slot)], children)

export const alertTitle = part(alertTitleStyles, "alert-title")
export const alertDescription = part(cn(alertDescriptionStyles, "font-prose"), "alert-description")
export const alertAction = part(alertActionStyles, "alert-action")
