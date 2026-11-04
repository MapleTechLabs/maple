import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto"
import { Option, Schema } from "effect"

/**
 * A Tinybird branch's credentials, passed from the trusted branch workflow to the
 * PR deploy job as a sealed artifact (see scripts/tinybird-pr-branch.ts).
 */
const BranchHandoff = Schema.Struct({
	host: Schema.NonEmptyString,
	id: Schema.NonEmptyString,
	token: Schema.NonEmptyString,
})
export type BranchHandoff = typeof BranchHandoff.Type

const decodeHandoff = Schema.decodeUnknownOption(Schema.fromJsonString(BranchHandoff))

const IV_BYTES = 12
const TAG_BYTES = 16

const keyOf = (secret: string): Buffer => createHash("sha256").update(secret).digest()

/** AES-256-GCM, `iv | tag | ciphertext` in base64. The branch name is the AAD. */
export const sealHandoff = (secret: string, branchName: string, handoff: BranchHandoff): string => {
	const iv = randomBytes(IV_BYTES)
	const cipher = createCipheriv("aes-256-gcm", keyOf(secret), iv)
	cipher.setAAD(Buffer.from(branchName))
	const sealed = Buffer.concat([cipher.update(JSON.stringify(handoff), "utf8"), cipher.final()])
	return Buffer.concat([iv, cipher.getAuthTag(), sealed]).toString("base64")
}

/** `undefined` when the secret, branch name or payload does not match what was sealed. */
export const openHandoff = (
	secret: string,
	branchName: string,
	encoded: string,
): BranchHandoff | undefined => {
	const raw = Buffer.from(encoded.trim(), "base64")
	if (raw.length <= IV_BYTES + TAG_BYTES) return undefined
	const decipher = createDecipheriv("aes-256-gcm", keyOf(secret), raw.subarray(0, IV_BYTES))
	decipher.setAAD(Buffer.from(branchName))
	decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES))
	const body = decipher.update(raw.subarray(IV_BYTES + TAG_BYTES))
	// `final` throws when the tag does not authenticate the key, branch name and payload.
	const finish = Option.liftThrowable(() => Buffer.concat([body, decipher.final()]).toString("utf8"))
	return finish().pipe(Option.flatMap(decodeHandoff), Option.getOrUndefined)
}
