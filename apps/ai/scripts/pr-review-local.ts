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
 * the sandbox container, `sandbox_exec` accepts only read-only git (plus `node`/`bun` with
 * `--allow-exec`), and the telemetry tools answer
 * that no warehouse is attached. Nothing is posted to GitHub; the run writes `review.md`,
 * `transcript.md` and `report.json` under `scripts/.pr-review-runs/`.
 *
 * Flags: `--repo-dir <path>` (a clone of the repository; default: this checkout when it is the same
 * repository, else a cached clone), `--model <openrouter id>`, `--prompt-file <path>` (replaces the
 * system prompt), `--out <dir>`, `--allow-exec` (lets `sandbox_exec` run `node` and `bun` in the
 * commit's worktree, as production's sandbox does; this runs model-written code on your machine).
 */
import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { ChatMessage, ChatToolCall } from "@maple/domain/chat-session"
import {
	GitCommitSha,
	OrgId,
	type PullRequestContext,
	type PullRequestFile,
	PrReviewId,
	PullRequestFileStatus,
	type SubmitPrReviewRequest,
	UserId,
} from "@maple/domain/http"
import {
	buildPublication,
	buildReviewKickoff,
	PR_REVIEW_RULE_FILES,
	type RepositoryRuleFile,
} from "@maple/backend/services/pr-review/PrReviewService"
import type { TenantContext } from "@maple/backend/services/auth/tenant-context"
import { Effect, Option, References, Schema } from "effect"
import { AGENTS } from "@/chat/agents"
import type { ChatTurnEvent } from "@/chat/events"
import { withToolTranscript } from "@/chat/close-out"
import { PR_REVIEW_TOOLS } from "@/chat/permissions"
import { PR_REVIEW_CLOSE_OUT_PROMPT } from "@/chat/prompts"
import { makeReviewCoverage } from "@/chat/review-coverage"
import { makeReviewLedger } from "@/chat/review-ledger"
import { runChatTurn } from "@/chat/run"
import { makeRunUsage, savedFindingsRequest } from "@/chat/tools"
import type { McpToolExecutorApi } from "@/mcp/dispatcher"
import {
	annotatePatch,
	renderChangedFiles,
	renderFileDiffs,
	renderPullRequestContext,
} from "@/mcp/tools/pull-request"
import type { McpToolResult } from "@/mcp/tools/types"
import { layerLlm, resolveReviewModel, type ResolvedModel } from "@/platform/Llm"

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
	/** Write the summary comment to the pull request with the caller's own `gh` login. */
	readonly post: boolean
	/** Review a local `base..head` range instead of a pull request; nothing is fetched from GitHub. */
	readonly range: string | undefined
	/** Let `sandbox_exec` run `node` and `bun`, which production's sandbox offers. Off by default. */
	readonly allowExec: boolean
}

const usage = () => {
	console.error(
		"usage: review:local <owner/repo> <number> | <pull request url> [--repo-dir p] [--model id] [--prompt-file p] [--out dir] [--post] [--allow-exec] | <owner/repo> --range base..head --repo-dir p",
	)
	process.exit(2)
}

const parseArgs = (argv: ReadonlyArray<string>): Args => {
	const flags = new Map<string, string>()
	const positional: Array<string> = []
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] ?? ""
		if (arg === "--post" || arg === "--allow-exec") {
			flags.set(arg.slice(2), "true")
		} else if (arg.startsWith("--")) {
			const value = argv[i + 1]
			if (value === undefined) usage()
			flags.set(arg.slice(2), value ?? "")
			i++
		} else positional.push(arg)
	}
	const fromUrl = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(positional[0] ?? "")
	const [owner, repo] = fromUrl ? [fromUrl[1], fromUrl[2]] : (positional[0] ?? "").split("/")
	const range = flags.get("range")
	const number = range === undefined ? Number(fromUrl ? fromUrl[3] : positional[1]) : 1
	if (!owner || !repo || !Number.isInteger(number) || number < 1) usage()
	if (range !== undefined && (!flags.has("repo-dir") || !/^[^\s.][^\s]*\.\.[^\s.][^\s]*$/.test(range))) {
		console.error("--range takes base..head and needs --repo-dir, the clone the range lives in")
		process.exit(2)
	}
	return {
		owner: owner ?? "",
		repo: repo ?? "",
		number,
		repoDir: flags.get("repo-dir"),
		model: flags.get("model"),
		promptFile: flags.get("prompt-file"),
		out: resolve(flags.get("out") ?? join(SCRIPT_DIR, ".pr-review-runs")),
		post: flags.get("post") === "true",
		range,
		allowExec: flags.get("allow-exec") === "true",
	}
}

// Processes

/**
 * The rule files at the base, as production's kickoff states them. A file absent from the base is
 * skipped; one present but unreadable makes the whole read `undefined`, as a failed read does in
 * production, so the agent reads the rules itself instead of reviewing without them.
 */
const readRules = (dir: string, baseSha: string): ReadonlyArray<RepositoryRuleFile> | undefined => {
	const files: Array<RepositoryRuleFile> = []
	for (const path of PR_REVIEW_RULE_FILES) {
		if (!run(["git", "cat-file", "-e", `${baseSha}:${path}`], dir).ok) continue
		const shown = run(["git", "show", `${baseSha}:${path}`], dir)
		if (!shown.ok) return undefined
		files.push({ path, content: shown.stdout })
	}
	return files
}

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

/** A model-written script: no inherited secrets, a wall-clock limit like the sandbox's. */
const runScript = (cmd: ReadonlyArray<string>, cwd: string) => {
	const [bin = "", ...rest] = cmd
	const proc = spawnSync(bin, rest, {
		cwd,
		encoding: "utf8",
		timeout: 30_000,
		maxBuffer: 8 * 1024 * 1024,
		env: { PATH: process.env.PATH ?? "", HOME: cwd },
	})
	return { code: proc.status, stdout: proc.stdout ?? "", stderr: proc.stderr ?? "" }
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

const GhContextCommits = Schema.Array(
	Schema.Struct({ sha: Schema.String, commit: Schema.Struct({ message: Schema.String }) }),
)
const GhContextComments = Schema.Array(
	Schema.Struct({
		user: Schema.NullOr(Schema.Struct({ login: Schema.String })),
		body: Schema.optionalKey(Schema.NullOr(Schema.String)),
		path: Schema.optionalKey(Schema.String),
		line: Schema.optionalKey(Schema.NullOr(Schema.Number)),
	}),
)
const GhContextChecks = Schema.Struct({
	check_runs: Schema.Array(
		Schema.Struct({
			name: Schema.String,
			status: Schema.String,
			conclusion: Schema.NullOr(Schema.String),
			output: Schema.optionalKey(Schema.Struct({ title: Schema.NullOr(Schema.String) })),
		}),
	),
})

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

// A local range standing in for a pull request

/** git's one-letter `--name-status` code as the provider's file status. */
const fileStatus = (code: string): PullRequestFile["status"] => {
	switch (code) {
		case "A":
			return "added"
		case "M":
			return "modified"
		case "D":
			return "removed"
		default:
			return "changed"
	}
}

/**
 * A `base..head` range of a local clone, shaped like the pull request GitHub would have shown:
 * the merge base as the base, one entry per changed file, and each file's hunks as its patch.
 * For building review fixtures without opening a pull request anywhere.
 */
const readRange = (args: Args, dir: string) => {
	const [baseRef = "", headRef = ""] = (args.range ?? "").split("..")
	const head = must(["git", "rev-parse", "--verify", `${headRef}^{commit}`], dir).trim()
	const base = must(["git", "merge-base", baseRef, head], dir).trim()
	const sha = (value: string) => orExit(Schema.decodeUnknownOption(GitCommitSha)(value), "commit")
	const subject = must(["git", "log", "-1", "--format=%s", head], dir).trim()
	const body = must(["git", "log", "-1", "--format=%b", head], dir).trim()
	const author = must(["git", "log", "-1", "--format=%an", head], dir).trim()
	const statuses = new Map(
		must(["git", "diff", "--no-renames", "--name-status", base, head], dir)
			.split("\n")
			.filter(Boolean)
			.map((line) => {
				const [status = "", path = ""] = line.split("\t")
				return [path, fileStatus(status.charAt(0))] as const
			}),
	)
	const files: ReadonlyArray<PullRequestFile> = must(
		["git", "diff", "--no-renames", "--numstat", base, head],
		dir,
	)
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const [added = "", deleted = "", path = ""] = line.split("\t")
			const binary = added === "-"
			const raw = binary
				? ""
				: must(["git", "diff", "--no-renames", "-U3", base, head, "--", path], dir)
			const hunks = raw.indexOf("\n@@")
			return {
				path,
				previousPath: null,
				status: statuses.get(path) ?? "changed",
				additions: binary ? 0 : Number(added),
				deletions: binary ? 0 : Number(deleted),
				patch: binary || hunks < 0 ? null : raw.slice(hunks + 1).replace(/\n$/, ""),
			}
		})
	return {
		pr: {
			number: args.number,
			title: subject,
			body,
			html_url: `local range ${args.range}`,
			user: { login: author },
			head: { sha: sha(head), ref: headRef, repo: null },
			base: { sha: sha(base), ref: baseRef },
		},
		files,
	}
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
	paths: Schema.optionalKey(Schema.Array(Schema.String)),
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

/** Tools this runner answers from the checkout; the rest of the review allowlist reads telemetry. */
const SOURCE_TOOLS = new Set([
	"pr_changed_files",
	"pr_context",
	"pr_file_diff",
	"sandbox_grep",
	"sandbox_list_files",
	"sandbox_read_file",
	"sandbox_exec",
	"list_source_repositories",
	"search_source_code",
	"read_source_file",
])

const TELEMETRY_TOOLS = new Set(PR_REVIEW_TOOLS.filter((name) => !SOURCE_TOOLS.has(name)))

/**
 * Flags that make a read-only git subcommand read or write outside the object store: host files
 * (`--no-index`, `--contents`), external programs (`--ext-diff`, `--textconv`, a pager), or an
 * output file.
 */
const UNSAFE_GIT_ARG =
	/^(--no-index|--contents|--ext-diff|--textconv|--open-files-in-pager|-O|--output|--exec|--upload-pack)/

const unsafeGitArg = (arg: string): boolean =>
	UNSAFE_GIT_ARG.test(arg) || arg.startsWith("/") || arg.startsWith("~") || arg.split(/[/:]/).includes("..")

/** The same answer `pr_context` gives in production, read with the caller's own `gh` login. */
const fetchPullRequestContext = (args: Args, headSha: string): PullRequestContext => {
	const slug = `repos/${args.owner}/${args.repo}`
	// Decoded at the boundary, one schema per read.
	const read = <A>(schema: Schema.Decoder<A>, path: string): A =>
		Schema.decodeUnknownSync(schema)(JSON.parse(must(["gh", "api", path])))
	const commits = read(GhContextCommits, `${slug}/pulls/${args.number}/commits?per_page=100`)
	const comments = [
		...read(
			GhContextComments,
			`${slug}/pulls/${args.number}/comments?per_page=100&sort=created&direction=desc`,
		),
		...read(GhContextComments, `${slug}/issues/${args.number}/comments?per_page=100`),
	]
	// The pull request's own head: the first page of commits stops at 100.
	const checks = read(GhContextChecks, `${slug}/commits/${headSha}/check-runs?per_page=100`).check_runs
	return {
		commits: commits.map((commit) => ({ sha: commit.sha, message: commit.commit.message })),
		// Maple's own review comments (one per review) are left out, as the production tool leaves out the App's.
		comments: comments
			.filter((comment) => !(comment.body ?? "").includes("<!-- maple-pr-review"))
			.map((comment) => ({
				author: comment.user?.login ?? "(deleted user)",
				path: comment.path ?? null,
				line: comment.line ?? null,
				body: comment.body ?? "",
			})),
		checks: checks.map((check) => ({
			name: check.name,
			status: check.status,
			conclusion: check.conclusion,
			title: check.output?.title ?? null,
		})),
	}
}

const makeExecutor = (input: {
	readonly repository: string
	readonly number: number
	readonly files: ReadonlyArray<PullRequestFile>
	readonly context: PullRequestContext | undefined
	readonly dir: string
	readonly headSha: string
	readonly allowExec: boolean
}): { readonly executor: McpToolExecutorApi; readonly cleanup: () => void } => {
	const git = (args: ReadonlyArray<string>) => run(["git", ...args], input.dir)
	// `sandbox_exec` runs where production runs it: inside a checkout of the commit, so a bare
	// `git log` or `git grep` sees the pull request's head rather than whatever the local clone has
	// checked out. One detached worktree per commit, made on first use, removed by `cleanup`.
	const worktrees = new Map<string, string>()
	const worktreeAt = (sha: string): string => {
		const known = worktrees.get(sha)
		if (known !== undefined) return known
		const path = join(homedir(), ".cache", "maple-pr-review", "worktrees", sha)
		if (!existsSync(path)) must(["git", "worktree", "add", "--detach", "--quiet", path, sha], input.dir)
		worktrees.set(sha, path)
		return path
	}
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
			case "pr_context":
				return num(params.number) !== input.number
					? failure(`Only pull request #${input.number} is available in this run.`)
					: input.context === undefined
						? text(["A local range run has no pull request, so there is no context to read."])
						: renderPullRequestContext(input.repository, input.number, input.context)
			case "pr_file_diff":
				return num(params.number) === input.number
					? renderFileDiffs(input.repository, input.number, input.files, [
							...(params.paths ?? []),
							...(str(params.path) === undefined ? [] : [str(params.path) ?? ""]),
						])
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
				if (input.allowExec && (command === "node" || command === "bun")) {
					const ref = refOf(params)
					if (typeof ref !== "string") return ref
					const result = runScript([command, ...args], worktreeAt(ref))
					return text([
						`Exit: ${result.code ?? -1}`,
						"```",
						result.stdout.slice(0, 48_000),
						result.stderr.slice(0, 2_000),
						"```",
					])
				}
				if (command !== "git" || !READ_ONLY_GIT.has(args[0] ?? "") || args.some(unsafeGitArg)) {
					return failure(
						`The local runner only executes read-only git (${[...READ_ONLY_GIT].join(", ")}).`,
					)
				}
				const ref = refOf(params)
				if (typeof ref !== "string") return ref
				const result = run(["git", ...args], worktreeAt(ref))
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
	const executor: McpToolExecutorApi = {
		execute: (_tenant, name, raw) =>
			Effect.sync(() =>
				dispatch(
					name,
					Option.getOrElse(decodeParams(raw), () => ({})),
				),
			),
	}
	const cleanup = () => {
		for (const path of worktrees.values()) run(["git", "worktree", "remove", "--force", path], input.dir)
	}
	return { executor, cleanup }
}

// Posting, as the caller

const GhComment = Schema.Struct({
	id: Schema.Number,
	html_url: Schema.String,
	body: Schema.optionalKey(Schema.NullOr(Schema.String)),
	user: Schema.NullOr(Schema.Struct({ login: Schema.String })),
})
const decodeCommentPagesJson = Schema.decodeUnknownOption(
	Schema.fromJsonString(Schema.Array(Schema.Array(GhComment))),
)
const decodeCommentJson = Schema.decodeUnknownOption(Schema.fromJsonString(GhComment))

/**
 * The same sticky comment the App would write, written with the caller's `gh` login so the
 * rendering can be checked on GitHub. Only a comment the caller wrote is edited.
 */
const postSummaryComment = (
	args: Args,
	comment: { readonly marker: string; readonly body: string },
): string => {
	const me = must(["gh", "api", "user", "--jq", ".login"]).trim()
	const slug = `repos/${args.owner}/${args.repo}`
	const pages = orExit(
		decodeCommentPagesJson(
			must([
				"gh",
				"api",
				"--paginate",
				"--slurp",
				`${slug}/issues/${args.number}/comments?per_page=100`,
			]),
		),
		"comments",
	)
	const existing = pages.flat().find((c) => (c.body ?? "").includes(comment.marker) && c.user?.login === me)
	mkdirSync(args.out, { recursive: true })
	const bodyFile = join(args.out, `.comment-${randomUUID()}.json`)
	writeFileSync(bodyFile, JSON.stringify({ body: comment.body }))
	const written = must(
		existing === undefined
			? ["gh", "api", "-X", "POST", `${slug}/issues/${args.number}/comments`, "--input", bodyFile]
			: ["gh", "api", "-X", "PATCH", `${slug}/issues/comments/${existing.id}`, "--input", bodyFile],
	)
	rmSync(bodyFile, { force: true })
	return orExit(decodeCommentJson(written), "comment").html_url
}

// Reporting

interface ToolRecord {
	readonly id: string
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
	if (args.model !== undefined) process.env.MAPLE_REVIEW_MODEL_OPENROUTER = args.model
	const promptOverride = args.promptFile === undefined ? undefined : readFileSync(args.promptFile, "utf8")
	const repository = `${args.owner}/${args.repo}`

	console.log(`Fetching ${repository}#${args.number}…`)
	const clone =
		args.range === undefined ? resolveClone(args) : { dir: args.repoDir ?? "", remote: "origin" }
	const { pr, files } = args.range === undefined ? fetchPullRequest(args) : readRange(args, clone.dir)
	if (args.range === undefined)
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
		injected.model ?? resolveReviewModel(env, { surface: "chat", orgId, sessionId, turnId: messageId })
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
		rules: readRules(clone.dir, pr.base.sha),
	})
	const { executor, cleanup: removeWorktrees } = makeExecutor({
		repository,
		number: args.number,
		files,
		context: args.range === undefined ? fetchPullRequestContext(args, pr.head.sha) : undefined,
		dir: clone.dir,
		headSha: pr.head.sha,
		allowExec: args.allowExec,
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
				const record: ToolRecord = { id: event.callId, name: event.name, input: event.input }
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

	// Shared by the pass and its close-out, as in production.
	const reviewState = { coverage: makeReviewCoverage(kickoff), ledger: makeReviewLedger() }
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
			review: reviewState,
			...(promptOverride === undefined
				? undefined
				: { agent: { ...AGENTS["pr-review"], prompt: promptOverride } }),
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
		`Reviewing with ${model.name} (budget: ${AGENTS["pr-review"].budget.maxToolCalls} calls, tools: ${PR_REVIEW_TOOLS.length})\n`,
	)
	await Effect.runPromise(pass({ text: kickoff, history: [] }))

	let closedOut = false
	// As production does: a pass that failed still gets its close-out, unless the provider itself
	// is what failed, where another call would fail the same way.
	const providerFailed = /out of credits|overloaded|Rate limit|InsufficientPermissions|\b40[123]\b/i.test(
		endReason,
	)
	if (submitted === undefined && !providerFailed) {
		closedOut = true
		console.log("\n\nNo review submitted; running the close-out pass…")
		const now = Date.now()
		await Effect.runPromise(
			pass({
				text: PR_REVIEW_CLOSE_OUT_PROMPT,
				closeOut: true,
				history: withToolTranscript([
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
						text: prose,
						toolCalls: tools.map(
							(tool) =>
								new ChatToolCall({
									id: tool.id,
									name: tool.name,
									input: tool.input,
									...(tool.output === undefined ? undefined : { output: tool.output }),
									...(tool.isError === undefined ? undefined : { isError: tool.isError }),
								}),
						),
						createdAt: now,
						startSeq: 2,
					}),
				]),
			}),
		)
	}

	// As production does: findings the pass saved are filed as a partial when no report landed.
	if (submitted === undefined && reviewState.ledger.findings().length > 0) {
		submitted = savedFindingsRequest({
			findings: reviewState.ledger.findings(),
			unreviewed: reviewState.coverage.unread(),
			modelName: model.name,
			usage,
		})
	}

	removeWorktrees()

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
		// Each run is its own review, so a posted run gets a comment of its own.
		reviewId: Schema.decodeSync(PrReviewId)(randomUUID()),
		repositoryUrl: `https://github.com/${repository}`,
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
		"# The pull request comment",
		"",
		publication.summaryComment.body.replace(publication.summaryComment.marker, "").trim(),
		"",
		"---",
		"",
		`# Check run: ${publication.title} (${publication.conclusion})`,
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

	if (args.post && args.range === undefined) {
		const url = postSummaryComment(args, publication.summaryComment)
		console.log(`\nPosted the summary comment: ${url}`)
	}
	console.log(
		`\n\n${publication.title.split(" · ")[0]} · ${report.verdict} · ${report.findings.length} findings${offDiff.length > 0 ? ` (${offDiff.length} off the diff)` : ""} · ${tools.length} tool calls · ${Math.round(durationMs / 1000)} s`,
	)
	console.log(`Review:     ${join(dir, "review.md")}`)
	console.log(`Transcript: ${join(dir, "transcript.md")}`)
	return dir
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await reviewLocally(process.argv.slice(2))
}
