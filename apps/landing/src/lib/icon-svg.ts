import {
	ICON_CLASS_MARK,
	ICON_DEFAULT_SIZES,
	ICON_ID_MARK,
	ICON_SIZE_MARK,
	ICON_TREES,
	type IconName,
	type IconNode,
} from "@maple/views/ui/icons.generated"
import { Array as Arr, Record as Rec, String as Str } from "effect"

export type IconSvgOptions = Readonly<{
	size?: number | string
	className?: string
	/** Set on the `<svg>`, replacing a default of the same name (`aria-hidden`, `aria-label`). */
	attributes?: Readonly<Record<string, string>>
}>

const escapeAttribute = (value: string): string =>
	Str.replaceAll("<", "&lt;")(Str.replaceAll('"', "&quot;")(Str.replaceAll("&", "&amp;")(value)))

const renderNode = (
	[tag, attributes, children]: IconNode,
	resolve: (value: string) => string | undefined,
	extra: Readonly<Record<string, string>>,
): string => {
	const own = Arr.flatMap(attributes, ([name, value]): ReadonlyArray<readonly [string, string]> => {
		const resolved = resolve(value)
		return resolved === undefined || name in extra ? [] : [[name, resolved]]
	})
	const all = [...own, ...Rec.toEntries(extra)]
	const attrs = Arr.join(
		Arr.map(all, ([name, value]) => ` ${name}="${escapeAttribute(value)}"`),
		"",
	)
	const inner = Arr.join(
		Arr.map(children, (child) => renderNode(child, resolve, {})),
		"",
	)
	return `<${tag}${attrs}>${inner}</${tag}>`
}

/** A generated icon as SVG markup, the same tree the dashboard's `icon()` renders. */
export const iconSvg = (name: IconName, options: IconSvgOptions = {}): string => {
	const size = String(options.size ?? ICON_DEFAULT_SIZES[name] ?? 24)
	const resolve = (value: string): string | undefined => {
		if (value === ICON_CLASS_MARK)
			return options.className === undefined || options.className === "" ? undefined : options.className
		return value === ICON_SIZE_MARK ? size : Str.replaceAll(ICON_ID_MARK, name)(value)
	}
	return renderNode(ICON_TREES[name], resolve, options.attributes ?? {})
}
