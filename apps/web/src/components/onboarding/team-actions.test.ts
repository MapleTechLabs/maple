import { Effect, Exit, Cause, Option } from "effect"
import { expect, it, vi } from "vitest"
import { makeOnboardingTeamActions } from "./team-actions"

it("sends invitations only as members and keeps SDK failures typed", async () => {
	const inviteMember = vi.fn().mockResolvedValue({ id: "invitation" })
	const update = vi.fn().mockResolvedValue({ id: "workspace" })
	const actions = makeOnboardingTeamActions({ inviteMember, update })
	await Effect.runPromise(actions.invite("teammate@example.com"))
	expect(inviteMember).toHaveBeenCalledWith({ emailAddress: "teammate@example.com", role: "org:member" })
	expect(update).not.toHaveBeenCalled()

	update.mockRejectedValue({ code: "forbidden" })
	const result = await Effect.runPromiseExit(actions.rename("Engineering"))
	expect(Exit.isFailure(result)).toBe(true)
	if (Exit.isFailure(result)) {
		const error = Option.getOrUndefined(Cause.findErrorOption(result.cause))
		expect(error?._tag).toBe("@maple/web/OnboardingTeamError")
		expect(error?.operation).toBe("rename")
	}
})
