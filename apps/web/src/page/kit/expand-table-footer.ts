import type { Html, HtmlBuilder } from "foldkit/html"
import { icon } from "@maple/views/ui/icon"
import { pressable } from "@maple/views/ui/pressable"
import { hstack } from "@maple/views/ui/stack"
import { typography } from "@maple/views/ui/typography"

/**
 * The foot of a capped table card: "Expand table" on the left and the row count on the right, one
 * click target that opens the whole table in a dialog.
 */
export const expandTableFooter = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		onClick: M
		/** The rows the dialog will show, with their noun: "42 queries". */
		count: string
	}>,
): Html =>
	pressable(
		h,
		{
			onClick: options.onClick,
			className:
				"flex w-full items-center justify-between gap-2 rounded-b-md px-4 py-2 text-2xs text-muted-foreground hover:bg-surface-sunken active:bg-surface-sunken hover:text-foreground active:text-foreground focus-visible:bg-surface-sunken focus-visible:outline-none",
		},
		[
			hstack(h, { gap: "1.5", as: "span" }, [icon(h, "MaximizeIcon", { size: 12 }), "Expand table"]),
			typography(h, { mono: true, numeric: true }, [options.count]),
		],
	)
