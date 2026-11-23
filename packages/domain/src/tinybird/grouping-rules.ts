/**
 * An org's own grouping rules, applied by the grouping key (`grouping.ts`) without a
 * deploy, like Sentry's fingerprint and stack trace rules.
 *
 * - `merge`: errors matching every field given are one issue per service.
 * - `library-frames` / `app-frames`: frames matching `frame` count as a dependency's
 *   (skipped when the error has frames of its own) or as the application's.
 *
 * Every field is a glob (`*` is any run of characters), case-insensitive, matched against
 * the whole value: `checkout-*`, `*timeout*`, `*node_modules/@acme/*`. Fields given on a
 * rule all have to match. The last matching rule wins. Rules only merge, never split.
 */
import { Array as Arr, Option, Schema, String as Str } from "effect"

export const MAX_GROUPING_RULES = 100
const MAX_GROUPING_PATTERN_CHARS = 300

export const GroupingRuleKind = Schema.Literals(["merge", "library-frames", "app-frames"]).annotate({
	identifier: "@maple/GroupingRuleKind",
	title: "Grouping Rule Kind",
})
export type GroupingRuleKind = Schema.Schema.Type<typeof GroupingRuleKind>

const Pattern = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_GROUPING_PATTERN_CHARS))

export class OrgGroupingRule extends Schema.Class<OrgGroupingRule>("@maple/OrgGroupingRule")({
	/** Stable across edits, so an issue grouped by a rule keeps its key. */
	id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
	kind: GroupingRuleKind,
	/** Every service when absent. */
	service: Schema.optionalKey(Pattern),
	exceptionType: Schema.optionalKey(Pattern),
	message: Schema.optionalKey(Pattern),
	/** A normalized frame line, for the frame kinds (and an optional filter on `merge`). */
	frame: Schema.optionalKey(Pattern),
	/** What the rule's issue is called in the "why grouped" view. */
	title: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
}) {}

export class GroupingConfig extends Schema.Class<GroupingConfig>("@maple/GroupingConfig")({
	rules: Schema.Array(OrgGroupingRule).check(Schema.isMaxLength(MAX_GROUPING_RULES)),
}) {}

export const EMPTY_GROUPING_CONFIG: GroupingConfig = new GroupingConfig({ rules: [] })

/** Why a rule is unusable, or undefined. A frame rule needs a frame; a merge rule a matcher. */
export const groupingRuleProblem = (rule: OrgGroupingRule): string | undefined => {
	if (rule.kind !== "merge" && rule.frame === undefined)
		return `${rule.id}: a frame rule needs a frame pattern`
	if (
		rule.kind === "merge" &&
		rule.exceptionType === undefined &&
		rule.message === undefined &&
		rule.frame === undefined
	) {
		return `${rule.id}: a merge rule needs an exception type, message or frame pattern`
	}
	return undefined
}

/** How much of a value a glob reads: bounds the match work per rule. */
const GLOB_SCAN_CHARS = 2_000

/**
 * A glob as a matcher: `*` is any run, everything else literal, case-insensitive, whole value.
 * Greedy segment search, so a hostile pattern cannot backtrack: work is linear per segment.
 */
const globMatcher = (glob: string): ((value: string) => boolean) => {
	const segments = Str.split("*")(Str.toLowerCase(glob))
	const first = segments[0] ?? ""
	const last = segments[segments.length - 1] ?? ""
	const middle = segments.slice(1, -1)
	return (raw) => {
		const value = Str.toLowerCase(Str.slice(0, GLOB_SCAN_CHARS)(raw))
		if (segments.length === 1) return value === first
		if (!Str.startsWith(first)(value) || value.length < first.length + last.length) return false
		const end = value.length - last.length
		if (!Str.endsWith(last)(value)) return false
		const reached = Arr.reduce(middle, first.length as number | undefined, (at, segment) => {
			if (at === undefined) return undefined
			const found = Option.map(Str.indexOf(segment)(Str.slice(at)(value)), (offset) => at + offset)
			return Option.isNone(found) || found.value + segment.length > end
				? undefined
				: found.value + segment.length
		})
		return reached !== undefined
	}
}

export interface CompiledGroupingRules {
	/** The merge rule an error matches; the last matching rule wins, as for frame rules. */
	readonly mergeRule: (
		sample: GroupingRuleSample,
		frames: ReadonlyArray<string>,
	) => OrgGroupingRule | undefined
	readonly frameKind: (frame: string, sample: GroupingRuleSample) => "app" | "library" | undefined
	readonly hasFrameRules: boolean
}

export interface GroupingRuleSample {
	readonly serviceName: string
	readonly exceptionType: string
	readonly statusMessage: string
}

export const compileGroupingRules = (config: GroupingConfig): CompiledGroupingRules => {
	const optional = (glob: string | undefined) => (glob === undefined ? undefined : globMatcher(glob))
	const usable = Arr.map(
		Arr.filter(config.rules, (rule) => groupingRuleProblem(rule) === undefined),
		(rule) => ({
			rule,
			service: optional(rule.service),
			exceptionType: optional(rule.exceptionType),
			message: optional(rule.message),
			frame: optional(rule.frame),
		}),
	)
	type Entry = (typeof usable)[number]
	const sampleMatches = (entry: Entry, sample: GroupingRuleSample) =>
		(entry.service?.(sample.serviceName) ?? true) &&
		(entry.exceptionType?.(sample.exceptionType) ?? true) &&
		(entry.message?.(sample.statusMessage) ?? true)
	const merges = Arr.filter(usable, ({ rule }) => rule.kind === "merge")
	const frameRules = Arr.filter(usable, ({ rule }) => rule.kind !== "merge")
	// The last matching rule wins, so a narrower rule added below a broad one overrides it.
	return {
		mergeRule: (sample, frames) =>
			Arr.reduce(merges, undefined as OrgGroupingRule | undefined, (found, entry) =>
				sampleMatches(entry, sample) &&
				(entry.frame === undefined || Arr.some(frames, (frame) => entry.frame?.(frame) ?? false))
					? entry.rule
					: found,
			),
		frameKind: (frame, sample) =>
			Arr.reduce(frameRules, undefined as "app" | "library" | undefined, (kind, entry) =>
				sampleMatches(entry, sample) && (entry.frame?.(frame) ?? false)
					? entry.rule.kind === "app-frames"
						? "app"
						: "library"
					: kind,
			),
		hasFrameRules: frameRules.length > 0,
	}
}

/** 64-bit FNV-1a, hex: stable across runtimes, which stored grouping keys depend on. */
export const stableHash = (text: string): string =>
	Str.padStart(
		16,
		"0",
	)(
		Arr.reduce([...new TextEncoder().encode(text)], 0xcbf29ce484222325n, (hash, byte) =>
			BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n),
		).toString(16),
	)

const encodeConfig = Schema.encodeSync(Schema.fromJsonString(GroupingConfig))

/** Names the rules a key was computed under; "" for none, which is the default grouping. */
export const groupingConfigDigest = (config: GroupingConfig): string =>
	config.rules.length === 0 ? "" : stableHash(encodeConfig(config))
