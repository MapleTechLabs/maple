/**
 * Historical PR replay and human semantic grading. See pr-review-eval/README.md.
 * mine proposes unverified candidates; run compares prompt/model combinations;
 * score evaluates explicit grades, never location overlap.
 */
import { createHash } from "node:crypto"
import { Schema } from "effect"
import { PR_REVIEW_SYSTEM_PROMPT } from "@/chat/prompts"
import { PR_REVIEW_BUDGET } from "@/chat/budgets"
import { PR_REVIEW_WORKER_PROMPT } from "@/chat/review-fanout"
import { Grade, scoreGrade } from "./pr-review-eval/grading"
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
	/** `base..head` to review instead of the pull request, when the bug never reached its final head. */
	readonly range?: string
	readonly expected?: "present" | "absent"
	readonly split?: string
	readonly enabled?: boolean
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
		if (!arg.startsWith("--")) continue
		if (arg === "--allow-exec" || arg === "--dry-run") {
			out.set(arg.slice(2), "true")
			continue
		}
		const value = argv[i + 1]
		// A flag without an operand is an error, never a reason to swallow the next flag.
		if (value === undefined || value.startsWith("--")) {
			console.error(`${arg} needs a value`)
			process.exit(2)
		}
		out.set(arg.slice(2), value)
		i++
	}
	return out
}

const positiveInt = (raw: string | undefined, fallback: number, name: string): number => {
	if (raw === undefined) return fallback
	const n = Number(raw)
	if (!Number.isInteger(n) || n < 1) {
		console.error(`--${name} must be a positive integer; got ${raw}`)
		process.exit(2)
	}
	return n
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
		// An insertion-only hunk (a guard, a missing header) removed nothing; the line it follows is
		// what the buggy code left out, so that line is what gets blamed.
		if (count === 0 && start === 0) continue
		const kind = classifyChangedFile(path)
		// A snapshot or a dependency patch changes with the bug's fix but never contained the bug.
		if (path.includes("__sql_baseline__") || path.endsWith(".patch")) continue
		if (kind === "source" || kind === "infra" || kind === "config")
			ranges.push({ path, lines: count === 0 ? [start, start] : [start, start + count - 1] })
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
	const limit = positiveInt(opts.get("limit"), 40, "limit")
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

const hash = (text: string) => createHash("sha256").update(text).digest("hex")

const runEval = async (argv: ReadonlyArray<string>) => {
	const opts = flags(argv)
	const corpus: { cases: ReadonlyArray<EvalCase> } = JSON.parse(readFileSync(CORPUS, "utf8"))
	const wanted = opts.get("cases")?.split(",")
	const cases = corpus.cases.filter(
		(c) =>
			c.enabled !== false &&
			(wanted === undefined || wanted.includes(c.id)) &&
			(!opts.has("split") || c.split === opts.get("split")),
	)
	if (cases.length === 0 || wanted?.some((id) => !cases.some((c) => c.id === id))) {
		console.error("No matching cases, or unknown/disabled case IDs.")
		process.exit(2)
	}
	if (opts.has("allow-exec")) {
		console.error("Historical evals disable execution to prevent reading future fixes from the clone.")
		process.exit(2)
	}
	const models = (opts.get("models") ?? opts.get("model"))?.split(",") ?? [undefined]
	const prompts = opts.has("prompt-file")
		? [opts.get("prompt-file")]
		: (opts
				.get("prompts")
				?.split(",")
				.map((p) => (p === "committed" ? undefined : p)) ?? [undefined])
	const repeats = positiveInt(opts.get("repeats"), 1, "repeats")
	// Resolve every ref before spending tokens. No live PR comments/checks enter a replay.
	for (const c of cases) {
		if (!c.range || !/^[a-f0-9]{40}\.\.[a-f0-9]{40}$/.test(c.range)) {
			console.error(`${c.id} needs an immutable base..head range`)
			process.exit(2)
		}
		for (const sha of c.range.split("..")) git(["cat-file", "-e", `${sha}^{commit}`])
		const [base, head] = c.range.split("..")
		if (git(["merge-base", base!, head!]).trim() !== base) {
			console.error(`${c.id}: pinned base must be an ancestor of head`)
			process.exit(2)
		}
	}
	const promptTexts = prompts.map((p) =>
		p === undefined ? PR_REVIEW_SYSTEM_PROMPT : readFileSync(resolve(p), "utf8"),
	)
	const groups = [...new Set(cases.map((c) => c.range))]
	console.log(
		`${cases.length} labels, ${groups.length} unique replays × ${models.length} models × ${prompts.length} prompts × ${repeats} repeats`,
	)
	if (opts.has("dry-run")) return
	const out = join(SCRIPT_DIR, ".pr-review-evals", new Date().toISOString().replace(/[:.]/g, "-"))
	mkdirSync(out, { recursive: true })
	writeFileSync(join(out, "corpus.json"), JSON.stringify({ cases }, null, "\t"))
	writeFileSync(join(out, "worker-prompt.txt"), PR_REVIEW_WORKER_PROMPT)
	writeFileSync(
		join(out, "manifest.json"),
		JSON.stringify(
			{
				revision: git(["rev-parse", "HEAD"]).trim(),
				dirty: git(["status", "--porcelain"]),
				models,
				prompts,
				repeats,
				historical: true,
				budget: PR_REVIEW_BUDGET,
				workerPromptHash: hash(PR_REVIEW_WORKER_PROMPT),
				promptHashes: promptTexts.map(hash),
				corpusHash: hash(JSON.stringify(cases)),
			},
			null,
			"\t",
		),
	)
	const results: Array<Record<string, unknown>> = []
	const grades: Array<Grade & { runId: string }> = []
	// Rotate variants between repetitions to reduce provider/cache/order bias.
	const variants = models.flatMap((model) => prompts.map((_, prompt) => ({ model, prompt })))
	for (let repeat = 0; repeat < repeats; repeat++)
		for (const range of groups) {
			const labels = cases.filter((c) => c.range === range)
			for (let v = 0; v < variants.length; v++) {
				const variant = variants[(v + repeat) % variants.length]!
				const runId = `r${repeat}-g${groups.indexOf(range)}-v${variants.indexOf(variant)}`
				const promptFile = join(out, `prompt-${variant.prompt}.txt`)
				writeFileSync(promptFile, promptTexts[variant.prompt]!)
				console.log(`\n${runId}: PR #${labels[0]!.number}`)
				const dir = await reviewLocally([
					REPOSITORY,
					"--number",
					String(labels[0]!.number),
					"--range",
					range!,
					"--repo-dir",
					REPO_ROOT,
					"--historical",
					"--out",
					join(out, "runs"),
					"--prompt-file",
					promptFile,
					...(variant.model === undefined ? [] : ["--model", variant.model]),
				])
				const report = JSON.parse(readFileSync(join(dir, "report.json"), "utf8"))
				const findings: ReadonlyArray<Finding> = report?.report?.findings ?? []
				results.push({
					runId,
					repeat,
					model: report?.model ?? variant.model ?? "default",
					prompt: variant.prompt,
					submitted: report?.report !== undefined,
					cases: labels.map((c) => c.id),
					run: dir,
					findings,
					calls: report?.tools?.length,
					usage: report?.usage,
					seconds: report ? report.durationMs / 1000 : null,
					closedOut: report?.closedOut,
					endReason: report?.endReason,
					offDiff: report?.offDiff,
					// Location overlap is navigation only, never a quality score.
					nearby: Object.fromEntries(
						labels.map((c) => [
							c.id,
							findings.flatMap((f, i) => (c.locations.some((l) => overlaps(f, l)) ? [i] : [])),
						]),
					),
				})
				if (report?.report)
					for (const c of labels)
						grades.push({
							runId,
							caseId: c.id,
							status: "pending",
							findings: findings.map((_, index) => ({
								index,
								verdict: "ungraded",
								rationale: "",
							})),
						})
				// Checkpoint after every replay, including failures.
				writeFileSync(join(out, "results.json"), JSON.stringify(results, null, "\t"))
				writeFileSync(join(out, "grades.json"), JSON.stringify(grades, null, "\t"))
			}
		}
	console.log(`\nArtifacts: ${out}\nGrade findings in grades.json, then run review:eval score --dir ${out}`)
	if (results.some((r) => r.submitted !== true)) process.exitCode = 1
}

const score = (argv: ReadonlyArray<string>) => {
	const opts = flags(argv)
	if (!opts.has("dir")) {
		console.error("score needs --dir")
		process.exit(2)
	}
	const dir = resolve(opts.get("dir")!)
	const cases: { cases: ReadonlyArray<EvalCase> } = JSON.parse(
		readFileSync(join(dir, "corpus.json"), "utf8"),
	)
	const grades = Schema.decodeUnknownSync(
		Schema.Array(Schema.Struct({ ...Grade.fields, runId: Schema.String })),
	)(JSON.parse(readFileSync(join(dir, "grades.json"), "utf8")))
	const results = Schema.decodeUnknownSync(
		Schema.Array(
			Schema.Struct({
				runId: Schema.String,
				submitted: Schema.Boolean,
				cases: Schema.Array(Schema.String),
				findings: Schema.Array(Schema.Unknown),
				model: Schema.String,
				prompt: Schema.Int,
			}),
		),
	)(JSON.parse(readFileSync(join(dir, "results.json"), "utf8")))
	const rows = results.flatMap((run) =>
		run.cases.map((caseId) => {
			const c = cases.cases.find((c) => c.id === caseId)!
			const matching = grades.filter((g) => g.runId === run.runId && g.caseId === caseId)
			const scored =
				matching.length === 1
					? scoreGrade(matching[0]!, run.findings.length, c.expected ?? "present")
					: null
			return {
				runId: run.runId,
				model: run.model,
				prompt: run.prompt,
				caseId,
				expected: c.expected,
				status: !run.submitted ? "failed" : scored === null ? "ungraded" : "graded",
				...scored,
			}
		}),
	)
	writeFileSync(join(dir, "scores.json"), JSON.stringify(rows, null, "\t"))
	console.table(rows)
	const variants = [...new Set(rows.map((r) => `${r.model} / prompt ${r.prompt}`))]
	const summary = variants.map((variant) => {
		const selected = rows.filter((r) => `${r.model} / prompt ${r.prompt}` === variant)
		const graded = selected.filter((r) => r.status === "graded")
		const positives = graded.filter((r) => r.expected === "present")
		const controls = graded.filter((r) => r.expected === "absent")
		return {
			variant,
			graded: graded.length,
			pending: selected.filter((r) => r.status === "ungraded").length,
			failed: selected.filter((r) => r.status === "failed").length,
			targetRecall: positives.length
				? positives.filter((r) => r.passed).length / positives.length
				: null,
			controlPassRate: controls.length
				? controls.filter((r) => r.passed).length / controls.length
				: null,
		}
	})
	writeFileSync(join(dir, "summary.json"), JSON.stringify(summary, null, "\t"))
	console.table(summary)
	console.log(
		"Pending grades are not misses or clean reviews. Shared replays appear once per target; do not sum their findings/tokens twice.",
	)
}

if (import.meta.main) {
	const [command, ...rest] = process.argv.slice(2)
	if (command === "mine") mine(rest)
	else if (command === "run") await runEval(rest)
	else if (command === "score") score(rest)
	else {
		console.error(
			"usage: review:eval mine [--ref ref] [--since date] [--limit n] | run [--cases ids] [--models ids] [--prompts committed,path] [--repeats n] [--split development|holdout] [--dry-run] | score --dir path",
		)
		process.exit(2)
	}
}
