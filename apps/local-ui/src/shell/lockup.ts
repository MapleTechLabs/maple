import { icon } from "@maple/views/ui/icon"
import { hstack } from "@maple/views/ui/stack"
import { typography } from "@maple/views/ui/typography"
import type { Html, HtmlBuilder } from "foldkit/html"

/** The lockup: `maple` in the display face, `local` in mono. */
export const localLockup = <M>(h: HtmlBuilder<M>): Html =>
	hstack(h, { as: "span", gap: "1.5", className: "shrink-0" }, [
		icon(h, "MapleMark", { size: 16, className: "shrink-0 text-primary" }),
		typography(
			h,
			{ size: "sm", weight: "semibold", className: "font-display tracking-[-0.01em] group-data-[collapsible=icon]:hidden" },
			["maple"],
		),
		typography(
			h,
			{
				size: "2xs",
				tone: "muted",
				weight: "medium",
				mono: true,
				className: "tracking-[0.08em] group-data-[collapsible=icon]:hidden",
			},
			["local"],
		),
	])
