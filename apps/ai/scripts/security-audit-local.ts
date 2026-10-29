/**
 * `bun run security:local <repo-dir> [options]`: one security-audit run of Cloudflare's skill over a
 * local clone, with the same engine, prompts and agents a deployed run uses. Source is read with
 * git at one commit; no target code is executed. The run directory has the skill's own layout, and
 * the upstream validators check it at the end.
 *
 * Options: --ref <commit> (HEAD) · --scope <path> (repeatable) · --profile quick|standard|deep (deep)
 * · --budget <invocations> · --out <dir> (~/security-audit-skill/<repo>/run-<N>) · --prior <run dir>
 * · --concurrency <n> (4) · --discovery-model <id> · --validation-model <id>
 */
import { spawnSync } from "node:child_process"
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
	AuditAgents,
	type AuditRunInput,
	AuditStore,
	changedMatcher,
	EVERYTHING_CHANGED,
	type AuditStoreApi,
	Findings,
	isSafeRelativePath,
	Ledger,
	type PriorRun,
	runAudit,
} from "@maple/security-audit"
import { ConfigProvider, Console, Effect, Layer, References, Schema } from "effect"
import { makeAuditAgents } from "@/security-audit/agents"
import { AUDIT_TOOL_GUIDANCE, SourceReadError, type SourceReaderApi } from "@/security-audit/source"
import { layerLlm, loadLlmSettings, resolveSecurityAuditModel } from "@/platform/Llm"

const MAX_OUTPUT_BYTES = 48 * 1024
const SKILL_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../packages/security-audit/skill")

interface Args {
	readonly repoDir: string
	readonly ref: string
	readonly scope: ReadonlyArray<string>
	readonly profile: "quick" | "standard" | "deep"
	readonly budget: number | null
	readonly out: string | undefined
	readonly prior: string | undefined
	readonly concurrency: number
	readonly discoveryModel: string | undefined
	readonly validationModel: string | undefined
}

const parseArgs = (argv: ReadonlyArray<string>): Args => {
	const flags = new Map<string, Array<string>>()
	const positional: Array<string> = []
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] ?? ""
		if (arg.startsWith("--")) {
			const value = argv[i + 1]
			// Every option takes a value; a missing one, or another option in its place, is a usage error.
			if (value === undefined || value.startsWith("--")) {
				console.error(
					`${arg} needs a value\n${"usage: bun run security:local <repo-dir> [--ref <commit>] [--scope <path>]... [--profile quick|standard|deep] [--budget <n>] [--concurrency <n>] [--out <dir>] [--prior <run dir>]"}`,
				)
				process.exit(2)
			}
			flags.set(arg.slice(2), [...(flags.get(arg.slice(2)) ?? []), value])
			i++
		} else positional.push(arg)
	}
	const positiveInt = (name: string, raw: string | undefined): number | undefined => {
		if (raw === undefined) return undefined
		const value = Number(raw)
		if (Number.isSafeInteger(value) && value > 0) return value
		console.error(`--${name} must be a positive integer, got ${JSON.stringify(raw)}`)
		return process.exit(2)
	}
	const one = (name: string) => flags.get(name)?.at(-1)
	const profile = one("profile") ?? "deep"
	if (
		positional[0] === undefined ||
		(profile !== "quick" && profile !== "standard" && profile !== "deep")
	) {
		console.error(
			"usage: bun run security:local <repo-dir> [--ref <commit>] [--scope <path>]... [--profile quick|standard|deep] [--budget <n>] [--out <dir>] [--prior <run dir>]",
		)
		process.exit(2)
	}
	return {
		repoDir: resolve(positional[0]),
		ref: one("ref") ?? "HEAD",
		scope: (flags.get("scope") ?? []).map((path) => path.replace(/\/+$/, "")),
		profile,
		budget: positiveInt("budget", one("budget")) ?? null,
		out: one("out"),
		prior: one("prior"),
		concurrency: positiveInt("concurrency", one("concurrency")) ?? 4,
		discoveryModel: one("discovery-model"),
		validationModel: one("validation-model"),
	}
}

const git = (dir: string, args: ReadonlyArray<string>) => {
	const result = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
	return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" }
}

const bounded = (text: string) => {
	const bytes = Buffer.from(text, "utf8")
	return bytes.length <= MAX_OUTPUT_BYTES
		? { text, truncated: false }
		: { text: bytes.subarray(0, MAX_OUTPUT_BYTES).toString("utf8"), truncated: true }
}

const safePath = (path: string | undefined) =>
	path === undefined || path === "" || path === "."
		? Effect.succeed(undefined)
		: isSafeRelativePath(path.replace(/\/+$/, ""))
			? Effect.succeed(path.replace(/\/+$/, ""))
			: Effect.fail(new SourceReadError({ message: `not a safe repository-relative path: ${path}` }))

/** git over the clone, at the run's commit only. */
const localSource = (dir: string, sha: string): SourceReaderApi => ({
	readFile: (path, start, end) =>
		Effect.flatMap(safePath(path), (safe) => {
			const result = git(dir, ["show", `${sha}:${safe ?? ""}`])
			if (result.status !== 0)
				return Effect.fail(
					new SourceReadError({
						message: `cannot read ${path}: ${result.stderr.trim().slice(0, 200)}`,
					}),
				)
			const lines = result.stdout.split("\n")
			const body = lines
				.slice(start - 1, end)
				.map((line, i) => `${start + i}\t${line}`)
				.join("\n")
			return Effect.succeed(bounded(`${path} (${lines.length} lines)\n${body}`))
		}),
	grep: (pattern, path) =>
		Effect.flatMap(safePath(path), (safe) => {
			const result = git(dir, [
				"grep",
				"-n",
				"-I",
				"-E",
				"--no-color",
				"-e",
				pattern,
				sha,
				"--",
				...(safe === undefined ? [] : [safe]),
			])
			if (result.status > 1)
				return Effect.fail(
					new SourceReadError({ message: `grep failed: ${result.stderr.trim().slice(0, 200)}` }),
				)
			return Effect.succeed(bounded(result.stdout.replaceAll(`${sha}:`, "")))
		}),
	listFiles: (path) =>
		Effect.flatMap(safePath(path), (safe) =>
			Effect.succeed(
				bounded(
					git(dir, [
						"ls-tree",
						"-r",
						"--name-only",
						sha,
						"--",
						...(safe === undefined ? [] : [safe]),
					]).stdout,
				),
			),
		),
	nearby: (path, basename) =>
		Effect.succeed(
			bounded(
				git(dir, ["ls-tree", "-r", "--name-only", sha])
					.stdout.split("\n")
					.filter(
						(file) =>
							file.startsWith(`${path}/`) || file === basename || file.endsWith(`/${basename}`),
					)
					.join("\n"),
			),
		),
	log: (path) =>
		Effect.flatMap(safePath(path), (safe) =>
			Effect.succeed(
				bounded(
					git(dir, [
						"log",
						"--format=%h %ad %s",
						"--date=short",
						"-n",
						"40",
						sha,
						"--",
						...(safe === undefined ? [] : [safe]),
					]).stdout,
				),
			),
		),
})

const nextRunDir = (repo: string) => {
	const root = join(homedir(), "security-audit-skill", repo)
	const taken = existsSync(root)
		? readdirSync(root).map((name) => Number(/^run-(\d+)$/.exec(name)?.[1] ?? 0))
		: []
	return join(root, `run-${Math.max(0, ...taken) + 1}`)
}

const PriorMetadata = Schema.Struct({ run_id: Schema.String, source_ref: Schema.String })

const loadPrior = (dir: string): PriorRun => {
	const metadata = Schema.decodeUnknownSync(PriorMetadata)(
		JSON.parse(readFileSync(join(dir, "run-metadata.json"), "utf8")),
	)
	return {
		runId: metadata.run_id,
		sourceRef: metadata.source_ref,
		ledger: Schema.decodeUnknownSync(Ledger)(
			JSON.parse(readFileSync(join(dir, "coverage-ledger.json"), "utf8")),
		),
		findings: Schema.decodeUnknownSync(Findings)(
			JSON.parse(readFileSync(join(dir, "findings.json"), "utf8")),
		),
	}
}

/** The skill's run directory, written as each shared file changes. */
const fileStore = (out: string): AuditStoreApi => {
	const write = (name: string, value: string) => Effect.sync(() => writeFileSync(join(out, name), value))
	const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`
	return {
		saveMetadata: (metadata) => write("run-metadata.json", json(metadata)),
		saveArchitecture: (_, md) => write("architecture.md", md),
		saveLedger: (_, ledger) => write("coverage-ledger.json", json(ledger)),
		// findings.json keeps the skill's shape; the estimates are Maple's, in a file of their own.
		saveFindings: (_, findings, estimates) =>
			Effect.all([
				write("findings.json", json(findings)),
				write("estimated-severity.json", json(Object.fromEntries(estimates))),
			]).pipe(Effect.asVoid),
		saveReports: (_, reports) =>
			Effect.all([
				write("REPORT.md", reports.report),
				write("FINDINGS-DETAIL.md", reports.findingsDetail),
				write("NEEDS-VALIDATION.md", reports.needsValidation),
			]).pipe(Effect.asVoid),
		recordEvent: (_, event) =>
			Effect.sync(() => {
				appendFileSync(
					join(out, "events.jsonl"),
					`${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`,
				)
				const line =
					event._tag === "Agent"
						? `${event.agentId.padEnd(18)} ${event.outcome}${event.usage === undefined ? "" : ` (${event.usage.inputTokens} in / ${event.usage.outputTokens} out${event.usage.costUsd === undefined ? "" : `, $${event.usage.costUsd.toFixed(3)}`})`}${event.message === undefined ? "" : `: ${event.message.slice(0, 160)}`}`
						: event._tag === "Phase"
							? `== ${event.phase}: ${event.detail}`
							: `-- ${event.message}`
				return line
			}).pipe(Effect.flatMap((line) => Console.log(line))),
	}
}

const main = async () => {
	const args = parseArgs(process.argv.slice(2))
	if (!process.env.OPENROUTER_API_KEY) {
		console.error(
			"OPENROUTER_API_KEY is not set; run through `bun run security:local`, which loads the root .env.local.",
		)
		process.exit(1)
	}
	const sha = git(args.repoDir, ["rev-parse", "--verify", `${args.ref}^{commit}`]).stdout.trim()
	if (sha === "") {
		console.error(`cannot resolve ${args.ref} in ${args.repoDir}`)
		process.exit(1)
	}
	const repo = basename(args.repoDir)
	const out = resolve(args.out ?? nextRunDir(repo))
	mkdirSync(out, { recursive: true })
	const prior = args.prior === undefined ? null : loadPrior(resolve(args.prior))
	// A failed diff (a prior commit this clone lacks) counts as everything changed.
	const diff =
		prior === null
			? undefined
			: git(args.repoDir, ["diff", "--name-only", "--no-renames", prior.sourceRef, sha])
	const changedSincePrior = changedMatcher(
		diff === undefined
			? []
			: diff.status === 0
				? diff.stdout.split("\n").filter(Boolean)
				: [EVERYTHING_CHANGED],
	)

	const env = { ...process.env }
	if (args.discoveryModel !== undefined) env.MAPLE_AUDIT_DISCOVERY_MODEL_OPENROUTER = args.discoveryModel
	if (args.validationModel !== undefined) env.MAPLE_AUDIT_VALIDATION_MODEL_OPENROUTER = args.validationModel
	const runId = basename(out)
	const program = Effect.gen(function* () {
		const settings = yield* loadLlmSettings
		const tags = { surface: "chat" as const, orgId: "local-security-audit", sessionId: `audit-${runId}` }
		const models = {
			discovery: resolveSecurityAuditModel(settings, "discovery", tags),
			validation: resolveSecurityAuditModel(settings, "validation", tags),
		}
		yield* Console.log(`Auditing ${repo} at ${sha.slice(0, 12)} (${args.profile}) into ${out}`)
		yield* Console.log(`discovery: ${models.discovery.name}, validation: ${models.validation.name}`)
		const agents = yield* makeAuditAgents(models, localSource(args.repoDir, sha)).pipe(
			Effect.provide(layerLlm(settings)),
		)
		const input: AuditRunInput = {
			runId,
			repo,
			target:
				args.scope.length === 0
					? `the repository ${repo} at commit ${sha}, read through your tools`
					: `the repository ${repo} at commit ${sha}, read through your tools; this run is scoped to ${args.scope.join(", ")}, so map those paths and only what they depend on or are reached from`,
			sourceRef: sha,
			profile: args.profile,
			scopePaths: args.scope,
			budget: args.budget,
			execution: {
				_tag: "Unavailable",
				blocker:
					"this runner has no OS-enforced sandbox (no network isolation, resource limits or scratch-only writes)",
			},
			toolGuidance: AUDIT_TOOL_GUIDANCE,
			prior,
			changedSincePrior,
			concurrency: args.concurrency,
		}
		return yield* runAudit(input).pipe(
			// The script composes the engine with its host here, at its entry point.
			// oxlint-disable-next-line effecttsgo/strict-effect-provide
			Effect.provide(
				Layer.mergeAll(Layer.succeed(AuditAgents, agents), Layer.succeed(AuditStore, fileStore(out))),
			),
		)
	})
	const result = await Effect.runPromise(
		program.pipe(
			// A CLI script: this is its entry point.
			// oxlint-disable-next-line effecttsgo/strict-effect-provide
			Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
			Effect.provideService(References.MinimumLogLevel, "Warn"),
		),
	)

	console.log(
		`\n${result.status} after ${result.invocations} agent invocations; ${result.findings.length} records`,
	)
	for (const name of ["validate-findings.cjs", "validate-coverage-ledger.cjs"]) {
		const file = name === "validate-findings.cjs" ? "findings.json" : "coverage-ledger.json"
		const check = spawnSync("node", [join(SKILL_DIR, name), join(out, file)], { encoding: "utf8" })
		console.log(`${name}: ${(check.stdout || check.stderr).trim()}`)
		// Output the skill's own validator rejects fails the run, not only its log.
		if (check.status !== 0) process.exitCode = 1
	}
	console.log(`report: ${join(out, "REPORT.md")}`)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	void main()
}
