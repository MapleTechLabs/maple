/**
 * Who may approve a write Maple proposed, and whose authority it runs under.
 *
 * Three cases and one rule between them: a connector that cannot prove who clicked lets the
 * conversation decide, and one that can requires a link and then runs as the person behind it.
 * The case worth guarding hardest is the third — a connector that CAN identify must never fall
 * back to the weaker rule for somebody who has not linked.
 */
import { Schema } from "effect"
import { UserId } from "@maple/domain/primitives"
import { describe, expect, it } from "vitest"
import { approvalPolicy, linkNotice } from "./approval.ts"

const ADA = Schema.decodeSync(UserId)("user_ada")

describe("who may approve", () => {
	it("lets the conversation decide when the connector cannot say who clicked", () => {
		// The weaker rule, and deliberate: without an identity half the alternative is a bot that
		// proposes changes and can never apply them.
		expect(approvalPolicy(false, undefined)).toEqual({ _tag: "org" })
	})

	it("ignores a stray link on a connector that cannot say who clicked", () => {
		// Nothing should have resolved one, and if something did it is not evidence about a
		// platform that cannot prove identity at all.
		expect(approvalPolicy(false, ADA)).toEqual({ _tag: "org" })
	})

	it("runs as the linked user when the connector can say who clicked", () => {
		expect(approvalPolicy(true, ADA)).toEqual({ _tag: "user", userId: ADA })
	})

	it("refuses an unlinked clicker rather than falling back to the weaker rule", () => {
		// The whole point: on a platform where identity was available, "nobody linked" must not
		// silently become "anyone in the channel may approve".
		expect(approvalPolicy(true, undefined)).toEqual({ _tag: "unlinked" })
	})
})

describe("the link hint", () => {
	it("sends them to Maple, where a session exists to bind the link to", () => {
		// Never straight to the platform's OAuth: the callback has to know which Maple user is
		// linking, and only Maple's own page can establish that.
		expect(linkNotice("https://app.maple.dev")).toContain("https://app.maple.dev/integrations")
	})
})
