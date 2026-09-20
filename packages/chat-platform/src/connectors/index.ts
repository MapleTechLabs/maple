/**
 * The registry.
 *
 * These import lines are the ONLY place outside `src/connectors/<id>/` that may
 * name a chat vendor. Adding a platform is a directory beside this file plus a
 * line here — no new Worker, no new Durable Object class, no infrastructure
 * change. `vendor-isolation.test.ts` is what keeps that true.
 */
import type { ChatConnector } from "../connector.ts"
import { discord } from "./discord/index.ts"

export const connectors: ReadonlyArray<ChatConnector> = [discord]
