import { Effect, Option, Array as Arr, String as Str } from "effect"
import { LockfileParseError } from "../errors.ts"
import { pkg } from "../internal/collect.ts"
import type { LockedPackage, LockfileInput } from "../types.ts"
import type { ParserOutput } from "./types.ts"

interface Require {
	readonly path: string
	readonly version: string
	readonly indirect: boolean
}

interface Replace {
	readonly oldPath: string
	readonly oldVersion: string | undefined
	readonly newPath: string
	readonly newVersion: string | undefined
}

interface GoModState {
	readonly block: string | undefined
	readonly requires: ReadonlyArray<Require>
	readonly replaces: ReadonlyArray<Replace>
	readonly errors: ReadonlyArray<string>
}

const DIRECTIVES = new Set([
	"module",
	"go",
	"toolchain",
	"require",
	"replace",
	"exclude",
	"retract",
	"tool",
	"godebug",
	"ignore",
])

const tokenize = (code: string): ReadonlyArray<string> =>
	Arr.map(
		Arr.filter(Str.split(/\s+/)(code), (t) => t !== ""),
		(t) => Str.replace(/^`(.*)`$/, "$1")(Str.replace(/^"(.*)"$/, "$1")(t)),
	)

const parseReplace = (tokens: ReadonlyArray<string>): Replace | undefined => {
	const arrow = tokens.indexOf("=>")
	const left = tokens.slice(0, arrow)
	const right = tokens.slice(arrow + 1)
	const [oldPath, oldVersion] = left
	const [newPath, newVersion] = right
	if (arrow === -1 || oldPath === undefined || newPath === undefined || left.length > 2 || right.length > 2)
		return undefined
	return { oldPath, oldVersion, newPath, newVersion }
}

/** Applies one directive line (`require x v1`, or a bare `x v1` inside a block) to the state. */
const apply = (
	state: GoModState,
	kind: string,
	tokens: ReadonlyArray<string>,
	indirect: boolean,
	line: string,
): GoModState => {
	if (kind === "require") {
		const [path, version] = tokens
		return path !== undefined && version !== undefined && tokens.length === 2
			? { ...state, requires: [...state.requires, { path, version, indirect }] }
			: { ...state, errors: [...state.errors, `bad require: ${line}`] }
	}
	if (kind === "replace") {
		const replace = parseReplace(tokens)
		return replace === undefined
			? { ...state, errors: [...state.errors, `bad replace: ${line}`] }
			: { ...state, replaces: [...state.replaces, replace] }
	}
	return state
}

const step = (state: GoModState, rawLine: string): GoModState => {
	const commentAt = Str.indexOf("//")(rawLine)
	const code = Str.trim(
		Option.match(commentAt, { onNone: () => rawLine, onSome: (at) => Str.slice(0, at)(rawLine) }),
	)
	const indirect = Option.exists(commentAt, (at) => /^\/\/\s*indirect\b/.test(Str.slice(at)(rawLine)))
	if (code === "") return state
	if (state.block !== undefined) {
		return code === ")"
			? { ...state, block: undefined }
			: apply(state, state.block, tokenize(code), indirect, code)
	}
	const [directive = "", ...rest] = tokenize(code)
	if (!DIRECTIVES.has(directive))
		return { ...state, errors: [...state.errors, `unknown directive: ${code}`] }
	if (rest.length === 1 && rest[0] === "(") return { ...state, block: directive }
	return apply(state, directive, rest, indirect, code)
}

const resolve = (req: Require, replaces: ReadonlyArray<Replace>): Require | undefined => {
	// A version-specific replace wins over a wildcard one, wherever each appears in the file.
	const found = Arr.findFirst(replaces, (r) => r.oldPath === req.path && r.oldVersion === req.version).pipe(
		Option.orElse(() =>
			Arr.findFirst(replaces, (r) => r.oldPath === req.path && r.oldVersion === undefined),
		),
	)
	if (Option.isNone(found)) return req
	const match = found.value
	return match.newVersion === undefined
		? undefined
		: { ...req, path: match.newPath, version: match.newVersion }
}

export const parseGoMod = Effect.fn("lockfiles.parseGoMod")(function* (input: LockfileInput) {
	const initial: GoModState = { block: undefined, requires: [], replaces: [], errors: [] }
	const state = Arr.reduce(Str.split(/\r?\n/)(input.content), initial, step)
	const errors =
		state.block === undefined ? state.errors : [...state.errors, `unclosed ${state.block} block`]
	if (errors.length > 0)
		return yield* new LockfileParseError({
			path: input.path,
			message: Arr.join(errors.slice(0, 3), "; "),
		})
	const resolved = Arr.map(state.requires, (req) => ({ req, to: resolve(req, state.replaces) }))
	const packages = Arr.flatMap(resolved, ({ to }): ReadonlyArray<LockedPackage> =>
		to === undefined ? [] : [pkg("Go", to.path, to.version, to.indirect ? "transitive" : "direct")],
	)
	const warnings = Arr.flatMap(resolved, ({ req, to }) =>
		to === undefined ? [`${req.path} is replaced by a local directory`] : [],
	)
	const output: ParserOutput = { kind: "go-mod", packages, warnings }
	return output
})

export const parseGoSum = Effect.fn("lockfiles.parseGoSum")(function* (input: LockfileInput) {
	const lines = Arr.filter(
		Arr.map(Str.split(/\r?\n/)(input.content), (line) => Str.trim(line)),
		(line) => line !== "",
	)
	const rows = Arr.map(lines, (line) => Str.split(/\s+/)(line))
	const bad = Arr.findFirst(rows, (row) => row.length !== 3 || !Str.includes(":")(row[2] ?? ""))
	if (Option.isSome(bad))
		return yield* new LockfileParseError({
			path: input.path,
			message: `bad go.sum line: ${Arr.join(bad.value, " ")}`,
		})
	const packages = Arr.flatMap(rows, ([path, version = ""]): ReadonlyArray<LockedPackage> =>
		Str.endsWith("/go.mod")(version) ? [] : [pkg("Go", path, version, "unknown")],
	)
	const output: ParserOutput = {
		kind: "go-sum",
		packages,
		warnings: ["go.sum lists more module versions than the build uses; prefer go.mod when both exist"],
	}
	return output
})
