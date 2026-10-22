import { Effect, Exit } from "effect"
import { afterEach, describe, expect, test, vi } from "vitest"
import { clerkTryReverified, REVERIFICATION_CANCELLED } from "./clerk"

const refusal = { errors: [{ code: "session_reverification_required", message: "Reverification required" }] }

/** A write Clerk refuses once for a stale session, then accepts. */
const writeRefusedOnce = () => {
	const calls = { count: 0 }
	const run = () => {
		calls.count += 1
		return calls.count === 1 ? Promise.reject(refusal) : Promise.resolve("done")
	}
	return { calls, run }
}

const stubClerk = (outcome: "verified" | "cancelled") => {
	const open = vi.fn((props: { afterVerification: () => void; afterVerificationCancelled: () => void }) =>
		outcome === "verified" ? props.afterVerification() : props.afterVerificationCancelled(),
	)
	vi.stubGlobal("window", { Clerk: { __internal_openReverification: open } })
	return open
}

afterEach(() => {
	vi.unstubAllGlobals()
})

describe("clerkTryReverified", () => {
	test("a refused write opens Clerk's challenge, then runs once more", async () => {
		const open = stubClerk("verified")
		const { calls, run } = writeRefusedOnce()
		const result = await Effect.runPromise(clerkTryReverified("Failed", run))
		expect(result).toBe("done")
		expect(open).toHaveBeenCalledTimes(1)
		expect(calls.count).toBe(2)
	})

	test("a dismissed challenge fails with the cancelled message and does not retry", async () => {
		stubClerk("cancelled")
		const { calls, run } = writeRefusedOnce()
		const exit = await Effect.runPromiseExit(clerkTryReverified("Failed", run))
		expect(Exit.isFailure(exit) && exit.cause.toString()).toContain(REVERIFICATION_CANCELLED)
		expect(calls.count).toBe(1)
	})

	test("any other failure is Clerk's own message, without a challenge", async () => {
		const open = stubClerk("verified")
		const exit = await Effect.runPromiseExit(
			clerkTryReverified("Failed", () =>
				Promise.reject({
					errors: [{ code: "form_password_incorrect", longMessage: "Wrong password" }],
				}),
			),
		)
		expect(Exit.isFailure(exit) && exit.cause.toString()).toContain("Wrong password")
		expect(open).not.toHaveBeenCalled()
	})
})
