/**
 * Run the pull request reviewer against a real pull request, on this machine, without the stack.
 *
 *   bun run --cwd apps/ai review:local MapleTechLabs/maple 965
 *   bun run --cwd apps/ai review:local https://github.com/octo/shop/pull/12 --model anthropic/claude-sonnet-5
 *   bun run --cwd apps/ai review:local MapleTechLabs/maple 965 --prompt-file /tmp/review-prompt.md
 *
 * What is real: the `pr-review` agent record (prompt, budget, allowlist), the engine loop, the
 * model (OpenRouter, from `.env.local`), `submit_review` and its normalization, and the check run
 * and inline comments `buildPublication` would post. The two diff tools answer through the same
 * renderers production uses, over the pull request fetched with your `gh` login.
 *
 * What is local: the source tools read a clone on disk at the head commit through git instead of
 * the sandbox container, `sandbox_exec` accepts only read-only git, and the telemetry tools answer
 * that no warehouse is attached. Nothing is posted to GitHub; the run writes `review.md`,
 * `transcript.md` and `report.json` under `scripts/.pr-review-runs/`.
 *
 * Flags: `--repo-dir <path>` (a clone of the repository; default: this checkout when it is the same
 * repository, else a cached clone), `--model <openrouter id>`, `--prompt-file <path>` (replaces the
 * system prompt), `--out <dir>`.
 */
import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { ChatMessage } from "@maple/domain/chat-session"
import {
	GitCommitSha,
	OrgId,
	type PullRequestFile,
	PullRequestFileStatus,
	type SubmitPrReviewRequest,
	UserId,
} from "@maple/domain/http"
import { buildPublication, buildReviewKickoff } from "@maple/backend/services/pr-review/PrReviewService"
import type { TenantContext } from "@maple/backend/services/auth/tenant-context"
import { Effect, Option, References, Schema } from "effect"
import { AGENTS } from "@/chat/agents"
import type { ChatTurnEvent } from "@/chat/events"
import { prReviewToolNames } from "@/chat/permissions"
import { PR_REVIEW_CLOSE_OUT_PROMPT } from "@/chat/prompts"
import { runChatTurn } from "@/chat/run"
import { makeRunUsage } from "@/chat/tools"
import type { McpToolExecutorApi } from "@/mcp/dispatcher"
import { annotatePatch, renderChangedFiles, renderFileDiff } from "@/mcp/tools/pull-request"
import type { McpToolResult } from "@/mcp/tools/types"
import { layerLlm, resolveTriageModel, type ResolvedModel } from "@/platform/Llm"

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))

// Arguments

interface Args {
	readonly owner: string
	readonly repo: string
	readonly number: number
	readonly repoDir: string | undefined
	readonly model: string | undefined
	readonly promptFile: string | undefined
	readonly out: string
}

const usage = () => {
	console.error(
		"usage: review:local <owner/repo> <number> | <pull request url> [--repo-dir p] [--model id] [--prompt-file p] [--out dir]",
	)
	process.exit(2)
}

const parseArgs = (argv: ReadonlyArray<string>): Args => {
	const flags = new Map<string, string>()
	const positional: Array<string> = []
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] ?? ""
		if (arg.startsWith("--")) {
			const value = argv[i + 1]
			if (value === undefined) usage()
			flags.set(arg.slice(2), value ?? "")
			i++
		} else positional.push(arg)
	}
	const fromUrl = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(positional[0] ?? "")
	const [owner, repo] = fromUrl ? [fromUrl[1], fromUrl[2]] : (positional[0] ?? "").split("/")
	const number = Number(fromUrl ? fromUrl[3] : positional[1])
	if (!owner || !repo || !Number.isInteger(number) || number < 1) usage()
	return {
		owner: owner ?? "",
		repo: repo ?? "",
		number,
		repoDir: flags.get("repo-dir"),
		model: flags.get("model"),
		promptFile: flags.get("prompt-file"),
		out: resolve(flags.get("out") ?? join(SCRIPT_DIR, ".pr-review-runs")),
	}
}

// Processes

const run = (cmd: ReadonlyArray<string>, cwd?: string) => {
	const [bin = "", ...rest] = cmd
	const proc = spawnSync(bin, rest, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
	return {
		ok: proc.status === 0,
		code: proc.status,
		stdout: proc.stdout ?? "",
		stderr: proc.stderr ?? "",
	}
}

const must = (cmd: ReadonlyArray<string>, cwd?: string): string => {
	const result = run(cmd, cwd)
	if (!result.ok) {
		console.error(`\n${cmd.join(" ")} failed:\n${result.stderr.trim()}`)
		process.exit(1)
	}
	return result.stdout
}

// GitHub, through the user's own `gh` login

const GhPullRequest = Schema.Struct({
	number: Schema.Number,
	title: Schema.NullOr(Schema.String),
	body: Schema.NullOr(Schema.String),
	html_url: Schema.String,
	draft: Schema.optionalKey(Schema.Boolean),
	user: Schema.NullOr(Schema.Struct({ login: Schema.String })),
	head: Schema.Struct({
		sha: GitCommitSha,
		ref: Schema.String,
		repo: Schema.NullOr(Schema.Struct({ full_name: Schema.String })),
	}),
	base: Schema.Struct({ sha: GitCommitSha, ref: Schema.String }),
})

const GhFile = Schema.Struct({
	filename: Schema.String,
	previous_filename: Schema.optionalKey(Schema.String),
	status: Schema.String,
	additions: Schema.Number,
	deletions: Schema.Number,
	patch: Schema.optionalKey(Schema.String),
})
const GhFilePages = Schema.Array(Schema.Array(GhFile))

const decodePullRequestJson = Schema.decodeUnknownOption(Schema.fromJsonString(GhPullRequest))
const decodeFilePagesJson = Schema.decodeUnknownOption(Schema.fromJsonString(GhFilePages))

const orExit = <A>(value: Option.Option<A>, what: string): A =>
	Option.getOrElse(value, () => {
		console.error(`Unexpected ${what} payload from GitHub`)
		return process.exit(1)
	})

const isFileStatus = Schema.is(PullRequestFileStatus)

const fetchPullRequest = (args: Args) => {
	const slug = `repos/${args.owner}/${args.repo}/pulls/${args.number}`
	const pr = orExit(decodePullRequestJson(must(["gh", "api", slug])), "pull request")
	const pages = orExit(
		decodeFilePagesJson(must(["gh", "api", "--paginate", "--slurp", `${slug}/files?per_page=100`])),
		"files",
	)
	const files: ReadonlyArray<PullRequestFile> = pages.flat().map((file) => ({
		path: file.filename,
		previousPath: file.previous_filename ?? null,
		status: isFileStatus(file.status) ? file.status : "changed",
		additions: file.additions,
		deletions: file.deletions,
		patch: file.patch ?? null,
	}))
	return { pr, files }
}

// A local clone standing in for the sandbox

const GITHUB_REMOTE = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?$/

/** Parsed with a fixed pattern and compared as strings, so no argument ever becomes regex. */
const remoteMatches = (url: string, owner: string, repo: string) => {
	const match = GITHUB_REMOTE.exec(url.trim())
	return (
		match !== null &&
		match[1]?.toLowerCase() === owner.toLowerCase() &&
		match[2]?.toLowerCase() === repo.toLowerCase()
	)
}

/** The clone to read from, and the remote in it that is the pull request's repository. */
const resolveClone = (args: Args): { readonly dir: string; readonly remote: string } => {
	const candidates = [
		args.repoDir,
		run(["git", "rev-parse", "--show-toplevel"], SCRIPT_DIR).stdout.trim() || undefined,
		join(homedir(), ".cache", "maple-pr-review", `${args.owner}__${args.repo}`),
	].filter((dir): dir is string => dir !== undefined)
	for (const dir of candidates) {
		if (!existsSync(join(dir, ".git")) && !existsSync(join(dir, "HEAD"))) continue
		for (const line of run(["git", "remote", "-v"], dir).stdout.split("\n")) {
			const [name, url] = line.split(/\s+/)
			if (name && url && remoteMatches(url, args.owner, args.repo)) return { dir, remote: name }
		}
		if (dir === args.repoDir) {
			console.error(`${dir} has no remote pointing at ${args.owner}/${args.repo}`)
			process.exit(1)
		}
	}
	const cache = join(homedir(), ".cache", "maple-pr-review", `${args.owner}__${args.repo}`)
	console.log(`Cloning ${args.owner}/${args.repo} into ${cache} (once)…`)
	mkdirSync(join(homedir(), ".cache", "maple-pr-review"), { recursive: true })
	must(["gh", "repo", "clone", `${args.owner}/${args.repo}`, cache, "--", "--quiet"])
	return { dir: cache, remote: "origin" }
}

const hasCommit = (dir: string, sha: string) => run(["git", "cat-file", "-e", `${sha}^{commit}`], dir).ok

/** Fetch the head (and base) the way GitHub exposes them, which also covers a fork's head. */
const ensureCommits = (dir: string, remote: string, number: number, shas: ReadonlyArray<string>) => {
	if (shas.every((sha) => hasCommit(dir, sha))) return
	console.log(`Fetching pull request #${number} into ${dir}…`)
	must(["git", "fetch", "--quiet", remote, `pull/${number}/head`], dir)
	const missing = shas.filter((sha) => !hasCommit(dir, sha))
	if (missing.length > 0) must(["git", "fetch", "--quiet", remote, ...missing], dir)
}

// The local tool executor

const text = (lines: ReadonlyArray<string>): McpToolResult => ({
	content: [{ type: "text", text: lines.join("\n") }],
})
const failure = (message: string): McpToolResult => ({
	content: [{ type: "text", text: message }],
	isError: true,
})

const NumberLike = Schema.Union([Schema.Number, Schema.String])

/** Every parameter the local tools read, decoded once; anything malformed reads as absent. */
const LocalToolParams = Schema.Struct({
	repository: Schema.optionalKey(Schema.String),
	number: Schema.optionalKey(NumberLike),
	path: Schema.optionalKey(Schema.String),
	glob: Schema.optionalKey(Schema.String),
	ref: Schema.optionalKey(Schema.String),
	pattern: Schema.optionalKey(Schema.String),
	query: Schema.optionalKey(Schema.String),
	case_sensitive: Schema.optionalKey(Schema.Boolean),
	context_lines: Schema.optionalKey(NumberLike),
	start_line: Schema.optionalKey(NumberLike),
	end_line: Schema.optionalKey(NumberLike),
	command: Schema.optionalKey(Schema.String),
	args: Schema.optionalKey(Schema.Array(Schema.String)),
})
type LocalToolParams = typeof LocalToolParams.Type
const decodeParams = Schema.decodeUnknownOption(LocalToolParams)

const str = (value: string | undefined): string | undefined =>
	value !== undefined && value.trim() !== "" ? value.trim() : undefined
const num = (value: number | string | undefined): number | undefined => {
	const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN
	return Number.isFinite(parsed) ? Math.floor(parsed) : undefined
}

/** A pathspec glob as a regex over the full path: `**` crosses directories, `*` and `?` do not. */
const globToRegex = (glob: string): RegExp =>
	new RegExp(
		`^${glob
			.split("**")
			.map((part) =>
				part
					.replace(/[.+^${}()|[\]\\]/g, "\\$&")
					.replace(/\*/g, "[^/]*")
					.replace(/\?/g, "[^/]"),
			)
			.join(".*")}$`,
	)

const unsafePath = (path: string) => path.startsWith("/") || path.split("/").includes("..")
const unsafeRef = (ref: string) => ref.startsWith("-") || /[\s~^:?*[\\]|\.\./.test(ref)

/** Git subcommands `sandbox_exec` may run here: reads of history, never anything that writes. */
const READ_ONLY_GIT = new Set([
	"log",
	"show",
	"blame",
	"diff",
	"grep",
	"ls-tree",
	"cat-file",
	"rev-parse",
	"shortlog",
])

const TELEMETRY_TOOLS = new Set([
	"list_services",
	"get_service_top_operations",
	"explore_attributes",
	"search_traces",
	"service_map",
	"list_metrics",
	"audit_setup",
	"get_instrumentation_recommendations",
])

const makeExecutor = (input: {
	readonly repository: string
	readonly number: number
	readonly files: ReadonlyArray<PullRequestFile>
	readonly dir: string
	readonly headSha: string
}): McpToolExecutorApi => {
	const git = (args: ReadonlyArray<string>) => run(["git", ...args], input.dir)
	const refOf = (params: LocalToolParams): string | McpToolResult => {
		const ref = str(params.ref)
		if (ref === undefined) return input.headSha
		if (unsafeRef(ref)) return failure("ref must be a branch, tag, or commit SHA")
		const resolved = git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])
		return resolved.ok
			? resolved.stdout.trim()
			: failure(`No ref '${ref}' exists in ${input.repository}.`)
	}
	const pathspec = (params: LocalToolParams): Array<string> => {
		const path = str(params.path)
		const glob = str(params.glob)
		if (glob !== undefined)
			return [`:(glob)${path === undefined ? "" : `${path.replace(/\/$/, "")}/`}${glob}`]
		return path === undefined ? [] : [path]
	}
	const readFile = (params: LocalToolParams): McpToolResult => {
		const path = str(params.path)
		if (path === undefined || unsafePath(path)) return failure("path must be repository-relative")
		const ref = refOf(params)
		if (typeof ref !== "string") return ref
		const shown = git(["show", `${ref}:${path}`])
		if (!shown.ok) return failure(`No file '${path}' exists in '${input.repository}' at '${ref}'.`)
		const all = shown.stdout.split("\n")
		const start = Math.max(1, num(params.start_line) ?? 1)
		const end = Math.min(all.length, num(params.end_line) ?? start + 399, start + 399)
		return text([
			`## ${input.repository}/${path}`,
			`Ref: \`${ref}\` · Lines: ${start}-${end}/${all.length}`,
			"```",
			...all.slice(start - 1, end).map((line, i) => `${start + i}: ${line}`),
			"```",
		])
	}
	const grep = (params: LocalToolParams, pattern: string | undefined, fixed: boolean): McpToolResult => {
		if (pattern === undefined) return failure("pattern must be 1-512 characters")
		const ref = refOf(params)
		if (typeof ref !== "string") return ref
		const context = Math.min(5, Math.max(0, num(params.context_lines) ?? 0))
		const insensitive = params.case_sensitive === false
		const result = git([
			"grep",
			"-n",
			"-I",
			...(fixed ? ["-F"] : ["-E"]),
			...(insensitive ? ["-i"] : []),
			...(context > 0 ? [`-C${context}`] : []),
			"-e",
			pattern,
			ref,
			"--",
			...pathspec(params),
		])
		if (result.code !== 0 && result.code !== 1)
			return failure(`git grep failed: ${result.stderr.trim().slice(0, 500)}`)
		const lines = result.stdout
			.split("\n")
			.filter(Boolean)
			.map((line) => line.replace(`${ref}:`, ""))
		return text([
			`## grep: \`${pattern}\``,
			`Repository: ${input.repository} · Ref: \`${ref}\``,
			...(lines.length === 0 ? ["No matches."] : ["```", ...lines.slice(0, 200), "```"]),
			...(lines.length > 200 ? ["Showing the first 200 lines; narrow the pattern, path or glob."] : []),
		])
	}

	const dispatch = (name: string, params: LocalToolParams): McpToolResult => {
		if (TELEMETRY_TOOLS.has(name)) {
			return text([
				"No warehouse is attached to this local review run, so live telemetry is unavailable.",
				"Judge instrumentation from the code, and do not file a finding that depends on live data.",
			])
		}
		const repository = str(params.repository)
		if (
			name !== "list_source_repositories" &&
			repository !== undefined &&
			repository.toLowerCase() !== input.repository.toLowerCase()
		) {
			return failure(
				`Repository '${repository}' is not connected; only ${input.repository} is available in this run.`,
			)
		}
		switch (name) {
			case "pr_changed_files":
				return num(params.number) === input.number
					? renderChangedFiles(input.repository, input.number, input.files)
					: failure(`Only pull request #${input.number} is available in this run.`)
			case "pr_file_diff":
				return num(params.number) === input.number
					? renderFileDiff(input.files, str(params.path) ?? "")
					: failure(`Only pull request #${input.number} is available in this run.`)
			case "list_source_repositories":
				return text([
					"## Connected source repositories (1)",
					`- ${input.repository} (head \`${input.headSha}\`)`,
				])
			case "sandbox_read_file":
			case "read_source_file":
				return readFile(params)
			case "sandbox_grep":
				return grep(params, str(params.pattern), false)
			case "search_source_code":
				return grep(params, str(params.query), true)
			case "sandbox_list_files": {
				const ref = refOf(params)
				if (typeof ref !== "string") return ref
				// `ls-tree` takes path prefixes, not pathspec magic, so the glob is applied here.
				const path = str(params.path)?.replace(/\/$/, "")
				const glob = str(params.glob)
				const listed = git([
					"ls-tree",
					"-r",
					"--name-only",
					ref,
					"--",
					...(path === undefined ? [] : [path]),
				])
				const matcher =
					glob === undefined
						? undefined
						: globToRegex(path === undefined ? glob : `${path}/${glob}`)
				const entries = listed.stdout
					.split("\n")
					.filter((entry) => entry !== "" && (matcher === undefined || matcher.test(entry)))
				return text([
					`## Files at \`${ref}\` (${entries.length})`,
					...entries.slice(0, 500),
					...(entries.length > 500 ? ["…truncated at 500; narrow the path or glob."] : []),
				])
			}
			case "sandbox_exec": {
				const command = str(params.command)
				const args = params.args ?? []
				if (
					command !== "git" ||
					!READ_ONLY_GIT.has(args[0] ?? "") ||
					args.some((arg) => arg.startsWith("--output") || arg === "-c")
				) {
					return failure(
						`The local runner only executes read-only git (${[...READ_ONLY_GIT].join(", ")}).`,
					)
				}
				const result = git(args)
				return text([
					`Exit: ${result.code ?? -1}`,
					"```",
					result.stdout.slice(0, 48_000),
					result.stderr.slice(0, 2_000),
					"```",
				])
			}
			default:
				return failure(`${name} is not available in the local runner.`)
		}
	}
	return {
		execute: (_tenant, name, raw) =>
			Effect.sync(() =>
				dispatch(
					name,
					Option.getOrElse(decodeParams(raw), () => ({})),
				),
			),
	}
}

// Reporting

interface ToolRecord {
	readonly name: string
	readonly input: unknown
	output?: string
	isError?: boolean
}

const renderOutput = (value: unknown): string =>
	typeof value === "string" ? value : JSON.stringify(value, null, 2)

/** The new-side lines of a file's diff, keyed by number, as the agent saw them. */
const newSideLines = (file: PullRequestFile | undefined): Map<number, string> => {
	const lines = new Map<number, string>()
	if (file?.patch == null) return lines
	for (const line of annotatePatch(file.patch).lines) {
		const match = /^\s*(\d+) ([+ ]) (.*)$/.exec(line)
		if (match) lines.set(Number(match[1]), `${match[2]} ${match[3]}`)
	}
	return lines
}

/**
 * One local review. `injected.model` replaces the resolved model, which is how the wiring is
 * exercised with a scripted model when no provider key is at hand.
 */
export const reviewLocally = async (
	argv: ReadonlyArray<string>,
	injected: { readonly model?: ResolvedModel } = {},
): Promise<string | undefined> => {
	const args = parseArgs(argv)
	if (injected.model === undefined && !process.env.OPENROUTER_API_KEY) {
		console.error(
			"OPENROUTER_API_KEY is not set; run through `bun run review:local`, which loads the root .env.local.",
		)
		process.exit(1)
	}
	if (args.model !== undefined) process.env.MAPLE_TRIAGE_MODEL_OPENROUTER = args.model
	const promptOverride = args.promptFile === undefined ? undefined : readFileSync(args.promptFile, "utf8")
	const repository = `${args.owner}/${args.repo}`

	console.log(`Fetching ${repository}#${args.number}…`)
	const { pr, files } = fetchPullRequest(args)
	const clone = resolveClone(args)
	ensureCommits(clone.dir, clone.remote, args.number, [pr.head.sha, pr.base.sha])

	const orgId = Schema.decodeSync(OrgId)("org_local_review")
	const sessionId = `${orgId}:pr-${randomUUID()}`
	const messageId = randomUUID()
	const tenant: TenantContext = {
		orgId,
		userId: Schema.decodeSync(UserId)("internal-service"),
		roles: [],
		authMode: "self_hosted",
	}
	const env = { ...process.env }
	const model =
		injected.model ?? resolveTriageModel(env, { surface: "chat", orgId, sessionId, turnId: messageId })
	const kickoff = buildReviewKickoff({
		repository,
		number: args.number,
		url: pr.html_url,
		title: pr.title,
		authorLogin: pr.user?.login ?? null,
		headRef: pr.head.ref,
		baseRef: pr.base.ref,
		headSha: pr.head.sha,
		baseSha: pr.base.sha,
		fork: pr.head.repo !== null && pr.head.repo.full_name.toLowerCase() !== repository.toLowerCase(),
		body: pr.body,
	})
	const executor = makeExecutor({
		repository,
		number: args.number,
		files,
		dir: clone.dir,
		headSha: pr.head.sha,
	})

	const tools: Array<ToolRecord> = []
	const byCall = new Map<string, ToolRecord>()
	let prose = ""
	let submitted: SubmitPrReviewRequest | undefined
	let endReason = "unknown"
	const usage = makeRunUsage()
	const started = Date.now()

	const append = (event: ChatTurnEvent) => {
		if (event.task !== undefined) return
		switch (event.type) {
			case "text-delta":
				prose += event.text
				process.stdout.write(`\x1b[2m${event.text}\x1b[0m`)
				return
			case "tool-call": {
				const record: ToolRecord = { name: event.name, input: event.input }
				tools.push(record)
				byCall.set(event.callId, record)
				process.stdout.write(`\n→ ${event.name} ${JSON.stringify(event.input).slice(0, 160)}\n`)
				return
			}
			case "tool-result": {
				const record = byCall.get(event.callId)
				if (record === undefined) return
				record.output = renderOutput(event.output)
				record.isError = event.isError === true
				process.stdout.write(`  ${record.isError ? "✗" : "←"} ${record.output.length} chars\n`)
				return
			}
			case "turn-end":
				endReason = event.error === undefined ? event.reason : `${event.reason}: ${event.error}`
				return
			default:
				return
		}
	}

	const pass = (turn: {
		readonly text: string
		readonly history: ReadonlyArray<ChatMessage>
		readonly closeOut?: boolean
	}) =>
		runChatTurn({
			sessionId,
			messageId,
			tenant,
			origin: { kind: "autonomous" },
			toolExecutor: executor,
			model,
			// A `pr-` session is never offered `submit_diagnosis`, so this is never called.
			submitDiagnosis: () => Effect.void,
			submitReview: (_orgId, _reviewId, request) =>
				Effect.sync(() => {
					submitted = request
				}),
			...(turn.closeOut === true ? { closeOut: true } : undefined),
			...(promptOverride === undefined ? undefined : { promptOverride }),
			text: turn.text,
			history: turn.history,
			usage,
			holdsTurn: () => true,
			append,
		}).pipe(
			Effect.provide(layerLlm(env)),
			// The engine logs every tool execution at info; the progress lines above are the readable view.
			Effect.provideService(References.MinimumLogLevel, "Warn"),
			Effect.catchCause((cause) =>
				Effect.sync(() => {
					const detail = String(cause)
					endReason = detail.includes("requires more credits")
						? "run failed: the OpenRouter key in .env.local is out of credits"
						: `run failed: ${detail.slice(0, 400)}`
				}),
			),
		)

	console.log(
		`Reviewing with ${model.name} (budget: ${AGENTS["pr-review"].budget.maxToolCalls} calls, tools: ${prReviewToolNames().length})\n`,
	)
	await Effect.runPromise(pass({ text: kickoff, history: [] }))

	let closedOut = false
	if (submitted === undefined && !endReason.startsWith("run failed")) {
		closedOut = true
		console.log("\n\nNo review submitted; running the close-out pass…")
		const evidence = tools.map(
			(tool) =>
				`[${tool.name} ${JSON.stringify(tool.input)}]\n${(tool.output ?? "(no result)").slice(0, 4_000)}`,
		)
		const now = Date.now()
		await Effect.runPromise(
			pass({
				text: PR_REVIEW_CLOSE_OUT_PROMPT,
				closeOut: true,
				history: [
					new ChatMessage({
						id: "kickoff",
						role: "user",
						text: kickoff,
						toolCalls: [],
						createdAt: now,
						startSeq: 1,
					}),
					new ChatMessage({
						id: "pass",
						role: "assistant",
						text: [prose, "Evidence gathered so far:", ...evidence].filter(Boolean).join("\n\n"),
						toolCalls: [],
						createdAt: now,
						startSeq: 2,
					}),
				],
			}),
		)
	}

	// Output
	const durationMs = Date.now() - started
	const stamp = new Date(started).toISOString().replace(/[:.]/g, "-")
	const dir = join(args.out, `${args.owner}__${args.repo}__${args.number}__${stamp}`)
	mkdirSync(dir, { recursive: true })
	const header = [
		`# Local review of ${repository}#${args.number} at \`${pr.head.sha.slice(0, 12)}\``,
		"",
		`${pr.title ?? "(untitled)"} · ${pr.html_url}`,
		"",
		"| Model | Duration | Tool calls | Input tokens | Output tokens | Cached input | Ended | Close-out |",
		"| --- | --- | --- | --- | --- | --- | --- | --- |",
		`| ${model.name} | ${Math.round(durationMs / 1000)} s | ${tools.length} | ${usage.input} | ${usage.output} | ${usage.cacheRead} | ${endReason} | ${closedOut ? "yes" : "no"} |`,
		...(promptOverride === undefined ? [] : ["", `Prompt override: \`${args.promptFile}\``]),
		"",
	]
	const transcript = [
		`# Transcript: ${repository}#${args.number}`,
		"",
		...tools.flatMap((tool, i) => [
			`## ${i + 1}. ${tool.name}${tool.isError ? " (error)" : ""}`,
			"```json",
			JSON.stringify(tool.input, null, 2),
			"```",
			"```",
			tool.output ?? "(no result)",
			"```",
			"",
		]),
		"## Assistant prose",
		"",
		prose || "(none)",
	]
	writeFileSync(join(dir, "transcript.md"), transcript.join("\n"))

	if (submitted === undefined) {
		writeFileSync(
			join(dir, "review.md"),
			[...header, "**No review was submitted.** See `transcript.md`."].join("\n"),
		)
		writeFileSync(
			join(dir, "report.json"),
			JSON.stringify(
				{
					pr: pr.html_url,
					headSha: pr.head.sha,
					model: model.name,
					usage,
					durationMs,
					endReason,
					tools: tools.map(({ name, input, isError, output }) => ({
						name,
						input,
						isError,
						outputChars: output?.length ?? 0,
					})),
				},
				null,
				2,
			),
		)
		console.log(`\n\nNo review submitted (${endReason}). Transcript: ${join(dir, "transcript.md")}`)
		return undefined
	}

	const report = submitted.report
	const publication = buildPublication({
		number: args.number,
		headSha: pr.head.sha,
		report,
		partial: submitted.partial === true,
	})
	const filesByPath = new Map(files.map((file) => [file.path, file]))
	const anchored = publication.annotations.map((annotation) => {
		const lines = newSideLines(filesByPath.get(annotation.path))
		return {
			annotation,
			onDiff: lines.has(annotation.startLine),
			context: [-2, -1, 0, 1, 2].flatMap((d) => {
				const line = lines.get(annotation.startLine + d)
				return line === undefined
					? []
					: [`${String(annotation.startLine + d).padStart(5)} ${d === 0 ? ">" : " "}${line}`]
			}),
		}
	})
	const offDiff = anchored.filter((entry) => !entry.onDiff)

	const review = [
		...header,
		`## Check run: ${publication.title} (${publication.conclusion})`,
		"",
		publication.summary,
		"",
		`## Findings (${anchored.length}${offDiff.length > 0 ? `, ${offDiff.length} off the diff` : ""})`,
		"",
		...(offDiff.length > 0
			? [
					"> A finding marked **off the diff** names a line that is not on the new side of this pull request's diff. GitHub rejects an inline comment there, and the review falls back to its body alone.",
					"",
				]
			: []),
		...anchored.flatMap(({ annotation, onDiff, context }) => [
			`### ${annotation.path}:${annotation.startLine}${annotation.endLine !== annotation.startLine ? `-${annotation.endLine}` : ""} · ${annotation.level}${onDiff ? "" : " · **off the diff**"}`,
			"",
			`**${annotation.title}**`,
			"",
			annotation.message,
			...(context.length > 0 ? ["", "```diff", ...context, "```"] : []),
			"",
		]),
		`## Review body${publication.reviewBody === null ? " (none: no inline comments to post)" : ""}`,
		"",
		publication.reviewBody ?? "",
	]
	writeFileSync(join(dir, "review.md"), review.join("\n"))
	writeFileSync(
		join(dir, "report.json"),
		JSON.stringify(
			{
				pr: pr.html_url,
				headSha: pr.head.sha,
				model: model.name,
				usage,
				durationMs,
				endReason,
				closedOut,
				promptFile: args.promptFile ?? null,
				report,
				publication,
				offDiff: offDiff.map(({ annotation }) => `${annotation.path}:${annotation.startLine}`),
				tools: tools.map(({ name, input, isError, output }) => ({
					name,
					input,
					isError,
					outputChars: output?.length ?? 0,
				})),
			},
			null,
			2,
		),
	)

	console.log(
		`\n\n${report.verdict} · ${report.findings.length} findings${offDiff.length > 0 ? ` (${offDiff.length} off the diff)` : ""} · ${tools.length} tool calls · ${Math.round(durationMs / 1000)} s`,
	)
	console.log(`Review:     ${join(dir, "review.md")}`)
	console.log(`Transcript: ${join(dir, "transcript.md")}`)
	return dir
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await reviewLocally(process.argv.slice(2))
}
