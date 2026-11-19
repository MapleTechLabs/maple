import { Option, Schema, Array as Arr, String as Str } from "effect"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import { deepEqual, isResolved } from "alchemy/Diff"
import * as Provider from "alchemy/Provider"
import { Resource } from "alchemy/Resource"
import { listAll, MapleApi } from "./MapleApi"
import { MapleErrorTags } from "./errors"
import type { Providers } from "./Providers"

export type StatusPageComponentStatus =
	| "operational"
	| "maintenance"
	| "degraded"
	| "partial_outage"
	| "major_outage"

/** One line on the page. Its place in `components` is its position. */
export interface StatusPageComponentProps {
	/** Components are matched to the page's existing ones by name, so a rename recreates one. */
	name: string
	description?: string | null
	/** Heading the component is listed under. */
	group?: string | null
	/** The `upm_…` uptime monitor driving its status, e.g. a `Maple.UptimeMonitor`'s `monitorId`. */
	monitor_id?: string | null
	/**
	 * A manual status override. Left unset, the override stays as set in Maple, so responders can
	 * flip a component during an incident without the next deploy undoing it; `null` clears it.
	 */
	manual_status?: StatusPageComponentStatus | null
	/** Whether the page shows its 90 days of uptime bars. Defaults to `true`. */
	show_uptime?: boolean
}

/** Theme fields left unset take the default theme's value. */
export interface StatusPageThemeProps {
	preset?: "default" | "maple" | "mono" | "midnight" | "paper"
	/** `auto` follows the visitor; `light` or `dark` forces one and enables the colour overrides. */
	appearance?: "auto" | "light" | "dark"
	/** `#rrggbb`, or `null` for the preset's. */
	accent?: string | null
	background?: string | null
	text?: string | null
	card?: string | null
	border?: string | null
	radius?: "none" | "sm" | "md" | "lg"
	font?: "sans" | "serif" | "mono"
}

/**
 * Status page props: the v2 status page config document (`PUT /v2/status_pages/{id}/config`,
 * snake_case as documented at `/v2/docs`), plus the page password and custom domain.
 * Optional fields left unset take their defaults.
 */
export interface StatusPageProps {
	name: string
	/** The page's address, `/s/<org key>/<slug>` on the status domain: 3 to 48 lowercase letters, digits or inner hyphens. */
	slug: string
	description?: string | null
	website_url?: string | null
	/** An https URL, or an uploaded image as a base64 `data:image/...` URL (at most 128 KB). */
	logo_url?: string | null
	logo_dark_url?: string | null
	favicon_url?: string | null
	support_url?: string | null
	privacy_url?: string | null
	terms_url?: string | null
	/** Defaults to `true`. */
	show_powered_by?: boolean
	/** Whether a linked monitor going down opens a page incident. Defaults to `off`. */
	auto_incidents?: "off" | "draft" | "publish"
	/** Left unset, the page keeps its visibility (`public` when created). */
	visibility?: "public" | "password" | "internal"
	theme?: StatusPageThemeProps
	/**
	 * Every component, in display order; components left out are deleted. Required, as in the
	 * config document, so a page is never emptied by a missing prop: pass `[]` for none.
	 */
	components: ReadonlyArray<StatusPageComponentProps>
	/**
	 * The password visitors enter for a `password` page, 8 to 256 characters. Write-only: it is
	 * set when it changes and removed when this prop is removed. Alchemy state keeps it, even
	 * as `Redacted`: protect the state as a credential.
	 */
	password?: string | Redacted.Redacted
	/**
	 * Serve the page on this hostname too, e.g. `status.acme.com`. Point the DNS records in the
	 * `customDomain` attribute at Maple. Removing the prop removes the domain.
	 */
	custom_domain?: string
}

export interface StatusPageDnsRecord {
	type: "CNAME" | "TXT"
	name: string
	value: string
	/** `routing`, `ownership` or `certificate`. */
	purpose: string
}

export type StatusPage = Resource<
	"Maple.StatusPage",
	StatusPageProps,
	{
		/** The `stp_…` public ID. */
		statusPageId: string
		name: string
		slug: string
		/** The page's components with their `stc_…` IDs, in display order. */
		components: Array<{ componentId: string; name: string }>
		/** The custom domain and the DNS records to add for it, or `null` without one. */
		customDomain: {
			hostname: string
			cnameTarget: string | null
			dnsRecords: Array<StatusPageDnsRecord>
		} | null
		/** A tag of the page's config; it changes when the page is edited outside Alchemy. */
		configVersion: string
	},
	never,
	Providers
>

/**
 * A public status page: its settings, theme, components, visibility, password and custom
 * domain. Incidents stay operational and are not declared here.
 *
 * @example
 * ```typescript
 * const api = yield* Maple.UptimeMonitor("api", {
 *   name: "API",
 *   config: { type: "http", url: "https://api.acme.com/health" },
 * })
 * yield* Maple.StatusPage("status", {
 *   name: "Acme Status",
 *   slug: "acme-status",
 *   theme: { preset: "midnight" },
 *   components: [{ name: "API", monitor_id: api.monitorId }],
 *   custom_domain: "status.acme.com",
 * })
 * ```
 */
export const StatusPage = Resource<StatusPage>("Maple.StatusPage")

const WirePage = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	slug: Schema.String,
	has_password: Schema.Boolean,
	visibility: Schema.String,
	draft: Schema.Boolean,
})
const decodeWirePage = Schema.decodeUnknownEffect(WirePage)

const WireConfigComponent = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	manual_status: Schema.NullOr(Schema.String),
})
const WireConfig = Schema.Struct({
	version: Schema.String,
	name: Schema.String,
	slug: Schema.String,
	components: Schema.Array(WireConfigComponent),
})
type WireConfig = Schema.Schema.Type<typeof WireConfig>
const decodeWireConfig = Schema.decodeUnknownEffect(WireConfig)

const WireCustomDomain = Schema.Struct({
	cname_target: Schema.NullOr(Schema.String),
	hostname: Schema.NullOr(Schema.String),
	dns_records: Schema.Array(
		Schema.Struct({
			type: Schema.Literals(["CNAME", "TXT"]),
			name: Schema.String,
			value: Schema.String,
			purpose: Schema.String,
		}),
	),
})
type WireCustomDomain = Schema.Schema.Type<typeof WireCustomDomain>
const decodeWireCustomDomain = Schema.decodeUnknownEffect(WireCustomDomain)

const unwrap = (value: string | Redacted.Redacted | undefined): string | undefined =>
	value === undefined ? undefined : Redacted.isRedacted(value) ? Redacted.value(value) : value

/**
 * The config document to apply. Components keep the IDs of the page's components of the same
 * name, so incidents and history stay attached to them.
 */
const configBody = (props: StatusPageProps, current?: WireConfig) => {
	const unclaimed = [...(current?.components ?? [])]
	const { password: _password, custom_domain: _domain, components, ...page } = props
	return {
		...page,
		components: Arr.map(components, (component) => {
			// The API stores names trimmed.
			const name = Str.trim(component.name)
			const index = Arr.findFirstIndex(unclaimed, (existing) => existing.name === name)
			const match = Option.isNone(index) ? undefined : unclaimed.splice(index.value, 1)[0]
			return {
				...(match === undefined ? undefined : { id: match.id }),
				...component,
				manual_status:
					component.manual_status !== undefined
						? component.manual_status
						: (match?.manual_status ?? null),
			}
		}),
	}
}

const toAttributes = (config: WireConfig, pageId: string, domain: WireCustomDomain) => ({
	statusPageId: pageId,
	name: config.name,
	slug: config.slug,
	components: Arr.map(config.components, (component) => ({
		componentId: component.id,
		name: component.name,
	})),
	customDomain:
		domain.hostname === null
			? null
			: {
					hostname: domain.hostname,
					cnameTarget: domain.cname_target,
					dnsRecords: Arr.map(domain.dns_records, (record) => ({ ...record })),
				},
	configVersion: config.version,
})

export const StatusPageProvider = () =>
	Provider.effect(
		StatusPage,
		Effect.gen(function* () {
			const api = yield* MapleApi
			const pagePath = (pageId: string) => `/v2/status_pages/${encodeURIComponent(pageId)}`
			const fetchPage = (pageId: string) =>
				api.get(pagePath(pageId)).pipe(
					Effect.catchTag(MapleErrorTags.statusPageNotFound, () => Effect.undefined),
					Effect.flatMap((fetched) =>
						fetched === undefined ? Effect.undefined : decodeWirePage(fetched),
					),
				)
			const fetchConfig = (pageId: string) =>
				api.get(`${pagePath(pageId)}/config`).pipe(Effect.flatMap(decodeWireConfig))
			const fetchDomain = (pageId: string) =>
				api.get(`${pagePath(pageId)}/custom_domain`).pipe(Effect.flatMap(decodeWireCustomDomain))
			const observe = Effect.fn(
				function* (pageId: string) {
					const page = yield* fetchPage(pageId)
					if (page === undefined) return undefined
					const config = yield* fetchConfig(page.id)
					const domain = yield* fetchDomain(page.id)
					return toAttributes(config, page.id, domain)
				},
				Effect.catchTag(MapleErrorTags.statusPageNotFound, () => Effect.undefined),
			)

			const configure = Effect.fn(function* (
				page: Schema.Schema.Type<typeof WirePage>,
				news: StatusPageProps,
				olds: StatusPageProps | undefined,
			) {
				const path = pagePath(page.id)
				const password = unwrap(news.password)
				const setPassword = api.put(`${path}/password`, { password })
				// Before the config only when the page is turning `password`: it cannot without one, and
				// must not open under an old one. Otherwise after the config, so a failed config leaves the
				// password as it was. These are separate writes: a failure partway leaves the earlier ones
				// applied, and the next deploy completes the rest.
				const changed =
					password !== undefined && (!page.has_password || password !== unwrap(olds?.password))
				const early = changed && news.visibility === "password" && page.visibility !== "password"
				if (early) yield* setPassword
				// A removed domain goes before the config, so the page can turn `internal`.
				let domain = yield* fetchDomain(page.id)
				if (
					news.custom_domain === undefined &&
					olds?.custom_domain !== undefined &&
					domain.hostname !== null
				) {
					domain = yield* api
						.delete(`${path}/custom_domain`)
						.pipe(Effect.flatMap(decodeWireCustomDomain))
				}
				// Conditional on the version read, so a manual status a responder sets meanwhile is
				// not overwritten with the one read: a conflict reads the config again.
				const config = yield* Effect.gen(function* () {
					const current = yield* fetchConfig(page.id)
					return yield* api
						.put(
							`${path}/config?if_version=${encodeURIComponent(current.version)}`,
							configBody(news, current),
						)
						.pipe(Effect.flatMap(decodeWireConfig))
				}).pipe(
					Effect.retry({
						times: 3,
						while: (error) => error._tag === MapleErrorTags.statusPageConflict,
					}),
				)
				if (news.custom_domain !== undefined && domain.hostname !== news.custom_domain) {
					domain = yield* api
						.put(`${path}/custom_domain`, { hostname: news.custom_domain })
						.pipe(Effect.flatMap(decodeWireCustomDomain))
				}
				if (changed && !early) yield* setPassword
				// Removed last: a `password` page refuses to lose its password.
				if (password === undefined && olds?.password !== undefined && page.has_password) {
					yield* api.delete(`${path}/password`)
				}
				return toAttributes(config, page.id, domain)
			})

			return {
				stables: ["statusPageId" as const],
				diff: Effect.fn(function* ({ news, olds }) {
					if (!isResolved(news)) return undefined
					// Not stripNullish: `manual_status: null` (clear) differs from unset (keep).
					if (olds !== undefined && !deepEqual(olds, news)) {
						return { action: "update", stables: ["statusPageId"] } as const
					}
					return undefined
				}),
				reconcile: Effect.fn(function* ({ news, olds, output }) {
					const existing = output === undefined ? undefined : yield* fetchPage(output.statusPageId)
					if (existing !== undefined) return yield* configure(existing, news, olds)
					// Created as a draft so no half-configured page is ever served; published once configured.
					// A page that fails to configure is deleted, so a retry can reuse its slug.
					const created = yield* api
						.post("/v2/status_pages", {
							name: news.name,
							slug: news.slug,
							publish: false,
						})
						.pipe(Effect.flatMap(decodeWirePage))
					// Only a page created here is published: an adopted draft stays a draft.
					return yield* configure(created, news, olds).pipe(
						Effect.tap(() => api.post(`${pagePath(created.id)}/publish`)),
						Effect.tapError(() => Effect.ignore(api.delete(pagePath(created.id)))),
					)
				}),
				delete: Effect.fn(function* ({ output }) {
					yield* api
						.delete(pagePath(output.statusPageId))
						.pipe(Effect.catchTag(MapleErrorTags.statusPageNotFound, () => Effect.void))
				}),
				read: Effect.fn(function* ({ output }) {
					if (output === undefined) return undefined
					return yield* observe(output.statusPageId)
				}),
				list: Effect.fn(function* () {
					const items = yield* listAll(api, "/v2/status_pages")
					const pages = yield* Effect.forEach(items, (item) => decodeWirePage(item))
					const observed = yield* Effect.forEach(pages, (page) => observe(page.id))
					return Arr.filter(observed, (attributes) => attributes !== undefined)
				}),
			}
		}),
	)

/** @internal Exposed for the in-repo contract test against `@maple/domain`. */
export const _statusPageConfigBody = configBody
