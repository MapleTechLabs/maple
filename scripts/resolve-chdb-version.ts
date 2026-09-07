import { createRequire } from "node:module"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

interface ChdbSession {
	query(sql: string, format?: string): string
	close(): void
}

interface ChdbPackage {
	Session: new (path?: string) => ChdbSession
}

const unquoteCsvScalar = (value: string): string => {
	const trimmed = value.trim()
	if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
		return trimmed.slice(1, -1).replace(/""/g, '"')
	}
	return trimmed
}

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const requireFromCliWorkspace = createRequire(join(repoRoot, "apps", "cli", "package.json"))
const { Session } = requireFromCliWorkspace("chdb") as ChdbPackage
const root = mkdtempSync(join(tmpdir(), "maple-chdb-version-"))
const session = new Session(join(root, "data"))

try {
	process.stdout.write(`${unquoteCsvScalar(session.query("SELECT version()", "CSV"))}\n`)
} finally {
	session.close()
	rmSync(root, { recursive: true, force: true })
}
