/**
 * The vendored skill as addressable text. The skill requires hunter and verifier prompts to carry
 * its blocks verbatim, so everything here returns exact substrings of the upstream files, never a
 * paraphrase. Block references use the skill's own form: `FILE.md#` plus the class name as written
 * in bold, or the heading text before any parenthetical qualifier.
 */
import { SKILL_FILES, type SkillFileName } from "./skill-files.generated"
import { Array as Arr, Brand, Option, Record as Rec, String as Str } from "effect"

export type { SkillFileName }

export const ATTACK_CLASSES_FILE = "ATTACK-CLASSES.md" satisfies SkillFileName

const CORE_FILES: ReadonlySet<string> = new Set([
	"SKILL.md",
	"RECONNAISSANCE.md",
	"HUNTING.md",
	"VALIDATION-AND-REPORTING.md",
	ATTACK_CLASSES_FILE,
])

/** Domain companions, in file order: the files reconnaissance selects from. */
// SAFETY: `Object.keys` of the generated `as const` record is exactly its key union.
export const COMPANION_FILES: ReadonlyArray<SkillFileName> = Arr.filter(
	Rec.keys(SKILL_FILES),
	(name) => !CORE_FILES.has(name),
)

export const skillFile = (name: SkillFileName): string => SKILL_FILES[name]

/**
 * File names the audit's own method text goes by. Prompts cite them, so agents try to read them
 * from the target; `RECURSION.md` is one they invent. A miss on one of these is not a target fact.
 */
export const SKILL_REFERENCE_FILES: ReadonlySet<string> = new Set([
	...Rec.keys(SKILL_FILES),
	"RECURSION.md",
	"report-schema.json",
])

/**
 * A block reference the vendored skill defines, spelled exactly as its key. Only `canonicalBlockRef`
 * and the block table make one, so a ledger unit built from these cannot name an unknown block.
 */
export type SkillBlockRef = Brand.Branded<string, "SkillBlockRef">
const SkillBlockRef = Brand.nominal<SkillBlockRef>()

export interface SkillBlock {
	/** `FILE.md#Name`, the skill's canonical block reference. */
	readonly ref: SkillBlockRef
	readonly file: SkillFileName
	readonly name: string
	/** The block's exact text, its marker line included. */
	readonly text: string
}

const ORDINARY_MARKER = /^\*\*([^*]+)\*\* \(subagent_type/
const SECTION_MARKER = /^## (.+)$/

const nameBeforeQualifier = (heading: string): string => Str.trim(Str.replace(/\s*\(.*$/, "")(heading))

const slice = (lines: ReadonlyArray<string>, from: number, to: number): string =>
	Str.trimEnd(Arr.join(lines.slice(from, to), "\n"))

/** The ordinary attack-class blocks: each runs from its bold marker to the next marker. */
const ordinaryBlocks = (): ReadonlyArray<SkillBlock> => {
	const lines = Str.split("\n")(SKILL_FILES[ATTACK_CLASSES_FILE])
	const starts = Arr.flatMap(lines, (line, index) => {
		const match = ORDINARY_MARKER.exec(line)
		return match?.[1] === undefined ? [] : [{ index, name: match[1] }]
	})
	return Arr.map(starts, (start, i) => ({
		ref: SkillBlockRef(`${ATTACK_CLASSES_FILE}#${start.name}`),
		file: ATTACK_CLASSES_FILE,
		name: start.name,
		text: slice(lines, start.index, starts[i + 1]?.index ?? lines.length),
	}))
}

/** A companion's `##` sections: core discipline, each attack-class subsection, universal moves, validation rules. */
const companionBlocks = (file: SkillFileName): ReadonlyArray<SkillBlock> => {
	const lines = Str.split("\n")(SKILL_FILES[file])
	const starts = Arr.flatMap(lines, (line, index) => {
		const match = SECTION_MARKER.exec(line)
		return match?.[1] === undefined ? [] : [{ index, name: nameBeforeQualifier(match[1]) }]
	})
	return Arr.map(starts, (start, i) => ({
		ref: SkillBlockRef(`${file}#${start.name}`),
		file,
		name: start.name,
		text: slice(lines, start.index, starts[i + 1]?.index ?? lines.length),
	}))
}

const ALL_BLOCKS: ReadonlyMap<SkillBlockRef, SkillBlock> = new Map(
	Arr.map([...ordinaryBlocks(), ...Arr.flatMap(COMPANION_FILES, companionBlocks)], (block) => [
		block.ref,
		block,
	]),
)

/** Every block reference the skill defines, ordinary blocks first, then each companion in file order. */
export const SKILL_BLOCK_REFS: ReadonlyArray<SkillBlockRef> = [...ALL_BLOCKS.keys()]

export const ORDINARY_BLOCK_REFS: ReadonlyArray<SkillBlockRef> = Arr.map(
	ordinaryBlocks(),
	(block) => block.ref,
)

/** Each companion file's block references, in heading order. */
export const companionBlockRefs = (file: SkillFileName): ReadonlyArray<SkillBlockRef> =>
	Arr.filter(SKILL_BLOCK_REFS, (ref) => Str.startsWith(`${file}#`)(ref))

/**
 * The lookup key both sides share: case-folded, the heading's parenthetical qualifier dropped,
 * whitespace trimmed around `#` and collapsed inside, so `web-protocol-and-auth.md # mfa,  passkey`
 * finds its block.
 */
const lookupKey = (ref: string): string => {
	const [file, name] = Option.match(Str.indexOf("#")(ref), {
		onNone: () => [ref, ""] as const,
		onSome: (at) => [Str.slice(0, at)(ref), nameBeforeQualifier(Str.slice(at + 1)(ref))] as const,
	})
	return Str.toLowerCase(`${Str.trim(file)}#${Str.replace(/\s+/g, " ")(name)}`)
}

const BY_LOOKUP_KEY: ReadonlyMap<string, SkillBlockRef> = new Map(
	Arr.map(SKILL_BLOCK_REFS, (ref) => [lookupKey(ref), ref]),
)

/** The skill's own spelling of `raw`, or undefined when no block it defines matches. */
export const canonicalBlockRef = (raw: string): SkillBlockRef | undefined => BY_LOOKUP_KEY.get(lookupKey(raw))

export const findBlock = (ref: string): SkillBlock | undefined => {
	const canonical = canonicalBlockRef(ref)
	return canonical === undefined ? undefined : ALL_BLOCKS.get(canonical)
}

/** The sections every prompt using a companion must carry alongside its chosen classes. */
export const COMPANION_REQUIRED_SECTIONS = ["Core discipline", "Universal moves", "Validation rules"] as const

/** Whether `ref` is one of a companion's required sections rather than one of its attack classes. */
export const isCompanionRequiredSection = (ref: SkillBlockRef): boolean =>
	Arr.some(COMPANION_REQUIRED_SECTIONS, (name) => Str.endsWith(`#${name}`)(ref))

/** The first `search` in `text` at or after `from`, as an index into the whole of `text`. */
const indexFrom = (text: string, search: string, from: number): Option.Option<number> =>
	Option.map(Str.indexOf(search)(Str.slice(from)(text)), (at) => at + from)

/** A companion's `When to use this file` guidance, which reconnaissance selects against. */
export const companionWhenToUse = (file: SkillFileName): string => {
	const text = SKILL_FILES[file]
	const start = Str.indexOf("#### When to use this file")(text)
	if (Option.isNone(start)) return ""
	const end = indexFrom(text, "\n## ", start.value)
	return Str.trimEnd(Str.slice(start.value, Option.getOrUndefined(end))(text))
}

/**
 * The first fenced block after `marker` in `file`, without its fences: how the skill ships the
 * prompts and procedures it says to copy verbatim.
 */
export const fencedBlockAfter = (file: SkillFileName, marker: string): string | undefined => {
	const text = SKILL_FILES[file]
	const open = Option.flatMap(Str.indexOf(marker)(text), (at) => indexFrom(text, "```", at))
	if (Option.isNone(open)) return undefined
	const bodyStart = Option.match(indexFrom(text, "\n", open.value), {
		onNone: () => 0,
		onSome: (newline) => newline + 1,
	})
	return Option.match(indexFrom(text, "\n```", bodyStart), {
		onNone: () => undefined,
		onSome: (close) => Str.slice(bodyStart, close)(text),
	})
}

/** The prose of a markdown section from its heading to the next heading of the same or higher level. */
export const sectionText = (file: SkillFileName, heading: string): string | undefined => {
	const text = SKILL_FILES[file]
	const found = Str.indexOf(heading)(text)
	if (Option.isNone(found)) return undefined
	const at = found.value
	const level = /^#+/.exec(heading)?.[0].length ?? 2
	const next = new RegExp(`\\n#{1,${level}} `, "g")
	next.lastIndex = at + heading.length
	const match = next.exec(text)
	return Str.trimEnd(Str.slice(at, match === null ? undefined : match.index)(text))
}

/** The prose of `file` from `marker` to the next heading of any level. */
export const textFrom = (file: SkillFileName, marker: string): string | undefined => {
	const text = SKILL_FILES[file]
	const at = Str.indexOf(marker)(text)
	if (Option.isNone(at)) return undefined
	const next = indexFrom(text, "\n#", at.value)
	return Str.trimEnd(Str.slice(at.value, Option.getOrUndefined(next))(text))
}
