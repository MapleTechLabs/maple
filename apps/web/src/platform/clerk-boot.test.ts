import { Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { afterEach, describe, expect, test, vi } from "vitest"

afterEach(() => {
	vi.unstubAllGlobals()
	vi.unstubAllEnvs()
})

/** A signed-out clerk-js already on `window`, so no script tag is injected. */
const stubClerk = (pathname: string, settles = true) => {
	const load = vi.fn(() => (settles ? Promise.resolve() : new Promise<void>(() => {})))
	vi.stubEnv("VITE_MAPLE_AUTH_MODE", "clerk")
	vi.stubGlobal("location", { pathname })
	vi.stubGlobal("window", { Clerk: { load, user: null, session: null, organization: null } })
	return load
}

/** A fresh page load: `boot.ts` starts the boot, then the app's `clerk.ts` loads. */
const loadModules = async () => {
	vi.resetModules()
	const { startClerkBoot } = await import("./clerk-boot")
	startClerkBoot()
	const clerk = await import("./clerk")
	// The boot's first step (the cookie purge) is async: let it reach `clerk.load`.
	await new Promise((resolve) => setTimeout(resolve, 0))
	return clerk
}

describe("clerk boot", () => {
	test("the boot starts Clerk loading before the app asks, and LoadClerk joins that load", async () => {
		const load = stubClerk("/")
		const { loadClerk } = await loadModules()
		expect(load).toHaveBeenCalledTimes(1)

		await Effect.runPromise(Effect.all([loadClerk, loadClerk]))
		expect(load).toHaveBeenCalledTimes(1)
	})

	test("a lab page does not start Clerk until something asks for it", async () => {
		vi.stubEnv("VITE_MAPLE_LAB", "on")
		const load = stubClerk("/lab/bench/logs")
		const { loadClerk } = await loadModules()
		expect(load).not.toHaveBeenCalled()

		await Effect.runPromise(loadClerk)
		expect(load).toHaveBeenCalledTimes(1)
	})

	test("a load that never settles fails LoadClerk 20s after the app asks for it", async () => {
		stubClerk("/", false)
		const { loadClerk } = await loadModules()
		const error = await Effect.runPromise(
			Effect.gen(function* () {
				const fiber = yield* Effect.forkChild(loadClerk)
				yield* TestClock.adjust("19 seconds")
				expect(fiber.pollUnsafe()).toBeUndefined()
				yield* TestClock.adjust("1 second")
				return yield* Effect.flip(Fiber.join(fiber))
			}).pipe(Effect.provide(TestClock.layer())),
		)
		expect(error).toMatchObject({
			_tag: "@maple/web/ClerkLoadError",
			message: "Clerk did not load in time",
		})
	})
})
