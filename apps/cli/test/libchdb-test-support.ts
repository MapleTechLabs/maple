import { describe } from "bun:test"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/** Whether a real libchdb is reachable: `MAPLE_LIBCHDB`, or the installed `~/.maple/bin` copy. */
export const libchdbAvailable =
	(process.env.MAPLE_LIBCHDB !== undefined && existsSync(process.env.MAPLE_LIBCHDB)) ||
	existsSync(join(homedir(), ".maple", "bin", "libchdb.so")) ||
	existsSync(join(homedir(), ".maple", "bin", "libchdb.dylib"))

/**
 * A suite that needs a real libchdb. Skipped where none is installed, except under
 * `MAPLE_REQUIRE_LIBCHDB=1` (the CI job that builds one), where it always runs so a
 * missing library fails at `Chdb.open` instead of silently skipping.
 */
export const describeWithChdb: (name: string, fn: () => void) => void =
	process.env.MAPLE_REQUIRE_LIBCHDB === "1" ? describe : describe.skipIf(!libchdbAvailable)
