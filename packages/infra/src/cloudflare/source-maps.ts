/**
 * Uploaded JavaScript source maps, one object per file at `v1/<orgId>/<fileId>`. The api writes
 * and reads them, the alerting Worker reads them (read-only) to group errors on mapped frames, and
 * the org-eraser Worker deletes a deleted org's prefix. Stage-isolated.
 * No lifecycle rule: retention is by last use, swept in code with the `source_map_files` rows.
 * Never add or change `locationHint` or `jurisdiction`: either replaces the
 * name-pinned bucket, which GC then deletes. Colocation needs a new bucket.
 */
import { REGION_INFRA } from "../region.ts"
import { stageProps } from "./stack.ts"
import * as Cloudflare from "@alchemy.run/cloudflare"
import * as RemovalPolicy from "alchemy/RemovalPolicy"

export const SourceMapsBucket = Cloudflare.R2.Bucket(
	"source-maps",
	stageProps<Cloudflare.R2.BucketProps>("source-maps", (name, { region }) => ({
		name,
		jurisdiction: REGION_INFRA[region].storageJurisdiction,
	})),
	// Customer uploads: `retain` never physically deletes a replaced generation.
).pipe(RemovalPolicy.retain())
