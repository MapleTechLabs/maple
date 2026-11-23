/**
 * An org's own grouping rules, applied by the grouping key (`grouping.ts`) without a
 * deploy, like Sentry's fingerprint and stack trace rules.
 *
 * - `merge`: errors matching every field given are one issue per service.
 * - `library-frames` / `app-frames`: frames matching `frame` count as a dependency's
 *   (skipped when the error has frames of its own) or as the application's.
 *
 * Patterns are globs (`*` is any run of characters), case-insensitive, matched against
 * the whole value: `*timeout*`, `@acme/http/errors/*`, `*node_modules/@acme/*`.
 * Rules only merge: a rule can join hashes, never split one.
 */
import { Array as Arr, Schema, String as Str } from "effect"

export const MAX_GROUPING_RULES = 100
export const MAX_GROUPING_PATTERN_CHARS = 300

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
	/** Exact service name; every service when absent. */
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

const escapeRegex = (text: string) => Str.replace(/[.+?^${}()|[\]\\]/g, "\\$&")(text)

/** A glob as an anchored, case-insensitive regex: `*` is any run, everything else literal. */
export const globRegex = (glob: string): RegExp =>
	new RegExp(`^${Arr.join(Arr.map(Str.split("*")(glob), escapeRegex), "[\\s\\S]*")}$`, "i")

export interface CompiledGroupingRules {
	readonly merges: ReadonlyArray<{
		readonly rule: OrgGroupingRule
		readonly matches: (sample: GroupingRuleSample, frames: ReadonlyArray<string>) => boolean
	}>
	readonly frameKind: (frame: string, serviceName: string) => "app" | "library" | undefined
	readonly hasFrameRules: boolean
}

export interface GroupingRuleSample {
	readonly serviceName: string
	readonly exceptionType: string
	readonly statusMessage: string
}

export const compileGroupingRules = (config: GroupingConfig): CompiledGroupingRules => {
	const compiled = Arr.map(config.rules, (rule) => ({
		rule,
		service: rule.service,
		exceptionType: rule.exceptionType === undefined ? undefined : globRegex(rule.exceptionType),
		message: rule.message === undefined ? undefined : globRegex(rule.message),
		frame: rule.frame === undefined ? undefined : globRegex(rule.frame),
	}))
	const usable = Arr.filter(compiled, ({ rule }) => groupingRuleProblem(rule) === undefined)
	const frameRules = Arr.filter(usable, ({ rule }) => rule.kind !== "merge")
	return {
		merges: Arr.map(
			Arr.filter(usable, ({ rule }) => rule.kind === "merge"),
			(entry) => ({
				rule: entry.rule,
				matches: (sample, frames) =>
					(entry.service === undefined || entry.service === sample.serviceName) &&
					(entry.exceptionType === undefined || entry.exceptionType.test(sample.exceptionType)) &&
					(entry.message === undefined || entry.message.test(sample.statusMessage)) &&
					(entry.frame === undefined ||
						Arr.some(frames, (frame) => entry.frame?.test(frame) ?? false)),
			}),
		),
		// The last matching rule wins, so a narrower rule below a broad one overrides it.
		frameKind: (frame, serviceName) =>
			Arr.reduce(frameRules, undefined as "app" | "library" | undefined, (kind, entry) =>
				(entry.service === undefined || entry.service === serviceName) &&
				(entry.frame?.test(frame) ?? false)
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
