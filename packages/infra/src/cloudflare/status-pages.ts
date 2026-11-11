/**
 * Edge storage for public status pages. The publisher (api, alerting) binds both read-write;
 * the status Worker reads them and writes only break-glass entry keys. Stage-isolated, and
 * retained: a replaced namespace or bucket would blank every customer's page.
 */
import { stageProps } from "./stack.ts"
import * as Cloudflare from "@alchemy.run/cloudflare"
import { adopt } from "alchemy/AdoptPolicy"
import * as RemovalPolicy from "alchemy/RemovalPolicy"
import * as Effect from "effect/Effect"
import { optionalPlain, STATUS_DOMAINS_CNAME_TARGET } from "../env.ts"

/** `host:`, `slug:`, `page:<id>:snapshot`, `overlay:<id>:<entry>`, `meta:heartbeat` (see `StatusPageKeys`). */
export const StatusSnapshotsKv = Cloudflare.KV.Namespace(
	// Logical ids differ from the shared physical name: alchemy keys state by id alone.
	"status-snapshots-kv",
	stageProps<Cloudflare.KV.NamespaceProps>("status-snapshots", (name) => ({ title: name })),
).pipe(RemovalPolicy.retain())

/** `pages/<id>/snapshot.json`, `hosts/<host>`, `slugs/<slug>`: the copies served when KV fails. */
export const StatusSnapshotsBucket = Cloudflare.R2.Bucket(
	"status-snapshots-r2",
	stageProps<Cloudflare.R2.BucketProps>("status-snapshots", (name) => ({ name })),
).pipe(RemovalPolicy.retain())

/**
 * Cloudflare for SaaS for status page custom domains: the originless, proxied
 * `status-domains.maple.dev` customers CNAME to, set as the zone's fallback origin. Traffic never
 * reaches that origin: each custom hostname gets a Worker route to its stage's status Worker
 * (created at runtime by `CloudflareCustomHostnames`). A zone singleton, so the US prd deploy owns
 * it for every stage and instance; skipped until `MAPLE_STATUS_DOMAINS_ZONE_ID` is set, since the
 * zone must have Cloudflare for SaaS enabled first. Retained: removing it takes every custom domain
 * down.
 */
export const declareStatusDomainsOrigin = Effect.gen(function* () {
	const { MAPLE_STATUS_DOMAINS_ZONE_ID: zoneId } = yield* optionalPlain("MAPLE_STATUS_DOMAINS_ZONE_ID")
	if (zoneId === undefined) return undefined
	const record = yield* Cloudflare.DNS.Record("status-domains-origin", {
		zoneId,
		type: "AAAA",
		name: STATUS_DOMAINS_CNAME_TARGET,
		content: "100::",
		proxied: true,
	}).pipe(adopt(true), RemovalPolicy.retain())
	return yield* Cloudflare.CustomHostname.FallbackOrigin("status-domains-fallback-origin", {
		zoneId,
		origin: record.name,
	}).pipe(adopt(true), RemovalPolicy.retain())
})
