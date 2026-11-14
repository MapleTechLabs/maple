import { Schema } from "effect"

/** Legacy 16-character bundled-schema fingerprint. */
export const Fingerprint16 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{16}$/i))

/** Full sha256 hex digest. */
export const Digest64 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/i))

/**
 * An ISO timestamp, or the literal `"unknown"`.
 *
 * Provenance timestamps on a store predate the versioned marker, so a store
 * created by an old build genuinely has no creation time. That is recorded
 * rather than guessed.
 */
export const IsoOrUnknown = Schema.String.check(
	Schema.makeFilter((value: string) =>
		value === "unknown" || Number.isFinite(Date.parse(value))
			? undefined
			: 'must be an ISO timestamp or "unknown"',
	),
)
