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
 *
 *   bun run --cwd apps/ai review:checklist MapleTechLabs/maple 1036 --snapshot [--repo-dir ../..]
 *
 * `--snapshot` writes the pull request as a corpus case for `merge-checklist.corpus.test.ts`
 * instead: its files, and each name's verdict from a whole-word `git grep` at the BASE commit of a
 * local clone (default: this checkout), since the default branch of a merged pull request already
 * holds its names. The case is written unlabelled; label it before the test accepts it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { renderBeforeMerge } from "@maple/backend/services/pr-review/PrReviewService"
import {
	buildChecklist,
	detectMergeSteps,
	type NameVerdict,
	searchVerdict,
} from "@maple/backend/services/pr-review/merge-checklist"
import {
	checklistKeys,
	MergeChecklistCase,
	MergeChecklistLabelFile,
	minimizeFiles,
} from "@maple/backend/services/pr-review/merge-checklist-corpus"
import { Option, Schema } from "effect"
import { fetchPullRequest, nameAtBase, run } from "./pr-review-local"

const CORPUS_DIR = fileURLToPath(
	new URL(
		"../../../packages/backend/src/services/pr-review/__fixtures__/merge-checklist/",
		import.meta.url,
	),
)
const encodeCase = Schema.encodeSync(MergeChecklistCase)
const LABELS = join(CORPUS_DIR, "labels.json")
const decodeLabels = Schema.decodeUnknownOption(Schema.fromJsonString(MergeChecklistLabelFile))

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
	if (argv.includes("--snapshot")) return snapshot(argv, owner, repo, number, pr, files)
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

const snapshot = (
	argv: ReadonlyArray<string>,
	owner: string,
	repo: string,
	number: number,
	pr: ReturnType<typeof fetchPullRequest>["pr"],
	files: ReturnType<typeof fetchPullRequest>["files"],
) => {
	const flag = argv.indexOf("--repo-dir")
	const dir = resolve(
		flag === -1 ? fileURLToPath(new URL("../../..", import.meta.url)) : (argv[flag + 1] ?? "."),
	)
	if (!run(["git", "cat-file", "-e", `${pr.base.sha}^{commit}`], dir).ok) {
		console.error(`${pr.base.sha} is not in ${dir}; fetch it or pass --repo-dir`)
		return process.exit(1)
	}
	const minimized = minimizeFiles(files)
	const detected = detectMergeSteps(files)
	const verdicts = Object.fromEntries(
		detected.names.map(({ name }) => [name, nameAtBase(dir, pr.base.sha, name)] as const),
	)
	// The cut patches must decide exactly what the full ones do, or the case measures nothing.
	const full = checklistKeys({ files, verdicts })
	const cut = checklistKeys({ files: minimized, verdicts })
	if (full.join("\n") !== cut.join("\n")) {
		console.error(
			`Cut patches change the checklist:\n  full: ${full.join(", ")}\n  cut:  ${cut.join(", ")}`,
		)
		return process.exit(1)
	}
	const id = `${repo}-${number}`
	const path = join(CORPUS_DIR, `${id}.json`)
	const labelled = existsSync(LABELS)
		? Option.match(decodeLabels(readFileSync(LABELS, "utf8")), {
				onNone: () => false,
				onSome: (labels) => id in labels,
			})
		: false
	const item: MergeChecklistCase = {
		id,
		repo: `${owner}/${repo}`,
		number,
		title: pr.title ?? "",
		baseSha: pr.base.sha,
		headSha: pr.head.sha,
		files: minimized,
		verdicts,
	}
	if (!existsSync(CORPUS_DIR)) mkdirSync(CORPUS_DIR, { recursive: true })
	// Generated, so compact: the labels are the file people read and edit.
	writeFileSync(path, `${JSON.stringify(encodeCase(item))}\n`)
	console.log(`${path}\n${pr.html_url} · ${pr.title}`)
	for (const [name, verdict] of Object.entries(verdicts)) console.log(`  ${verdict.padEnd(10)} ${name}`)
	console.log(`Detectors list: ${full.length === 0 ? "nothing" : full.join(", ")}`)
	if (!labelled)
		console.log(
			`Label it in ${LABELS}: "${id}": { "expected": [...], "acceptable": [...], "note": "..." }`,
		)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	checklistLocally(process.argv.slice(2))
}
