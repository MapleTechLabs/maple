import { describe, expect, it } from "vitest"
import { String as Str } from "effect"
import { ledgerErrors } from "../validators"
import { seed } from "./__fixtures__/harness"
import { type ProposalReview, proposalNote, reviewProposal, seedUnit } from "./ledger"

const BEARER = "WEB-PROTOCOL-AND-AUTH.md#Bearer tokens"
const REVOCATION = "DATA-ISOLATION-AND-LIFECYCLE.md#Revocation and retention"
const FIREWALL = "CLOUD-AND-DEPLOYMENT.md#Firewall and tunnel"

/** The admitted unit and what was dropped; a refusal fails the test with its reason. */
const admitted = (review: ProposalReview) => {
	expect(review._tag === "Refused" ? review.reason : "admitted").toBe("admitted")
	return review._tag === "Admissible" ? review : { unit: undefined, dropped: undefined }
}

describe("reviewProposal", () => {
	it("rewrites loosely spelled references to the skill's own and the ledger accepts the unit", () => {
		const proposal = seed("keys", "Access control", {
			ordinary_attack_class_block: "attack-classes.md#access control",
			selected_companion_blocks: [
				"DATA-ISOLATION-AND-LIFECYCLE.md#Tenant and object-isolation attack classes (subagent_type: `general`)",
			],
			excluded_blocks: [{ block: "  client-side.md#core discipline ", reason: "no browser surface" }],
		})
		const review = admitted(reviewProposal(proposal))
		expect(review.unit?.ordinary_attack_class_block).toBe("ATTACK-CLASSES.md#Access control")
		expect(review.unit?.selected_companion_blocks).toEqual([
			"DATA-ISOLATION-AND-LIFECYCLE.md#Tenant and object-isolation attack classes",
		])
		expect(review.unit?.excluded_blocks).toEqual([
			{ block: "CLIENT-SIDE.md#Core discipline", reason: "no browser surface" },
		])
		expect(review.dropped).toEqual([])
		expect(ledgerErrors([seedUnit(review.unit!, { scope: [], priorStatus: "none" })])).toEqual([])
	})

	it("drops the run 1ddcbea3 companion and excluded references and keeps the unit", () => {
		const proposal = seed("keys", "Access control", {
			selected_companion_blocks: [BEARER, "WEB-PROTOCOL-AND-AUTH.md#API-key and mTLS attack classes"],
			excluded_blocks: [
				{ block: REVOCATION, reason: "no deletion path" },
				{ block: FIREWALL, reason: "no ingress config" },
			],
		})
		const review = admitted(reviewProposal(proposal))
		expect(review.unit?.selected_companion_blocks).toEqual([
			"WEB-PROTOCOL-AND-AUTH.md#API-key and mTLS attack classes",
		])
		expect(review.unit?.excluded_blocks).toEqual([])
		expect(review.dropped).toEqual([BEARER, REVOCATION, FIREWALL])
		expect(proposalNote(proposal, reviewProposal(proposal))).toBe(
			`kept: POST /keys / Access control: dropped 3 unknown block references (${BEARER}, ${REVOCATION}, ${FIREWALL})`,
		)
	})

	it("refuses a unit whose ordinary attack-class block is unknown and names it for repair", () => {
		const review = reviewProposal(
			seed("keys", "Access control", {
				ordinary_attack_class_block: "ATTACK-CLASSES.md#Bearer tokens",
			}),
		)
		expect(review).toEqual({
			_tag: "Refused",
			reason: "unknown ordinary attack-class block: ATTACK-CLASSES.md#Bearer tokens",
			unknownRefs: ["ATTACK-CLASSES.md#Bearer tokens"],
		})
	})

	it("refuses a companion-only unit when none of its companion blocks is known", () => {
		const review = reviewProposal(
			seed("keys", "Bearer tokens", {
				ordinary_attack_class_block: null,
				selected_companion_blocks: [BEARER, FIREWALL],
			}),
		)
		expect(review._tag === "Refused" ? review.unknownRefs : []).toEqual([BEARER, FIREWALL])
	})

	it("refuses a companion-only unit whose only known blocks are the companion's required sections", () => {
		const review = reviewProposal(
			seed("keys", "Bearer tokens", {
				ordinary_attack_class_block: null,
				selected_companion_blocks: ["WEB-PROTOCOL-AND-AUTH.md#Core discipline", BEARER],
			}),
		)
		expect(review._tag === "Refused" ? review.unknownRefs : []).toEqual([BEARER])
	})

	it("refuses a companion section named as the ordinary attack-class block", () => {
		const core = "WEB-PROTOCOL-AND-AUTH.md#Core discipline"
		expect(reviewProposal(seed("keys", "Bearer tokens", { ordinary_attack_class_block: core }))).toEqual({
			_tag: "Refused",
			reason: `not an ordinary attack-class block: ${core}`,
			unknownRefs: [core],
		})
	})

	it("refuses a unit with neither an attack-class block nor a companion block", () => {
		const review = reviewProposal(
			seed("keys", "Bearer tokens", {
				ordinary_attack_class_block: null,
				selected_companion_blocks: [],
			}),
		)
		expect(review).toEqual({
			_tag: "Refused",
			reason: "no known attack-class block: no companion block names an attack class",
			unknownRefs: [],
		})
	})

	it("collapses two spellings of one block and an exclusion of a selected block", () => {
		const tenant = "DATA-ISOLATION-AND-LIFECYCLE.md#Tenant and object-isolation attack classes"
		const review = admitted(
			reviewProposal(
				seed("keys", "Access control", {
					selected_companion_blocks: [tenant, Str.toLowerCase(tenant)],
					excluded_blocks: [
						{ block: Str.toUpperCase(tenant), reason: "x" },
						{ block: "CLIENT-SIDE.md#Core discipline", reason: "first" },
						{ block: "client-side.md#Core discipline", reason: "second" },
					],
				}),
			),
		)
		expect(review.unit?.selected_companion_blocks).toEqual([tenant])
		expect(review.unit?.excluded_blocks).toEqual([
			{ block: "CLIENT-SIDE.md#Core discipline", reason: "first" },
		])
		expect(ledgerErrors([seedUnit(review.unit!, { scope: [], priorStatus: "none" })])).toEqual([])
	})
})
