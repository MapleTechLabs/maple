// Shape primitives shared by the archive journal and manifest readers. Domain
// invariants (path containment, phase-vs-kind, cursor consistency) stay in
// those readers, each with its own tested message.
import { Schema, SchemaGetter, String as Str } from "effect"

/** Byte counts and cursors: never negative, never beyond exact integer range. */
export const NonNegativeSafeInt = Schema.Number.check(
	Schema.makeFilter((value: number) =>
		Number.isSafeInteger(value) && value >= 0 ? undefined : "must be a safe non-negative integer",
	),
)

/**
 * A sha256 digest, normalized to lower case before it is compared.
 *
 * Case normalization is part of the rule, not a courtesy: these digests gate
 * whether a generation may be deleted, and an upper-case digest that failed to
 * compare equal would look like corruption of data that is in fact intact.
 */
export const Sha256Lower = Schema.String.pipe(
	Schema.decodeTo(Schema.String, {
		decode: SchemaGetter.transform((value: string) => Str.toLowerCase(value)),
		encode: SchemaGetter.passthrough(),
	}),
).check(
	Schema.makeFilter((value: string) =>
		/^[0-9a-f]{64}$/.test(value) ? undefined : "must be 64 hex characters",
	),
)

export const NonEmptyString = Schema.String.check(Schema.isMinLength(1))
