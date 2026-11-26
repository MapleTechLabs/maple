/**
 * Session-replay payloads: the ingest gateway writes them over S3 (token minted in
 * `apps/ingest/alchemy.run.ts`), api reads them back, and the org-eraser Worker deletes a deleted
 * org's prefix. Stage-isolated.
 * Objects sit under `r{days}/` for the chunk row's stamped period and expire 2 days after the
 * row does, or sessions list but play empty. Legacy unprefixed `v1/` keys keep their 32 days.
 * Never add or change `locationHint` or `jurisdiction`: either replaces the
 * name-pinned bucket, which GC then deletes. Colocation needs a new bucket.
 */
import { RETENTION_PERIODS } from "@maple/domain/retention"
import { Array as Arr } from "effect"
import { REGION_INFRA } from "../region.ts"
import { stageProps } from "./stack.ts"
import * as Cloudflare from "@alchemy.run/cloudflare"
import * as RemovalPolicy from "alchemy/RemovalPolicy"

const DAY_SECONDS = 24 * 60 * 60
/** Days an object outlives its chunk row, so a listed session never plays empty. */
const EXPIRY_SLACK_DAYS = 2

export const ReplayBlobs = Cloudflare.R2.Bucket(
	"replay-blobs",
	stageProps<Cloudflare.R2.BucketProps>("replay-blobs", (name, { region }) => ({
		name,
		jurisdiction: REGION_INFRA[region].storageJurisdiction,
		// The period leads the key and the format version follows it (`r30/v1/`), so a format
		// change stays under its period's rule. No rule may be unprefixed: it would cap every period.
		lifecycleRules: [
			{
				id: "expire-replay-chunks",
				enabled: true,
				prefix: "v1/",
				deleteObjectsTransition: { condition: { type: "Age", maxAge: 32 * DAY_SECONDS } },
			},
			...Arr.map(RETENTION_PERIODS, (days) => ({
				id: `expire-replay-chunks-r${days}`,
				enabled: true,
				prefix: `r${days}/`,
				deleteObjectsTransition: {
					condition: { type: "Age" as const, maxAge: (days + EXPIRY_SLACK_DAYS) * DAY_SECONDS },
				},
			})),
		],
	})),
	// Customer recordings: `retain` never physically deletes a replaced generation.
).pipe(RemovalPolicy.retain())
