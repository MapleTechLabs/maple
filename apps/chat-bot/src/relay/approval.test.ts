/**
 * Who may approve a write Maple proposed.
 *
 * The rule is short enough to read and dangerous enough to pin: it is the only thing between
 * anybody who can click a button in a shared channel and a change to the org's alerts. Every case
 * below is a workspace somebody actually configures.
 */
import { APPROVER_ROLE_SETTING, type InboundActor } from "@maple/chat-platform"
import { describe, expect, it } from "vitest"
import { mayApprove } from "./approval.ts"

const actor = (overrides: Partial<InboundActor> = {}): InboundActor => ({
	id: "author-1",
	displayName: "Ada",
	roleIds: [],
	isWorkspaceAdmin: false,
	...overrides,
})

const APPROVERS = "role-approvers"

describe("who may approve", () => {
	it("lets a holder of the configured role approve, admin or not", () => {
		const settings = { [APPROVER_ROLE_SETTING]: APPROVERS }
		expect(mayApprove(settings, actor({ roleIds: [APPROVERS] }))).toBe(true)
		expect(mayApprove(settings, actor({ roleIds: ["role-other", APPROVERS] }))).toBe(true)
	})

	it("refuses everyone else once a role is configured, administrators included", () => {
		// Configuring the role IS the org saying who it meant, so it is not a floor that workspace
		// administration sits above.
		const settings = { [APPROVER_ROLE_SETTING]: APPROVERS }
		expect(mayApprove(settings, actor({ roleIds: ["role-other"] }))).toBe(false)
		expect(mayApprove(settings, actor({ isWorkspaceAdmin: true }))).toBe(false)
	})

	it("falls back to whoever may manage the workspace when no role is configured", () => {
		expect(mayApprove({}, actor({ isWorkspaceAdmin: true }))).toBe(true)
		expect(mayApprove({}, actor())).toBe(false)
		// A role somebody typed as whitespace is no role, not a role nobody holds — otherwise
		// clearing the field would lock every approval out of the workspace.
		expect(mayApprove({ [APPROVER_ROLE_SETTING]: "   " }, actor({ isWorkspaceAdmin: true }))).toBe(true)
	})

	it("never reads a role the platform did not report", () => {
		// `roleIds` is what ingress carried, and the empty list is the answer for a member with no
		// roles — never a wildcard.
		expect(mayApprove({ [APPROVER_ROLE_SETTING]: APPROVERS }, actor())).toBe(false)
	})
})
