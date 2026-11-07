#!/usr/bin/env bun
/**
 * Raw colours in the dashboard's CSS. oxlint reads no CSS, so `maple/no-raw-color` never sees a hex,
 * `rgb()`, `oklch()` or named colour in a stylesheet. This fails on any outside the token files
 * (packages/ui/src/styles/tokens.css, syntax-tokens.css) and vendored files (first line
 * `/* Vendored verbatim`). Masks, and custom properties a mask reads, may use opaque black.
 */
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { Array as Arr, Schema, String as Str } from "effect"

const root = join(import.meta.dir, "..")
const DIRS = ["apps/web/src", "apps/local-ui/src", "packages/views/src", "packages/ui/src"]
const TOKEN_FILES = new Set(["packages/ui/src/styles/tokens.css", "packages/ui/src/styles/syntax-tokens.css"])

const MASK_PROPERTIES = new Set(["mask", "mask-image", "-webkit-mask", "-webkit-mask-image"])
const MASK_BLACK = /^(?:#000(?:000)?|black|rgba?\(\s*0\s+0\s+0\s*\/[^)]*\))$/i

const NAMED = "black|white|red|green|blue|gray|grey|yellow|orange|purple|pink"
/** A hex colour, a colour function call, or a named colour as a whole word. */
const COLOR = new RegExp(
	`#[0-9a-f]{3,8}\\b|\\b(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb)\\([^()]*\\)|(?<![\\w-])(?:${NAMED})(?![\\w-])`,
	"gi",
)

const Violation = Schema.Struct({ file: Schema.String, line: Schema.Number, value: Schema.String })
type Violation = typeof Violation.Type

function* walk(dir: string): Generator<string> {
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry)
		if (statSync(path).isDirectory()) yield* walk(path)
		else if (Str.endsWith(".css")(path)) yield path
	}
}

/** Blank out comments, keeping newlines so offsets still map to lines. */
const stripComments = (source: string): string =>
	source.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "))

const BOUNDARY = /[;{}]/

/** The declaration around `index`, or undefined when the match sits in a selector or at-rule prelude. */
const declarationAt = (source: string, index: number): { property: string } | undefined => {
	let start = index
	while (start > 0 && !BOUNDARY.test(source[start - 1] ?? "")) start--
	let end = index
	while (end < source.length && !BOUNDARY.test(source[end] ?? "")) end++
	if (source[end] === "{") return undefined
	const segment = source.slice(start, index)
	const colon = segment.indexOf(":")
	if (colon === -1) return undefined
	return { property: Str.toLowerCase(Str.trim(segment.slice(0, colon))) }
}

/** Mask properties plus the custom properties a mask declaration reads (`mask-image: var(--fade)`). */
const maskPropertiesOf = (source: string): ReadonlySet<string> => {
	const declarations = source.matchAll(/(?:^|[;{\s])((?:-webkit-)?mask(?:-image)?)\s*:([^;{}]*)/g)
	const referenced = Arr.flatMap([...declarations], (match) =>
		Arr.map([...(match[2] ?? "").matchAll(/var\(\s*(--[\w-]+)/g)], (ref) => ref[1] ?? ""),
	)
	return new Set([...MASK_PROPERTIES, ...referenced])
}

const scan = (file: string): ReadonlyArray<Violation> => {
	const raw = readFileSync(file, "utf8")
	const path = relative(root, file)
	if (TOKEN_FILES.has(path) || Str.startsWith("/* Vendored verbatim")(raw)) return []
	const source = stripComments(raw)
	const maskProperties = maskPropertiesOf(source)
	return Arr.flatMap([...source.matchAll(COLOR)], (match) => {
		const declaration = declarationAt(source, match.index)
		if (declaration === undefined) return []
		if (maskProperties.has(declaration.property) && MASK_BLACK.test(match[0])) return []
		const line = source.slice(0, match.index).split("\n").length
		return [Violation.make({ file: path, line, value: match[0] })]
	})
}

const violations = Arr.flatMap(DIRS, (dir) => Arr.flatMap([...walk(join(root, dir))], scan))

if (violations.length > 0) {
	console.error(
		"Raw colours in CSS. Use a token from packages/ui/src/styles/tokens.css (`var(--color-...)`):\n",
	)
	for (const { file, line, value } of violations) console.error(`  ${file}:${line}  ${value}`)
	console.error(`\n${violations.length} raw colour(s).`)
	process.exit(1)
}
console.log("No raw colours in dashboard CSS.")
