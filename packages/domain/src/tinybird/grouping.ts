/**
 * The grouping key: which issue a warehouse fingerprint joins, computed by the errors tick
 * from one sample. Keys only merge hashes, never split one; why and how it was measured is
 * in `docs/error-issue-lifecycle.md` ("The grouping key").
 */
import { Array as Arr, Option, Schema, String as Str } from "effect"

import type { StackFrame, SymbolicatedStack } from "../errors/js-stack"
import {
	computeFingerprintInputs,
	currentFrameCandidates,
	CUSTOM_FINGERPRINT_ATTRIBUTE,
	type FingerprintInputs,
	isLibraryFrame,
	MAX_FINGERPRINT_FRAMES,
	SPAN_SIGNATURE_PREFIX,
} from "./fingerprint"
import {
	compileGroupingRules,
	type CompiledGroupingRules,
	EMPTY_GROUPING_CONFIG,
	type OrgGroupingRule,
	stableHash,
} from "./grouping-rules"

/** Bumped whenever a key changes for the same sample, so stored keys are recomputed. */
export const GROUPING_KEY_VERSION = 1

/**
 * Error types that name a runtime's failure class, not the application's failure: the
 * frames still have to tell two of them apart. A type outside this list (a tagged or
 * custom error, `@acme/http/errors/Unauthorized`) names one failure, so with its message
 * the throw site adds nothing but splits.
 */
const GENERIC_ERROR_TYPE_PATTERN =
	"^(Error|TypeError|RangeError|ReferenceError|SyntaxError|EvalError|URIError|AggregateError|DOMException|" +
	"Exception|RuntimeError|ValueError|KeyError|AttributeError|IndexError|OSError|" +
	"NSError|HttpClientError|SchemaError|UnknownException|TimeoutError|ErrorInfo|" +
	"\\*errors\\.errorString|\\*fmt\\.wrapError|EXC_[A-Z_]+|SIG[A-Z]+|[0-9]+|_OTHER|)$"

/**
 * A chunk the browser failed to load. Its message names a content-hashed asset, so every
 * deploy opened another issue for the one failure: the app is out of date in the tab.
 */
const CHUNK_LOAD_PATTERN =
	"ChunkLoadError|Loading chunk [^ ]+ failed|Failed to fetch dynamically imported module|" +
	"error loading dynamically imported module|Importing a module script failed"

/**
 * Frame functions that are not a call site anyone fixes: generic wrappers, constructors
 * and the plumbing of schema classes and promise chains.
 */
const PLUMBING_FUNCTION_PATTERN = "^(new|catch|Object\\.|makeClass|Generator\\.|Array\\.|Promise\\.)"

const genericTypeRe = new RegExp(GENERIC_ERROR_TYPE_PATTERN)
const chunkLoadRe = new RegExp(CHUNK_LOAD_PATTERN, "i")
const plumbingRe = new RegExp(PLUMBING_FUNCTION_PATTERN)
const namedFrameRe = /^[ \t]*at (?:async |new )?([^ (<]+) \(/
const framePathRe = /(\(|@|^[ \t]*at |^[ \t]*File ")(?:[^ ()"]*\/)?([^/ ()"]+\/[^/ ()"]+)(?=[)" ,]|$)/

/**
 * Which rule decided a key: what the "why grouped" view names.
 * - `custom`: `maple.fingerprint` set the hash outright; the key is the hash's own inputs.
 * - `span`: no exception at all, keyed on its span, as the hash is.
 * - `org-rule`: one of the org's merge rules (`grouping-rules.ts`).
 * - `chunk-load`: every chunk the service failed to load.
 * - `type-message`: a specific error type with a message; the two are the identity.
 * - `type-function`: a specific error type with no message; the first named function.
 * - `frames`: a generic type; frames (install roots trimmed) and message, as the hash.
 * - `source-mapped`: `frames` or `type-function` read through source maps: original files and
 *   functions, so a deploy's renamed bundle keeps its key.
 */
export const GroupingRule = Schema.Literals([
	"custom",
	"span",
	"org-rule",
	"chunk-load",
	"type-message",
	"type-function",
	"frames",
	"source-mapped",
]).annotate({ identifier: "@maple/GroupingRule", title: "Grouping Rule" })
export type GroupingRule = Schema.Schema.Type<typeof GroupingRule>

export interface GroupingParts {
	readonly rule: GroupingRule
	/** What the key hashes after the service, in order. */
	readonly parts: ReadonlyArray<string>
}

export interface GroupingSample {
	readonly serviceName: string
	readonly exceptionType: string
	readonly exceptionStacktrace: string
	readonly statusMessage: string
	readonly customFingerprint?: string
	readonly span?: { readonly kind: string; readonly name: string }
	/** The stack mapped through the org's source maps, when the tick could look it up. */
	readonly symbolicatedStack?: SymbolicatedStack
}

/** A frame's file, cut to its last two path segments: install roots and worktrees vary. */
const trimFramePath = (frame: string): string => {
	const match = framePathRe.exec(frame)
	if (match === null) return frame
	const [whole, lead = "", tail = ""] = match
	return `${Str.slice(0, match.index)(frame)}${lead}${tail}${Str.slice(match.index + whole.length)(frame)}`
}

/** The function a frame names, unless it is plumbing or minified away. */
export const frameFunction = (frame: string): string | undefined => {
	const name = namedFrameRe.exec(frame)?.[1]
	return name === undefined || plumbingRe.test(name) ? undefined : name
}

/** A mapped frame's function when the source map supplied it, unless it is plumbing. */
const mappedFunction = (frame: StackFrame): string | undefined => {
	const name = frame.function
	return frame.function_from_map !== true || name === null || plumbingRe.test(name) ? undefined : name
}

/**
 * A source line with formatting whitespace collapsed to one space and trimmed; whitespace inside a
 * string literal (`'`, `"`, `` ` ``, with backslash escapes) is part of the code and kept as is.
 */
export const collapseCodeWhitespace = (line: string): string =>
	Str.trim(
		Arr.reduce(
			Arr.fromIterable(line),
			{ out: "", quote: "", escaped: false, space: false },
			(state, char) => {
				if (state.quote !== "") {
					const closes = !state.escaped && char === state.quote
					return {
						out: state.out + char,
						quote: closes ? "" : state.quote,
						escaped: !state.escaped && char === "\\",
						space: false,
					}
				}
				if (/\s/u.test(char)) return { ...state, space: true }
				const out = `${state.out}${state.space ? " " : ""}${char}`
				return {
					out,
					quote: char === "'" || char === '"' || char === "`" ? char : "",
					escaped: false,
					space: false,
				}
			},
		).out,
	)

/**
 * A mapped frame as the key reads it, never a line or column: its original file and function, or,
 * with no function name, the file and its source line's text. `undefined` when it has neither.
 */
const mappedFrameLine = (frame: StackFrame, file: string): string | undefined => {
	const name = mappedFunction(frame)
	if (name !== undefined) return `at ${name} (${file})`
	const text = frame.context === null ? "" : collapseCodeWhitespace(frame.context.line)
	return text === "" ? undefined : `at ${file} | ${text}`
}

/**
 * The app's source-mapped frames, top first, when the stack resolved at least one. Unmapped
 * frames are left out: their names and hashed files change with every deploy. `undefined` also
 * when a frame the key reads has no identity beyond its file: the raw key keeps it apart.
 */
const sourceMappedFrames = (
	sample: GroupingSample,
	rules: CompiledGroupingRules,
): { readonly frames: ReadonlyArray<string>; readonly skipped: ReadonlyArray<string> } | undefined => {
	const stack = sample.symbolicatedStack
	if (stack === undefined || (stack.status !== "resolved" && stack.status !== "partial")) return undefined
	const mapped = Arr.dedupeAdjacentWith(
		Arr.flatMap(stack.frames, (frame) => {
			if (!frame.resolved || frame.file === null) return []
			const line = mappedFrameLine(frame, frame.file)
			const shown = line ?? `at ${frame.file}`
			// Rules read both the generated frame and its mapped location, as they did before the
			// map came: a frame either side marks a library stays out of the key.
			const kinds = [rules.frameKind(shown, sample), rules.frameKind(frame.raw, sample)]
			const app = Arr.contains(kinds, "library")
				? false
				: Arr.contains(kinds, "app")
					? true
					: frame.in_app
			return [{ line, shown, app }]
		}),
		(a, b) => a.line !== undefined && a.line === b.line,
	)
	const read = Arr.filter(mapped, (frame) => frame.app).slice(0, MAX_FINGERPRINT_FRAMES)
	if (read.length === 0) return undefined
	const lines = Arr.getSomes(Arr.map(read, (frame) => Option.fromUndefinedOr(frame.line)))
	if (lines.length < read.length) return undefined
	return {
		frames: lines,
		skipped: Arr.map(
			Arr.filter(mapped, (frame) => !frame.app),
			(frame) => frame.shown,
		),
	}
}

/** A key's inputs, and what the "why grouped" view shows of them. */
export interface GroupingExplanation extends GroupingParts {
	/** The frames the rule read, top first; empty when it reads none. */
	readonly frames: ReadonlyArray<string>
	/** Frames passed over as a dependency's or a runtime's. */
	readonly skippedFrames: ReadonlyArray<string>
	readonly messageSignature: string
	readonly customKey: string | undefined
	/** The org rule that decided it, for `org-rule`. */
	readonly orgRule: OrgGroupingRule | undefined
}

const NO_RULES = compileGroupingRules(EMPTY_GROUPING_CONFIG)

/** The frames a key reads: the hash's own, or re-chosen under the org's frame rules. */
const chooseFrames = (
	sample: GroupingSample,
	inputs: FingerprintInputs,
	rules: CompiledGroupingRules,
): { readonly frames: ReadonlyArray<string>; readonly skipped: ReadonlyArray<string> } => {
	const { frames: candidates, maxFrames } = currentFrameCandidates(sample)
	const isApp = (frame: string) => {
		const kind = rules.frameKind(frame, sample)
		return kind === undefined ? !isLibraryFrame(frame) : kind === "app"
	}
	const app = Arr.filter(candidates, isApp)
	const skipped = app.length > 0 ? Arr.filter(candidates, (frame) => !isApp(frame)) : []
	if (!rules.hasFrameRules) {
		const own = inputs.fpFrames === "" ? [] : Str.split("\n")(inputs.fpFrames)
		return { frames: own, skipped }
	}
	return { frames: (app.length > 0 ? app : candidates).slice(0, maxFrames), skipped }
}

export const explainGrouping = (
	sample: GroupingSample,
	rules: CompiledGroupingRules = NO_RULES,
): GroupingExplanation => {
	const inputs = computeFingerprintInputs(sample)
	const { frames, skipped } = chooseFrames(sample, inputs, rules)
	const customKey =
		sample.customFingerprint === undefined || Str.trim(sample.customFingerprint) === ""
			? undefined
			: Str.trim(sample.customFingerprint)
	const explained = (
		parts: GroupingParts,
		read: ReadonlyArray<string>,
		orgRule?: OrgGroupingRule,
		passedOver: ReadonlyArray<string> = skipped,
	) => ({
		...parts,
		frames: read,
		skippedFrames: read.length === 0 ? [] : passedOver,
		messageSignature: inputs.msgSignature,
		customKey,
		orgRule,
	})
	if (inputs.hashInputs[0] === CUSTOM_FINGERPRINT_ATTRIBUTE && inputs.hashInputs.length === 2) {
		return explained({ rule: "custom", parts: inputs.hashInputs }, [])
	}
	if (Str.startsWith(SPAN_SIGNATURE_PREFIX)(inputs.msgSignature)) {
		return explained({ rule: "span", parts: inputs.hashInputs }, [])
	}
	// A `{{default}}` key splits whatever the rules below join.
	const extension =
		inputs.customExtension === "" ? [] : [CUSTOM_FINGERPRINT_ATTRIBUTE, inputs.customExtension]
	const extend = (parts: GroupingParts): GroupingParts => ({
		rule: parts.rule,
		parts: [...parts.parts, ...extension],
	})
	const merge = rules.mergeRule(sample, frames)
	if (merge !== undefined) {
		return explained(extend({ rule: "org-rule", parts: ["org-rule", merge.id] }), [], merge)
	}
	if (chunkLoadRe.test(sample.exceptionType) || chunkLoadRe.test(sample.statusMessage)) {
		return explained(extend({ rule: "chunk-load", parts: ["chunk-load"] }), [])
	}
	const message = inputs.msgSignature
	const trimmed = Arr.join(Arr.map(frames, trimFramePath), "\n")
	// Only the frame parts read source maps; every rule above keeps its priority.
	const mapped = sourceMappedFrames(sample, rules)
	const byFrames = () =>
		mapped === undefined
			? explained(extend({ rule: "frames", parts: [sample.exceptionType, trimmed, message] }), frames)
			: explained(
					extend({
						rule: "source-mapped",
						parts: [sample.exceptionType, Arr.join(mapped.frames, "\n"), message],
					}),
					mapped.frames,
					undefined,
					mapped.skipped,
				)
	if (genericTypeRe.test(sample.exceptionType)) return byFrames()
	if (message !== "")
		return explained(extend({ rule: "type-message", parts: [sample.exceptionType, message] }), [])
	if (mapped !== undefined) {
		const mappedNamed = Arr.findFirst(mapped.frames, (frame) => frameFunction(frame) !== undefined)
		if (mappedNamed._tag === "None") return byFrames()
		return explained(
			extend({
				rule: "source-mapped",
				parts: [sample.exceptionType, frameFunction(mappedNamed.value) ?? ""],
			}),
			[mappedNamed.value],
			undefined,
			mapped.skipped,
		)
	}
	const named = Arr.findFirst(frames, (frame) => frameFunction(frame) !== undefined)
	if (named._tag === "None") return byFrames()
	return explained(
		extend({ rule: "type-function", parts: [sample.exceptionType, frameFunction(named.value) ?? ""] }),
		[named.value],
	)
}

export const groupingParts = (
	sample: GroupingSample,
	rules: CompiledGroupingRules = NO_RULES,
): GroupingParts => {
	const { rule, parts } = explainGrouping(sample, rules)
	return { rule, parts }
}

/** The stored key for a service and its parts, as `groupingKey` computes it. */
export const keyOfParts = (serviceName: string, { rule, parts }: GroupingParts): string =>
	stableHash(Arr.join([`g${GROUPING_KEY_VERSION}`, serviceName, rule, ...parts], "\u0000"))

/** The key two hashes must share to join one issue. Scoped to the service, as the hash is. */
export const groupingKey = (sample: GroupingSample, rules: CompiledGroupingRules = NO_RULES): string =>
	keyOfParts(sample.serviceName, groupingParts(sample, rules))
