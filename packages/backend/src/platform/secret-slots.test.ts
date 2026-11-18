import { describe, expect, it } from "@effect/vitest"
import { Effect, Option } from "effect"
import { openSecret, parseSecretKeyring } from "./SecretBox"
import { clickHousePasswordSlot } from "./secret-slots"

// The ingest gateway opens this column in Rust. The same triples are pinned in
// apps/ingest/src/main.rs, so a change to either envelope breaks one of the two tests.
const fixtureKeyring = parseSecretKeyring(
	{ primary: Buffer.alloc(32, 5).toString("base64"), decryptOnly: Option.none() },
	(message) => message,
)

const v2Fixture = {
	ciphertext: "v2.IGjfnBNl.1HbzraIYWPNUxiGCnA==",
	iv: "3gBID0+h49Y9q+SD",
	tag: "s2cyY7uChmyKqIcJzE8m7Q==",
}

/** Sealed for org_fixture while `ch_url` was `https://ch.example.com:8443`. */
const v3Fixture = {
	ciphertext: "v3.IGjfnBNl.xeDTFXH6xa2O+HjUIA==",
	iv: "AAECAwQFBgcICQoL",
	tag: "cG8TD4fQzD4DFygS8QA5tw==",
}

const open = (chUrl: string, stored: typeof v2Fixture) =>
	Effect.flatMap(fixtureKeyring, (keyring) =>
		openSecret(keyring, clickHousePasswordSlot, { orgId: "org_fixture", chUrl }, stored, (m) => m),
	)

describe("clickHousePasswordSlot", () => {
	it.effect("opens the v2 fixture the ingest gateway's tests open", () =>
		Effect.gen(function* () {
			expect(yield* open("https://ch.example.com:8443", v2Fixture)).toBe("ch-secret-123")
		}),
	)

	it.effect("opens the v3 fixture only while ch_url is the one it was sealed for", () =>
		Effect.gen(function* () {
			expect(yield* open("https://ch.example.com:8443", v3Fixture)).toBe("ch-secret-123")
			const moved = yield* open("https://attacker.example:8443", v3Fixture).pipe(Effect.flip)
			expect(moved).toBe("Decryption failed")
		}),
	)
})
