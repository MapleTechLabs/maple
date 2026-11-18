import { Array as Arr, String as Str } from "effect"
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"
import type { IconName } from "./icons.generated"

// One icon tree drawn as an `<svg>`, with no import of the icon registry: a bundle that draws a
// few named trees (the landing nav, a button's spinner) never carries every icon. `icon` (./icon)
// is the lookup by name, which does.

/** In an icon tree: the attribute value that takes the drawn `size`. */
export const ICON_SIZE_MARK = "7777"
/** In an icon tree: the attribute value that takes the call site's class. */
export const ICON_CLASS_MARK = "__icon_class__"
/** In an icon tree: where an icon's own `useId` (a gradient id) goes. */
export const ICON_ID_MARK = "__icon_id__"

export type IconTag =
	| "svg"
	| "path"
	| "g"
	| "line"
	| "circle"
	| "rect"
	| "polyline"
	| "polygon"
	| "ellipse"
	| "defs"
	| "linearGradient"
	| "stop"
	| "radialGradient"

export type IconNode = readonly [IconTag, ReadonlyArray<readonly [string, string]>, ReadonlyArray<IconNode>]

export type IconOptions<Message> = Readonly<{
	/** Width and height. Defaults to the icon's own (24 for most). */
	size?: number | string
	className?: string
	/** Inline style (`{ color }`). */
	style?: Readonly<Record<string, string>>
	/** Attributes set on the `<svg>` after its defaults (`aria-label`, `role`, `data-*`). */
	attributes?: ReadonlyArray<Attribute<Message>>
	/** Root attributes the call site sets to `undefined` (`aria-hidden={undefined}`). */
	removedAttributes?: ReadonlyArray<string>
	/** The icon's own `useId` (a gradient id), unique on the page; defaults to the icon's name. */
	id?: string
}>

const renderNode = <Message>(
	h: HtmlBuilder<Message>,
	[tag, attributes, children]: IconNode,
	options: IconOptions<Message>,
	size: string,
	id: string,
): Html => {
	const own = Arr.flatMap(attributes, ([name, value]): ReadonlyArray<Attribute<Message>> => {
		if (options.removedAttributes?.includes(name) === true) return []
		if (value === ICON_CLASS_MARK)
			return options.className === undefined || options.className === ""
				? []
				: [h.Class(options.className)]
		return [h.Attribute(name, value === ICON_SIZE_MARK ? size : Str.replaceAll(ICON_ID_MARK, id)(value))]
	})
	const root = tag === "svg"
	return h[tag](
		[
			...own,
			...(root && options.style !== undefined ? [h.Style(options.style)] : []),
			...(root ? (options.attributes ?? []) : []),
		],
		Arr.map(children, (child) => renderNode(h, child, {}, size, id)),
	)
}

/** One icon tree drawn without the registry lookup (`control-icons`), so a bundle keeps only it; 24 unless `size` says. */
export const iconNode = <Message>(
	h: HtmlBuilder<Message>,
	tree: IconNode,
	name: IconName,
	options: IconOptions<Message> = {},
): Html => renderNode(h, tree, options, String(options.size ?? 24), options.id ?? name)
