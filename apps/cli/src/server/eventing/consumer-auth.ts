import { resolve } from "node:path"
import { ensureLocalToken, localTokenMatches } from "../local-token"

export const eventConsumerTokenPath = (dataDir: string): string => `${resolve(dataDir)}.event-consumer-token`
export const ensureEventConsumerToken = (dataDir: string): Promise<string> =>
	ensureLocalToken(eventConsumerTokenPath(dataDir), "event consumer token")
export const eventConsumerTokenMatches = localTokenMatches
