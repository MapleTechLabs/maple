import { Schema } from "effect"

export class LockfileParseError extends Schema.TaggedError<
	LockfileParseError,
	{ readonly brand: unique symbol }
>()("@maple/lockfiles/LockfileParseError", { message: Schema.String, path: Schema.String }) {}

export class LockfileUnsupportedError extends Schema.TaggedError<
	LockfileUnsupportedError,
	{ readonly brand: unique symbol }
>()("@maple/lockfiles/LockfileUnsupportedError", { message: Schema.String, path: Schema.String }) {}
