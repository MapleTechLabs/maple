/**
 * Every chat platform this build ships.
 *
 * The one file above a connector directory that is allowed to name a vendor, and the only edit a
 * new platform needs outside its own directory. `vendor-isolation.test.ts` enforces the rest.
 *
 * Deliberately not annotated: the inferred element type unions every connector's requirements, so
 * a host that drives one platform would otherwise have to supply the credentials of all of them.
 * Pick a connector by id and drive THAT one — the registry is for looking up, not for driving.
 */
import { discord } from "./discord"

export const connectors = [discord]
