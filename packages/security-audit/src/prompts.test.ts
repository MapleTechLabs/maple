import { describe, expect, it } from "vitest"
import { plannedUnit } from "./__fixtures__/records"
import { confirmedRecord, needsValidationRecord } from "./__fixtures__/records"
import {
	type AgentContext,
	candidateVerifierPrompt,
	companionFileOf,
	hunterPrompt,
	recordVerifierPrompt,
	unknownBlockRefs,
	VERBATIM,
} from "./prompts"
import {
	COMPANION_FILES,
	COMPANION_REQUIRED_SECTIONS,
	findBlock,
	ORDINARY_BLOCK_REFS,
	skillFile,
} from "./skill"

const context: AgentContext = {
	agentId: "hunter-1",
	toolGuidance: "Read files with read_file.",
	execution: { _tag: "Unavailable", blocker: "no OS-enforced sandbox" },
}

const prompt = hunterPrompt(
	{
		architectureMd: "ARCHITECTURE-SUMMARY",
		units: [plannedUnit],
		carriedExclusions: [],
		peerCoverageIds: ["peer-unit"],
		scratchPath: "agents/hunter-1/scratch",
		artifactsPath: "agents/hunter-1/artifacts",
		promotionAllowlist: "none",
	},
	context,
)

describe("skill blocks", () => {
	it("gives each ordinary attack class exactly its own block", () => {
		const texts = ORDINARY_BLOCK_REFS.map((ref) => findBlock(ref)?.text ?? "")
		expect(texts.map((text) => text.match(/\(subagent_type/g)?.length)).toEqual(texts.map(() => 1))
		expect(texts.map((text) => text.startsWith("**"))).toEqual(texts.map(() => true))
	})

	it("keeps the closing caveat with the last ordinary block", () => {
		expect(findBlock("ATTACK-CLASSES.md#Obvious things")?.text).toContain("A flag is not a finding")
	})

	it("resolves the three sections every companion must carry", () => {
		for (const file of COMPANION_FILES) {
			for (const section of COMPANION_REQUIRED_SECTIONS) {
				expect(
					findBlock(`${file}#${section}`)?.text.startsWith(`## ${section}`),
					`${file}#${section}`,
				).toBe(true)
			}
		}
	})

	it("extracts every verbatim prompt as an exact excerpt of its skill file", () => {
		const sources = [
			"HUNTING.md",
			"VALIDATION-AND-REPORTING.md",
			"RECONNAISSANCE.md",
			"SKILL.md",
		] as const
		const all = [
			...Object.values(VERBATIM).filter((value): value is string => typeof value === "string"),
			...Object.values(VERBATIM.recon),
		]
		for (const text of all) {
			expect(text.length).toBeGreaterThan(100)
			expect(sources.some((file) => skillFile(file).includes(text))).toBe(true)
		}
	})
})

describe("hunterPrompt", () => {
	it("carries every selected block verbatim", () => {
		for (const ref of [
			plannedUnit.ordinary_attack_class_block!,
			...plannedUnit.selected_companion_blocks,
		]) {
			expect(prompt).toContain(findBlock(ref)!.text)
		}
	})

	it("orders the parts as the skill requires", () => {
		const positions = [
			prompt.indexOf("Your goal is to find"),
			prompt.indexOf("ARCHITECTURE-SUMMARY"),
			prompt.indexOf(plannedUnit.coverage_id),
			prompt.indexOf(findBlock("ATTACK-CLASSES.md#Access control")!.text),
			prompt.indexOf("CLIENT-SIDE.md#Core discipline: no browser surface"),
			prompt.indexOf(VERBATIM.coreHuntingMethod),
			prompt.indexOf(VERBATIM.hunterPromotion),
			prompt.indexOf(VERBATIM.coreValidationRules),
			prompt.indexOf("peer-unit"),
			prompt.indexOf(VERBATIM.structuredHunterResult),
		]
		expect(positions.every((p) => p >= 0)).toBe(true)
		expect([...positions].sort((a, b) => a - b)).toEqual(positions)
	})

	it("leaves execution scaffolding out when execution is unavailable and asks for a validation plan", () => {
		const available = hunterPrompt(
			{
				architectureMd: "ARCHITECTURE-SUMMARY",
				units: [plannedUnit],
				carriedExclusions: [],
				peerCoverageIds: [],
				scratchPath: "agents/hunter-1/scratch",
				artifactsPath: "agents/hunter-1/artifacts",
				promotionAllowlist: "declared per check",
			},
			{ ...context, execution: { _tag: "Available", limits: "60s, 512 MiB" } },
		)
		const confirmedBranch = '"const": "confirmed"'
		for (const scaffold of ["agents/hunter-1/scratch", "agents/hunter-1/artifacts", confirmedBranch]) {
			expect(available).toContain(scaffold)
			expect(prompt).not.toContain(scaffold)
		}
		expect(prompt).toContain("Propose every lead as needs_validation")
		expect(prompt).toContain("concrete validation_plan")
	})

	it("tells the hunter not to execute when the sandbox is unavailable", () => {
		expect(prompt).toContain(
			"No target-controlled execution is available in this run: no OS-enforced sandbox",
		)
	})
})

describe("companionFileOf", () => {
	it("takes the file part of a reference and keeps a bare file name whole", () => {
		expect([
			companionFileOf("CLIENT-SIDE.md#Core discipline"),
			companionFileOf("CLIENT-SIDE.md"),
		]).toEqual(["CLIENT-SIDE.md", "CLIENT-SIDE.md"])
	})
})

describe("unknownBlockRefs", () => {
	it("flags a reference the skill does not define", () => {
		expect(
			unknownBlockRefs({
				...plannedUnit,
				selected_companion_blocks: ["DATA-ISOLATION-AND-LIFECYCLE.md#tenant-isolation"],
			}),
		).toEqual(["DATA-ISOLATION-AND-LIFECYCLE.md#tenant-isolation"])
	})
})

describe("estimated severity", () => {
	const estimate = {
		likelihood: { score: "low", reason: "needs a leaked key id" },
		impact: { score: "high", reason: "cross-tenant key roll" },
		overall_severity: "low",
	} as const

	it("asks hunters for an estimate beside each lead, calibrated by the skill's anchors", () => {
		expect(prompt).toContain(
			"Every needs_validation candidate therefore also carries `estimated_severity`",
		)
		// The skill's calibration anchors through its high/medium discriminator, verbatim.
		expect(prompt).toContain(VERBATIM.severityAnchors)
		expect(prompt).toContain("The high/medium discriminator")
	})

	it("asks a candidate verifier for its own estimate at the top level of a needs_validation decision", () => {
		const verifier = candidateVerifierPrompt(
			{
				candidate: needsValidationRecord,
				linkedChecks: [],
				architectureFacts: "",
				companionValidationBlocks: [],
				priorRecords: [],
			},
			context,
		)
		expect(verifier).toContain(
			'{"decision": "needs_validation", "record": {...}, "estimated_severity": {...}}',
		)
	})

	it("shows a record verifier a lead's current estimate, and none for a confirmed record", () => {
		expect(recordVerifierPrompt(needsValidationRecord, context, estimate)).toContain(
			JSON.stringify(estimate),
		)
		const confirmedPrompt = recordVerifierPrompt(confirmedRecord, context, null)
		expect(confirmedPrompt).not.toContain("The record's current estimate")
		expect(confirmedPrompt).not.toContain("The record carries no estimate yet")
	})
})
