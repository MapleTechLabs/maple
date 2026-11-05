/**
 * `bun run security:local <repo-dir> [options]`: one security-audit run of Cloudflare's skill over a
 * local clone, with the same engine, prompts and agents a deployed run uses. Source is read with
 * git at one commit. Target code runs only with `--executor`, in the execution sandbox that
 * `bun run --cwd apps/sandbox executor:local <repo-dir>` serves. The run directory has the skill's
 * own layout, and the upstream validators check it at the end.
 *
 * Options: --ref <commit> (HEAD) · --scope <path> (repeatable) · --profile quick|standard|deep (deep)
 * · --budget <invocations> · --out <dir> (~/security-audit-skill/<repo>/run-<N>) · --prior <run dir>
 * · --concurrency <n> (4) · --discovery-model <id> · --validation-model <id> · --executor <url>
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
import {
	Clock,
	ConfigProvider,
	Console,
	DateTime,
	Effect,
	Layer,
	Option,
	References,
	Schema,
	Array as Arr,
	Record as Rec,
	String as Str,
} from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { type ExecutorTransport, SandboxClientError } from "@maple/backend/sandbox/client"
import { makeExecutor } from "@maple/backend/services/sandbox/ExecutorService"
import {
	EXECUTOR_DESTROY_PATH,
	EXECUTOR_PREPARE_PATH,
	EXECUTOR_RELEASE_PATH,
	EXECUTOR_RUN_PATH,
	ExecutorDestroyRequest,
	ExecutorDestroyResponse,
	ExecutorPrepareRequest,
	ExecutorPrepareResponse,
	ExecutorReleaseRequest,
	ExecutorReleaseResponse,
	ExecutorRunRequest,
	ExecutorRunResponse,
} from "@maple/domain/executor"
import { OrgId } from "@maple/domain/http"
import { SandboxCheckout } from "@maple/domain/sandbox"
import { makeAuditAgents } from "../src/security-audit/agents"
import {
	type AuditExecutionApi,
	AuditExecutionError,
	EXECUTION_TOOL_GUIDANCE,
	executionPolicy,
} from "../src/security-audit/execution"
import { AUDIT_TOOL_GUIDANCE, SourceReadError, type SourceReaderApi } from "../src/security-audit/source"
import { layerLlm, loadLlmSettings, resolveSecurityAuditModel } from "../src/platform/Llm"

const MAX_OUTPUT_BYTES = 48 * 1024
const decodeJson = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown))
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const encodePrettyJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown, { space: 2 }))
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
	/** `executor:local`'s address; without it nothing executes. */
	readonly executor: string | undefined
}

const parseArgs = (argv: ReadonlyArray<string>): Args => {
	const flags = new Map<string, Array<string>>()
	const positional: Array<string> = []
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] ?? ""
		if (Str.startsWith("--")(arg)) {
			const value = argv[i + 1]
			// Every option takes a value; a missing one, or another option in its place, is a usage error.
			if (value === undefined || Str.startsWith("--")(value)) {
				console.error(
					`${arg} needs a value\n${"usage: bun run security:local <repo-dir> [--ref <commit>] [--scope <path>]... [--profile quick|standard|deep] [--budget <n>] [--concurrency <n>] [--out <dir>] [--prior <run dir>]"}`,
				)
				process.exit(2)
			}
			flags.set(Str.slice(2)(arg), [...(flags.get(Str.slice(2)(arg)) ?? []), value])
			i++
		} else positional.push(arg)
	}
	const positiveInt = (name: string, raw: string | undefined): number | undefined => {
		if (raw === undefined) return undefined
		const value = Number(raw)
		if (Number.isSafeInteger(value) && value > 0) return value
		console.error(`--${name} must be a positive integer, got ${encodeJson(raw)}`)
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
		scope: Arr.map(flags.get("scope") ?? [], (path) => Str.replace(/\/+$/, "")(path)),
		profile,
		budget: positiveInt("budget", one("budget")) ?? null,
		out: one("out"),
		prior: one("prior"),
		concurrency: positiveInt("concurrency", one("concurrency")) ?? 4,
		discoveryModel: one("discovery-model"),
		validationModel: one("validation-model"),
		executor: one("executor"),
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
		? Effect.undefined
		: isSafeRelativePath(Str.replace(/\/+$/, "")(path))
			? Effect.succeed(Str.replace(/\/+$/, "")(path))
			: Effect.fail(new SourceReadError({ message: `not a safe repository-relative path: ${path}` }))

/** git over the clone, at the run's commit only. */
const localSource = (dir: string, sha: string): SourceReaderApi => ({
	readFile: (path, start, end) =>
		Effect.flatMap(safePath(path), (safe) => {
			const result = git(dir, ["show", `${sha}:${safe ?? ""}`])
			if (result.status !== 0)
				return Effect.fail(
					new SourceReadError({
						message: `cannot read ${path}: ${Str.slice(0, 200)(Str.trim(result.stderr))}`,
					}),
				)
			const lines = Str.split("\n")(result.stdout)
			const body = Arr.join(
				Arr.map(lines.slice(start - 1, end), (line, i) => `${start + i}\t${line}`),
				"\n",
			)
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
					new SourceReadError({
						message: `grep failed: ${Str.slice(0, 200)(Str.trim(result.stderr))}`,
					}),
				)
			return Effect.succeed(bounded(Str.replaceAll(`${sha}:`, "")(result.stdout)))
		}),
	listFiles: (path) =>
		Effect.map(safePath(path), (safe) =>
			bounded(
				git(dir, ["ls-tree", "-r", "--name-only", sha, "--", ...(safe === undefined ? [] : [safe])])
					.stdout,
			),
		),
	nearby: (path, basename) =>
		Effect.succeed(
			bounded(
				Arr.join(
					Arr.filter(
						Str.split("\n")(git(dir, ["ls-tree", "-r", "--name-only", sha]).stdout),
						(file) =>
							Str.startsWith(`${path}/`)(file) ||
							file === basename ||
							Str.endsWith(`/${basename}`)(file),
					),
					"\n",
				),
			),
		),
	log: (path) =>
		Effect.map(safePath(path), (safe) =>
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
})

const nextRunDir = (repo: string) => {
	const root = join(homedir(), "security-audit-skill", repo)
	const taken = existsSync(root)
		? Arr.map(readdirSync(root), (name) => Number(/^run-(\d+)$/.exec(name)?.[1] ?? 0))
		: []
	return join(root, `run-${Math.max(0, ...taken) + 1}`)
}

const PriorMetadata = Schema.Struct({ run_id: Schema.String, source_ref: Schema.String })

const loadPrior = (dir: string): PriorRun => {
	const metadata = Schema.decodeUnknownSync(PriorMetadata)(
		decodeJson(readFileSync(join(dir, "run-metadata.json"), "utf8")),
	)
	return {
		runId: metadata.run_id,
		sourceRef: metadata.source_ref,
		ledger: Schema.decodeUnknownSync(Ledger)(
			decodeJson(readFileSync(join(dir, "coverage-ledger.json"), "utf8")),
		),
		findings: Schema.decodeUnknownSync(Findings)(
			decodeJson(readFileSync(join(dir, "findings.json"), "utf8")),
		),
	}
}

/** The skill's run directory, written as each shared file changes. */
const fileStore = (out: string): AuditStoreApi => {
	const write = (name: string, value: string) => Effect.sync(() => writeFileSync(join(out, name), value))
	const json = (value: unknown) => `${encodePrettyJson(value)}\n`
	return {
		saveMetadata: (metadata) => write("run-metadata.json", json(metadata)),
		saveArchitecture: (_, md) => write("architecture.md", md),
		saveLedger: (_, ledger) => write("coverage-ledger.json", json(ledger)),
		// findings.json keeps the skill's shape; the estimates are Maple's, in a file of their own.
		saveFindings: (_, findings, estimates) =>
			Effect.all([
				write("findings.json", json(findings)),
				write("estimated-severity.json", json(Rec.fromEntries(estimates))),
			]).pipe(Effect.asVoid),
		saveReports: (_, reports) =>
			Effect.all([
				write("REPORT.md", reports.report),
				write("FINDINGS-DETAIL.md", reports.findingsDetail),
				write("NEEDS-VALIDATION.md", reports.needsValidation),
			]).pipe(Effect.asVoid),
		recordEvent: (_, event) =>
			DateTime.now.pipe(
				Effect.map((now) => {
					appendFileSync(
						join(out, "events.jsonl"),
						`${encodeJson({ at: DateTime.formatIso(now), ...event })}\n`,
					)
					const line =
						event._tag === "Agent"
							? `${Str.padEnd(18)(event.agentId)} ${event.outcome}${event.usage === undefined ? "" : ` (${event.usage.inputTokens} in / ${event.usage.outputTokens} out${event.usage.costUsd === undefined ? "" : `, $${event.usage.costUsd.toFixed(3)}`})`}${event.message === undefined ? "" : `: ${Str.slice(0, 160)(event.message)}`}`
							: event._tag === "Phase"
								? `== ${event.phase}: ${event.detail}`
								: `-- ${event.message}`
					return line
				}),
				Effect.flatMap((line) => Console.log(line)),
			),
	}
}

/** The executor ignores the org; a local run still names one for the same calls a deployed run makes. */
const LOCAL_ORG = Schema.decodeSync(OrgId)("org_local_security_audit")

/** The executor wire over HTTP to `executor:local`, decoded with the same schemas as the binding. */
const httpTransport = (base: string): ExecutorTransport => {
	const send = <Body, A>(path: string, body: Body, answer: Schema.Decoder<A>) =>
		HttpClient.execute(
			HttpClientRequest.post(`${base}${path}`).pipe(HttpClientRequest.bodyJsonUnsafe(body)),
		).pipe(
			Effect.flatMap((response) => response.json),
			Effect.flatMap((json) => Schema.decodeEffect(answer)(json)),
			Effect.mapBoth({
				onSuccess: Option.some,
				onFailure: (error) => new SandboxClientError({ message: `executor:local: ${String(error)}` }),
			}),
			// A CLI script: each call is its own entry point.
			// oxlint-disable-next-line effecttsgo/strict-effect-provide
			Effect.provide(FetchHttpClient.layer),
		)
	return {
		available: true,
		prepare: (request) =>
			send(
				EXECUTOR_PREPARE_PATH,
				Schema.encodeSync(ExecutorPrepareRequest)(request),
				ExecutorPrepareResponse,
			),
		run: (request) =>
			send(EXECUTOR_RUN_PATH, Schema.encodeSync(ExecutorRunRequest)(request), ExecutorRunResponse),
		release: (request) =>
			send(
				EXECUTOR_RELEASE_PATH,
				Schema.encodeSync(ExecutorReleaseRequest)(request),
				ExecutorReleaseResponse,
			),
		destroy: (request) =>
			send(
				EXECUTOR_DESTROY_PATH,
				Schema.encodeSync(ExecutorDestroyRequest)(request),
				ExecutorDestroyResponse,
			),
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
	const sha = Str.trim(git(args.repoDir, ["rev-parse", "--verify", `${args.ref}^{commit}`]).stdout)
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
				? Arr.filter(Str.split("\n")(diff.stdout), Boolean)
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
		yield* Console.log(`Auditing ${repo} at ${Str.slice(0, 12)(sha)} (${args.profile}) into ${out}`)
		yield* Console.log(`discovery: ${models.discovery.name}, validation: ${models.validation.name}`)
		// Prepared before any agent, as a deployed run does; the stand-in gateway serves this clone.
		const executor =
			args.executor === undefined
				? undefined
				: makeExecutor({
						transport: httpTransport(Str.replace(/\/+$/u, "")(args.executor)),
						checkout: () =>
							Effect.succeed(
								new SandboxCheckout({
									repository: repo,
									sha,
									remoteUrl: "local",
									token: "local",
								}),
							),
					})
		const target = { repository: repo, sha }
		// Every run its own executor: run directories share the name `run` across eval cases.
		const executorRun = `${repo}-${Str.slice(0, 8)(sha)}-${yield* Clock.currentTimeMillis}`
		// A failed prepare leaves the run source-only, as a deployed run does.
		const installs =
			executor === undefined
				? undefined
				: yield* executor.prepare(LOCAL_ORG, executorRun, target).pipe(
						Effect.tapError((error) =>
							Console.log(`executor not prepared, running source-only: ${error.message}`),
						),
						Effect.orElseSucceed(() => undefined),
					)
		if (installs !== undefined)
			yield* Console.log(
				`executor prepared: ${
					Arr.join(
						Arr.map(
							installs,
							(install) => `${install.dir} ${install.manager} ${install.outcome}`,
						),
						", ",
					) || "no lockfile"
				}`,
			)
		const execution: AuditExecutionApi | undefined =
			executor === undefined || installs === undefined
				? undefined
				: {
						run: (agentId, command) =>
							executor
								.run(LOCAL_ORG, executorRun, target, { ...command, agentId })
								.pipe(
									Effect.mapError(
										(error) => new AuditExecutionError({ message: error.message }),
									),
								),
						release: (agentId) => executor.release(executorRun, agentId),
					}
		const agents = yield* makeAuditAgents(models, localSource(args.repoDir, sha), execution).pipe(
			// oxlint-disable-next-line effecttsgo/strict-effect-provide -- script entry point: the local run composes its own LLM layer
			Effect.provide(layerLlm(settings)),
		)
		const input: AuditRunInput = {
			runId,
			repo,
			target:
				args.scope.length === 0
					? `the repository ${repo} at commit ${sha}, read through your tools`
					: `the repository ${repo} at commit ${sha}, read through your tools; this run is scoped to ${Arr.join(args.scope, ", ")}, so map those paths and only what they depend on or are reached from`,
			sourceRef: sha,
			profile: args.profile,
			scopePaths: args.scope,
			budget: args.budget,
			execution:
				installs === undefined
					? {
							_tag: "Unavailable",
							blocker:
								"this run has no OS-enforced sandbox (start executor:local and pass --executor to execute)",
						}
					: executionPolicy(installs),
			toolGuidance:
				installs === undefined
					? AUDIT_TOOL_GUIDANCE
					: `${AUDIT_TOOL_GUIDANCE} ${EXECUTION_TOOL_GUIDANCE}`,
			prior,
			changedSincePrior,
			concurrency: args.concurrency,
		}
		return yield* runAudit(input).pipe(
			// The script composes the engine with its host here, at its entry point.
			Effect.provide([Layer.succeed(AuditAgents, agents), Layer.succeed(AuditStore, fileStore(out))]),
			Effect.ensuring(executor === undefined ? Effect.void : executor.destroy(executorRun)),
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
		console.log(`${name}: ${Str.trim(check.stdout || check.stderr)}`)
		// Output the skill's own validator rejects fails the run, not only its log.
		if (check.status !== 0) process.exitCode = 1
	}
	console.log(`report: ${join(out, "REPORT.md")}`)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	void main()
}
