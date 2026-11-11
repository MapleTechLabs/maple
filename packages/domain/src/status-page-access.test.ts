import { assert, describe, it } from "@effect/vitest"
import { Effect, String as Str } from "effect"
import { Base64Url } from "effect/encoding"
import {
	hashStatusPagePassword,
	STATUS_PAGE_PASSWORD_MAX_LENGTH,
	verifyStatusPagePassword,
} from "./status-page-access"

const PASSWORD = "correct horse battery"

/** A well-formed hash of `PASSWORD` at any iteration count, so only the count can make it fail. */
const hashAt = (iterations: number) =>
	Effect.promise(async () => {
		const salt = crypto.getRandomValues(new Uint8Array(16))
		const key = await crypto.subtle.importKey(
			"raw",
			new TextEncoder().encode(PASSWORD),
			"PBKDF2",
			false,
			["deriveBits"],
		)
		const bits = await crypto.subtle.deriveBits(
			{ name: "PBKDF2", hash: "SHA-256", salt, iterations },
			key,
			256,
		)
		return `pbkdf2-sha256$${iterations}$${Base64Url.encode(salt)}$${Base64Url.encode(new Uint8Array(bits))}`
	})

describe("verifyStatusPagePassword", () => {
	it.effect("accepts the password the hash was made from", () =>
		Effect.gen(function* () {
			const stored = yield* hashStatusPagePassword(PASSWORD)
			assert.isTrue(yield* verifyStatusPagePassword(PASSWORD, stored))
		}),
	)

	const tampered: ReadonlyArray<readonly [string, (stored: string) => string]> = [
		["another scheme", (stored) => Str.replace("pbkdf2-sha256$", "pbkdf2-sha1$")(stored)],
		["non-numeric iterations", (stored) => Str.replace("$100000$", "$1e5$")(stored)],
		["an extra part", (stored) => `${stored}$extra`],
		[
			"a salt that is not base64url",
			(stored) => {
				const [scheme, iterations, , key] = Str.split("$")(stored)
				return `${scheme}$${iterations}$not+base64/!$${key}`
			},
		],
	]

	for (const [name, tamper] of tampered) {
		it.effect(`matches nothing for a hash with ${name}`, () =>
			Effect.gen(function* () {
				const stored = yield* hashStatusPagePassword(PASSWORD)
				assert.isFalse(yield* verifyStatusPagePassword(PASSWORD, tamper(stored)))
			}),
		)
	}

	it.effect("matches nothing for more iterations than Workers allow", () =>
		Effect.gen(function* () {
			assert.isTrue(yield* verifyStatusPagePassword(PASSWORD, yield* hashAt(1_000)))
			assert.isFalse(yield* verifyStatusPagePassword(PASSWORD, yield* hashAt(100_001)))
		}),
	)

	it.effect("refuses a password over the length limit, even one the hash was made from", () =>
		Effect.gen(function* () {
			const long = Str.repeat(STATUS_PAGE_PASSWORD_MAX_LENGTH + 1)("a")
			const stored = yield* hashStatusPagePassword(long)
			assert.isFalse(yield* verifyStatusPagePassword(long, stored))
		}),
	)
})
