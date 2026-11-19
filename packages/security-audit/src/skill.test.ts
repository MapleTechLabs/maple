import { describe, expect, it } from "vitest"
import { Array as Arr, Option, String as Str } from "effect"
import { canonicalBlockRef, findBlock, SKILL_BLOCK_REFS } from "./skill"

/** A ref with its heading part rewritten by `f`, the file part kept. */
const withName = (ref: string, f: (name: string) => string): string =>
	Option.match(Str.indexOf("#")(ref), {
		onNone: () => ref,
		onSome: (at) => `${Str.slice(0, at)(ref)}#${f(Str.slice(at + 1)(ref))}`,
	})

describe("canonicalBlockRef", () => {
	it("maps every defined reference to itself, so no two blocks share a lookup key", () => {
		expect(Arr.map(SKILL_BLOCK_REFS, canonicalBlockRef)).toEqual(SKILL_BLOCK_REFS)
	})

	it("resolves case, a parenthetical qualifier and stray whitespace to the skill's spelling", () => {
		const variants = (ref: string) => [
			Str.toLowerCase(ref),
			Str.toUpperCase(ref),
			withName(ref, (name) => `${name} (subagent_type: \`general\`)`),
			withName(ref, (name) => `  ${Str.replaceAll(" ", "   ")(name)}  `),
			` ${Str.replace("#", " # ")(ref)} `,
		]
		const unresolved = Arr.flatMap(SKILL_BLOCK_REFS, (ref) =>
			Arr.filter(variants(ref), (variant) => canonicalBlockRef(variant) !== ref),
		)
		expect(unresolved).toEqual([])
	})

	it("finds a block by any spelling that resolves to it", () => {
		expect(
			findBlock("web-protocol-and-auth.md#mfa, passkey, and account-transition attack classes")?.ref,
		).toBe("WEB-PROTOCOL-AND-AUTH.md#MFA, passkey, and account-transition attack classes")
	})

	it("leaves the finer names a critic invented in run 1ddcbea3 unresolved", () => {
		expect(
			Arr.map(
				[
					"WEB-PROTOCOL-AND-AUTH.md#Bearer tokens",
					"DATA-ISOLATION-AND-LIFECYCLE.md#Revocation and retention",
					"CLOUD-AND-DEPLOYMENT.md#Firewall and tunnel",
				],
				canonicalBlockRef,
			),
		).toEqual([undefined, undefined, undefined])
	})

	it("does not resolve a bare file name or a block from another file", () => {
		expect(canonicalBlockRef("WEB-PROTOCOL-AND-AUTH.md")).toBeUndefined()
		expect(canonicalBlockRef("CLIENT-SIDE.md#HTTP framing and cache attack classes")).toBeUndefined()
	})
})
