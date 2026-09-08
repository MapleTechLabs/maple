import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"

// The package's tested Markdown remains the source of truth, including in npm releases.
const source = new URL("../../../lib/effect-clickhouse/docs/", import.meta.url)
const output = new URL("../content/", import.meta.url)
const repository = "https://github.com/MapleTechLabs/maple/blob/main/lib/effect-clickhouse/"
const pages = [
	"index",
	"getting-started",
	"recipes",
	"tables-and-types",
	"queries",
	"expressions",
	"joins-and-subqueries",
	"unions-and-ctes",
	"params-and-compilation",
	"decoding-results",
	"running-queries",
	"benchmarking",
	"benchmark-agent",
	"tenant-scoping",
	"extending",
	"reference",
	"troubleshooting",
]

await rm(output, { recursive: true, force: true })
await mkdir(output, { recursive: true })
for (const file of await readdir(source)) {
	if (!file.endsWith(".md")) continue
	const markdown = await readFile(new URL(file, source), "utf8")
	const title = markdown.match(/^# (.+)$/m)?.[1] ?? file.replace(/\.md$/, "")
	const slug = file === "README.md" ? "index" : file.replace(/\.md$/, "")
	const body = markdown.replace(/^# .+\n+/, "").replace(/\]\((\.\.?\/[^)]+)\)/g, (_match, href: string) => {
		if (href.startsWith("../")) return `](${repository}${href.slice(3)})`
		return `](${href
			.replace(/^\.\//, "/")
			.replace(/\.md(?=#|$)/, "")
			.replace(/^\/README(?=#|$)/, "/")})`
	})
	await writeFile(new URL(`${slug}.md`, output), `---\ntitle: ${JSON.stringify(title)}\n---\n\n${body}`)
}
await writeFile(new URL("meta.json", output), JSON.stringify({ pages }, null, 2))
console.log(`Prepared ${pages.length} documentation pages`)
