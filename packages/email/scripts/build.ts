/// <reference types="@types/bun" />
/**
 * Compiles the templates under `templates/` into the checked-in modules under
 * `src/generated/`.
 *
 * Foldkit renders each view to markup and every Tailwind class is flattened
 * into an inline `style` (`inline-tailwind.ts`). None of that can run on
 * Cloudflare Workers, so it happens here, once, at build time, and the result
 * is emitted as plain strings. At runtime `src/template.ts` only splices them.
 *
 * Two kinds of unit come out of a compile:
 *
 *   PAGE      — the whole document, with `[[token]]` values and `[[#slot]]`
 *               holes.
 *   FRAGMENTS — one entry per name in a template's `fragments` map, each
 *               rendered standalone with its own `[[token]]` placeholders.
 *
 * Usage: bun run --cwd packages/email build [--check]
 */
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { TEMPLATES, type Template } from "../templates"
import { documentShell, renderUnit } from "../templates/render"
import { inlineTailwind } from "./inline-tailwind"
import { Array as Arr, Record as Rec, String as Str } from "effect"

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/**
 * Adjacencies that must compile with no whitespace between them — Vue turns any
 * newline between siblings into a rendered space, and a space here would show
 * up as a gap in the email. Cheap insurance against a stray line break in a
 * component template.
 */
const TIGHT_JOINS: ReadonlyArray<string> = [
	"</span>[[message]]", // NEW badge → error message
	"</span>[[name]]", // status dot → service name
	"[[index]].", // rank number → period
	"[[count]]×", // occurrence count → multiplication sign
	"[[#barOk]][[#barErr]]", // stacked sparkline segments
]

async function renderPage(template: Template): Promise<string> {
	const body = await renderUnit({ context: "flow", view: template.page })
	return inlineTailwind(documentShell(body))
}

/**
 * Every unitless `line-height` must be a ratio that is exact in binary, or the
 * used line box drifts off the pixel grid. lightningcss truncates Tailwind's
 * 20/14 to `1.42857`, which computes 19.99998px on a 14px font — Chrome rounds
 * that box down and the text sits a pixel high. The ratios the templates
 * actually want (1, 1.25, 1.375) all fit in three decimals; anything longer is
 * a truncated fraction that should have been pinned to px in inline-tailwind.ts.
 */
function assertExactLineHeights(label: string, html: string): void {
	for (const match of html.matchAll(/line-height:\s*([\d.]+)\s*[;"]/g)) {
		const value = match[1]
		if (value === undefined || Str.includes("px")(value)) continue
		const decimals = Str.split(".")(value)[1]?.length ?? 0
		if (decimals > 3) {
			throw new Error(
				`${label}: line-height "${value}" is a truncated ratio — pin it to px in inline-tailwind.ts`,
			)
		}
	}
}

function assertTightJoins(label: string, html: string): void {
	for (const join of TIGHT_JOINS) {
		if (!Str.includes(join)(html)) continue
		const loosened = Str.replace(/(\]\]|>)(\[\[|[.×])/, "$1 $2")(join)
		if (Str.includes(loosened)(html)) {
			throw new Error(`${label}: whitespace crept into the tight join "${join}"`)
		}
	}
}

function asTemplateLiteral(value: string): string {
	return `\`${Str.replace(/\\|`|\$\{/g, "\\$&")(value)}\``
}

function emitModule(output: string, page: string, fragments: ReadonlyMap<string, string>): string {
	const entries = Arr.map(
		[...fragments.keys()].sort(),
		(name) => `\t${name}: ${asTemplateLiteral(fragments.get(name) ?? "")},`,
	)
	return `// GENERATED FILE — DO NOT EDIT.
//
// Compiled from packages/email/templates/ into ${output}.
// Regenerate with: bun run --cwd packages/email build

/** The full page, with \`[[token]]\` values and \`[[#slot]]\` fragment holes. */
export const PAGE = ${asTemplateLiteral(page)}

/** Repeated, optional and nested regions spliced into the page's slots. */
export const FRAGMENTS = {
${Arr.join(entries, "\n")}
} as const

export type FragmentName = keyof typeof FRAGMENTS
`
}

async function buildTemplate(template: Template): Promise<{ path: string; contents: string }> {
	const page = await renderPage(template)
	assertTightJoins(template.output, page)
	assertExactLineHeights(template.output, page)

	const fragments = new Map<string, string>()
	for (const [name, unit] of Rec.toEntries(template.fragments)) {
		const html = await inlineTailwind(await renderUnit(unit))
		assertTightJoins(`${template.output}#${name}`, html)
		assertExactLineHeights(`${template.output}#${name}`, html)
		fragments.set(name, html)
	}

	return {
		path: join(PACKAGE_ROOT, "src", "generated", template.output),
		contents: emitModule(template.output, page, fragments),
	}
}

const check = process.argv.includes("--check")
let drifted = false

for (const template of TEMPLATES) {
	const { path, contents } = await buildTemplate(template)
	if (check) {
		const current = await Bun.file(path)
			.text()
			.catch(() => "")
		if (current !== contents) {
			drifted = true
			console.error(`✗ ${path} is out of date — run: bun run --cwd packages/email build`)
		} else {
			console.log(`✓ ${path}`)
		}
		continue
	}
	await Bun.write(path, contents)
	console.log(`✓ ${path} (${contents.length} chars)`)
}

if (drifted) process.exit(1)
