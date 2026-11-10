import { describe, expect, it } from "@effect/vitest"
import { Array as Arr, Effect, Option, String as Str } from "effect"
import { encryptAes256Gcm } from "./Crypto"
import {
	type SecretSlot,
	hkdfSha256,
	openSecret,
	parseSecretKeyring,
	sealSecret,
	sealSecretV2,
} from "./SecretBox"

const keyOf = (byte: number) => Buffer.alloc(32, byte).toString("base64")

const keyring = (primary: number, ...decryptOnly: ReadonlyArray<number>) =>
	parseSecretKeyring(
		{
			primary: keyOf(primary),
			decryptOnly:
				decryptOnly.length === 0
					? Option.none()
					: Option.some(Arr.join(Arr.map(decryptOnly, keyOf), ",")),
		},
		(message) => message,
	)

interface Ref {
	readonly orgId: string
	readonly id: string
}

const slot: SecretSlot<Ref> = {
	name: "widgets.secret",
	binding: (ref) => [ref.orgId, ref.id],
}

const otherSlot: SecretSlot<Ref> = {
	name: "widgets.other_secret",
	binding: (ref) => [ref.orgId, ref.id],
}

const boundSlot: SecretSlot<Ref> = {
	name: "gadgets.secret",
	binding: (ref) => [ref.orgId, ref.id],
	legacyAad: (ref) => Buffer.from(`gadgets:v1:${ref.orgId}:${ref.id}`, "utf8"),
}

const ref: Ref = { orgId: "org_a", id: "row_1" }
const fail = (message: string) => message

describe("hkdfSha256", () => {
	it("matches RFC 5869 test case 3 (empty salt and info)", () => {
		const inputKey = Buffer.alloc(22, 0x0b)
		expect(hkdfSha256(inputKey, "").toString("hex")).toBe(
			"8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d",
		)
	})
})

describe("parseSecretKeyring", () => {
	it.effect("names the setting when the primary key is missing or malformed", () =>
		Effect.gen(function* () {
			const missing = yield* parseSecretKeyring(
				{ primary: "  ", decryptOnly: Option.none() },
				fail,
			).pipe(Effect.flip)
			const short = yield* parseSecretKeyring(
				{ primary: Buffer.alloc(16, 1).toString("base64"), decryptOnly: Option.none() },
				fail,
			).pipe(Effect.flip)
			expect(missing).toBe("MAPLE_INGEST_KEY_ENCRYPTION_KEY is required")
			expect(short).toBe("MAPLE_INGEST_KEY_ENCRYPTION_KEY must be base64 for exactly 32 bytes")
		}),
	)

	it.effect("rejects a malformed decrypt-only key instead of dropping it", () =>
		Effect.gen(function* () {
			const error = yield* parseSecretKeyring(
				{ primary: keyOf(1), decryptOnly: Option.some(`${keyOf(2)},not-a-key`) },
				fail,
			).pipe(Effect.flip)
			expect(error).toContain("MAPLE_INGEST_KEY_DECRYPTION_KEYS")
		}),
	)

	it.effect("lists the primary once when it is repeated in the decrypt-only list", () =>
		Effect.gen(function* () {
			const ring = yield* parseSecretKeyring(
				{ primary: keyOf(1), decryptOnly: Option.some(`${keyOf(1)}, ${keyOf(2)} ,${keyOf(2)}`) },
				fail,
			)
			expect(Arr.map(ring.keys, (key) => key.id)).toEqual([
				ring.primary.id,
				(yield* keyring(2)).primary.id,
			])
		}),
	)
})

describe("v2 envelope", () => {
	it.effect("round-trips and records the sealing key's id in the ciphertext", () =>
		Effect.gen(function* () {
			const ring = yield* keyring(1)
			const sealed = yield* sealSecretV2(ring, slot, ref, "hunter2", fail)
			expect(Str.startsWith(`v2.${ring.primary.id}.`)(sealed.ciphertext)).toBe(true)
			expect(yield* openSecret(ring, slot, ref, sealed, fail)).toBe("hunter2")
		}),
	)

	it.effect("does not open on another row, another org or another column", () =>
		Effect.gen(function* () {
			const ring = yield* keyring(1)
			const sealed = yield* sealSecretV2(ring, slot, ref, "hunter2", fail)
			const outcomes = yield* Effect.all([
				openSecret(ring, slot, { ...ref, id: "row_2" }, sealed, fail).pipe(Effect.option),
				openSecret(ring, slot, { ...ref, orgId: "org_b" }, sealed, fail).pipe(Effect.option),
				openSecret(ring, otherSlot, ref, sealed, fail).pipe(Effect.option),
			])
			expect(outcomes).toEqual([Option.none(), Option.none(), Option.none()])
		}),
	)

	it.effect("keeps (org, row) boundaries apart when ids contain the separator", () =>
		Effect.gen(function* () {
			const ring = yield* keyring(1)
			const sealed = yield* sealSecretV2(ring, slot, { orgId: "a", id: "b,1:c" }, "x", fail)
			const moved = yield* openSecret(ring, slot, { orgId: "a,1:b", id: "c" }, sealed, fail).pipe(
				Effect.option,
			)
			expect(moved).toEqual(Option.none())
		}),
	)

	it.effect("refuses a tag cut down to fewer bytes", () =>
		Effect.gen(function* () {
			const ring = yield* keyring(1)
			const sealed = yield* sealSecretV2(ring, slot, ref, "hunter2", fail)
			const shortTag = Buffer.from(sealed.tag, "base64").subarray(0, 4).toString("base64")
			const outcome = yield* openSecret(ring, slot, ref, { ...sealed, tag: shortTag }, fail).pipe(
				Effect.flip,
			)
			expect(outcome).toBe("Decryption failed")
		}),
	)

	it.effect("opens with a decrypt-only key after the primary is rotated", () =>
		Effect.gen(function* () {
			const sealed = yield* sealSecretV2(yield* keyring(1), slot, ref, "hunter2", fail)
			expect(yield* openSecret(yield* keyring(2, 1), slot, ref, sealed, fail)).toBe("hunter2")
		}),
	)

	it.effect("says so when the sealing key is not held", () =>
		Effect.gen(function* () {
			const sealed = yield* sealSecretV2(yield* keyring(1), slot, ref, "hunter2", fail)
			const error = yield* openSecret(yield* keyring(2), slot, ref, sealed, fail).pipe(Effect.flip)
			expect(error).toBe("Sealed with a key this deployment does not hold")
		}),
	)
})

describe("pre-v2 envelope", () => {
	it.effect("opens a value written by the old helpers, with and without their AAD", () =>
		Effect.gen(function* () {
			const ring = yield* keyring(1)
			const master = Buffer.alloc(32, 1)
			const plain = yield* encryptAes256Gcm("old", master, fail)
			const bound = yield* encryptAes256Gcm(
				"old-bound",
				master,
				fail,
				Buffer.from("gadgets:v1:org_a:row_1", "utf8"),
			)
			expect(yield* openSecret(ring, slot, ref, plain, fail)).toBe("old")
			expect(yield* openSecret(ring, boundSlot, ref, bound, fail)).toBe("old-bound")
		}),
	)

	it.effect("opens a value sealed under a decrypt-only key", () =>
		Effect.gen(function* () {
			const old = yield* encryptAes256Gcm("old", Buffer.alloc(32, 1), fail)
			expect(yield* openSecret(yield* keyring(2, 1), slot, ref, old, fail)).toBe("old")
		}),
	)

	it.effect("is what sealSecret still writes, so an undeployed reader keeps working", () =>
		Effect.gen(function* () {
			const ring = yield* keyring(1)
			const sealed = yield* sealSecret(ring, boundSlot, ref, "hunter2", fail)
			expect(sealed.ciphertext).not.toContain(".")
			expect(yield* openSecret(ring, boundSlot, ref, sealed, fail)).toBe("hunter2")
		}),
	)
})
