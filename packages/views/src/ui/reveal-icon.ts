import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { type IconName, icon } from "./icon"

/**
 * `revealIcon`: a muted trailing icon (an external-link or "go" arrow) hidden until its `group`
 * row is hovered or keyboard-focused.
 */
export const revealIcon = <M>(
	h: HtmlBuilder<M>,
	name: IconName,
	options: Readonly<{ size?: number; className?: string }> = {},
): Html =>
	icon(h, name, {
		size: options.size ?? 14,
		className: cn(
			"shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100",
			options.className,
		),
	})
