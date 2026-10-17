import type { Attribute, Html, HtmlBuilder } from "foldkit/html"
import { ICON_CLASS_MARK, ICON_SIZE_MARK, ICON_TREES, type IconName, type IconNode } from "./icons.generated"

export type { IconName } from "./icons.generated"

export type IconOptions = Readonly<{
	/** React's `size` prop: width and height. Defaults to the icon's own 24. */
	size?: number
	className?: string
	/** Inline style the React call site passes (`style={{ color }}`). */
	color?: string
}>

const renderNode = <Message>(h: HtmlBuilder<Message>, node: IconNode, options: IconOptions): Html => {
	const [tag, attributes, children] = node
	const rendered: Array<Attribute<Message>> = []
	for (const [name, value] of attributes) {
		if (value === ICON_CLASS_MARK) {
			if (options.className !== undefined && options.className !== "")
				rendered.push(h.Class(options.className))
		} else if (value === ICON_SIZE_MARK) rendered.push(h.Attribute(name, String(options.size ?? 24)))
		else rendered.push(h.Attribute(name, value))
	}
	if (options.color !== undefined) rendered.push(h.Style({ color: options.color }))
	const kids = children.map((child) => renderNode(h, child, {}))
	return tag === "svg" ? h.svg(rendered, kids) : h.path(rendered, kids)
}

/** `<XIcon size className style>` from `apps/web/src/components/icons`, as generated markup. */
export const icon = <Message>(h: HtmlBuilder<Message>, name: IconName, options: IconOptions = {}): Html =>
	renderNode(h, ICON_TREES[name], options)
