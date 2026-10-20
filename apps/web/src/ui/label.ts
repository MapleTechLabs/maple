import { cn } from "@maple/ui/lib/utils"
import { labelStyles } from "@maple/ui/styles/ui/label"
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"

/** `<Label>` from @maple/ui. Wrapping a Base UI checkbox, radio or switch, it carries their `-label` id. */
export const label = <Message>(
	h: HtmlBuilder<Message>,
	options: Readonly<{ className?: string; attributes?: ReadonlyArray<Attribute<Message>> }>,
	children: ReadonlyArray<Html | string>,
): Html =>
	h.label(
		[
			h.Class(cn(labelStyles, options.className)),
			h.DataAttribute("slot", "label"),
			...(options.attributes ?? []),
		],
		children,
	)
