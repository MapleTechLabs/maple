import { Effect } from "effect"
import { afterEach, describe, expect, test, vi } from "vitest"

afterEach(() => {
	vi.unstubAllGlobals()
	vi.unstubAllEnvs()
})

/** A signed-out clerk-js already on `window`, so no script tag is injected. */
const stubClerk = (pathname: string) => {
	const load = vi.fn(() => Promise.resolve())
	vi.stubEnv("VITE_MAPLE_AUTH_MODE", "clerk")
	vi.stubGlobal("location", { pathname })
	vi.stubGlobal("window", { Clerk: { load, user: null, session: null, organization: null } })
	return load
}

/** `clerk.ts` and `clerk-boot.ts` as a fresh page load evaluates them. */
const loadModules = async () => {
	vi.resetModules()
	const clerk = await import("./clerk")
	// The boot's first step (the cookie purge) is async: let it reach `clerk.load`.
	await new Promise((resolve) => setTimeout(resolve, 0))
	return clerk
}

describe("clerk boot", () => {
	test("Clerk starts loading when the module loads, and LoadClerk joins that load", async () => {
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
})
