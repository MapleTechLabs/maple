import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"

// The package's tested Markdown remains the source of truth, including in npm releases.
// Use a reviewed local docs directory for documentation-only releases.
const source = process.env.EFFECT_CLICKHOUSE_DOCS_DIR
	? pathToFileURL(resolve(process.env.EFFECT_CLICKHOUSE_DOCS_DIR) + "/")
	: new URL("../docs/", import.meta.resolve("@maple-dev/effect-clickhouse"))
const output = new URL("../content/", import.meta.url)
const repository = "https://github.com/MapleTechLabs/effect-clickhouse/blob/v0.1.0/"
const sections = [
	{
		title: "Start here",
		pages: [
			{ slug: "index", icon: "house" },
			{ slug: "getting-started", icon: "compass" },
			{ slug: "recipes", icon: "grid" },
		],
	},
	{
		title: "Build queries",
		pages: [
			{ slug: "tables-and-types", icon: "grid" },
			{ slug: "queries", icon: "square-terminal" },
			{ slug: "expressions", icon: "pixel-brackets-curly" },
			{ slug: "joins-and-subqueries", icon: "branch-fork" },
			{ slug: "unions-and-ctes", icon: "layers" },
			{ slug: "tenant-scoping", icon: "shield" },
			{ slug: "extending", icon: "gear" },
		],
	},
	{
		title: "Run & decode",
		pages: [
			{ slug: "params-and-compilation", icon: "sliders" },
			{ slug: "running-queries", icon: "media-play" },
			{ slug: "decoding-results", icon: "download" },
		],
	},
	{
		title: "Benchmarking",
		pages: [
			{ slug: "benchmarking", icon: "chart-bar" },
			{ slug: "benchmark-agent", icon: "face-robot" },
		],
	},
	{
		title: "Reference",
		pages: [
			{ slug: "reference", icon: "cube" },
			{ slug: "troubleshooting", icon: "circle-question" },
			{ slug: "testing", icon: "shield" },
		],
	},
]
const pages = sections.flatMap((section) => [
	`---${section.title}---`,
	...section.pages.map((page) => page.slug),
])
const pageIcons = new Map(
	sections.flatMap((section) => section.pages.map((page) => [page.slug, page.icon] as const)),
)

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
	await writeFile(
		new URL(`${slug}.md`, output),
		`---\ntitle: ${JSON.stringify(title)}\nicon: ${JSON.stringify(pageIcons.get(slug) ?? "cube")}\n---\n\n${body}`,
	)
}
await writeFile(new URL("meta.json", output), JSON.stringify({ pages }, null, 2))
console.log(`Prepared ${pageIcons.size} documentation pages`)
