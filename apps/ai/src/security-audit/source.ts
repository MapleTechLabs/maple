/**
 * Read-only source access for audit agents. `SourceReader` is the port: the local runner answers
 * it with git over a clone, a deployed run with the repository sandbox. Every tool reads the one
 * commit the run is pinned to, and every answer is bounded so a single call cannot fill a context.
 */
import { SKILL_REFERENCE_FILES } from "@maple/security-audit"
import { Context, Effect, Schema } from "effect"
import { Tool, Toolkit } from "effect/ai"
import { toolHandlersWithContent } from "../platform/genai-spans"

/** What the model sees from one read: the text, cut at the bound, and whether it was cut. */
export interface SourceOutput {
	readonly text: string
	readonly truncated: boolean
}

export class SourceReadError extends Schema.TaggedError<SourceReadError>()(
	"@maple/ai/security-audit/SourceReadError",
	{
		message: Schema.String,
	},
) {}

export interface SourceReaderApi {
	readonly readFile: (
		path: string,
		startLine: number,
		endLine: number,
	) => Effect.Effect<SourceOutput, SourceReadError>
	/** Extended regular expression over tracked files, `path:line:text` per match. */
	readonly grep: (pattern: string, path: string | undefined) => Effect.Effect<SourceOutput, SourceReadError>
	readonly listFiles: (path: string | undefined) => Effect.Effect<SourceOutput, SourceReadError>
	/** Commit history touching a path: reverted fixes and removed secrets live here. */
	readonly log: (path: string | undefined) => Effect.Effect<SourceOutput, SourceReadError>
	/**
	 * One listing for a read that missed: tracked files under `path`, plus every tracked file named
	 * `basename` anywhere in the repository.
	 */
	readonly nearby: (path: string, basename: string) => Effect.Effect<SourceOutput, SourceReadError>
}

export class SourceReader extends Context.Service<SourceReader, SourceReaderApi>()(
	"@maple/ai/security-audit/SourceReader",
) {}

/** Lines one `read_file` call may return. */
export const MAX_READ_LINES = 400

const ToolFailure = Schema.Struct({ message: Schema.String })

const readFileTool = Tool.make("read_file", {
	description: `Read lines of a tracked file at the audited commit, numbered. At most ${MAX_READ_LINES} lines per call.`,
	parameters: Schema.Struct({
		path: Schema.String.annotate({ description: "Repository-relative path" }),
		start_line: Schema.optional(Schema.Number).annotate({
			description: "First line, 1-based (default 1)",
		}),
		end_line: Schema.optional(Schema.Number).annotate({ description: "Last line, inclusive" }),
	}),
	success: Schema.String,
	failure: ToolFailure,
	failureMode: "return",
})

const grepTool = Tool.make("grep", {
	description:
		"Search tracked files at the audited commit with an extended regular expression. Answers path:line:text per match, bounded.",
	parameters: Schema.Struct({
		pattern: Schema.String.annotate({ description: "Extended regular expression (git grep -E)" }),
		path: Schema.optional(Schema.String).annotate({
			description: "Limit to this repository-relative directory or file",
		}),
	}),
	success: Schema.String,
	failure: ToolFailure,
	failureMode: "return",
})

// Every tool takes a required argument: a call with no arguments at all streams from Anthropic models
// without its parameter end, which the engine rejects as a protocol error (seen 2026-10-23).
const listFilesTool = Tool.make("list_files", {
	description: "List tracked files at the audited commit under a directory.",
	parameters: Schema.Struct({
		path: Schema.String.annotate({
			description: 'Repository-relative directory; "." for the whole repository',
		}),
	}),
	success: Schema.String,
	failure: ToolFailure,
	failureMode: "return",
})

const gitLogTool = Tool.make("git_log", {
	description:
		"Recent commits touching a path, newest first, with their messages: reverted fixes and removed secrets show here.",
	parameters: Schema.Struct({
		path: Schema.String.annotate({
			description: 'Repository-relative path; "." for the whole repository',
		}),
	}),
	success: Schema.String,
	failure: ToolFailure,
	failureMode: "return",
})

export const AUDIT_TOOLKIT = Toolkit.make(readFileTool, grepTool, listFilesTool, gitLogTool)

/** How every prompt tells agents to read the target. */
export const AUDIT_TOOL_GUIDANCE =
	"Read the target only through these tools, which read the audited commit: read_file (numbered lines), grep (extended regex, path:line:text), list_files, git_log. Batch independent reads in one turn. They never execute target code and have no network."

const render = (output: SourceOutput) =>
	output.truncated
		? `${output.text}\n[output truncated: narrow the path or pattern]`
		: output.text || "(no output)"

/** What a tool answers the model when it cannot: `failureMode: "return"` hands it this message. */
type ToolFailure = typeof ToolFailure.Type

const answer = (effect: Effect.Effect<SourceOutput, SourceReadError>) =>
	effect.pipe(
		Effect.map(render),
		Effect.mapError((error): ToolFailure => ({ message: error.message })),
	)

/**
 * A model's path as a repository-relative one: a leading `./` or `/` and backslashes are spelling,
 * `..` resolves lexically. "" is the root; undefined when the path climbs out of it.
 */
export const normalizePath = (raw: string): string | undefined =>
	raw
		.trim()
		.replaceAll("\\", "/")
		.split("/")
		.filter((part) => part !== "" && part !== ".")
		.reduce<ReadonlyArray<string> | undefined>(
			(parts, part) =>
				parts === undefined
					? undefined
					: part !== ".."
						? [...parts, part]
						: parts.length === 0
							? undefined
							: parts.slice(0, -1),
			[],
		)
		?.join("/")

const resolvePath = (raw: string): Effect.Effect<string, ToolFailure> => {
	const path = normalizePath(raw)
	return path === undefined
		? Effect.fail({ message: `${raw} leaves the repository; paths are relative to its root` })
		: Effect.succeed(path)
}

/** An optional path tool argument; the root is no path at all. */
const scopePath = (raw: string | undefined) =>
	raw === undefined
		? Effect.succeed(undefined)
		: Effect.map(resolvePath(raw), (path) => (path === "" ? undefined : path))

/** Paths a missed read suggests, at most. */
const MAX_SUGGESTIONS = 10
/** Lines of a directory listing a read of the directory answers with. */
const MAX_LISTING = 200

const listing = (path: string, files: ReadonlyArray<string>, truncated: boolean) =>
	[
		`${path} is a directory. Tracked files under it:`,
		...files.slice(0, MAX_LISTING),
		...(files.length > MAX_LISTING || truncated
			? ["[listing truncated: list_files a subdirectory]"]
			: []),
	].join("\n")

/**
 * A read that failed, answered with what the model can do next: a directory's listing, a note that
 * a skill file is method text, or tracked files sharing the name. One listing call at most.
 */
const missedRead = (source: SourceReaderApi, path: string, error: SourceReadError) =>
	Effect.gen(function* () {
		const basename = path.slice(path.lastIndexOf("/") + 1)
		if (SKILL_REFERENCE_FILES.has(basename))
			return yield* Effect.fail<ToolFailure>({
				message: `${path} is not a file of this repository: ${basename} is the audit's own method text, and what you need from it is already in your prompt. Read the target's files instead.`,
			})
		const found = yield* Effect.result(source.nearby(path, basename))
		if (found._tag === "Failure") return yield* Effect.fail<ToolFailure>({ message: error.message })
		const files = found.success.text.split("\n").filter((line) => line !== "")
		const under = files.filter((file) => file.startsWith(`${path}/`))
		if (under.length > 0) return listing(path, under, found.success.truncated)
		const named = files
			.filter((file) => file === basename || file.endsWith(`/${basename}`))
			.slice(0, MAX_SUGGESTIONS)
		return yield* Effect.fail<ToolFailure>({
			message: [
				error.message,
				named.length === 0
					? `No tracked file is named ${basename}. Use list_files on a parent directory to see what exists.`
					: `Tracked files with the same name:\n${named.join("\n")}`,
			].join("\n"),
		})
	})

/**
 * The toolkit's handlers over the `SourceReader` the run provides. `onCall` runs once per tool
 * call, so the host can tell an agent that read the repository from one that never did.
 */
export const auditToolHandlers = (source: SourceReaderApi, onCall: Effect.Effect<void> = Effect.void) =>
	toolHandlersWithContent(AUDIT_TOOLKIT, {
		read_file: ({ path, start_line, end_line }) =>
			Effect.gen(function* () {
				yield* onCall
				const resolved = yield* resolvePath(path)
				if (resolved === "") return yield* answer(source.listFiles(undefined))
				const start = Math.max(1, Math.floor(start_line ?? 1))
				const end = Math.min(
					Math.floor(end_line ?? start + MAX_READ_LINES - 1),
					start + MAX_READ_LINES - 1,
				)
				const read = yield* Effect.result(source.readFile(resolved, start, Math.max(start, end)))
				return read._tag === "Success"
					? render(read.success)
					: yield* missedRead(source, resolved, read.failure)
			}),
		grep: ({ pattern, path }) =>
			Effect.andThen(
				onCall,
				Effect.flatMap(scopePath(path), (scope) => answer(source.grep(pattern, scope))),
			),
		list_files: ({ path }) =>
			Effect.andThen(
				onCall,
				Effect.flatMap(scopePath(path), (scope) => answer(source.listFiles(scope))),
			),
		git_log: ({ path }) =>
			Effect.andThen(
				onCall,
				Effect.flatMap(scopePath(path), (scope) => answer(source.log(scope))),
			),
	})
