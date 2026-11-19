/**
 * The org-eraser Worker's config-sourced env, resolved as one `Config`: its own telemetry, the
 * warehouse host, and the delete token no other deployable binds.
 */
import type { MapleRegion, MapleStage } from "@maple/infra/cloudflare"
import { merge, requirePlainEntry, selfObservabilityEnv } from "@maple/infra/env"
import * as Secrets from "@maple/infra/secrets"

export const orgEraserConfiguredEnv = (stage: MapleStage, region: MapleRegion) =>
	merge(
		selfObservabilityEnv(stage, region),
		requirePlainEntry("TINYBIRD_HOST"),
		// Optional until an operator provisions it; warehouse erasures wait with a reason meanwhile.
		Secrets.WarehouseDeleteToken.optional,
	)
