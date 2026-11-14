/**
 * The electric-sync Worker's config-sourced env, resolved as one `Config`. An explicit catalog, as
 * in `apps/api/src/resources/env.ts`.
 */
import type { MapleDomains, MapleRegion, MapleStage } from "@maple/infra/cloudflare"
import {
	authEnv,
	derived,
	devOrgOverrideEnv,
	merge,
	optionalPlain,
	selfObservabilityEnv,
} from "@maple/infra/env"
import * as Secrets from "@maple/infra/secrets"

export const electricSyncConfiguredEnv = (stage: MapleStage, region: MapleRegion, domains: MapleDomains) =>
	merge(
		authEnv,
		devOrgOverrideEnv(stage),
		// A preview proxies its own Electric, never the shared `dev` one (another stage's data);
		// a `preview:web` stage has none, so sync stays off.
		stage.kind === "pr"
			? domains.electric
				? derived("ELECTRIC_URL", `https://${domains.electric}`)
				: merge()
			: merge(optionalPlain("ELECTRIC_URL"), optionalPlain("ELECTRIC_SOURCE_ID")),
		Secrets.ElectricSecret.optional,
		selfObservabilityEnv(stage, region),
	)
