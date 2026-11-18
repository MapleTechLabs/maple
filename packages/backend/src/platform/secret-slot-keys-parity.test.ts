import { describe, expect, it } from "@effect/vitest"
import { Array as Arr, Effect, Option, Redacted, String as Str } from "effect"
import {
	CLICKHOUSE_PASSWORD_SLOT,
	clickHousePasswordSlotKeys,
	secretKeyId,
	secretSlotSubkey,
} from "@maple/infra/secret-slot-keys"
import { decryptAes256Gcm } from "./Crypto"
import { parseSecretKeyring, sealSecret } from "./SecretBox"
import { clickHousePasswordSlot } from "./secret-slots"

// The deploy derives the ingest gateway's slot keys in packages/infra, apart from SecretBox.
// These tests hold the two derivations equal, so a sealed password keeps opening in the gateway.
const masters = Arr.map([5, 6, 0x5a], (fill) => Buffer.alloc(32, fill))

const keyringOf = (master: Buffer) =>
	parseSecretKeyring({ primary: master.toString("base64"), decryptOnly: Option.none() }, (m) => m)

/** The v3 AAD of a ClickHouse password, written out as docs/secret-encryption.md specifies it. */
const v3Aad = (orgId: string, chUrl: string) =>
	Buffer.from(
		Arr.join(
			Arr.map(
				[CLICKHOUSE_PASSWORD_SLOT, orgId, "destination", chUrl],
				(part) => `${Buffer.byteLength(part, "utf8")}:${part},`,
			),
			"",
		),
	)

describe("infra's slot key derivation", () => {
	it("names the slot SecretBox seals ClickHouse passwords under", () => {
		expect(CLICKHOUSE_PASSWORD_SLOT).toBe(clickHousePasswordSlot.name)
	})

	it.effect("gives each master the key id SecretBox stamps on its envelopes", () =>
		Effect.forEach(masters, (master) =>
			Effect.map(keyringOf(master), (keyring) => expect(secretKeyId(master)).toBe(keyring.primary.id)),
		),
	)

	it.effect("opens a password SecretBox sealed, with only the derived slot subkey", () =>
		Effect.forEach(masters, (master) =>
			Effect.gen(function* () {
				const keyring = yield* keyringOf(master)
				const ref = { orgId: "org_parity", chUrl: "https://ch.example.com:8443" }
				const sealed = yield* sealSecret(keyring, clickHousePasswordSlot, ref, "ch-secret", (m) => m)
				const body = Str.split(sealed.ciphertext, ".")[2] ?? ""
				const opened = yield* decryptAes256Gcm(
					{ ...sealed, ciphertext: body },
					secretSlotSubkey(master, CLICKHOUSE_PASSWORD_SLOT),
					(m) => m,
					v3Aad(ref.orgId, ref.chUrl),
				)
				expect(opened).toBe("ch-secret")
				const otherSlot = yield* decryptAes256Gcm(
					{ ...sealed, ciphertext: body },
					secretSlotSubkey(master, "org_ingest_keys.private_key"),
					(m) => m,
					v3Aad(ref.orgId, ref.chUrl),
				).pipe(Effect.flip)
				expect(otherSlot).toBe("Decryption failed")
			}),
		),
	)

	it.effect("derives the slot keys string pinned in the gateway's tests for the fixture master", () =>
		Effect.gen(function* () {
			const slotKeys = yield* clickHousePasswordSlotKeys({
				primary: Redacted.make(Buffer.alloc(32, 5).toString("base64")),
				decryptOnly: Option.none(),
			})
			// FIXTURE_SLOT_KEYS in apps/ingest/src/main.rs, which opens secret-slots.test.ts's fixtures.
			expect(Redacted.value(slotKeys.value)).toBe("IGjfnBNl:DxboU6BYcIHPRlnXrZyrpik+g9IlCixfjGcrpISh4AU=")
		}),
	)
})
