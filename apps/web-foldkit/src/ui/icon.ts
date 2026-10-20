import type { Attribute, Html, HtmlBuilder } from "foldkit/html"
import {
	ICON_CLASS_MARK,
	ICON_DEFAULT_SIZES,
	ICON_ID_MARK,
	ICON_SIZE_MARK,
	ICON_TREES,
	type IconName,
	type IconNode,
} from "./icons.generated"

export type { IconName } from "./icons.generated"

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
	const own = attributes.flatMap(([name, value]): ReadonlyArray<Attribute<Message>> => {
		if (options.removedAttributes?.includes(name) === true) return []
		if (value === ICON_CLASS_MARK)
			return options.className === undefined || options.className === ""
				? []
				: [h.Class(options.className)]
		return [h.Attribute(name, value === ICON_SIZE_MARK ? size : value.replaceAll(ICON_ID_MARK, id))]
	})
	const root = tag === "svg"
	return h[tag](
		[
			...own,
			...(root && options.style !== undefined ? [h.Style(options.style)] : []),
			...(root ? (options.attributes ?? []) : []),
		],
		children.map((child) => renderNode(h, child, {}, size, id)),
	)
}

/** A generated icon with its size, class, style and attributes. */
export const icon = <Message>(
	h: HtmlBuilder<Message>,
	name: IconName,
	options: IconOptions<Message> = {},
): Html =>
	renderNode(h, ICON_TREES[name], options, String(options.size ?? ICON_DEFAULT_SIZES[name] ?? 24), options.id ?? name)

/** `style={{ color }}` when the call site has a colour. */
export const iconColor = (color: string | undefined): Pick<IconOptions<never>, "style"> =>
	color === undefined ? {} : { style: { color } }
