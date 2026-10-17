import type { Html, HtmlBuilder } from "foldkit/html"
import { NUCLEO_ICONS, type NucleoIconName, type SvgNode } from "./nucleo-icons.gen"

export type { NucleoIconName }

export interface IconOptions {
	/** `size` prop of the React icon: width and height. */
	readonly size?: number | string
	readonly className?: string
	readonly style?: Readonly<Record<string, string>>
	/** Extra root attributes (`{...props}` on the React icon). */
	readonly attributes?: ReadonlyArray<readonly [string, string]>
}

const child = <M>(h: HtmlBuilder<M>, [tag, attributes, children]: SvgNode): Html => {
	const attrs = attributes.map(([name, value]) => h.Attribute(name, value))
	const kids = children.map((node) => child(h, node))
	switch (tag) {
		case "line":
			return h.line(attrs, kids)
		case "g":
			return h.g(attrs, kids)
		case "circle":
			return h.circle(attrs, kids)
		default:
			return h.path(attrs, kids)
	}
}

/** An `@maple/ui` icon component's markup, with its `size`, `className` and `style` props applied. */
export const nucleoIcon = <M>(h: HtmlBuilder<M>, name: NucleoIconName, options: IconOptions = {}): Html => {
	const [, attributes, children] = NUCLEO_ICONS[name] satisfies SvgNode
	const overrides = new Map<string, string>(options.attributes ?? [])
	if (options.size !== undefined) {
		overrides.set("width", String(options.size))
		overrides.set("height", String(options.size))
	}
	const root = attributes.filter(([attribute]) => !overrides.has(attribute)).map(([attribute, value]) => h.Attribute(attribute, value))
	return h.svg(
		[
			...root,
			...[...overrides].map(([attribute, value]) => h.Attribute(attribute, value)),
			...(options.className ? [h.Class(options.className)] : []),
			...(options.style ? [h.Style(options.style)] : []),
		],
		children.map((node) => child(h, node)),
	)
}
