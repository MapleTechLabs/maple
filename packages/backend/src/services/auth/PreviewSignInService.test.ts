import { describe, expect, it } from "@effect/vitest"
import { Effect, Option, Redacted } from "effect"
import {
	makePreviewSignIn,
	PREVIEW_REVIEWER_EMAIL,
	PREVIEW_REVIEWER_ORG_NAME,
	previewKey,
	type PreviewClerk,
} from "./PreviewSignInService"

const previewEnv = {
	MAPLE_AUTH_MODE: "clerk",
	MAPLE_ENVIRONMENT: "pr-1336",
	CLERK_SECRET_KEY: Option.some(Redacted.make("sk_test_abc")),
	PREVIEW_SIGNIN_KEY: Option.some(Redacted.make("shared-key")),
}

/** An in-memory Clerk that records every write, starting with `users` already present. */
const fakeClerk = (users: Record<string, { id: string; orgs: Array<string> }> = {}) => {
	const writes: string[] = []
	const clerk: PreviewClerk = {
		findUserIdByEmail: (email) => Effect.succeed(Option.fromNullishOr(users[email]?.id)),
		createUser: (email) =>
			Effect.sync(() => {
				writes.push(`createUser ${email}`)
				users[email] = { id: "user_new", orgs: [] }
				return "user_new"
			}),
		isMemberOf: (userId, name) =>
			Effect.succeed(
				Object.values(users).some((user) => user.id === userId && user.orgs.includes(name)),
			),
		createOrganization: (userId, name) =>
			Effect.sync(() => void writes.push(`createOrg ${userId} ${name}`)),
		createSignInToken: (userId, ttl) => Effect.succeed(`ticket:${userId}:${ttl}`),
	}
	return { clerk, writes }
}

describe("previewKey", () => {
	it("is the key on a PR stage with a Clerk development instance", () => {
		expect(previewKey(previewEnv)).toEqual(Option.some("shared-key"))
	})

	it.each([
		["production", { MAPLE_ENVIRONMENT: "production" }],
		["a dev stage", { MAPLE_ENVIRONMENT: "development" }],
		["a live Clerk instance", { CLERK_SECRET_KEY: Option.some(Redacted.make("sk_live_abc")) }],
		["self-hosted auth", { MAPLE_AUTH_MODE: "self_hosted" }],
		["an unset key", { PREVIEW_SIGNIN_KEY: Option.none() }],
		["a blank key", { PREVIEW_SIGNIN_KEY: Option.some(Redacted.make("  ")) }],
	])("is none on %s", (_, override) => {
		expect(previewKey({ ...previewEnv, ...override })).toEqual(Option.none())
	})
})

describe("makePreviewSignIn", () => {
	it.effect("reports disabled and refuses sign-in outside previews", () =>
		Effect.gen(function* () {
			const service = makePreviewSignIn(Option.none())
			expect((yield* service.status()).enabled).toBe(false)
			const error = yield* Effect.flip(service.signIn("shared-key"))
			expect(error._tag).toBe("@maple/http/errors/PreviewSignInDisabledError")
		}),
	)

	it.effect("rejects a wrong key without touching Clerk", () =>
		Effect.gen(function* () {
			const { clerk, writes } = fakeClerk()
			const service = makePreviewSignIn(Option.some({ key: "shared-key", clerk }))
			const error = yield* Effect.flip(service.signIn("shared-kez"))
			expect(error._tag).toBe("@maple/http/errors/PreviewSignInInvalidKeyError")
			expect(writes).toEqual([])
		}),
	)

	it.effect("creates the reviewer and its org on first use, then mints a ticket", () =>
		Effect.gen(function* () {
			const { clerk, writes } = fakeClerk()
			const service = makePreviewSignIn(Option.some({ key: "shared-key", clerk }))
			expect((yield* service.status()).enabled).toBe(true)
			const { ticket } = yield* service.signIn("shared-key")
			expect(ticket).toBe("ticket:user_new:120")
			expect(writes).toEqual([
				`createUser ${PREVIEW_REVIEWER_EMAIL}`,
				`createOrg user_new ${PREVIEW_REVIEWER_ORG_NAME}`,
			])
		}),
	)

	it.effect("reuses an existing reviewer that already has an org", () =>
		Effect.gen(function* () {
			const { clerk, writes } = fakeClerk({
				[PREVIEW_REVIEWER_EMAIL]: { id: "user_1", orgs: [PREVIEW_REVIEWER_ORG_NAME] },
			})
			const service = makePreviewSignIn(Option.some({ key: "shared-key", clerk }))
			const { ticket } = yield* service.signIn("shared-key")
			expect(ticket).toBe("ticket:user_1:120")
			expect(writes).toEqual([])
		}),
	)

	it.effect("creates the Preview org for a reviewer that only belongs to other orgs", () =>
		Effect.gen(function* () {
			const { clerk, writes } = fakeClerk({
				[PREVIEW_REVIEWER_EMAIL]: { id: "user_1", orgs: ["Acme"] },
			})
			const service = makePreviewSignIn(Option.some({ key: "shared-key", clerk }))
			yield* service.signIn("shared-key")
			expect(writes).toEqual([`createOrg user_1 ${PREVIEW_REVIEWER_ORG_NAME}`])
		}),
	)
})
