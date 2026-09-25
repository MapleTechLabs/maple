/**
 * Linking a chat account takes a personal credential.
 *
 * `CurrentTenant.userId` is "whoever is calling" only under a signed-in session. Under an API key
 * it is the human who CREATED the key, so without this guard a key scoped to `integrations:write`
 * could bind an attacker's chat account to that human — and every approval from it would then run
 * with their roles, through the Durable Object, where the key's scopes are never consulted.
 * Revoking the key would not undo it.
 */
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import type { AuditActorInfo } from "@maple/backend/services/auth/audit-actor"
import { CurrentAuditActor } from "@maple/backend/services/auth/audit-actor"
import { requirePerson } from "./integrations-chat.http"

const asActor = (info: AuditActorInfo | undefined) =>
	requirePerson.pipe(Effect.provideService(CurrentAuditActor, info), Effect.exit)

describe("who may link a chat account", () => {
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

	it.effect("refuses Maple's own internal token", () =>
		Effect.gen(function* () {
			const result = yield* asActor({ type: "system", source: "system" })
			assert.isTrue(result._tag === "Failure")
		}),
	)

	it.effect("is what the connector list consults before returning the caller's own link", () =>
		Effect.gen(function* () {
			// `tenant.userId` under an API key is the human who created it, so answering "your link"
			// would hand the key's holder that person's chat account. The list omits it instead.
			const asPerson = yield* asActor({ type: "user", source: "dashboard" })
			const asKey = yield* asActor({ type: "api_key", source: "api", label: "ci-deploy" })
			assert.isTrue(asPerson._tag === "Success")
			assert.isTrue(asKey._tag === "Failure")
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
