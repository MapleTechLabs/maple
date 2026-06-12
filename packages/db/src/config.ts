import { mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Embedded-PGlite location for local dev and tests. `dataDir` is what the
 * PGlite constructor accepts: `memory://` for ephemeral in-memory databases,
 * or a filesystem directory for persistent ones.
 */
export interface MapleDbConfig {
	readonly dataDir: string
}

const defaultLocalDataDir = () => {
	const currentDir = dirname(fileURLToPath(import.meta.url))
	return resolve(currentDir, "../../../apps/api/.data/pglite")
}

export const resolveMapleDbConfig = (
	env: Record<string, string | undefined> = process.env,
): MapleDbConfig => {
	const configured = env.MAPLE_DB_URL?.trim()
	return {
		dataDir: configured && configured.length > 0 ? configured : defaultLocalDataDir(),
	}
}

export const ensureMapleDbDirectory = (config: MapleDbConfig = resolveMapleDbConfig()): MapleDbConfig => {
	if (!config.dataDir.startsWith("memory://")) {
		mkdirSync(config.dataDir, { recursive: true })
	}

	return config
}
