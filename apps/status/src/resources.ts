/**
 * Edge storage for public status pages. The publisher (api, alerting) binds both read-write;
 * the status Worker reads them and writes only the break-glass overlay. Stage-isolated, and
 * retained: a replaced namespace or bucket would blank every customer's page.
 */
import { stageProps } from "@maple/infra/cloudflare"
import * as Cloudflare from "@alchemy.run/cloudflare"
import * as RemovalPolicy from "alchemy/RemovalPolicy"

/** `host:`, `slug:`, `page:<id>:snapshot`, `page:<id>:overlay`, `meta:heartbeat` (see `StatusPageKeys`). */
export const StatusSnapshotsKv = Cloudflare.KV.Namespace(
	// Logical ids differ from the shared physical name: alchemy keys state by id alone.
	"status-snapshots-kv",
	stageProps<Cloudflare.KV.NamespaceProps>("status-snapshots", (name) => ({ title: name })),
).pipe(RemovalPolicy.retain())

/** `pages/<id>/snapshot.json`: the copy served when KV fails. */
export const StatusSnapshotsBucket = Cloudflare.R2.Bucket(
	"status-snapshots-r2",
	stageProps<Cloudflare.R2.BucketProps>("status-snapshots", (name) => ({ name })),
).pipe(RemovalPolicy.retain())
