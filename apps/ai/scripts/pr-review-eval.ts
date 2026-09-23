/**
 * How often the reviewer catches a bug that shipped, measured on this repository's own history.
 *
 *   bun run --cwd apps/ai review:eval mine [--since 2026-08-01] [--ref origin/main] [--limit 40]
 *   bun run --cwd apps/ai review:eval run [--model id] [--prompt-file p] [--cases id,id]
 *
 * `mine` walks `fix:` commits, blames the lines each one changed back to the squash-merged pull
 * request that wrote them, and prints candidates. A person keeps the real bugs in
 * `pr-review-eval/corpus.json`. `run` reviews every corpus pull request with `review:local` and
 * counts a case caught when a finding lands on a line the fix later changed. Unmatched findings are
 * not false positives by definition; read them in each run's `review.md`.
 */
import { spawnSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { classifyChangedFile } from "@/mcp/tools/pull-request"
import { reviewLocally } from "./pr-review-local"

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SCRIPT_DIR, "../../..")
const CORPUS = join(SCRIPT_DIR, "pr-review-eval", "corpus.json")
const REPOSITORY = "MapleTechLabs/maple"
/** Lines of slack between a finding and the fixed range: a finding on the call site above counts. */
const LINE_TOLERANCE = 3
const FIX_SUBJECT = /^(fix|hotfix)(\([^)]*\))?!?:/i
const SQUASH_PR = /\(#(\d+)\)\s*$/

interface Location {
	readonly path: string
	readonly lines: readonly [number, number]
}

interface EvalCase {
	readonly id: string
	readonly number: number
	readonly bug: string
	readonly fix: { readonly sha: string; readonly subject: string }
	readonly locations: ReadonlyArray<Location>
}

interface Finding {
	readonly path: string
	readonly line: number
	readonly endLine?: number
	readonly category?: string
	readonly severity: string
	readonly title: string
}

const git = (args: ReadonlyArray<string>): string => {
	const proc = spawnSync("git", args, { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
	if (proc.status !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr}`)
	return proc.stdout
}

const flags = (argv: ReadonlyArray<string>): Map<string, string> => {
	const out = new Map<string, string>()
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] ?? ""
		if (arg.startsWith("--")) {
			out.set(arg.slice(2), argv[i + 1] ?? "")
			i++
		}
	}
	return out
}

// Mining

/** The old-side line ranges a commit changed, per file, for files a review would read. */
const changedOldRanges = (sha: string): Array<Location> => {
	const ranges: Array<Location> = []
	let path: string | undefined
	for (const line of git(["diff", "-U0", "--no-color", "--no-renames", `${sha}^`, sha]).split("\n")) {
		if (line.startsWith("--- ")) {
			path = line === "--- /dev/null" ? undefined : line.slice("--- a/".length)
			continue
		}
		const hunk = /^@@ -(\d+)(?:,(\d+))? \+/.exec(line)
		if (hunk === null || path === undefined) continue
		const start = Number(hunk[1])
		const count = hunk[2] === undefined ? 1 : Number(hunk[2])
		if (count === 0) continue
		const kind = classifyChangedFile(path)
		// A snapshot or a dependency patch changes with the bug's fix but never contained the bug.
		if (path.includes("__sql_baseline__") || path.endsWith(".patch")) continue
		if (kind === "source" || kind === "infra" || kind === "config")
			ranges.push({ path, lines: [start, start + count - 1] })
	}
	return ranges
}

/** Which commit wrote each line of a range, with the line's number and path in that commit. */
const blameRange = (sha: string, range: Location) => {
	const out: Array<{ commit: string; path: string; line: number }> = []
	const porcelain = git([
		"blame",
		"--porcelain",
		"-L",
		`${range.lines[0]},${range.lines[1]}`,
		`${sha}^`,
		"--",
		range.path,
	])
	const filenames = new Map<string, string>()
	let current: { commit: string; line: number } | undefined
	for (const line of porcelain.split("\n")) {
		const header = /^([0-9a-f]{40}) (\d+) \d+/.exec(line)
		if (header !== null) {
			current = { commit: header[1] ?? "", line: Number(header[2]) }
			continue
		}
		if (line.startsWith("filename ") && current !== undefined)
			filenames.set(current.commit, line.slice(9))
		if (line.startsWith("\t") && current !== undefined)
			out.push({ ...current, path: filenames.get(current.commit) ?? range.path })
	}
	return out
}

/** Contiguous lines per path, so one blamed hunk is one location. */
const mergeLines = (lines: ReadonlyArray<{ path: string; line: number }>): Array<Location> => {
	const byPath = new Map<string, Array<number>>()
	for (const { path, line } of lines) byPath.set(path, [...(byPath.get(path) ?? []), line])
	return [...byPath.entries()].flatMap(([path, numbers]) => {
		const sorted = [...new Set(numbers)].sort((a, b) => a - b)
		const merged: Array<Location> = []
		for (const n of sorted) {
			const last = merged.at(-1)
			if (last !== undefined && n <= last.lines[1] + 1)
				merged[merged.length - 1] = { path, lines: [last.lines[0], n] }
			else merged.push({ path, lines: [n, n] })
		}
		return merged
	})
}

const mine = (argv: ReadonlyArray<string>) => {
	const opts = flags(argv)
	const ref = opts.get("ref") ?? "origin/main"
	const since = opts.get("since") ?? "2026-08-01"
	const limit = Number(opts.get("limit") ?? "40")
	const subjects = new Map<string, string>()
	const subjectOf = (sha: string) => {
		const known = subjects.get(sha)
		if (known !== undefined) return known
		const subject = git(["show", "-s", "--format=%s", sha]).trim()
		subjects.set(sha, subject)
		return subject
	}
	const candidates: Array<EvalCase> = []
	const log = git(["log", "--first-parent", ref, `--since=${since}`, "--format=%H%x09%s"])
	for (const entry of log.split("\n")) {
		if (candidates.length >= limit) break
		const [sha = "", subject = ""] = entry.split("\t")
		if (!FIX_SUBJECT.test(subject)) continue
		const blamed = changedOldRanges(sha).flatMap((range) => blameRange(sha, range))
		const byPr = new Map<number, Array<{ path: string; line: number }>>()
		for (const { commit, path, line } of blamed) {
			const pr = SQUASH_PR.exec(subjectOf(commit))
			if (pr === null || commit === sha) continue
			const number = Number(pr[1])
			byPr.set(number, [...(byPr.get(number) ?? []), { path, line }])
		}
		// The pull request that wrote most of the fixed lines is the one that shipped the bug.
		const top = [...byPr.entries()].sort((a, b) => b[1].length - a[1].length)[0]
		if (top === undefined) continue
		const [number, lines] = top
		candidates.push({
			id: `pr${number}-fix${sha.slice(0, 7)}`,
			number,
			bug: "",
			fix: { sha, subject },
			locations: mergeLines(lines),
		})
		console.error(`#${number} <- ${sha.slice(0, 10)} ${subject}`)
	}
	console.log(JSON.stringify({ cases: candidates }, null, "\t"))
}

// Running

const overlaps = (finding: Finding, location: Location) =>
	finding.path === location.path &&
	finding.line - LINE_TOLERANCE <= location.lines[1] &&
	(finding.endLine ?? finding.line) + LINE_TOLERANCE >= location.lines[0]

const runEval = async (argv: ReadonlyArray<string>) => {
	const opts = flags(argv)
	const wanted = opts.get("cases")?.split(",")
	const corpus: { cases: ReadonlyArray<EvalCase> } = JSON.parse(readFileSync(CORPUS, "utf8"))
	const cases = corpus.cases.filter((c) => wanted === undefined || wanted.includes(c.id))
	const model = opts.get("model")
	const label = `${new Date().toISOString().replace(/[:.]/g, "-")}${model === undefined ? "" : `__${model.replace(/[^\w.-]+/g, "_")}`}`
	const out = join(SCRIPT_DIR, ".pr-review-evals", label)
	mkdirSync(out, { recursive: true })

	const results: Array<Record<string, unknown>> = []
	for (const evalCase of cases) {
		console.log(`\n=== ${evalCase.id}: ${evalCase.bug}`)
		const dir = await reviewLocally([
			REPOSITORY,
			String(evalCase.number),
			"--repo-dir",
			REPO_ROOT,
			"--out",
			join(out, "runs"),
			...(model === undefined ? [] : ["--model", model]),
			...(opts.has("prompt-file") ? ["--prompt-file", opts.get("prompt-file") ?? ""] : []),
		])
		if (dir === undefined) {
			results.push({ id: evalCase.id, submitted: false })
			continue
		}
		const report = JSON.parse(readFileSync(join(dir, "report.json"), "utf8"))
		const findings: ReadonlyArray<Finding> = report.report.findings
		const hits = findings.filter((finding) => evalCase.locations.some((loc) => overlaps(finding, loc)))
		results.push({
			id: evalCase.id,
			submitted: true,
			caught: hits.length > 0,
			hits: hits.map((f) => `${f.path}:${f.line} ${f.severity}/${f.category ?? "?"} ${f.title}`),
			findings: findings.length,
			unmatched: findings.length - hits.length,
			calls: report.tools.length,
			inputTokens: report.usage?.input ?? null,
			seconds: Math.round(report.durationMs / 1000),
			run: dir,
		})
	}

	const submitted = results.filter((r) => r.submitted)
	const caught = submitted.filter((r) => r.caught).length
	const sum = (key: string) => submitted.reduce((total, r) => total + (Number(r[key]) || 0), 0)
	const summary = [
		`# review:eval ${label}`,
		"",
		`Model: ${model ?? "(default)"} · prompt: ${opts.get("prompt-file") ?? "(committed)"}`,
		"",
		`**Caught ${caught} of ${cases.length}** (${submitted.length} submitted) · ${sum("findings")} findings, ${sum("unmatched")} unmatched · ${sum("calls")} calls · ${sum("inputTokens")} input tokens · ${sum("seconds")} s`,
		"",
		"| Case | Caught | Findings | Unmatched | Calls | Seconds |",
		"| --- | --- | --- | --- | --- | --- |",
		...results.map((r) =>
			r.submitted
				? `| ${r.id} | ${r.caught ? "yes" : "no"} | ${r.findings} | ${r.unmatched} | ${r.calls} | ${r.seconds} |`
				: `| ${r.id} | no review submitted | | | | |`,
		),
	].join("\n")
	writeFileSync(join(out, "summary.md"), summary)
	writeFileSync(join(out, "results.json"), JSON.stringify(results, null, "\t"))
	console.log(`\n${summary}\n\nWritten to ${out}`)
}

const [command, ...rest] = process.argv.slice(2)
if (command === "mine") mine(rest)
else if (command === "run") await runEval(rest)
else {
	console.error(
		"usage: review:eval mine [--since date] [--ref ref] [--limit n] | run [--model id] [--prompt-file p] [--cases a,b]",
	)
	process.exit(2)
}
