// Increment this value for every structural change to the generated local
// schema. The compatibility manifest and migration registry must be updated in
// the same change before a new value can ship.
export const LOCAL_SCHEMA_VERSION = 19 as const

/** SQLite eventing state has its own independent version sequence. */
export const LOCAL_CONTROL_SCHEMA_VERSION = 1 as const
