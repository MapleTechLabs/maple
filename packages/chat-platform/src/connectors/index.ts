/**
 * Every chat platform this build ships.
 *
 * The one file above a connector directory that is allowed to name a vendor, and the only edit a
 * new platform needs outside its own directory — `manifests.ts`, the dashboard's half of the same
 * registration, is the other. `vendor-isolation.test.ts` enforces the rest.
 *
 * Deliberately not annotated: the inferred element type unions every registered connector's
 * requirements, which is exactly what a host Worker supplies — it provides all of them, and picks
 * the one an incoming event belongs to by id.
 */
import { discord } from "./discord"
import { slack } from "./slack"

export const connectors = [discord, slack]
