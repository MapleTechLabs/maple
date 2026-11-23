/**
 * The grouping key: which issue a warehouse fingerprint joins, computed by the errors tick
 * from one sample. Keys only merge hashes, never split one; why and how it was measured is
 * in `docs/error-issue-lifecycle.md` ("The grouping key").
 */
import { Array as Arr, Schema, String as Str } from "effect"

import {
	computeFingerprintInputs,
	currentFrameCandidates,
	CUSTOM_FINGERPRINT_ATTRIBUTE,
	type FingerprintInputs,
	isLibraryFrame,
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
 */
export const GroupingRule = Schema.Literals([
	"custom",
	"span",
	"org-rule",
	"chunk-load",
	"type-message",
	"type-function",
	"frames",
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
}

/** A frame's file, cut to its last two path segments: install roots and worktrees vary. */
const trimFramePath = (frame: string): string => {
	const match = framePathRe.exec(frame)
	if (match === null) return frame
	const [whole, lead = "", tail = ""] = match
	return `${Str.slice(0, match.index)(frame)}${lead}${tail}${Str.slice(match.index + whole.length)(frame)}`
}

/** The function a frame names, unless it is plumbing or minified away. */
const frameFunction = (frame: string): string | undefined => {
	const name = namedFrameRe.exec(frame)?.[1]
	return name === undefined || plumbingRe.test(name) ? undefined : name
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
	const explained = (parts: GroupingParts, read: ReadonlyArray<string>, orgRule?: OrgGroupingRule) => ({
		...parts,
		frames: read,
		skippedFrames: read.length === 0 ? [] : skipped,
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
	const byFrames = () =>
		explained(extend({ rule: "frames", parts: [sample.exceptionType, trimmed, message] }), frames)
	if (genericTypeRe.test(sample.exceptionType)) return byFrames()
	if (message !== "")
		return explained(extend({ rule: "type-message", parts: [sample.exceptionType, message] }), [])
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
