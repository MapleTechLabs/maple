import {
	ICON_CLASS_MARK,
	ICON_DEFAULT_SIZES,
	ICON_ID_MARK,
	ICON_SIZE_MARK,
	ICON_TREES,
	type IconName,
	type IconNode,
} from "@maple/views/ui/icons.generated"

export type IconSvgOptions = Readonly<{
	size?: number | string
	className?: string
	/** Set on the `<svg>`, replacing a default of the same name (`aria-hidden`, `aria-label`). */
	attributes?: Readonly<Record<string, string>>
}>

const escapeAttribute = (value: string): string =>
	value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;")

const renderNode = (
	[tag, attributes, children]: IconNode,
	resolve: (value: string) => string | undefined,
	extra: Readonly<Record<string, string>>,
): string => {
	const own = attributes.flatMap(([name, value]): ReadonlyArray<readonly [string, string]> => {
		const resolved = resolve(value)
		return resolved === undefined || name in extra ? [] : [[name, resolved]]
	})
	const all = [...own, ...Object.entries(extra)]
	const attrs = all.map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`).join("")
	const inner = children.map((child) => renderNode(child, resolve, {})).join("")
	return `<${tag}${attrs}>${inner}</${tag}>`
}

/** A generated icon as SVG markup, the same tree the dashboard's `icon()` renders. */
export const iconSvg = (name: IconName, options: IconSvgOptions = {}): string => {
	const size = String(options.size ?? ICON_DEFAULT_SIZES[name] ?? 24)
	const resolve = (value: string): string | undefined => {
		if (value === ICON_CLASS_MARK)
			return options.className === undefined || options.className === "" ? undefined : options.className
		return value === ICON_SIZE_MARK ? size : value.replaceAll(ICON_ID_MARK, name)
	}
	return renderNode(ICON_TREES[name], resolve, options.attributes ?? {})
}
