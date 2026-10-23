/**
 * Read-only source access for audit agents. `SourceReader` is the port: the local runner answers
 * it with git over a clone, a deployed run with the repository sandbox. Every tool reads the one
 * commit the run is pinned to, and every answer is bounded so a single call cannot fill a context.
 */
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

const answer = (effect: Effect.Effect<SourceOutput, SourceReadError>) =>
	effect.pipe(
		Effect.map(render),
		Effect.mapError((error) => ({ message: error.message })),
	)

/** The toolkit's handlers over the `SourceReader` the run provides. */
export const auditToolHandlers = (source: SourceReaderApi) =>
	toolHandlersWithContent(AUDIT_TOOLKIT, {
		read_file: ({ path, start_line, end_line }) => {
			const start = Math.max(1, Math.floor(start_line ?? 1))
			const end = Math.min(
				Math.floor(end_line ?? start + MAX_READ_LINES - 1),
				start + MAX_READ_LINES - 1,
			)
			return answer(source.readFile(path, start, Math.max(start, end)))
		},
		grep: ({ pattern, path }) => answer(source.grep(pattern, path)),
		list_files: ({ path }) => answer(source.listFiles(path === "." ? undefined : path)),
		git_log: ({ path }) => answer(source.log(path === "." ? undefined : path)),
	})
