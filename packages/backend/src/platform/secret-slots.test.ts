import { describe, expect, it } from "@effect/vitest"
import { Effect, Option } from "effect"
import { openSecret, parseSecretKeyring } from "./SecretBox"
import { clickHousePasswordSlot } from "./secret-slots"

describe("clickHousePasswordSlot", () => {
	// The ingest gateway opens this column in Rust. The same triple is pinned in
	// apps/ingest/src/main.rs, so a change to the envelope breaks one of the two tests.
	it.effect("opens the fixture the ingest gateway's tests open", () =>
		Effect.gen(function* () {
			const keyring = yield* parseSecretKeyring(
				{ primary: Buffer.alloc(32, 5).toString("base64"), decryptOnly: Option.none() },
				(message) => message,
			)
			const password = yield* openSecret(
				keyring,
				clickHousePasswordSlot,
				{ orgId: "org_fixture" },
				{
					ciphertext: "v2.IGjfnBNl.1HbzraIYWPNUxiGCnA==",
					iv: "3gBID0+h49Y9q+SD",
					tag: "s2cyY7uChmyKqIcJzE8m7Q==",
				},
				(message) => message,
			)
			expect(password).toBe("ch-secret-123")
		}),
	)
})
