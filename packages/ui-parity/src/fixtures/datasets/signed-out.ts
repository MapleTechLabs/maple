import type { Dataset } from "../dataset.ts"
import { FROZEN_NOW } from "../identity.ts"
import { emptyTelemetry } from "../telemetry/rows.ts"

/** An anonymous visitor: authenticated endpoints answer 401 and login is refused. */
export const signedOutDataset: Dataset = {
	name: "signed-out",
	now: FROZEN_NOW,
	identity: null,
	auth: "self_hosted",
	endpoints: {},
	synced: {},
	telemetry: emptyTelemetry,
}
