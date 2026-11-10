// The maintenance token beside a data dir: trusted local tooling (delete, checkpoint,
// retention) sends it so the server allows writes and maintenance routes.
import { resolve } from "node:path"
import { String as Str } from "effect"
import { ensureLocalToken, localTokenMatches, readRealFile } from "./local-token"

export const MAINTENANCE_TOKEN_HEADER = "x-maple-maintenance-token"

export const maintenanceTokenPath = (dataDir: string): string => `${resolve(dataDir)}.maintenance-token`

export const ensureMaintenanceToken = (dataDir: string): Promise<string> =>
	ensureLocalToken(maintenanceTokenPath(dataDir), "maintenance token")

/** The token a client sends; throws when the file is missing or not a real file. */
export const readMaintenanceToken = (dataDir: string): string =>
	Str.trim(readRealFile(maintenanceTokenPath(dataDir), "maintenance token"))

/** Does `req` carry the server's maintenance token? */
export const hasMaintenanceToken = (token: string, req: Request): boolean =>
	localTokenMatches(token, req.headers.get(MAINTENANCE_TOKEN_HEADER))
