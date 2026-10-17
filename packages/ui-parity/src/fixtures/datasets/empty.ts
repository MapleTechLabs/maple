import type { Dataset } from "../dataset.ts"
import { FROZEN_NOW, newOrgAdmin } from "../identity.ts"
import { emptyTelemetry } from "../telemetry/rows.ts"

/** A brand-new org: signed in, no telemetry, no dashboards or alerts. */
export const emptyDataset: Dataset = {
	name: "empty",
	now: FROZEN_NOW,
	identity: newOrgAdmin,
	auth: "self_hosted",
	endpoints: {},
	synced: {},
	telemetry: emptyTelemetry,
}
