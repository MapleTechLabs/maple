import type { Attribute, Html, HtmlBuilder } from "foldkit/html"
import { button } from "./button"
import { icon } from "./icon"
import { hstack } from "./stack"
import { typography, typographyClass } from "./typography"

// `RemovableChip`: an active filter as a small mono chip, its label then an x that removes it
// (the infra filter rails).

const CHIP_CLASS = typographyClass({
	size: "3xs",
	tone: "muted",
	mono: true,
	className: "rounded-sm border border-border-subtle bg-background/60 py-0.5 pr-0.5 pl-1.5",
})

export const removableChip = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ label: string; onRemove: M; attributes?: ReadonlyArray<Attribute<M>> }>,
): Html =>
	hstack(h, { gap: "1", inline: true, as: "span", className: CHIP_CLASS, attributes: options.attributes }, [
		typography(h, { tone: "soft", truncate: true, className: "max-w-[22ch]" }, [options.label]),
		button(
			h,
			{
				variant: "ghost",
				size: "icon-2xs",
				className: typographyClass({ tone: "muted", hoverTone: "foreground" }),
				attributes: [h.AriaLabel(`Remove ${options.label}`), h.OnClick(options.onRemove)],
			},
			[icon(h, "XmarkIcon")],
		),
	])
