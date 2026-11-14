/**
 * The alerting Worker's config-sourced env, resolved as one `Config`. An explicit catalog, as in
 * `apps/api/src/resources/env.ts`; largely shared with api via `@maple/infra/env`.
 */
import { chatConnectorOutboundConfigKeys } from "@maple/chat-platform"
import type { MapleDomains, MapleRegion, MapleStage } from "@maple/infra/cloudflare"
import {
	apnsEnv,
	cloudflareOAuthEnv,
	configKeysEnv,
	linearOAuthEnv,
	mapleServerEnv,
	merge,
	optionalPlain,
	plainFrom,
	type PlainEnv,
	planetScaleOAuthEnv,
	supabaseOAuthEnv,
} from "@maple/infra/env"
import * as Secrets from "@maple/infra/secrets"
import { Config } from "effect"

export const alertingConfiguredEnv = (stage: MapleStage, region: MapleRegion, domains: MapleDomains) =>
	merge(
		mapleServerEnv(stage, region, domains),
		// "1" runs crons on a non-prod stage (which otherwise skips them).
		optionalPlain("MAPLE_ALERTING_ALLOW_NONPROD"),
		// "1" runs every tick's tenant reads on an org-scoped warehouse token, so a query aimed at
		// another org returns nothing. Under its own deploy var: the rollout reaches no other Worker.
		plainFrom(["MAPLE_ALERTING_ORG_SCOPED_READS"], "").pipe(
			Config.map((value): PlainEnv =>
				value === "" ? {} : { MAPLE_WAREHOUSE_ORG_SCOPED_READS: value },
			),
		),
		linearOAuthEnv,
		// Signs the chart image URL in notifications; unset sends them text-only.
		Secrets.ShareTokenHmacKey.optional,
		// Push for incidents, plus OAuth refresh for the Cloudflare, PlanetScale and Supabase pollers.
		apnsEnv,
		cloudflareOAuthEnv,
		planetScaleOAuthEnv,
		supabaseOAuthEnv,
		// Sign-in for the Google Cloud metrics poller; unset leaves its tick a no-op.
		Secrets.GcpServiceAccountKey.optional,
		// Outbound config for `chat` destinations' connectors.
		configKeysEnv(chatConnectorOutboundConfigKeys),
	)
