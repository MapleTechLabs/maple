import type { Attribute, Html, HtmlBuilder } from "foldkit/html"
import {
	ICON_CLASS_MARK,
	ICON_DEFAULT_SIZES,
	ICON_SIZE_MARK,
	ICON_TREES,
	type IconName,
	type IconNode,
} from "./icons.generated"

export type { IconName } from "./icons.generated"

export type IconOptions<Message> = Readonly<{
	/** React's `size` prop: width and height. Defaults to the icon's own (24 for most). */
	size?: number | string
	className?: string
	/** Inline style the React call site passes (`style={{ color }}`). */
	style?: Readonly<Record<string, string>>
	/** Props spread onto the React `<svg>` after its defaults (`aria-label`, `role`, `data-*`). */
	attributes?: ReadonlyArray<Attribute<Message>>
}>

const renderNode = <Message>(
	h: HtmlBuilder<Message>,
	[tag, attributes, children]: IconNode,
	options: IconOptions<Message>,
	size: string,
): Html => {
	const own = attributes.flatMap(([name, value]): ReadonlyArray<Attribute<Message>> => {
		if (value === ICON_CLASS_MARK)
			return options.className === undefined || options.className === ""
				? []
				: [h.Class(options.className)]
		return [h.Attribute(name, value === ICON_SIZE_MARK ? size : value)]
	})
	const root = tag === "svg"
	return h[tag](
		[
			...own,
			...(root && options.style !== undefined ? [h.Style(options.style)] : []),
			...(root ? (options.attributes ?? []) : []),
		],
		children.map((child) => renderNode(h, child, {}, size)),
	)
}

/** `<XIcon size className style {...props}>` from @maple/ui or apps/web, as generated markup. */
export const icon = <Message>(
	h: HtmlBuilder<Message>,
	name: IconName,
	options: IconOptions<Message> = {},
): Html => renderNode(h, ICON_TREES[name], options, String(options.size ?? ICON_DEFAULT_SIZES[name] ?? 24))

/** `style={{ color }}` when the call site has a colour. */
export const iconColor = (color: string | undefined): Pick<IconOptions<never>, "style"> =>
	color === undefined ? {} : { style: { color } }
