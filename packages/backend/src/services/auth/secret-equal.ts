import { createHash, timingSafeEqual } from "node:crypto"

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest()

/**
 * Constant-time equality of a presented secret and the expected one. Both sides are hashed first,
 * so the compared buffers always have the same length whatever the input's length or encoding.
 */
export const secretsEqual = (provided: string, expected: string): boolean =>
	timingSafeEqual(digest(provided), digest(expected))
