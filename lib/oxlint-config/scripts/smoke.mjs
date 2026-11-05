// Lints a throwaway project that extends every preset and checks each planted violation is
// reported, and that the clean file stays clean. Run from any checkout with oxlint installed.
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

const pkg = dirname(dirname(fileURLToPath(import.meta.url)))
// The fixture imports effect, so it needs a node_modules with both oxlint and effect in it.
const findNodeModules = (dir) => {
	const candidate = join(dir, "node_modules")
	if (existsSync(join(candidate, "oxlint")) && existsSync(join(candidate, "effect"))) return candidate
	const parent = dirname(dir)
	if (parent === dir) throw new Error(`no node_modules with oxlint and effect above ${pkg}`)
	return findNodeModules(parent)
}
const nodeModules = findNodeModules(pkg)

const files = {
	"tsconfig.json": JSON.stringify({
		compilerOptions: {
			strict: true,
			module: "preserve",
			moduleResolution: "bundler",
			target: "es2022",
			jsx: "react-jsx",
			noEmit: true,
			skipLibCheck: true,
		},
		include: ["src"],
	}),
	"src/clean.ts": `import { Effect } from "effect"
export const double = (n: number) => Effect.succeed(n * 2)
`,
	"src/effect.ts": `import { Effect } from "effect"
export const parse = (s: string) => {
	try { return Date.parse(s) } catch { return 0 }
}
export const boom = Effect.die("no")
export const loose: Record<string, any> = {}
export const count = (n: number) => (n ? "some" : "none")
export const later = () => { Promise.resolve(1) }
export const log = Effect.sync(() => console.log("hi"))
`,
	"src/slop.ts": `export const widen = (x: string) => x as unknown as number
`,
	"src/view.tsx": `import { useEffect } from "react"
export const View = () => { useEffect(() => {}, []); return null }
`,
	"src/math.test.ts": `import { expect, it } from "vitest"
it("adds", () => { expect(1).toBeDefined() })
it("nothing", () => { const x = 1 + 1; void x })
`,
}

const expected = {
	"src/effect.ts": [
		"effect-strict(no-try-catch)",
		"effect-strict(no-date-parse)",
		"effect-strict(no-effect-die)",
		"effect-strict(no-record-string-any)",
		"typescript-eslint(strict-boolean-expressions)",
		"typescript-eslint(no-floating-promises)",
		"effecttsgo(global-console-in-effect)",
	],
	"src/slop.ts": ["anti-slop(no-chained-type-assertions)"],
	"src/view.tsx": ["effect-strict(no-react-use-effect)"],
	"src/math.test.ts": ["test-slop(no-weak-only-assertions)", "vitest(expect-expect)"],
	"src/clean.ts": [],
}

const dir = realpathSync(mkdtempSync(join(tmpdir(), "oxlint-config-smoke-")))
for (const [path, content] of Object.entries(files)) {
	mkdirSync(dirname(join(dir, path)), { recursive: true })
	writeFileSync(join(dir, path), content)
}
symlinkSync(nodeModules, join(dir, "node_modules"))
const preset = (name) => `./${relative(dir, join(pkg, name))}`
writeFileSync(
	join(dir, ".oxlintrc.json"),
	JSON.stringify({ extends: ["base.json", "effect.json", "tests.json", "react.json"].map(preset) }),
)

let out
try {
	out = execFileSync(
		join(nodeModules, ".bin/oxlint"),
		["-c", ".oxlintrc.json", "--format", "json", "src"],
		{
			cwd: dir,
			encoding: "utf8",
		},
	)
} catch (error) {
	out = error.stdout || error.stderr
}
if (!process.env.KEEP) rmSync(dir, { recursive: true, force: true })
if (process.env.KEEP) console.log(dir)

const report = JSON.parse(out)
const seen = {}
for (const d of report.diagnostics) {
	const rule = d.code.replace(/^typescript\(/, "typescript-eslint(")
	;(seen[d.filename] ??= new Set()).add(rule)
}
let failed = 0
for (const [file, rules] of Object.entries(expected)) {
	const got = seen[file] ?? new Set()
	for (const rule of rules) {
		if (got.has(rule)) {
			console.log(`ok    ${file}  ${rule}`)
		} else {
			failed += 1
			console.log(`MISS  ${file}  ${rule}`)
		}
	}
	if (rules.length === 0 && got.size > 0) {
		failed += 1
		console.log(`DIRTY ${file}  ${[...got].join(", ")}`)
	}
	if (rules.length === 0 && got.size === 0) console.log(`ok    ${file}  clean`)
}
if (failed > 0) {
	console.log(
		"\nall diagnostics:",
		JSON.stringify(seen, (_, v) => (v instanceof Set ? [...v] : v), 2),
	)
	process.exit(1)
}
