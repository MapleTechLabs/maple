/// <reference types="@types/bun" />
/**
 * Flattens Tailwind classes into inline `style` attributes, the one CSS form
 * every email client honours.
 *
 * Tailwind compiles the theme `inline`, so utilities carry literal values
 * instead of `var(--spacing)` references. What it still leaves behind is
 * resolved here: `--tw-*` custom properties are substituted per element,
 * `calc()` products are folded, and logical properties (`padding-inline`) are
 * spelled out as the physical pairs older clients understand.
 *
 * Input is the markup Foldkit's static render emits: double-quoted attributes
 * with `"` always escaped, so a start-tag regex is exact rather than a guess.
 * Anything the inliner cannot resolve throws instead of shipping a raw
 * `var()` or an unknown class to a recipient.
 */
import { compile } from "tailwindcss"
import { dirname, join } from "node:path"
import { Array as Arr, String as Str } from "effect"

const TAILWIND_ROOT = dirname(Bun.resolveSync("tailwindcss/package.json", import.meta.dir))

/**
 * The Maple palette plus the utilities layer. Preflight is deliberately not
 * imported: it would stamp box-sizing/margin/padding onto every element, which
 * no email client needs. The cost is that `border-*` utilities carry no
 * border-style, so every border also names `border-solid` (or sets
 * `border-bottom` inline).
 */
const STYLESHEET = `
@import "tailwindcss/theme.css" layer(theme) theme(inline);
@import "tailwindcss/utilities.css" layer(utilities);
@theme inline {
	--color-maple-bg: #141210;
	--color-maple-surface: #1e1b18;
	--color-maple-card: #262320;
	--color-maple-border: #3a342e;
	--color-maple-border-subtle: #302b26;
	--color-maple-fg: #e8dfd3;
	--color-maple-fg-muted: #8a7f72;
	--color-maple-fg-dim: #5c554c;
	--color-maple-orange: #e8872a;
	--color-maple-red: #e85d4a;
	--font-mono: SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace;

	/*
	 * Tailwind ships these as ratios (20/14, 16/12, 24/16). A ratio written
	 * with fewer digits than the exact fraction computes 19.99998px instead of
	 * 20px, and Chrome rounds that line box down: the text sits a pixel high.
	 * Pinning px keeps the arithmetic exact.
	 */
	--text-xs--line-height: 16px;
	--text-sm--line-height: 20px;
	--text-base--line-height: 24px;
}
`

type Declarations = ReadonlyArray<readonly [property: string, value: string]>

interface Rule {
	/** Position in the stylesheet: equal-specificity rules cascade in this order. */
	readonly order: number
	readonly declarations: Declarations
}

interface Stylesheet {
	readonly rules: ReadonlyMap<string, Rule>
	/** `@property` initial values, the fallback for an unset `--tw-*`. */
	readonly initialValues: ReadonlyMap<string, string>
}

/**
 * Properties older clients only know by another name: logical pairs become
 * physical ones, and Outlook reads `text-decoration`, not its longhand.
 */
const LEGACY = new Map([
	["padding-inline", ["padding-left", "padding-right"]],
	["padding-block", ["padding-top", "padding-bottom"]],
	["margin-inline", ["margin-left", "margin-right"]],
	["margin-block", ["margin-top", "margin-bottom"]],
	["text-decoration-line", ["text-decoration"]],
])

/** Returns the body of the block opened at `open` (the index of its `{`). */
function blockBody(css: string, open: number): { body: string } {
	let depth = 0
	for (let index = open; index < css.length; index++) {
		if (css[index] === "{") depth++
		else if (css[index] === "}" && --depth === 0) return { body: Str.slice(open + 1, index)(css) }
	}
	throw new Error("Unbalanced braces in compiled Tailwind CSS")
}

function parseDeclarations(body: string): Declarations {
	return Arr.map(
		Arr.filter(
			Arr.map(Str.split(";")(body), (declaration) => Str.trim(declaration)),
			(declaration) => declaration !== "",
		),
		(declaration) => {
			const colon = declaration.indexOf(":")
			return [
				Str.trim(Str.slice(0, colon)(declaration)),
				Str.trim(Str.slice(colon + 1)(declaration)),
			] as const
		},
	)
}

/** `.py-2\.5` → `py-2.5`. */
function unescapeSelector(selector: string): string {
	return Str.replace(/\\(.)/g, "$1")(Str.slice(1)(selector))
}

function parseStylesheet(css: string): Stylesheet {
	const rules = new Map<string, Rule>()
	const initialValues = new Map<string, string>()

	// A unit with no classes compiles to a bare `@layer utilities;` statement.
	const layer = /@layer utilities\s*\{/.exec(css)
	if (layer !== null) {
		const { body } = blockBody(css, layer.index + layer[0].length - 1)
		for (const match of body.matchAll(/(\.[^{\s]+)\s*\{([^{}]*)\}/g)) {
			rules.set(unescapeSelector(match[1] ?? ""), {
				order: rules.size,
				declarations: parseDeclarations(match[2] ?? ""),
			})
		}
	}
	for (const match of css.matchAll(/@property\s+(--[\w-]+)\s*\{([^{}]*)\}/g)) {
		const initial = parseDeclarations(match[2] ?? "").find(([property]) => property === "initial-value")
		if (initial !== undefined) initialValues.set(match[1] ?? "", initial[1])
	}
	return { rules, initialValues }
}

/** Folds `calc(0.25rem * 3)` and `calc(1 / 2 * 100%)` into a literal. */
function foldCalc(value: string): string {
	return value.replace(/calc\(([^()]*)\)/g, (expression, inner: string) => {
		const terms = Str.split(/\s*([*/])\s*/)(Str.trim(inner))
		let unit = ""
		let result = Number.NaN
		for (let index = 0; index < terms.length; index += 2) {
			const match = /^(-?[\d.]+)([a-z%]*)$/.exec(terms[index] ?? "")
			if (match === null) throw new Error(`Cannot fold ${expression}`)
			if (match[2] !== "") {
				if (unit !== "") throw new Error(`Cannot fold ${expression}: two units`)
				unit = match[2] ?? ""
			}
			const operand = Number(match[1])
			result = index === 0 ? operand : terms[index - 1] === "*" ? result * operand : result / operand
		}
		const folded = Number(result.toFixed(6))
		return folded === 0 ? "0" : `${folded}${unit}`
	})
}

/** `0px` / `0rem` → `0`, the unitless zero email inliners have always emitted. */
const ZERO_LENGTH = /(^|[\s(,])0(?:px|rem|em)(?=$|[\s),])/g

function resolveVars(value: string, scope: ReadonlyMap<string, string>, sheet: Stylesheet): string {
	const resolved = value.replace(
		/var\((--[\w-]+)(?:,\s*([^()]*))?\)/g,
		(reference, name: string, fallback?: string) => {
			const replacement = scope.get(name) ?? fallback ?? sheet.initialValues.get(name)
			if (replacement === undefined || replacement === "initial") {
				throw new Error(`Unresolvable ${reference} in compiled Tailwind CSS`)
			}
			return replacement
		},
	)
	return resolved === value ? value : resolveVars(resolved, scope, sheet)
}

/**
 * The inline declarations for one element's classes, applied in stylesheet
 * order whatever order the classes are written in. Custom properties are
 * collected first because they resolve regardless of which class set them; a
 * property set twice keeps its last value, as the cascade would.
 */
function styleFor(classes: ReadonlyArray<string>, sheet: Stylesheet): string {
	const matched = Arr.map(
		Arr.map(classes, (name) => {
			const rule = sheet.rules.get(name)
			if (rule === undefined) throw new Error(`Unknown Tailwind class "${name}"`)
			return rule
		}).sort((left, right) => left.order - right.order),
		(rule) => rule.declarations,
	)
	const scope = new Map(Arr.filter(matched.flat(), ([property]) => Str.startsWith("--")(property)))

	const output = new Map<string, string>()
	for (const [property, raw] of matched.flat()) {
		if (Str.startsWith("--")(property)) continue
		const value = Str.replace(ZERO_LENGTH, "$10")(foldCalc(resolveVars(raw, scope, sheet)))
		for (const physical of LEGACY.get(property) ?? [property]) {
			output.delete(physical)
			output.set(physical, value)
		}
	}
	return Arr.join(
		Arr.map([...output], ([property, value]) => `${property}: ${value};`),
		" ",
	)
}

const START_TAG = /<([a-z][a-z0-9]*)((?:\s+[a-z-]+="[^"]*")*)(\s*\/?)>/g
const ATTRIBUTE = /\s+([a-z-]+)="([^"]*)"/g

/** Compiles the classes `html` uses and moves them into `style` attributes. */
export async function inlineTailwind(html: string): Promise<string> {
	const candidates = new Set<string>()
	for (const match of html.matchAll(/\sclass="([^"]*)"/g)) {
		for (const name of Str.split(/\s+/)(match[1] ?? "")) if (name !== "") candidates.add(name)
	}

	const compiler = await compile(STYLESHEET, {
		base: TAILWIND_ROOT,
		loadStylesheet: async (id: string) => {
			const path = join(TAILWIND_ROOT, Str.replace(/^tailwindcss\//, "")(id))
			return { path, base: dirname(path), content: await Bun.file(path).text() }
		},
	})
	const sheet = parseStylesheet(compiler.build([...candidates]))

	return html.replace(START_TAG, (tag, name: string, attributes: string, close: string) => {
		const parsed = Arr.map(
			[...attributes.matchAll(ATTRIBUTE)],
			(match) => [match[1] ?? "", match[2] ?? ""] as const,
		)
		const classes = parsed.find(([key]) => key === "class")?.[1]
		if (classes === undefined) return tag

		const inline = parsed.find(([key]) => key === "style")?.[1]
		const own = inline === undefined ? "" : `${Str.replace(/;?\s*$/, "")(inline)};`
		const style = Arr.join(
			Arr.filter([styleFor(Arr.filter(Str.split(/\s+/)(classes), Boolean), sheet), own], Boolean),
			" ",
		)
		const rest = Arr.join(
			Arr.map(
				Arr.filter(parsed, ([key]) => key !== "class" && key !== "style"),
				([key, value]) => ` ${key}="${value}"`,
			),
			"",
		)
		return `<${name}${rest} style="${style}"${close}>`
	})
}
