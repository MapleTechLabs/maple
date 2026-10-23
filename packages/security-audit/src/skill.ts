/**
 * The vendored skill as addressable text. The skill requires hunter and verifier prompts to carry
 * its blocks verbatim, so everything here returns exact substrings of the upstream files, never a
 * paraphrase. Block references use the skill's own form: `FILE.md#` plus the class name as written
 * in bold, or the heading text before any parenthetical qualifier.
 */
import { SKILL_FILES, type SkillFileName } from "./skill-files.generated"

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
export const COMPANION_FILES: ReadonlyArray<SkillFileName> = (
	Object.keys(SKILL_FILES) as Array<SkillFileName>
).filter((name) => !CORE_FILES.has(name))

export const skillFile = (name: SkillFileName): string => SKILL_FILES[name]

export interface SkillBlock {
	/** `FILE.md#Name`, the skill's canonical block reference. */
	readonly ref: string
	readonly file: SkillFileName
	readonly name: string
	/** The block's exact text, its marker line included. */
	readonly text: string
}

const ORDINARY_MARKER = /^\*\*([^*]+)\*\* \(subagent_type/
const SECTION_MARKER = /^## (.+)$/

const nameBeforeQualifier = (heading: string): string => heading.replace(/\s*\(.*$/, "").trim()

const slice = (lines: ReadonlyArray<string>, from: number, to: number): string =>
	lines.slice(from, to).join("\n").trimEnd()

/** The ordinary attack-class blocks: each runs from its bold marker to the next marker. */
const ordinaryBlocks = (): ReadonlyArray<SkillBlock> => {
	const lines = SKILL_FILES[ATTACK_CLASSES_FILE].split("\n")
	const starts = lines.flatMap((line, index) => {
		const match = ORDINARY_MARKER.exec(line)
		return match?.[1] === undefined ? [] : [{ index, name: match[1] }]
	})
	return starts.map((start, i) => ({
		ref: `${ATTACK_CLASSES_FILE}#${start.name}`,
		file: ATTACK_CLASSES_FILE,
		name: start.name,
		text: slice(lines, start.index, starts[i + 1]?.index ?? lines.length),
	}))
}

/** A companion's `##` sections: core discipline, each attack-class subsection, universal moves, validation rules. */
const companionBlocks = (file: SkillFileName): ReadonlyArray<SkillBlock> => {
	const lines = SKILL_FILES[file].split("\n")
	const starts = lines.flatMap((line, index) => {
		const match = SECTION_MARKER.exec(line)
		return match?.[1] === undefined ? [] : [{ index, name: nameBeforeQualifier(match[1]) }]
	})
	return starts.map((start, i) => ({
		ref: `${file}#${start.name}`,
		file,
		name: start.name,
		text: slice(lines, start.index, starts[i + 1]?.index ?? lines.length),
	}))
}

const ALL_BLOCKS: ReadonlyMap<string, SkillBlock> = new Map(
	[...ordinaryBlocks(), ...COMPANION_FILES.flatMap(companionBlocks)].map((block) => [block.ref, block]),
)

export const ORDINARY_BLOCK_REFS: ReadonlyArray<string> = ordinaryBlocks().map((block) => block.ref)

export const blockRefs = (): ReadonlyArray<string> => [...ALL_BLOCKS.keys()]

export const findBlock = (ref: string): SkillBlock | undefined => ALL_BLOCKS.get(ref)

/** The sections every prompt using a companion must carry alongside its chosen classes. */
export const COMPANION_REQUIRED_SECTIONS = ["Core discipline", "Universal moves", "Validation rules"] as const

/** A companion's `When to use this file` guidance, which reconnaissance selects against. */
export const companionWhenToUse = (file: SkillFileName): string => {
	const text = SKILL_FILES[file]
	const start = text.indexOf("#### When to use this file")
	if (start < 0) return ""
	const end = text.indexOf("\n## ", start)
	return text.slice(start, end < 0 ? undefined : end).trimEnd()
}

/**
 * The first fenced block after `marker` in `file`, without its fences: how the skill ships the
 * prompts and procedures it says to copy verbatim.
 */
export const fencedBlockAfter = (file: SkillFileName, marker: string): string | undefined => {
	const text = SKILL_FILES[file]
	const at = text.indexOf(marker)
	const open = at < 0 ? -1 : text.indexOf("```", at)
	if (open < 0) return undefined
	const bodyStart = text.indexOf("\n", open) + 1
	const close = text.indexOf("\n```", bodyStart)
	return close < 0 ? undefined : text.slice(bodyStart, close)
}

/** The prose of a markdown section from its heading to the next heading of the same or higher level. */
export const sectionText = (file: SkillFileName, heading: string): string | undefined => {
	const text = SKILL_FILES[file]
	const at = text.indexOf(heading)
	if (at < 0) return undefined
	const level = /^#+/.exec(heading)?.[0].length ?? 2
	const next = new RegExp(`\\n#{1,${level}} `, "g")
	next.lastIndex = at + heading.length
	const match = next.exec(text)
	return text.slice(at, match === null ? undefined : match.index).trimEnd()
}
