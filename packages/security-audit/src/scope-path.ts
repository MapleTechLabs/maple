/**
 * `isSafeRelativePath` from the skill's ledger validator, ported without `node:path` so browser
 * bundles can check a scope path. `scope-path.test.ts` holds it to the upstream function.
 */
import { Array as Arr, String as Str } from "effect"

const PATH_FORBIDDEN_CHARACTER = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u
const WINDOWS_RESERVED_COMPONENT =
	/^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu

/** A repository-relative path the engine accepts as a scope path. */
export const isSafeScopePath = (value: string): boolean =>
	value.length > 0 &&
	Str.trim(value) === value &&
	!PATH_FORBIDDEN_CHARACTER.test(value) &&
	!Str.includes("\\")(value) &&
	!Str.includes(":")(value) &&
	!Str.startsWith("/")(value) &&
	!Str.startsWith("~")(value) &&
	Arr.every(
		Str.split("/")(value),
		(segment) =>
			segment !== "" &&
			segment !== "." &&
			segment !== ".." &&
			!/[ .]$/u.test(segment) &&
			!WINDOWS_RESERVED_COMPONENT.test(segment),
	)
