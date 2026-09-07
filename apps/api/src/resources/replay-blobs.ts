/**
 * Session-replay rrweb payloads. The ingest gateway (a Rust service on ECS
 * Fargate, not a Worker) writes these over the S3 API with SigV4 — its
 * bucket-scoped token is minted in `apps/ingest/alchemy.run.ts`, next to the
 * writer — and the api Worker binds the same bucket to hydrate
 * `session_replay_events` rows whose `Events` is empty. Stage-isolated, so a
 * pr/stg deploy can never serve or overwrite prd recordings. Declared once
 * here; alchemy registers a resource by id, so the second yield returns the
 * first's registration.
 *
 * The 32-day expiry is deliberately LONGER than the table's 30-day TTL: the
 * row must disappear before the object does. The other way round leaves a
 * session that lists as recorded but plays back empty, which is the one
 * failure mode with no good client-side handling.
 *
 * Don't add `locationHint`: it is advisory (the bucket stayed `wnam` anyway)
 * and changing it replaces a name-pinned bucket, which GC then deletes. Took
 * prd red on 2026-08-24. Colocation needs a new bucket, not a replace.
 */
import { stageProps } from "@maple/infra/cloudflare"
import * as Cloudflare from "alchemy/Cloudflare"
import * as RemovalPolicy from "alchemy/RemovalPolicy"

export const ReplayBlobs = Cloudflare.R2.Bucket(
	"replay-blobs",
	stageProps<Cloudflare.R2.BucketProps>("replay-blobs", (name) => ({
		name,
		// Deliberately unprefixed, so the rule covers whatever key scheme is
		// current. `replay_object_key` is versioned (`v1/…`) precisely so a
		// format change can write under a new prefix while the old one ages
		// out — a rule pinned to `v1/` would silently stop expiring anything
		// the moment that happens, and the bucket would grow forever with no
		// failing test to catch it. Nothing else writes here.
		lifecycleRules: [
			{
				id: "expire-replay-chunks",
				enabled: true,
				deleteObjectsTransition: { condition: { type: "Age", maxAge: 32 * 24 * 60 * 60 } },
			},
		],
	})),
	// Holds customer recordings. `retain` also drops a replaced generation
	// from state without the physical delete, which unwedges a half-applied
	// replace (`retainOldGeneration` in alchemy's `collectGarbage`).
).pipe(RemovalPolicy.retain())
