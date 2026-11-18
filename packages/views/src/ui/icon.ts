import type { Html, HtmlBuilder } from "foldkit/html"
import { type IconOptions, iconNode } from "./icon-node"
import { ICON_DEFAULT_SIZES, ICON_TREES, type IconName } from "./icons.generated"

export type { IconOptions } from "./icon-node"
export type { IconName } from "./icons.generated"

/** A generated icon with its size, class, style and attributes. */
export const icon = <Message>(
	h: HtmlBuilder<Message>,
	name: IconName,
	options: IconOptions<Message> = {},
): Html =>
	iconNode(h, ICON_TREES[name], name, { ...options, size: options.size ?? ICON_DEFAULT_SIZES[name] ?? 24 })

/** A list row's leading icon, muted and nudged down onto its first line of text. */
export const rowIcon = <Message>(h: HtmlBuilder<Message>, name: IconName): Html =>
	icon(h, name, { size: 16, className: "mt-0.5 shrink-0 text-muted-foreground" })

/** A colour style when the call site has a colour. */
export const iconColor = (color: string | undefined): Pick<IconOptions<never>, "style"> =>
	color === undefined ? {} : { style: { color } }
