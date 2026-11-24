import { Effect, String as Str } from "effect"
import { LockfileParseError, LockfileUnsupportedError } from "./errors.ts"
import { dedupePackages } from "./internal/collect.ts"
import { parseSpan } from "./internal/span.ts"
import { parseBunLock } from "./parsers/bun.ts"
import { parseCargoLock } from "./parsers/cargo.ts"
import { parseGoMod, parseGoSum } from "./parsers/go.ts"
import { parsePackageLock } from "./parsers/packageLock.ts"
import { parsePnpmLock } from "./parsers/pnpm.ts"
import type { Parser } from "./parsers/types.ts"
import { parseYarnLock } from "./parsers/yarn.ts"
import { BUN_LOCKB_UNSUPPORTED, lockfileKindOf } from "./paths.ts"
import type { LockfileInput, LockfileKind, ParsedLockfile } from "./types.ts"

const PARSERS = {
	"package-lock": parsePackageLock,
	"pnpm-lock": parsePnpmLock,
	"yarn-v1": parseYarnLock,
	"yarn-berry": parseYarnLock,
	"bun-lock": parseBunLock,
	"go-mod": parseGoMod,
	"go-sum": parseGoSum,
	"cargo-lock": parseCargoLock,
} satisfies Record<Exclude<LockfileKind, "bun-lockb">, Parser>

export const parseLockfile = Effect.fn(function* (
	input: LockfileInput,
): Effect.fn.Return<ParsedLockfile, LockfileParseError | LockfileUnsupportedError> {
	const kind = lockfileKindOf(input.path)
	if (kind === undefined) {
		return yield* new LockfileUnsupportedError({
			path: input.path,
			message: `not a supported lockfile: ${input.path}`,
		})
	}
	if (kind === "bun-lockb") {
		return yield* new LockfileUnsupportedError({ path: input.path, message: BUN_LOCKB_UNSUPPORTED })
	}
	// An editor's byte order mark is not part of any format, and JSON.parse refuses it.
	const content = Str.startsWith("\uFEFF")(input.content) ? Str.slice(1)(input.content) : input.content
	const output = yield* PARSERS[kind]({ ...input, content })
	return {
		path: input.path,
		kind: output.kind,
		packages: dedupePackages(output.packages),
		warnings: output.warnings,
	}
}, parseSpan("lockfiles.parseLockfile"))
