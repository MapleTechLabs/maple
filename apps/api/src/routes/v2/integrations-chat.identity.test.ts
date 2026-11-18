/**
 * A personal action takes a personal credential: linking a chat account, and starting an install
 * or a connection, are bound to `CurrentTenant.userId`, which is the caller only under a signed-in
 * session. Under an API key it is the member who created the key.
 */
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import type { AuditActorInfo } from "@maple/backend/services/auth/audit-actor"
import { CurrentAuditActor } from "@maple/backend/services/auth/audit-actor"
import { requirePerson } from "./require-person"

const asActor = (info: AuditActorInfo | undefined) =>
	requirePerson.pipe(Effect.provideService(CurrentAuditActor, info), Effect.exit)

describe("who may take a personal action", () => {
	it.effect("lets a signed-in person through", () =>
		Effect.gen(function* () {
			const result = yield* asActor({ type: "user", source: "dashboard" })
			assert.isTrue(result._tag === "Success")
		}),
	)

	it.effect("refuses an API key, however broadly it is scoped", () =>
		Effect.gen(function* () {
			// The key's creator is a real admin; that is exactly what makes this dangerous.
			const result = yield* asActor({ type: "api_key", source: "api", label: "ci-deploy" })
			assert.isTrue(result._tag === "Failure")
		}),
	)

	it.effect("refuses a device credential, which is a user's but not a session", () =>
		Effect.gen(function* () {
			const result = yield* asActor({ type: "user", source: "api", label: "Device credential" })
			assert.isTrue(result._tag === "Failure")
		}),
	)

	it.effect("refuses Maple's own internal token", () =>
		Effect.gen(function* () {
			const result = yield* asActor({ type: "system", source: "system" })
			assert.isTrue(result._tag === "Failure")
		}),
	)

	it.effect("denies by default when the credential cannot be identified", () =>
		Effect.gen(function* () {
			// `undefined` means the request skipped the standard auth middlewares; a credential this
			// route cannot name is not a person.
			const result = yield* asActor(undefined)
			assert.isTrue(result._tag === "Failure")
		}),
	)
})
