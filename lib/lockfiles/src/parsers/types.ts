import type { Effect } from "effect"
import type { LockfileParseError } from "../errors.ts"
import type { LockedPackage, LockfileInput, LockfileKind } from "../types.ts"

export interface ParserOutput {
	readonly kind: LockfileKind
	readonly packages: ReadonlyArray<LockedPackage>
	readonly warnings: ReadonlyArray<string>
}

export type Parser = (input: LockfileInput) => Effect.Effect<ParserOutput, LockfileParseError>
