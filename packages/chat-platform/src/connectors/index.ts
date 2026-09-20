/**
 * Every chat platform this build ships.
 *
 * The one file above a connector directory that is allowed to name a vendor, and the only edit a
 * new platform needs outside its own directory. `vendor-isolation.test.ts` enforces the rest.
 */
import { discord } from "./discord"

export const connectors = [discord]
