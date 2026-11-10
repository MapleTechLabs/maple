// Stored shapes shared by the HTTP contract (`./http/share.ts`) and the Postgres tables.

import { Schema } from "effect"

/** How a share link resolves. */
export const DashboardShareMode = Schema.Literals(["public", "org"])
export type DashboardShareMode = Schema.Schema.Type<typeof DashboardShareMode>
