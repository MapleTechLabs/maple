/**
 * The "before merge" checklist for a real pull request, with every decision behind it, and no model.
 *
 *   bun run --cwd apps/ai review:checklist MapleTechLabs/maple 1081
 *   bun run --cwd apps/ai review:checklist https://github.com/octo/shop/pull/12 --no-search
 *
 * Runs the service's own steps (`detectMergeSteps`, `searchVerdict`, `buildChecklist`) over the
 * pull request's files through your `gh` login, prints each name's verdict, then the section as the
 * review comment renders it. `--no-search` skips the default-branch searches (every name is then
 * unverified); GitHub allows about 10 code searches a minute, and a refused one reads as unverified.
 */
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { renderBeforeMerge } from "@maple/backend/services/pr-review/PrReviewService"
import {
	buildChecklist,
	detectMergeSteps,
	type NameVerdict,
	searchVerdict,
} from "@maple/backend/services/pr-review/merge-checklist"
import { Option, Schema } from "effect"
import { fetchPullRequest, run } from "./pr-review-local"

const MAX_SEARCHES = 10

const SearchResult = Schema.Struct({
	items: Schema.Array(
		Schema.Struct({
			text_matches: Schema.optionalKey(Schema.Array(Schema.Struct({ fragment: Schema.String }))),
		}),
	),
})
const decodeSearch = Schema.decodeUnknownOption(Schema.fromJsonString(SearchResult))

/** One name's verdict from GitHub code search, the way the service's provider asks for it. */
const verdictFor = (owner: string, repo: string, name: string): NameVerdict => {
	const result = run([
		"gh",
		"api",
		"-X",
		"GET",
		"search/code",
		"-H",
		"Accept: application/vnd.github.text-match+json",
		"-f",
		`q="${name}" repo:${owner}/${repo}`,
		"-f",
		"per_page=5",
	])
	if (!result.ok) return "unverified"
	return Option.match(decodeSearch(result.stdout), {
		onNone: () => "unverified",
		onSome: ({ items }) =>
			searchVerdict(
				name,
				items.map((item) => ({ snippets: (item.text_matches ?? []).map((match) => match.fragment) })),
			),
	})
}

const usage = (): never => {
	console.error("usage: review:checklist <owner/repo> <number> | <pull request url> [--no-search]")
	return process.exit(2)
}

export const checklistLocally = (argv: ReadonlyArray<string>) => {
	const positional = argv.filter((arg) => !arg.startsWith("--"))
	const search = !argv.includes("--no-search")
	const fromUrl = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(positional[0] ?? "")
	const [owner = "", repo = ""] = fromUrl ? [fromUrl[1], fromUrl[2]] : (positional[0] ?? "").split("/")
	const number = Number(fromUrl ? fromUrl[3] : positional[1])
	if (!owner || !repo || !Number.isInteger(number) || number < 1) usage()

	const { pr, files } = fetchPullRequest({ owner, repo, number })
	const detected = detectMergeSteps(files)
	const verdicts = new Map<string, NameVerdict>(
		search
			? detected.names.slice(0, MAX_SEARCHES).map(({ name }) => [name, verdictFor(owner, repo, name)])
			: [],
	)
	const checklist = buildChecklist({ detected, verdicts, reviewer: [], isIgnored: () => false })

	console.log(`${pr.html_url} · ${files.length} files\n`)
	console.log(`Names the diff starts reading (${detected.names.length}):`)
	for (const candidate of detected.names) {
		const verdict = verdicts.get(candidate.name) ?? "unverified"
		console.log(
			`  ${verdict.padEnd(10)} ${candidate.kind.padEnd(6)} ${candidate.name}  ${candidate.path}:${candidate.line}${candidate.ci ? "  (CI)" : ""}`,
		)
	}
	console.log(`\nFile steps (${detected.steps.length}):`)
	for (const step of detected.steps) console.log(`  ${step.kind.padEnd(10)} ${step.path}`)
	if (checklist.trace.cut > 0) console.log(`\n${checklist.trace.cut} steps past the cap were cut.`)
	const section = renderBeforeMerge(
		checklist.steps,
		(path, line) =>
			`https://github.com/${owner}/${repo}/blob/${pr.head.sha}/${path}${line === undefined ? "" : `#L${line}`}`,
	)
	console.log(`\n${section.length === 0 ? "Nothing before merge." : section.join("\n")}`)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	checklistLocally(process.argv.slice(2))
}
