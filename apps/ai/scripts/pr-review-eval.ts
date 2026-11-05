/**
 * Historical PR replay and human semantic grading. See pr-review-eval/README.md.
 * mine proposes unverified candidates; run compares prompt/model combinations;
 * score evaluates explicit grades, never location overlap.
 */
import { createHash } from "node:crypto"
import { Schema, Array as Arr, Record as Rec, String as Str } from "effect"
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
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const encodeTabbedJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown, { space: "\t" }))
// Files this script wrote itself, read back with their declared shape trusted.
const decodeTrustedJson = Schema.decodeSync(Schema.fromJsonString(Schema.Any))

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
	if (proc.status !== 0) throw new Error(`git ${Arr.join(args, " ")}: ${proc.stderr}`)
	return proc.stdout
}

const flags = (argv: ReadonlyArray<string>): Map<string, string> => {
	const out = new Map<string, string>()
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] ?? ""
		if (!Str.startsWith("--")(arg)) continue
		if (arg === "--allow-exec" || arg === "--dry-run") {
			out.set(Str.slice(2)(arg), "true")
			continue
		}
		const value = argv[i + 1]
		// A flag without an operand is an error, never a reason to swallow the next flag.
		if (value === undefined || Str.startsWith("--")(value)) {
			console.error(`${arg} needs a value`)
			process.exit(2)
		}
		out.set(Str.slice(2)(arg), value)
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
	// `--- ` is a file header only between `diff --git` and the first hunk: inside a hunk it is a
	// deleted line that began `-- ` (a SQL comment), which once became the path `ilder:errors:...`.
	let inHeader = false
	for (const line of Str.split("\n")(git(["diff", "-U0", "--no-color", "--no-renames", `${sha}^`, sha]))) {
		if (Str.startsWith("diff --git ")(line)) {
			inHeader = true
			path = undefined
			continue
		}
		if (inHeader && Str.startsWith("--- ")(line)) {
			path = line === "--- /dev/null" ? undefined : Str.slice("--- a/".length)(line)
			continue
		}
		if (Str.startsWith("@@")(line)) inHeader = false
		const hunk = /^@@ -(\d+)(?:,(\d+))? \+/.exec(line)
		if (hunk === null || path === undefined) continue
		const start = Number(hunk[1])
		const count = hunk[2] === undefined ? 1 : Number(hunk[2])
		// An insertion-only hunk (a guard, a missing header) removed nothing; the line it follows is
		// what the buggy code left out, so that line is what gets blamed.
		if (count === 0 && start === 0) continue
		const kind = classifyChangedFile(path)
		// A snapshot or a dependency patch changes with the bug's fix but never contained the bug.
		if (Str.includes("__sql_baseline__")(path) || Str.endsWith(".patch")(path)) continue
		if (kind === "source" || kind === "infra" || kind === "config")
			ranges.push({ path, lines: count === 0 ? [start, start] : [start, start + count - 1] })
	}
	return ranges
}

/** Which commit wrote each line of a range, with the line's number and path in that commit. */
const blameRange = (sha: string, range: Location) => {
	const out: Array<{ commit: string; path: string; line: number }> = []
	const blame = spawnSync(
		"git",
		["blame", "--porcelain", "-L", `${range.lines[0]},${range.lines[1]}`, `${sha}^`, "--", range.path],
		{ cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
	)
	// One unreadable range (a path the parser got wrong, a file git cannot follow) skips that range,
	// not the whole mine.
	if (blame.status !== 0) {
		console.error(
			`skipped ${range.path}:${range.lines.join("-")} in ${Str.slice(0, 10)(sha)}: ${Str.trim(blame.stderr)}`,
		)
		return out
	}
	const porcelain = blame.stdout
	const filenames = new Map<string, string>()
	let current: { commit: string; line: number } | undefined
	for (const line of Str.split("\n")(porcelain)) {
		const header = /^([0-9a-f]{40}) (\d+) \d+/.exec(line)
		if (header !== null) {
			current = { commit: header[1] ?? "", line: Number(header[2]) }
			continue
		}
		if (Str.startsWith("filename ")(line) && current !== undefined)
			filenames.set(current.commit, Str.slice(9)(line))
		if (Str.startsWith("\t")(line) && current !== undefined)
			out.push({ ...current, path: filenames.get(current.commit) ?? range.path })
	}
	return out
}

/** Contiguous lines per path, so one blamed hunk is one location. */
const mergeLines = (lines: ReadonlyArray<{ path: string; line: number }>): Array<Location> => {
	const byPath = new Map<string, Array<number>>()
	for (const { path, line } of lines) byPath.set(path, [...(byPath.get(path) ?? []), line])
	return Arr.flatMap([...byPath.entries()], ([path, numbers]) => {
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
	// Reviews of 13 or more files are the ones a reviewer splits across child reviewers.
	const minFiles = positiveInt(opts.get("min-files"), 1, "min-files")
	const subjects = new Map<string, string>()
	const subjectOf = (sha: string) => {
		const known = subjects.get(sha)
		if (known !== undefined) return known
		const subject = Str.trim(git(["show", "-s", "--format=%s", sha]))
		subjects.set(sha, subject)
		return subject
	}
	const candidates: Array<EvalCase> = []
	const log = git(["log", "--first-parent", ref, `--since=${since}`, "--format=%H%x09%s"])
	for (const entry of Str.split("\n")(log)) {
		if (candidates.length >= limit) break
		const [sha, subject = ""] = Str.split("\t")(entry)
		if (!FIX_SUBJECT.test(subject)) continue
		const blamed = Arr.flatMap(changedOldRanges(sha), (range) => blameRange(sha, range))
		const byPr = new Map<
			number,
			{ readonly commit: string; readonly lines: Array<{ path: string; line: number }> }
		>()
		for (const { commit, path, line } of blamed) {
			const pr = SQUASH_PR.exec(subjectOf(commit))
			if (pr === null || commit === sha) continue
			const number = Number(pr[1])
			const known = byPr.get(number)
			byPr.set(number, {
				commit: known?.commit ?? commit,
				lines: [...(known?.lines ?? []), { path, line }],
			})
		}
		// The pull request that wrote most of the fixed lines is the one that shipped the bug.
		const top = [...byPr.entries()].sort((a, b) => b[1].lines.length - a[1].lines.length)[0]
		if (top === undefined) continue
		const [number, { commit, lines }] = top
		const files = Arr.filter(
			Str.split("\n")(git(["diff", "--name-only", `${commit}^`, commit])),
			(file) => file !== "",
		).length
		if (files < minFiles) continue
		candidates.push({
			id: `pr${number}-fix${Str.slice(0, 7)(sha)}`,
			number,
			bug: "",
			fix: { sha, subject },
			locations: mergeLines(lines),
			// The squash that shipped the bug, replayed as the review saw it.
			range: `${Str.trim(git(["rev-parse", `${commit}^`]))}..${commit}`,
			expected: "present",
		})
		console.error(`#${number} (${files} files) <- ${Str.slice(0, 10)(sha)} ${subject}`)
	}
	console.log(encodeTabbedJson({ cases: candidates }))
}

// Running

const overlaps = (finding: Finding, location: Location) =>
	finding.path === location.path &&
	finding.line - LINE_TOLERANCE <= location.lines[1] &&
	(finding.endLine ?? finding.line) + LINE_TOLERANCE >= location.lines[0]

const hash = (text: string) => createHash("sha256").update(text).digest("hex")

const runEval = async (argv: ReadonlyArray<string>) => {
	const opts = flags(argv)
	const corpus: { cases: ReadonlyArray<EvalCase> } = decodeTrustedJson(readFileSync(CORPUS, "utf8"))
	const wanted = opts.get("cases")?.split(",")
	const cases = Arr.filter(
		corpus.cases,
		(c) =>
			c.enabled !== false &&
			(wanted === undefined || wanted.includes(c.id)) &&
			(!opts.has("split") || c.split === opts.get("split")),
	)
	if (cases.length === 0 || wanted?.some((id) => !Arr.some(cases, (c) => c.id === id))) {
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
	const concurrency = positiveInt(opts.get("concurrency"), 1, "concurrency")
	const codeModes = Arr.map(Str.split(",")(opts.get("code-mode") ?? "off"), (mode) => {
		if (mode !== "off" && mode !== "on" && mode !== "only") {
			console.error(`--code-mode takes a list of off, on and only; got ${mode}`)
			process.exit(2)
		}
		return mode
	})
	// Resolve every ref before spending tokens. No live PR comments/checks enter a replay.
	for (const c of cases) {
		if (!c.range || !/^[a-f0-9]{40}\.\.[a-f0-9]{40}$/.test(c.range)) {
			console.error(`${c.id} needs an immutable base..head range`)
			process.exit(2)
		}
		for (const sha of Str.split("..")(c.range)) git(["cat-file", "-e", `${sha}^{commit}`])
		const [base, head] = Str.split("..")(c.range)
		if (Str.trim(git(["merge-base", base, head])) !== base) {
			console.error(`${c.id}: pinned base must be an ancestor of head`)
			process.exit(2)
		}
	}
	const promptTexts = prompts.map((p) =>
		p === undefined ? PR_REVIEW_SYSTEM_PROMPT : readFileSync(resolve(p), "utf8"),
	)
	const groups = [...new Set(Arr.map(cases, (c) => c.range))]
	console.log(
		`${cases.length} labels, ${groups.length} unique replays × ${models.length} models × ${prompts.length} prompts × ${codeModes.length} code modes × ${repeats} repeats`,
	)
	if (opts.has("dry-run")) return
	const out = join(SCRIPT_DIR, ".pr-review-evals", Str.replace(/[:.]/g, "-")(new Date().toISOString()))
	mkdirSync(out, { recursive: true })
	writeFileSync(join(out, "corpus.json"), encodeTabbedJson({ cases }))
	writeFileSync(join(out, "worker-prompt.txt"), PR_REVIEW_WORKER_PROMPT)
	writeFileSync(
		join(out, "manifest.json"),
		encodeTabbedJson({
			revision: Str.trim(git(["rev-parse", "HEAD"])),
			dirty: git(["status", "--porcelain"]),
			models,
			prompts,
			codeModes,
			repeats,
			historical: true,
			budget: PR_REVIEW_BUDGET,
			workerPromptHash: hash(PR_REVIEW_WORKER_PROMPT),
			promptHashes: Arr.map(promptTexts, hash),
			corpusHash: hash(encodeJson(cases)),
		}),
	)
	const results: Array<Record<string, unknown>> = []
	const grades: Array<Grade & { runId: string }> = []
	// Rotate variants between repetitions to reduce provider/cache/order bias.
	const variants = Arr.flatMap(models, (model) =>
		Arr.flatMap(prompts, (_, prompt) => Arr.map(codeModes, (codeMode) => ({ model, prompt, codeMode }))),
	)
	const jobs = Array.from({ length: repeats }, (_, repeat) =>
		Arr.flatMap(groups, (range) =>
			Arr.map(variants, (_, v) => {
				const variant = variants[(v + repeat) % variants.length]
				return {
					repeat,
					range,
					variant,
					labels: Arr.filter(cases, (c) => c.range === range),
					runId: `r${repeat}-g${groups.indexOf(range)}-v${variants.indexOf(variant)}`,
				}
			}),
		),
	).flat()
	const runJob = async (
		{ repeat, range, variant, labels, runId }: (typeof jobs)[number],
		order: number,
	) => {
		const promptFile = join(out, `prompt-${variant.prompt}.txt`)
		writeFileSync(promptFile, promptTexts[variant.prompt])
		console.log(`\n${runId}: PR #${labels[0].number}`)
		const dir = await reviewLocally([
			REPOSITORY,
			"--number",
			String(labels[0].number),
			"--range",
			range!,
			"--repo-dir",
			REPO_ROOT,
			"--historical",
			"--out",
			// Per run: two runs of one pull request starting in the same millisecond named one folder.
			join(out, "runs", runId),
			"--prompt-file",
			promptFile,
			...(variant.model === undefined ? [] : ["--model", variant.model]),
			...(variant.codeMode === "on"
				? ["--code-mode"]
				: variant.codeMode === "only"
					? ["--code-only"]
					: []),
		])
		const report = decodeTrustedJson(readFileSync(join(dir, "report.json"), "utf8"))
		const findings: ReadonlyArray<Finding> = report?.report?.findings ?? []
		results.push({
			order,
			runId,
			repeat,
			model: report?.model ?? variant.model ?? "default",
			prompt: variant.prompt,
			codeMode: variant.codeMode,
			submitted: report?.report !== undefined,
			cases: Arr.map(labels, (c) => c.id),
			run: dir,
			findings,
			calls: report?.tools?.length,
			llmCalls: report?.usage?.charges?.length,
			// The review_files children's share of `usage`.
			delegated: report?.usage?.delegated,
			usage: report?.usage,
			seconds: report ? report.durationMs / 1000 : null,
			closedOut: report?.closedOut,
			endReason: report?.endReason,
			offDiff: report?.offDiff,
			// Location overlap is navigation only, never a quality score.
			nearby: Rec.fromEntries(
				Arr.map(labels, (c) => [
					c.id,
					Arr.flatMap(findings, (f, i) =>
						Arr.some(c.locations, (l) => overlaps(f, l)) ? [i] : [],
					),
				]),
			),
		})
		if (report?.report)
			for (const c of labels)
				grades.push({
					runId,
					caseId: c.id,
					status: "pending",
					findings: Arr.map(findings, (_, index) => ({
						index,
						verdict: "ungraded",
						rationale: "",
					})),
				})
		checkpoint()
	}
	// After every replay, including failures, in job order whatever finished first.
	const checkpoint = () => {
		results.sort((a, b) => Number(a.order) - Number(b.order))
		writeFileSync(join(out, "results.json"), encodeTabbedJson(results))
		writeFileSync(join(out, "grades.json"), encodeTabbedJson(grades))
	}
	// Each review runs a parent and up to four children against one provider; past about three at
	// once, rate limits fail reviews outright. Their streamed output interleaves on stdout.
	let next = 0
	const worker = async (): Promise<void> => {
		const order = next++
		const job = jobs[order]
		if (job === undefined) return
		// A review that threw is a failed result, and the pool goes on to the next job.
		await runJob(job, order).catch((error: unknown) => {
			console.error(`\n${job.runId} failed: ${String(error)}`)
			results.push({
				order,
				runId: job.runId,
				repeat: job.repeat,
				model: job.variant.model ?? "default",
				prompt: job.variant.prompt,
				codeMode: job.variant.codeMode,
				submitted: false,
				cases: Arr.map(job.labels, (c) => c.id),
				findings: [],
				error: String(error),
			})
			checkpoint()
		})
		return worker()
	}
	await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker))
	console.log(`\nArtifacts: ${out}\nGrade findings in grades.json, then run review:eval score --dir ${out}`)
	if (Arr.some(results, (r) => r.submitted !== true)) process.exitCode = 1
}

const score = (argv: ReadonlyArray<string>) => {
	const opts = flags(argv)
	if (!opts.has("dir")) {
		console.error("score needs --dir")
		process.exit(2)
	}
	const dir = resolve(opts.get("dir")!)
	const cases: { cases: ReadonlyArray<EvalCase> } = decodeTrustedJson(
		readFileSync(join(dir, "corpus.json"), "utf8"),
	)
	const grades = Schema.decodeSync(
		Schema.fromJsonString(Schema.Array(Schema.Struct({ ...Grade.fields, runId: Schema.String }))),
	)(readFileSync(join(dir, "grades.json"), "utf8"))
	const results = Schema.decodeSync(
		Schema.fromJsonString(
			Schema.Array(
				Schema.Struct({
					runId: Schema.String,
					submitted: Schema.Boolean,
					cases: Schema.Array(Schema.String),
					findings: Schema.Array(Schema.Unknown),
					model: Schema.String,
					prompt: Schema.Int,
					codeMode: Schema.optionalKey(Schema.Literals(["off", "on", "only"])),
				}),
			),
		),
	)(readFileSync(join(dir, "results.json"), "utf8"))
	const rows = Arr.flatMap(results, (run) =>
		Arr.map(run.cases, (caseId) => {
			const c = cases.cases.find((c) => c.id === caseId)!
			const matching = Arr.filter(grades, (g) => g.runId === run.runId && g.caseId === caseId)
			const scored =
				matching.length === 1
					? scoreGrade(matching[0], run.findings.length, c.expected ?? "present")
					: null
			return {
				runId: run.runId,
				model: run.model,
				prompt: run.prompt,
				codeMode: run.codeMode ?? "off",
				caseId,
				expected: c.expected,
				status: !run.submitted ? "failed" : scored === null ? "ungraded" : "graded",
				...scored,
			}
		}),
	)
	writeFileSync(join(dir, "scores.json"), encodeTabbedJson(rows))
	console.table(rows)
	const label = (r: (typeof rows)[number]) => `${r.model} / prompt ${r.prompt} / run_code ${r.codeMode}`
	const variants = [...new Set(Arr.map(rows, label))]
	const summary = Arr.map(variants, (variant) => {
		const selected = Arr.filter(rows, (r) => label(r) === variant)
		const graded = Arr.filter(selected, (r) => r.status === "graded")
		const positives = Arr.filter(graded, (r) => r.expected === "present")
		const controls = Arr.filter(graded, (r) => r.expected === "absent")
		return {
			variant,
			graded: graded.length,
			pending: Arr.filter(selected, (r) => r.status === "ungraded").length,
			failed: Arr.filter(selected, (r) => r.status === "failed").length,
			targetRecall: positives.length
				? positives.filter((r) => r.passed).length / positives.length
				: null,
			controlPassRate: controls.length
				? controls.filter((r) => r.passed).length / controls.length
				: null,
		}
	})
	writeFileSync(join(dir, "summary.json"), encodeTabbedJson(summary))
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
			"usage: review:eval mine [--ref ref] [--since date] [--limit n] [--min-files n] | run [--cases ids] [--models ids] [--prompts committed,path] [--code-mode off,on,only] [--repeats n] [--concurrency n] [--split development|holdout] [--dry-run] | score --dir path",
		)
		process.exit(2)
	}
}
