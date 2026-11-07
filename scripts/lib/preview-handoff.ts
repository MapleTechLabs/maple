/**
 * A Tinybird branch's credentials, passed from the trusted branch workflow to the
 * PR deploy job as a sealed artifact (see scripts/tinybird-pr-branch.ts).
 * Dependency-free: CI runs this before any install.
 */
export interface BranchHandoff {
	readonly host: string
	readonly id: string
	readonly token: string
}

const IV_BYTES = 12

const keyOf = async (secret: string): Promise<CryptoKey> =>
	crypto.subtle.importKey(
		"raw",
		await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret)),
		"AES-GCM",
		false,
		["encrypt", "decrypt"],
	)

/** AES-256-GCM, `iv | ciphertext+tag` in base64. The branch name is the additional data. */
export const sealHandoff = async (
	secret: string,
	branchName: string,
	handoff: BranchHandoff,
): Promise<string> => {
	const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
	const sealed = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(branchName) },
		await keyOf(secret),
		new TextEncoder().encode([handoff.host, handoff.id, handoff.token].join("\n")),
	)
	return Buffer.concat([iv, new Uint8Array(sealed)]).toString("base64")
}

/** `undefined` when the secret, branch name or payload does not match what was sealed. */
export const openHandoff = async (
	secret: string,
	branchName: string,
	encoded: string,
): Promise<BranchHandoff | undefined> => {
	const raw = Buffer.from(encoded.trim(), "base64")
	if (raw.length <= IV_BYTES) return undefined
	const plain = await crypto.subtle
		.decrypt(
			{
				name: "AES-GCM",
				iv: raw.subarray(0, IV_BYTES),
				additionalData: new TextEncoder().encode(branchName),
			},
			await keyOf(secret),
			raw.subarray(IV_BYTES),
		)
		.then(
			(bytes) => new TextDecoder().decode(bytes),
			() => undefined,
		)
	if (plain === undefined) return undefined
	// Host, id and token, one per line: none of them can hold a newline.
	const [host, id, token, ...rest] = plain.split("\n")
	if (!host || !id || !token || rest.length > 0) return undefined
	return { host, id, token }
}
