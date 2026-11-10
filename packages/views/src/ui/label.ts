import { cn } from "@maple/ui/lib/utils"
import { labelStyles } from "./label.styles"
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"

/** A form label. Wrapping a Base UI checkbox, radio or switch, it carries their `-label` id. */
export const label = <Message>(
	h: HtmlBuilder<Message>,
	options: Readonly<{ className?: string; attributes?: ReadonlyArray<Attribute<Message>> }>,
	children: ReadonlyArray<Html | string>,
): Html =>
	h.label(
		[
			// A label around a disabled control dims its text like the control does.
			h.Class(cn(labelStyles, "has-data-disabled:text-muted-foreground", options.className)),
			h.DataAttribute("slot", "label"),
			...(options.attributes ?? []),
		],
		children,
	)
