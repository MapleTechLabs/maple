/**
 * Revoked ingest keys (`INGEST_BLOCKED_KEYS`), refused twice: at Cloudflare's edge, so their
 * traffic never reaches an ALB, and by the gateway itself after it normalizes the header.
 */
import { adopt } from "alchemy/AdoptPolicy"
import * as Cloudflare from "@alchemy.run/cloudflare"
import * as RemovalPolicy from "alchemy/RemovalPolicy"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as SchemaTransformation from "effect/SchemaTransformation"
import { MAPLE_REGIONS, type MapleStage, resolveMapleDomains } from "@maple/infra/cloudflare"
import type { PlainEnv } from "@maple/infra/env"

/** The zone every prd ingest hostname lives in. */
const PRD_ZONE = "maple.dev"

/**
 * `INGEST_BLOCKED_KEYS`, comma-separated. Keys are `maple_pk_`/`maple_sk_`/`maple_src_` + base64url,
 * so a value can never break out of the WAF expression.
 */
const blockedIngestKeys = Config.schema(
	Schema.String.pipe(
		Schema.decodeTo(
			Schema.Array(Schema.String.check(Schema.isPattern(/^maple_(pk|sk|src)_[A-Za-z0-9_-]+$/))),
			SchemaTransformation.transform<ReadonlyArray<string>, string>({
				decode: (raw) =>
					raw
						.split(",")
						.map((key) => key.trim())
						.filter((key) => key !== ""),
				encode: (keys) => keys.join(","),
			}),
		),
	),
	"INGEST_BLOCKED_KEYS",
).pipe(Config.withDefault([]))

/** The same keys for the gateway's own check (`parse_blocked_ingest_keys`); the edge rule matches exact values only. */
export const blockedIngestKeysEnv: Config.Config<PlainEnv> = Config.map(blockedIngestKeys, (keys): PlainEnv =>
	keys.length > 0 ? { INGEST_BLOCKED_KEYS: keys.join(",") } : {},
)

/**
 * The edge rule. This owns the zone's whole custom-WAF phase: a rule added in the dashboard is
 * overwritten, so add it here instead. One owner (the US prd) covers both regions.
 */
export const blockIngestKeysAtEdge = (stage: MapleStage) =>
	Effect.gen(function* () {
		const keys = yield* blockedIngestKeys
		const hosts = MAPLE_REGIONS.flatMap((region) => resolveMapleDomains({ stage, region }).ingest ?? [])
		const set = (values: ReadonlyArray<string>) => `{${values.map((value) => `"${value}"`).join(" ")}}`

		const zone = yield* Cloudflare.Zone.Zone("maple-dev-zone", { name: PRD_ZONE }).pipe(
			adopt(true),
			RemovalPolicy.retain(),
		)
		return yield* Cloudflare.Ruleset.Ruleset("waf-custom-rules", {
			zone,
			phase: "http_request_firewall_custom",
			// Unchanged since the rule lived in apps/ingest/alchemy.run.ts: a new one only rewrites the ruleset.
			description: "Managed by alchemy (apps/ingest/alchemy.run.ts)",
			rules:
				keys.length === 0
					? []
					: [
							{
								description: "Block revoked ingest keys",
								action: "block",
								expression:
									`http.host in ${set(hosts)} and (` +
									`any(http.request.headers["authorization"][*] in ${set(keys.map((key) => `Bearer ${key}`))}) or ` +
									`any(http.request.headers["x-maple-ingest-key"][*] in ${set(keys)}))`,
							},
						],
		})
	})
