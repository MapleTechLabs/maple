/**
 * `bun run security:eval <cases.json>... [options]`: runs the security-audit engine over labelled
 * cases (a repository at a commit that still has known bugs, scoped to their slice), records cost
 * and verdict counts per run, and scores runs against human grades. Case files live in
 * security-audit-eval/cases/ (format: `CaseFile` in ./security-audit-eval/scoring.ts); grades in
 * `<results>/grades.json` (`Grades`).
 *
 * The spend cap applies per results directory: it sums every run under it (finished, aborted,
 * in flight), is checked before each launch and every poll, and stops a run that passes it.
 *
 * Options: --results <dir> (~/.cache/maple-security-eval/results, never inside this repo) · --repos <dir> (~/.cache/maple-security-eval/repos) · --only <id,...>
 * · --variant <name> with --profile/--budget/--concurrency overrides · --cap-usd <n> (250)
 * · --per-invocation-usd <n> (1.5, the estimate before any run) · --grades <file> (<results>/grades.json)
 * · --discovery-model / --validation-model <openrouter id> · --score-only · --dry-run
 */
import { spawn, spawnSync } from "node:child_process"
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { Effect } from "effect"
import {
	aggregate,
	type CaseResult,
	decodeCaseFile,
	decodeCaseResult,
	parseEventLines,
	decodeFindings,
	decodeGrades,
	decodeRunStatus,
	type EvalCase,
	estimateCost,
	type Finding,
	fitsCap,
	type Grades,
	locationMatches,
	metricsOf,
	type Profile,
	renderRuns,
	renderTable,
	scoreRun,
	usageOf,
} from "./security-audit-eval/scoring"

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const AI_DIR = resolve(SCRIPT_DIR, "..")
const POLL_MS = 30_000
const EVAL_CACHE = join(homedir(), ".cache", "maple-security-eval")

/** `path` with symlinks resolved, through its nearest existing ancestor when it does not exist yet. */
const realPath = (path: string): string =>
	existsSync(path) || dirname(path) === path
		? realpathSync(path)
		: join(realPath(dirname(path)), basename(path))

/** Whether `path` is `dir` or inside it, both already real. */
const isWithin = (path: string, dir: string) => {
	const rel = relative(dir, path)
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** The Maple checkout this script runs from: results (case repos, findings) must stay out of it. */
const repoRoot = () => {
	const top = spawnSync("git", ["-C", AI_DIR, "rev-parse", "--show-toplevel"], { encoding: "utf8" })
	return realPath(top.status === 0 ? top.stdout.trim() : resolve(AI_DIR, "..", ".."))
}

interface Args {
	readonly caseFiles: ReadonlyArray<string>
	readonly results: string
	readonly repos: string
	readonly only: ReadonlySet<string> | null
	readonly variant: string | undefined
	readonly profile: Profile | undefined
	readonly budget: number | undefined
	readonly concurrency: number | undefined
	readonly capUsd: number
	readonly perInvocationUsd: number
	readonly grades: string
	readonly scoreOnly: boolean
	readonly dryRun: boolean
	readonly discoveryModel: string | undefined
	readonly validationModel: string | undefined
}

const usage = () => {
	console.error(
		"usage: bun run security:eval <cases.json>... [--results <dir>] [--repos <dir>] [--only <id,...>] [--variant <name> --profile <p> --budget <n> --concurrency <n>] [--cap-usd <n>] [--per-invocation-usd <n>] [--grades <file>] [--score-only] [--dry-run]",
	)
	return process.exit(2)
}

const isProfile = (value: string | undefined): value is Profile =>
	value === "quick" || value === "standard" || value === "deep"

const parseArgs = (argv: ReadonlyArray<string>): Args => {
	const switches = new Set(["score-only", "dry-run"])
	const parsed = argv.reduce<{
		readonly flags: ReadonlyMap<string, string>
		readonly positional: ReadonlyArray<string>
		readonly pending: string | null
	}>(
		(acc, arg) =>
			acc.pending !== null
				? { ...acc, flags: new Map(acc.flags).set(acc.pending, arg), pending: null }
				: arg.startsWith("--")
					? switches.has(arg.slice(2))
						? { ...acc, flags: new Map(acc.flags).set(arg.slice(2), "true") }
						: { ...acc, pending: arg.slice(2) }
					: { ...acc, positional: [...acc.positional, arg] },
		{ flags: new Map(), positional: [], pending: null },
	)
	if (parsed.pending !== null) usage()
	const flag = (name: string) => parsed.flags.get(name)
	const number = (name: string) => {
		const raw = flag(name)
		if (raw === undefined) return undefined
		const value = Number(raw)
		if (!Number.isFinite(value) || value <= 0) usage()
		return value
	}
	const results = realPath(resolve(flag("results") ?? join(EVAL_CACHE, "results")))
	const profile = flag("profile")
	if (parsed.positional.length === 0) return usage()
	if (isWithin(results, repoRoot())) {
		console.error(`--results ${results} is inside the Maple repository; pick a directory outside it.`)
		return process.exit(2)
	}
	if (profile !== undefined && !isProfile(profile)) return usage()
	const variant = flag("variant")
	// An override without a variant name would overwrite the default run's results.
	if (variant === undefined && (profile !== undefined || flag("budget") !== undefined)) return usage()
	return {
		caseFiles: parsed.positional.map((path) => resolve(path)),
		results,
		repos: resolve(flag("repos") ?? join(EVAL_CACHE, "repos")),
		only: flag("only") === undefined ? null : new Set((flag("only") ?? "").split(",")),
		variant,
		profile,
		budget: number("budget"),
		concurrency: number("concurrency"),
		capUsd: number("cap-usd") ?? 250,
		perInvocationUsd: number("per-invocation-usd") ?? 1.5,
		grades: resolve(flag("grades") ?? join(results, "grades.json")),
		scoreOnly: flag("score-only") === "true",
		dryRun: flag("dry-run") === "true",
		discoveryModel: flag("discovery-model"),
		validationModel: flag("validation-model"),
	}
}

const git = (dir: string, args: ReadonlyArray<string>) => {
	const result = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" })
	return {
		ok: result.status === 0,
		stdout: (result.stdout ?? "").trim(),
		stderr: (result.stderr ?? "").trim(),
	}
}

type RepoCheck =
	| { readonly dir: string; readonly error?: undefined }
	| { readonly dir?: undefined; readonly error: string }

const hasCommit = (dir: string, sha: string) => git(dir, ["cat-file", "-e", "--", `${sha}^{commit}`]).ok

/**
 * The case's repository with its commit and every fix commit present. A new repository is a fresh,
 * empty directory; its content is only read through git at the commit, never checked out or run.
 * Fetches are blobless with full history, so the fix-containment check below can actually run.
 */
const ensureRepo = (repos: string, c: EvalCase): RepoCheck => {
	const dir = join(repos, c.repo.name)
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true })
		git(dir, ["init", "-q"])
		git(dir, ["remote", "add", "--", "origin", c.repo.url])
	}
	const origin = git(dir, ["remote", "get-url", "--", "origin"])
	if (!origin.ok || origin.stdout !== c.repo.url)
		return { error: `${dir} exists with origin ${origin.stdout || "(none)"}, not ${c.repo.url}` }
	const missing = [c.sha, ...c.bugs.map((bug) => bug.fixSha)].filter((sha) => !hasCommit(dir, sha))
	if (missing.length > 0) {
		const fetched = git(dir, ["fetch", "-q", "--filter=blob:none", "--", "origin", ...missing])
		if (!fetched.ok)
			return { error: `cannot fetch ${missing.join(", ")} from ${c.repo.url}: ${fetched.stderr}` }
	}
	// An unknown fix commit cannot be checked, so it fails the case rather than reading as "not contained".
	const unknown = [c.sha, ...c.bugs.map((bug) => bug.fixSha)].filter((sha) => !hasCommit(dir, sha))
	if (unknown.length > 0) return { error: `commits not present after fetch: ${unknown.join(", ")}` }
	// A run at a commit that already contains a fix would score a fixed bug as missed.
	const fixed = c.bugs.filter(
		(bug) => git(dir, ["merge-base", "--is-ancestor", "--", bug.fixSha, c.sha]).ok,
	)
	return fixed.length > 0
		? { error: `${c.sha} already contains the fix for ${fixed.map((b) => b.id).join(", ")}` }
		: { dir }
}

const readJsonLines = (path: string) => (existsSync(path) ? parseEventLines(readFileSync(path, "utf8")) : [])

const readFindings = (runDir: string): ReadonlyArray<Finding> => {
	const path = join(runDir, "findings.json")
	return existsSync(path) ? decodeFindings(JSON.parse(readFileSync(path, "utf8"))) : []
}

const readStatus = (runDir: string) => {
	const path = join(runDir, "run-metadata.json")
	return existsSync(path) ? decodeRunStatus(JSON.parse(readFileSync(path, "utf8"))).run_status : "missing"
}

const loadResults = (results: string): ReadonlyArray<CaseResult> =>
	existsSync(results)
		? readdirSync(results)
				.map((name) => join(results, name, "result.json"))
				.filter((path) => existsSync(path))
				.map((path) => decodeCaseResult(JSON.parse(readFileSync(path, "utf8"))))
		: []

/**
 * Everything spent under the results directory: finished, aborted and in-flight runs alike, so
 * parallel invocations and abandoned runs count against the cap.
 */
const RUN_DIR = /^run(\.aborted-\d+)?$/

const spentUsd = (results: string) =>
	readdirSync(results, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.flatMap((entry) =>
			readdirSync(join(results, entry.name))
				.filter((name) => RUN_DIR.test(name))
				.map((name) => join(results, entry.name, name, "events.jsonl")),
		)
		.reduce((acc, path) => acc + usageOf(readJsonLines(path)).costUsd, 0)

/**
 * Claims a key for this process: an exclusive create, so two harnesses never run the same key.
 * The claim is removed when the run ends; one left by a killed harness is removed by hand.
 */
const claim = (results: string, key: string) =>
	Effect.runSync(
		Effect.result(
			Effect.try(() =>
				writeFileSync(join(results, `${key}.claim`), `${process.pid}\n`, { flag: "wx" }),
			),
		),
	)._tag === "Success"

const release = (results: string, key: string) => rmSync(join(results, `${key}.claim`), { force: true })

const settingsFor = (
	args: Args,
	defaults: { profile: Profile; budget: number; concurrency: number },
	c: EvalCase,
) => ({
	profile: args.profile ?? c.profile ?? defaults.profile,
	budget: args.budget ?? c.budget ?? defaults.budget,
	concurrency: args.concurrency ?? c.concurrency ?? defaults.concurrency,
})

const runCase = (
	args: Args,
	c: EvalCase,
	settings: Settings,
	key: string,
	repoDir: string,
): Promise<CaseResult> => {
	const out = join(args.results, key)
	const runDir = join(out, "run")
	// A run left by a crash keeps its spend on the books but never mixes with the new one.
	if (existsSync(runDir)) renameSync(runDir, join(out, `run.aborted-${Date.now()}`))
	mkdirSync(runDir, { recursive: true })
	const started = Date.now()
	const runnerArgs = [
		"scripts/security-audit-local.ts",
		repoDir,
		"--ref",
		c.sha,
		...c.scope.flatMap((path) => ["--scope", path]),
		"--profile",
		settings.profile,
		"--budget",
		String(settings.budget),
		"--concurrency",
		String(settings.concurrency),
		"--out",
		runDir,
		...(args.discoveryModel === undefined ? [] : ["--discovery-model", args.discoveryModel]),
		...(args.validationModel === undefined ? [] : ["--validation-model", args.validationModel]),
	]
	const log = join(out, "runner.log")
	writeFileSync(log, `bun ${runnerArgs.join(" ")}\n`)
	return new Promise((done) => {
		const child = spawn("bun", runnerArgs, { cwd: AI_DIR, stdio: ["ignore", "pipe", "pipe"] })
		const append = (chunk: Buffer) => writeFileSync(log, chunk, { flag: "a" })
		child.stdout.on("data", append)
		child.stderr.on("data", append)
		const stopped = new Set<string>()
		const progress = setInterval(() => {
			const events = readJsonLines(join(runDir, "events.jsonl"))
			const m = metricsOf({ status: "running", events, findings: [], wallClockSeconds: 0 })
			const spent = spentUsd(args.results)
			console.log(
				`  ${key}: ${m.invocations} invocations, $${m.costUsd.toFixed(2)}, ${Math.round((Date.now() - started) / 60_000)}m; directory spend $${spent.toFixed(2)}`,
			)
			if (spent > args.capUsd && !stopped.has("cap")) {
				stopped.add("cap")
				console.log(`  ${key}: stopping, spend $${spent.toFixed(2)} passed the $${args.capUsd} cap`)
				child.kill("SIGTERM")
			}
		}, POLL_MS)
		child.on("close", (code) => {
			clearInterval(progress)
			const findings = readFindings(runDir)
			const result: CaseResult = {
				key,
				case: c,
				profile: settings.profile,
				budget: settings.budget,
				exitCode: code ?? 1,
				metrics: metricsOf({
					status: stopped.has("cap") ? "stopped_at_cap" : readStatus(runDir),
					events: readJsonLines(join(runDir, "events.jsonl")),
					findings,
					wallClockSeconds: (Date.now() - started) / 1000,
				}),
				locationMatches: locationMatches(findings, c.bugs),
				models: { discovery: args.discoveryModel ?? null, validation: args.validationModel ?? null },
			}
			writeFileSync(join(out, "result.json"), `${JSON.stringify(result, null, 2)}\n`)
			done(result)
		})
	})
}

const loadGrades = (path: string): Grades =>
	existsSync(path) ? decodeGrades(JSON.parse(readFileSync(path, "utf8"))) : { bugs: [], spotChecks: [] }

const writeSummary = (args: Args) => {
	const results = loadResults(args.results)
	const grades = loadGrades(args.grades)
	const runs = results.map((r) => scoreRun(r, readFindings(join(args.results, r.key, "run")), grades))
	const byLanguage = aggregate(runs, (r) => `${r.corpus}/${r.language}`)
	const byCorpus = aggregate(runs, (r) => r.corpus)
	const total = aggregate(runs, () => "all")
	writeFileSync(
		join(args.results, "results.json"),
		`${JSON.stringify({ generatedAt: new Date().toISOString(), byLanguage, byCorpus, total, runs }, null, 2)}\n`,
	)
	const summary = [
		"# Security audit eval",
		`Generated ${new Date().toISOString()} from ${results.length} runs; grades from ${args.grades}.`,
		"## By language",
		renderTable(byLanguage),
		"## By corpus",
		renderTable([...byCorpus, ...total]),
		"## Runs",
		renderRuns(runs),
		"## Location suggestions (ungraded aid)",
		...results.map(
			(r) =>
				`- ${r.key}: ${r.locationMatches.map((m) => `${m.bug} <- ${m.fingerprint} [${m.verdict}] ${m.files.join(", ")}`).join("; ") || "none"}`,
		),
	].join("\n\n")
	writeFileSync(join(args.results, "summary.md"), `${summary}\n`)
	console.log(renderTable([...byLanguage, ...total]))
}

type Settings = { readonly profile: Profile; readonly budget: number; readonly concurrency: number }

/** One case under its claim: skip a finished key, check the cap and the repository, then run. */
const runClaimed = async (args: Args, c: EvalCase, settings: Settings, key: string) => {
	const existing = loadResults(args.results)
	if (existing.some((r) => r.key === key)) {
		console.log(`skip ${key}: already has a result`)
		return
	}
	const spent = spentUsd(args.results)
	const estimate = estimateCost(
		settings.budget,
		existing.map((r) => r.metrics),
		args.perInvocationUsd,
	)
	if (!fitsCap(spent, estimate, args.capUsd)) {
		console.log(
			`stop before ${key}: spent $${spent.toFixed(2)} + estimated $${estimate.toFixed(2)} exceeds the $${args.capUsd} cap`,
		)
		return
	}
	console.log(
		`run ${key} (${settings.profile}, budget ${settings.budget}); spent $${spent.toFixed(2)}, estimate $${estimate.toFixed(2)}`,
	)
	const repo = ensureRepo(args.repos, c)
	if (repo.error !== undefined) {
		console.log(`skip ${key}: ${repo.error}`)
		return
	}
	if (args.dryRun) return
	const result = await runCase(args, c, settings, key, repo.dir)
	console.log(
		`done ${key}: ${result.metrics.status}, ${result.metrics.invocations} invocations, $${result.metrics.costUsd.toFixed(2)}, ${result.metrics.confirmed}/${result.metrics.needsValidation}/${result.metrics.rejected} C/NV/R`,
	)
}

const main = async () => {
	const args = parseArgs(process.argv.slice(2))
	mkdirSync(args.results, { recursive: true })
	if (args.scoreOnly) return writeSummary(args)
	if (!args.dryRun && !process.env.OPENROUTER_API_KEY) {
		console.error("OPENROUTER_API_KEY is not set; run under `infisical run --env dev --`.")
		return process.exit(1)
	}
	const files = args.caseFiles.map((path) => decodeCaseFile(JSON.parse(readFileSync(path, "utf8"))))
	const queue = files.flatMap((file) =>
		file.cases
			.filter((c) => args.only === null || args.only.has(c.id))
			.map((c) => ({ c, settings: settingsFor(args, file.defaults, c) })),
	)
	// Sequential on purpose: each run already fans out to its own agents, and the cap is checked
	// against real spend before every launch and while each run is in flight.
	await queue.reduce<Promise<void>>(
		(previous, { c, settings }) =>
			previous.then(() => {
				const key = args.variant === undefined ? c.id : `${c.id}@${args.variant}`
				if (!args.dryRun && !claim(args.results, key)) {
					console.log(`skip ${key}: claimed by another harness (${key}.claim)`)
					return undefined
				}
				// Every exit after the claim, early or not, releases it.
				return runClaimed(args, c, settings, key).finally(() => {
					if (!args.dryRun) release(args.results, key)
				})
			}),
		Promise.resolve(),
	)
	writeSummary(args)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	void main()
}
