/**
 * Session-replay payloads: the ingest gateway writes them over S3 (token minted in
 * `apps/ingest/alchemy.run.ts`) and api reads them back. Stage-isolated.
 * Expiry (32d) must outlive the table's 30-day TTL, or sessions list but play empty.
 * Never add or change `locationHint` or `jurisdiction`: either replaces the
 * name-pinned bucket, which GC then deletes. Colocation needs a new bucket.
 */
import { resolveStorageJurisdiction, stageProps } from "@maple/infra/cloudflare"
import * as Cloudflare from "alchemy/Cloudflare"
import * as RemovalPolicy from "alchemy/RemovalPolicy"

export const ReplayBlobs = Cloudflare.R2.Bucket(
	"replay-blobs",
	stageProps<Cloudflare.R2.BucketProps>("replay-blobs", (name, { region }) => ({
		name,
		jurisdiction: resolveStorageJurisdiction(region),
		// Unprefixed on purpose: keys are versioned (`v1/`), and a prefixed rule would stop
		// expiring anything after a format change.
		lifecycleRules: [
			{
				id: "expire-replay-chunks",
				enabled: true,
				deleteObjectsTransition: { condition: { type: "Age", maxAge: 32 * 24 * 60 * 60 } },
			},
		],
	})),
	// Customer recordings: `retain` never physically deletes a replaced generation.
).pipe(RemovalPolicy.retain())
