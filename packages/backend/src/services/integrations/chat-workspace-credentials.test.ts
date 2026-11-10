/**
 * The envelope, on its own.
 *
 * The round trip is the cheap half; the binding is the half worth a test — the whole reason the
 * AAD exists is that an attacker with database writes must not be able to move a working
 * ciphertext onto a row it was not written for.
 */
import { assert, describe, it } from "@effect/vitest"
import { Array as Arr, Effect, Option } from "effect"
import { parseSecretKeyring } from "@maple/backend/platform/SecretBox"
import {
	openChatWorkspaceCredentials,
	sealChatWorkspaceCredentials,
	storedCredentials,
} from "./chat-workspace-credentials"

const KEY = Buffer.alloc(32, 7)
const OTHER_KEY = Buffer.alloc(32, 9)

const REF = { orgId: "org_1", connector: "testchat", externalWorkspaceId: "workspace-1" }

const SECRET = '{"token":"a-workspaces-own-token"}'

const fail = (message: string) => new Error(message)

const keyringOf = (primary: Buffer, decryptOnly: ReadonlyArray<Buffer> = []) =>
	parseSecretKeyring(
		{
			primary: primary.toString("base64"),
			decryptOnly: Option.some(
				Arr.join(
					Arr.map(decryptOnly, (key) => key.toString("base64")),
					",",
				),
			),
		},
		fail,
	)

const seal = (ref = REF, key = KEY) =>
	Effect.flatMap(keyringOf(key), (keyring) => sealChatWorkspaceCredentials(SECRET, keyring, ref, fail))

const open = (
	sealed: { readonly ciphertext: string; readonly iv: string; readonly tag: string },
	ref = REF,
	key = KEY,
	decryptOnly: ReadonlyArray<Buffer> = [],
) =>
	Effect.flatMap(keyringOf(key, decryptOnly), (keyring) =>
		openChatWorkspaceCredentials(sealed, keyring, ref, fail),
	)

describe("chat workspace credentials", () => {
	it.effect("round-trips a connector's own secret", () =>
		Effect.gen(function* () {
			const sealed = yield* seal()
			assert.notInclude(sealed.ciphertext, "token")
			assert.strictEqual(yield* open(sealed), SECRET)
		}),
	)

	it.effect("mints a fresh nonce every time, so two rows never share one", () =>
		Effect.gen(function* () {
			const first = yield* seal()
			const second = yield* seal()
			assert.notStrictEqual(first.iv, second.iv)
			assert.notStrictEqual(first.ciphertext, second.ciphertext)
		}),
	)

	it.effect("refuses to open a ciphertext moved onto another org, connector or workspace", () =>
		Effect.gen(function* () {
			const sealed = yield* seal()
			for (const ref of [
				{ ...REF, orgId: "org_2" },
				{ ...REF, connector: "otherchat" },
				{ ...REF, externalWorkspaceId: "workspace-2" },
			]) {
				assert.isTrue(yield* Effect.isFailure(open(sealed, ref)))
			}
		}),
	)

	it.effect("refuses to open it with a different deployment's key", () =>
		Effect.gen(function* () {
			const sealed = yield* seal()
			assert.isTrue(yield* Effect.isFailure(open(sealed, REF, OTHER_KEY)))
		}),
	)

	it.effect("still opens it after a rotation, while the old key is kept for opening", () =>
		Effect.gen(function* () {
			const sealed = yield* seal(REF, OTHER_KEY)
			assert.strictEqual(yield* open(sealed, REF, KEY, [OTHER_KEY]), SECRET)
		}),
	)

	it.effect("refuses a stored value that is not in the v2 envelope", () =>
		Effect.gen(function* () {
			const stored = {
				ciphertext: Buffer.from("old").toString("base64"),
				iv: Buffer.alloc(12, 1).toString("base64"),
				tag: Buffer.alloc(16, 2).toString("base64"),
			}
			const error = yield* open(stored).pipe(Effect.flip)
			assert.strictEqual(error.message, "Stored value is not in the v2 envelope")
		}),
	)

	it("reads a row with no credential, and a half-written one, as no credential", () => {
		assert.isNull(
			storedCredentials({ credentialsCiphertext: null, credentialsIv: null, credentialsTag: null }),
		)
		// Two of three columns is a row nobody can decrypt; treating it as absent is the same
		// outcome as trying and failing, one branch earlier.
		assert.isNull(
			storedCredentials({ credentialsCiphertext: "c", credentialsIv: "i", credentialsTag: null }),
		)
		assert.deepStrictEqual(
			storedCredentials({ credentialsCiphertext: "c", credentialsIv: "i", credentialsTag: "t" }),
			{ ciphertext: "c", iv: "i", tag: "t" },
		)
	})
})
