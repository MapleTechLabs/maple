import { Effect, Schema } from "effect"
import {
	ListSourceRepositoriesOutput,
	ReadSourceFileOutput,
	SearchSourceCodeOutput,
} from "@maple/domain/mcp-outputs"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import { VcsSourceService } from "@maple/backend/services/integrations/vcs/VcsSourceService"
import { McpInvalidInputError, type McpToolRegistrar } from "./types"
import { fromVcsLookupError } from "../lib/source-errors"
import * as P from "../lib/params"
import { doc, type DocBlock } from "../lib/tool-doc"

const MAX_FILE_LINES = 400
const MAX_FILE_CHARS = 40_000
const MAX_SNIPPET_CHARS = 2_000

/** GitHub-backed reads: they reach outside Maple's own data. */
const HINTS = { readOnly: true, openWorld: true } as const

const unsafePath = (path: string): boolean =>
	path.startsWith("/") || path.split("/").some((segment) => segment === "..")

const REPOSITORY = P.text("Connected repository in owner/name form")

/** Matches whose line numbers are looked up: each costs one file read against the rate limit. */
const LINE_LOOKUP_MATCHES = 3
const MAX_LINES_PER_MATCH = 5
/** Characters GitHub code search drops from a query, so a query leaning on them can miss. */
const IGNORED_PUNCTUATION = /[.,:;/\\`'"=*!?#$&+^|~<>(){}[\]@]/

/** GitHub's `path:` qualifier names a directory; a file path splits into `path:` plus `filename:`. */
export const splitSearchPath = (raw: string): { readonly dir?: string; readonly filename?: string } => {
	const path = raw.trim().replace(/^\.\//, "").replace(/\/+$/, "")
	const slash = path.lastIndexOf("/")
	const base = path.slice(slash + 1)
	if (!base.includes(".")) return path === "" ? {} : { dir: path }
	return slash === -1 ? { filename: base } : { dir: path.slice(0, slash), filename: base }
}

/** 1-based lines holding the query, else the first snippet line; at most a few. */
export const matchLines = (content: string, query: string, snippet: string | undefined): Array<number> => {
	const lines = content.split("\n")
	const find = (needle: string) =>
		lines.flatMap((line, i) => (line.toLowerCase().includes(needle) ? [i + 1] : []))
	const byQuery = find(query.toLowerCase())
	if (byQuery.length > 0) return byQuery.slice(0, MAX_LINES_PER_MATCH)
	const anchor = snippet?.split("\n").find((line) => line.trim().length > 0)?.trim().toLowerCase()
	return anchor === undefined ? [] : find(anchor).slice(0, MAX_LINES_PER_MATCH)
}

export function registerSourceCodeTools(server: McpToolRegistrar) {
	server.define({
		name: "list_source_repositories",
		title: "List Source Repositories",
		description:
			"List source repositories connected to this Maple organization. Use before source investigation when telemetry does not identify an exact vcs.repository.url.full. Returns only repositories the organization's GitHub App installation can access.",
		parameters: Schema.Struct({}),
		output: ListSourceRepositoriesOutput,
		hints: HINTS,
		phrases: ["Listing repositories"],
		handler: Effect.fn("McpTool.listSourceRepositories")(function* () {
			const tenant = yield* CurrentMcpTenant
			const source = yield* VcsSourceService
			const repositories = yield* source
				.listRepositories(tenant.orgId)
				.pipe(Effect.mapError(fromVcsLookupError("list_source_repositories")))
			return {
				repositories: repositories.map((repo) => ({
					provider: repo.provider,
					fullName: repo.fullName,
					trackedBranch: repo.trackedBranch,
					defaultBranch: repo.defaultBranch,
					htmlUrl: repo.htmlUrl,
					isPrivate: repo.isPrivate,
					isArchived: repo.isArchived,
				})),
			}
		}),
		render: (output) => ({
			title: `Connected source repositories (${output.repositories.length})`,
			...(output.repositories.length === 0
				? {
						empty: {
							message:
								"No repositories are visible to this organization's GitHub App installation.",
							hints: [
								"Grant the installation access to the repository in GitHub, or connect GitHub in Maple settings.",
							],
						},
					}
				: undefined),
			blocks:
				output.repositories.length === 0
					? []
					: [
							doc.list(
								output.repositories.map(
									(repo) =>
										`${repo.fullName}: tracked ref \`${repo.trackedBranch}\`${repo.isArchived ? " (archived)" : ""}`,
								),
							),
						],
		}),
	})

	server.define({
		name: "search_source_code",
		title: "Search Source Code",
		description:
			"Search one connected repository through GitHub's code search: an index of the default branch only (GitHub offers no branch or ref for it), matched on whole tokens with punctuation ignored, not regex, and rate limited. It finds where a symbol or message lives, not what was deployed. Use exact exception text, function or class names, routes, span names or log fragments from telemetry, then read_source_file on promising paths. The repository comes from telemetry (vcs.repository.url.full) or list_source_repositories.",
		parameters: Schema.Struct({
			repository: REPOSITORY,
			query: P.text("Plain code or text to search for, without repo:, org: or user: qualifiers"),
			path: P.optionalText("Directory prefix or file path to restrict the search to"),
			limit: P.limit({ default: 10, max: 20, noun: "matches" }),
		}),
		output: SearchSourceCodeOutput,
		hints: HINTS,
		phrases: ["Searching the code", "Searching source code"],
		handler: Effect.fn("McpTool.searchSourceCode")(function* ({ repository, query, path, limit }) {
			const trimmed = query.trim()
			if (!trimmed || trimmed.length > 256 || /(?:^|\s)(?:repo|org|user):/i.test(trimmed)) {
				return yield* new McpInvalidInputError({
					message:
						"query must be 1-256 characters of plain source text without repo:, org:, or user: qualifiers",
					parameter: "query",
				})
			}
			if (path !== undefined && unsafePath(path)) {
				return yield* new McpInvalidInputError({
					message: "path must be repository-relative",
					parameter: "path",
				})
			}
			const tenant = yield* CurrentMcpTenant
			const source = yield* VcsSourceService
			const repo = repository.trim()
			const { dir, filename } = path === undefined ? {} : splitSearchPath(path)
			const matches = yield* source
				.searchCode(tenant.orgId, repo, filename === undefined ? trimmed : `${trimmed} filename:${filename}`, {
					...(dir === undefined ? undefined : { path: dir }),
					limit,
				})
				.pipe(Effect.mapError(fromVcsLookupError("search_source_code")))
			// Code search returns no line numbers; read the top files to find them. Best effort.
			const lines = yield* Effect.forEach(
				matches.slice(0, LINE_LOOKUP_MATCHES),
				(match) =>
					source.readFile(tenant.orgId, repo, match.path).pipe(
						Effect.map((file) => matchLines(file.content, trimmed, match.snippets[0])),
						Effect.orElseSucceed((): Array<number> => []),
					),
				{ concurrency: LINE_LOOKUP_MATCHES },
			)
			return {
				repository: repo,
				query: trimmed,
				...(path === undefined ? undefined : { path }),
				matches: matches.map((match, i) => {
					const found = lines[i] ?? []
					return {
						path: match.path,
						sha: match.sha,
						htmlUrl: match.htmlUrl,
						snippets: match.snippets
							.slice(0, 2)
							.map((snippet) => snippet.slice(0, MAX_SNIPPET_CHARS)),
						...(found.length === 0 ? undefined : { lines: found }),
					}
				}),
			}
		}),
		render: (output) => ({
			title: `Source search: ${output.repository}`,
			scope: [
				["Query", `\`${output.query}\``],
				["Path", output.path],
			],
			...(output.matches.length === 0
				? {
						empty: {
							message: "No matching source files found.",
							hints: [
								"Search a shorter, distinctive fragment (a symbol or a literal from the message), or drop the path filter.",
								...(IGNORED_PUNCTUATION.test(output.query)
									? [
											"GitHub code search ignores punctuation such as . : / ( ) and quotes, so search the words around it.",
										]
									: []),
								...(output.path === undefined
									? []
									: [
											"The path filter is a directory prefix (or a file name) on the default branch; a path that only exists on another branch matches nothing.",
										]),
							],
						},
					}
				: undefined),
			blocks: output.matches.flatMap((match): Array<DocBlock> => [
				doc.heading(match.path),
				doc.fields([
					["Blob", `\`${match.sha}\``],
					["URL", match.htmlUrl],
					["Lines", match.lines?.join(", ")],
				]),
				...match.snippets.map((snippet) => doc.code("", snippet)),
			]),
			next: output.matches
				.slice(0, 3)
				.map((match) =>
					doc.next(
						"read_source_file",
						{
							repository: output.repository,
							path: match.path,
							...(match.lines?.[0] === undefined
								? undefined
								: { start_line: Math.max(1, match.lines[0] - 20) }),
						},
						"read the file",
					),
				),
		}),
	})

	server.define({
		name: "read_source_file",
		title: "Read Source File",
		description:
			"Read a line range from a file in one connected repository, through GitHub. For incident causality pass the deployed commit SHA from telemetry as `ref`; otherwise the tracked branch is read and the result is not proof of deployed code.",
		parameters: Schema.Struct({
			repository: REPOSITORY,
			path: P.text("Repository-relative file path"),
			ref: P.optionalText(
				"Branch, tag, or preferably the deployed commit SHA (the service's vcs.ref.head.revision). Default: the repository's tracked branch. A service version such as 0.0.22 is not a git ref",
			),
			start_line: P.optionalNumber("First line to return, 1-based"),
			end_line: P.optionalNumber(`Last line to return; at most ${MAX_FILE_LINES} lines per call`),
		}),
		output: ReadSourceFileOutput,
		hints: HINTS,
		phrases: ["Reading a source file", "Reading the code"],
		handler: Effect.fn("McpTool.readSourceFile")(function* ({
			repository,
			path,
			ref,
			start_line,
			end_line,
		}) {
			const filePath = path.trim()
			if (!filePath || unsafePath(filePath)) {
				return yield* new McpInvalidInputError({
					message: "path must be repository-relative",
					parameter: "path",
				})
			}
			const start = Math.max(1, Math.floor(start_line ?? 1))
			const requestedEnd = Math.floor(end_line ?? start + MAX_FILE_LINES - 1)
			if (requestedEnd < start) {
				return yield* new McpInvalidInputError({
					message: "end_line must be greater than or equal to start_line",
					parameter: "end_line",
				})
			}
			const end = Math.min(requestedEnd, start + MAX_FILE_LINES - 1)
			const tenant = yield* CurrentMcpTenant
			const source = yield* VcsSourceService
			const file = yield* source
				.readFile(tenant.orgId, repository.trim(), filePath, ref)
				.pipe(Effect.mapError(fromVcsLookupError("read_source_file")))
			if (file.content.includes("\u0000")) {
				return yield* new McpInvalidInputError({
					message: "The requested file is binary and cannot be read as source text",
					parameter: "path",
				})
			}
			const allLines = file.content.split("\n")
			// Whole lines up to the character budget, so every returned line keeps its number.
			const lines: Array<string> = []
			let chars = 0
			for (const line of allLines.slice(start - 1, end)) {
				if (chars + line.length > MAX_FILE_CHARS && lines.length > 0) break
				lines.push(line)
				chars += line.length + 1
			}
			const endLine = start + lines.length - 1
			return {
				repository: repository.trim(),
				path: file.path,
				ref: file.ref,
				sha: file.sha,
				htmlUrl: file.htmlUrl,
				startLine: start,
				endLine,
				totalLines: allLines.length,
				truncated: endLine < allLines.length,
				lines,
			}
		}),
		render: (output) => ({
			title: `${output.repository}/${output.path}`,
			scope: [
				["Ref", `\`${output.ref}\``],
				["Blob", `\`${output.sha}\``],
				[
					"Lines",
					`${output.startLine}-${output.endLine}/${output.totalLines}${output.truncated ? " · truncated" : ""}`,
				],
			],
			...(output.lines.length === 0
				? {
						empty: {
							message: `The file has ${output.totalLines} lines; line ${output.startLine} is past its end.`,
						},
					}
				: undefined),
			blocks: [
				doc.fields([["URL", output.htmlUrl]]),
				...(output.lines.length === 0
					? []
					: [
							doc.code(
								"",
								output.lines
									.map((line, index) => `${output.startLine + index}: ${line}`)
									.join("\n"),
							),
						]),
			],
			...(output.truncated && output.lines.length > 0
				? {
						next: [
							doc.next(
								"read_source_file",
								{
									repository: output.repository,
									path: output.path,
									ref: output.ref,
									start_line: output.endLine + 1,
								},
								"the lines after this range",
							),
						],
					}
				: undefined),
		}),
	})
}
