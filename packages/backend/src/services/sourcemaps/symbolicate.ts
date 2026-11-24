import {
	type ParsedFrame,
	type StackFrame,
	type StackFrameContext,
	type SymbolicatedStack,
	isInAppPath,
	parseJsStack,
} from "@maple/domain/errors/js-stack"
import { type TraceMap, isIgnored, originalPositionFor, sourceContentFor } from "@jridgewell/trace-mapping"
import { Array as Arr, Predicate, String as Str } from "effect"
import { isLookupUrl } from "./source-map-files"

const CONTEXT_LINES = 5

/** `webpack://my-app/./src/a.ts` and `../../src/a.ts` both read as `src/a.ts`. */
export const displaySourcePath = (source: string): string =>
	Str.replace(/^(?:\.{1,2}\/)+/u, "")(Str.replace(/^webpack:\/\/[^/]*\//u, "")(source))

const contextFor = (map: TraceMap, source: string, line: number): StackFrameContext | null => {
	// A short `sourcesContent` array leaves `undefined` where the type says string or null.
	const content: unknown = sourceContentFor(map, source)
	if (!Predicate.isString(content)) return null
	const lines = Str.split(content, /\r?\n/u)
	const index = line - 1
	const current = lines[index]
	if (current === undefined) return null
	return {
		pre: lines.slice(Math.max(0, index - CONTEXT_LINES), index),
		line: current,
		post: lines.slice(index + 1, index + 1 + CONTEXT_LINES),
	}
}

const unresolved = (frame: ParsedFrame): StackFrame => ({
	raw: frame.raw,
	function: frame.function,
	file: frame.url,
	line: frame.line,
	column: frame.column,
	// A frame with no location (`native`, `<anonymous>`) is the engine's, never the app's.
	in_app: frame.url !== null && isInAppPath(frame.url),
	resolved: false,
	context: null,
})

interface MappedFrame {
	readonly frame: StackFrame
	/** The name a map gives the frame's position: at a call site, the name of the function called. */
	readonly callee: string | null
}

const resolveFrame = (frame: ParsedFrame, map: TraceMap): MappedFrame => {
	// trace-mapping throws below line 1; such a frame stays raw and the rest still map.
	if (frame.line === null || !Number.isFinite(frame.line) || frame.line < 1)
		return { frame: unresolved(frame), callee: null }
	// Stack columns are 1-based, trace-mapping columns 0-based (lines are 1-based in both).
	const position = originalPositionFor(map, {
		line: frame.line,
		column: Math.max(0, (frame.column ?? 1) - 1),
	})
	if (position.source === null) return { frame: unresolved(frame), callee: null }
	const file = displaySourcePath(position.source)
	return {
		frame: {
			raw: frame.raw,
			function: frame.function,
			file,
			line: position.line,
			column: position.column + 1,
			// The map's `ignoreList` marks framework and vendor sources out of app.
			in_app: isInAppPath(file) && !isIgnored(map, position.source),
			resolved: true,
			context: contextFor(map, position.source, position.line),
		},
		callee: position.name,
	}
}

/**
 * A frame whose map the org could have uploaded: an in-app JS file or served URL, or any in-app
 * URL its SDK recorded a debug id for (a `blob:` script).
 */
export const couldHaveSourceMap = (
	url: string | null,
	debugIds: ReadonlyMap<string, string> = NO_DEBUG_IDS,
): url is string => url !== null && isLookupUrl(url, debugIds) && isInAppPath(url)

const NO_DEBUG_IDS: ReadonlyMap<string, string> = new Map()

/**
 * Maps a JS stack trace through source maps. `lookup` returns the pre-loaded map for a frame,
 * or undefined when none is stored; frames without a URL are never looked up. The status and
 * `missing` count only frames that could have a map, so engine and dependency frames never
 * make a stack partial.
 */
export const symbolicateStack = (
	stacktrace: string,
	lookup: (frame: ParsedFrame) => TraceMap | undefined,
	debugIds: ReadonlyMap<string, string> = NO_DEBUG_IDS,
): SymbolicatedStack => {
	const { frames: parsed } = parseJsStack(stacktrace)
	const results = Arr.map(parsed, (frame) => {
		const map = frame.url === null ? undefined : lookup(frame)
		return {
			mapped: map === undefined ? { frame: unresolved(frame), callee: null } : resolveFrame(frame, map),
			candidate: couldHaveSourceMap(frame.url, debugIds),
		}
	})
	// A frame's own position names what it calls, so a resolved frame takes its name from the
	// caller's call site (the next frame), else keeps the minified name.
	const frames = Arr.map(results, (result, i) => {
		const callerName = results[i + 1]?.mapped.callee ?? null
		return result.mapped.frame.resolved && callerName !== null
			? { ...result.mapped.frame, function: callerName, function_from_map: true }
			: result.mapped.frame
	})
	const unresolvedCandidates = Arr.filter(
		parsed,
		(frame, i) => couldHaveSourceMap(frame.url, debugIds) && frames[i]?.resolved !== true,
	)
	const missing = Arr.dedupe(
		Arr.filter(
			Arr.map(unresolvedCandidates, (frame) => frame.url),
			(url) => url !== null,
		),
	)
	const candidates = Arr.filter(results, (result) => result.candidate).length
	const resolvedCount = Arr.filter(frames, (frame) => frame.resolved).length
	const status: SymbolicatedStack["status"] =
		frames.length === 0 || (candidates === 0 && resolvedCount === 0)
			? "not_applicable"
			: resolvedCount === 0
				? "missing_map"
				: unresolvedCandidates.length === 0
					? "resolved"
					: "partial"
	return { status, frames, missing }
}
