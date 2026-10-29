import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api"
import { Schema } from "effect"
import {
	StatusPageAutoIncidents,
	StatusPageComponentId,
	StatusPageComponentStatus,
	StatusPageId,
	StatusPageIncidentId,
	StatusPageIncidentImpact,
	StatusPageIncidentKind,
	StatusPageIncidentStatus,
	StatusPageIncidentUpdateId,
	StatusPageUpdateSource,
} from "../../primitives"
import {
	DEFAULT_STATUS_PAGE_THEME,
	StatusPageThemeAppearance,
	StatusPageThemeFont,
	StatusPageThemePreset,
	StatusPageThemeRadius,
} from "../../status-page"
import {
	StatusPageComponentNotFoundError,
	StatusPageConflictError,
	StatusPageIncidentNotFoundError,
	StatusPageNotFoundError,
	StatusPagePersistenceError,
	StatusPageSlugTakenError,
	StatusPageValidationError,
} from "../status-pages"
import { AuthorizationV2 } from "./auth"
import { ListOf, ListQuery, Timestamp, wireExample } from "./envelopes"
import { V2InsufficientPermissions, V2ParameterInvalid } from "./errors"
import { publicErrors } from "./public-error"
import { PublicId, PublicIdPrefixes } from "./public-id"
import { UptimeMonitorPublicId } from "./uptime-monitors"

/** `stp_…` public ID ⇄ internal `StatusPageId` (raw UUID). */
export const StatusPagePublicId = PublicId(PublicIdPrefixes.statusPage, StatusPageId)
/** `stc_…` public ID ⇄ internal `StatusPageComponentId`. */
export const StatusPageComponentPublicId = PublicId(
	PublicIdPrefixes.statusPageComponent,
	StatusPageComponentId,
)
/** `sti_…` public ID ⇄ internal `StatusPageIncidentId`. */
export const StatusPageIncidentPublicId = PublicId(PublicIdPrefixes.statusPageIncident, StatusPageIncidentId)
/** `stu_…` public ID ⇄ internal `StatusPageIncidentUpdateId`. */
export const StatusPageIncidentUpdatePublicId = PublicId(
	PublicIdPrefixes.statusPageIncidentUpdate,
	StatusPageIncidentUpdateId,
)

const NonEmptyString = Schema.String.check(Schema.isMinLength(1))

// --- Pages ---

const slugField = Schema.String.annotate({
	description:
		"The page's address, `<slug>.<status domain>`: 3 to 48 lowercase letters, digits or inner hyphens. Unique across Maple.",
	examples: ["acme-status"],
})

const autoIncidentsField = StatusPageAutoIncidents.annotate({
	description:
		"Whether a linked monitor going down opens a page incident: `off`, `draft` (unpublished until you publish it), or `publish`.",
	examples: ["draft"],
})

const themeExample = {
	preset: "midnight",
	appearance: "dark",
	accent: "#a5b4fc",
	background: null,
	text: null,
	card: null,
	border: null,
	radius: "md",
	font: "sans",
} as const

const themeColor = (what: string) =>
	Schema.NullOr(Schema.String).annotate({
		description: `${what} as \`#rrggbb\`, or \`null\` for the preset's. Applies only when \`appearance\` is \`light\` or \`dark\`.`,
		examples: ["#0f1115"],
	})

const themeFields = {
	preset: StatusPageThemePreset.annotate({
		description: "Base palette for light and dark: `default`, `mono`, `midnight` or `paper`.",
		examples: ["midnight"],
	}),
	appearance: StatusPageThemeAppearance.annotate({
		description:
			"`auto` follows the visitor's light or dark setting; `light` or `dark` forces one and enables the colour overrides.",
		examples: ["auto"],
	}),
	accent: Schema.NullOr(Schema.String).annotate({
		description:
			"Link and highlight colour as `#rrggbb` in every appearance, or `null` for the preset's.",
		examples: ["#1a2b3c"],
	}),
	background: themeColor("Page background"),
	text: themeColor("Text colour"),
	card: themeColor("Card and group header background"),
	border: themeColor("Border colour"),
	radius: StatusPageThemeRadius.annotate({
		description: "Corner radius of cards, banners and bars: `none`, `sm`, `md` or `lg`.",
		examples: ["md"],
	}),
	font: StatusPageThemeFont.annotate({
		description: "Font family: `sans`, `serif` or `mono` (system fonts).",
		examples: ["sans"],
	}),
}

export const V2StatusPageTheme = Schema.Struct(themeFields).annotate({
	identifier: "StatusPageTheme",
	title: "Status page theme",
	description:
		"How the public page looks. Text must reach a WCAG AA contrast of 4.5:1 on the background and on cards.",
	examples: [wireExample(themeExample)],
})
export type V2StatusPageTheme = Schema.Schema.Type<typeof V2StatusPageTheme>

/** Omitted theme fields keep their current value (the default on create). */
export const V2StatusPageThemeParams = Schema.Struct({
	preset: Schema.optionalKey(themeFields.preset),
	appearance: Schema.optionalKey(themeFields.appearance),
	accent: Schema.optionalKey(themeFields.accent),
	background: Schema.optionalKey(themeFields.background),
	text: Schema.optionalKey(themeFields.text),
	card: Schema.optionalKey(themeFields.card),
	border: Schema.optionalKey(themeFields.border),
	radius: Schema.optionalKey(themeFields.radius),
	font: Schema.optionalKey(themeFields.font),
}).annotate({
	identifier: "StatusPageThemeParams",
	title: "Status page theme parameters",
	description: "Theme fields to set. Omitted fields keep their current value, or the default on create.",
	examples: [wireExample({ preset: "paper", font: "serif" })],
})
export type V2StatusPageThemeParams = Schema.Schema.Type<typeof V2StatusPageThemeParams>

const statusPageExample = {
	id: "stp_YofPTrK9782DWwcnXhpcCw",
	object: "status_page",
	name: "Acme Status",
	slug: "acme-status",
	description: "Live status of Acme's API and dashboard.",
	website_url: "https://acme.example",
	logo_url: null,
	privacy_url: "https://acme.example/privacy",
	terms_url: null,
	theme: themeExample,
	show_powered_by: true,
	auto_incidents: "draft",
	break_glass_token_suffix: null,
	revision: 4,
	published_revision: 4,
	published_at: "2026-07-15T09:12:00.000Z",
	last_publish_error: null,
	created_at: "2026-07-01T12:00:00.000Z",
	updated_at: "2026-07-15T09:12:00.000Z",
} as const

export const V2StatusPage = Schema.Struct({
	id: StatusPagePublicId,
	object: Schema.Literal("status_page").annotate({
		description: 'The object type, always `"status_page"`.',
		examples: ["status_page"],
	}),
	name: Schema.String.annotate({ description: "Shown as the page title.", examples: ["Acme Status"] }),
	slug: slugField,
	description: Schema.NullOr(Schema.String).annotate({ description: "Text under the title, or `null`." }),
	website_url: Schema.NullOr(Schema.String).annotate({ description: "Your site, linked from the page." }),
	logo_url: Schema.NullOr(Schema.String).annotate({ description: "An https logo URL, or `null`." }),
	privacy_url: Schema.NullOr(Schema.String).annotate({
		description: "An https link to your privacy policy, shown in the page footer, or `null`.",
	}),
	terms_url: Schema.NullOr(Schema.String).annotate({
		description: "An https link to your terms of service, shown in the page footer, or `null`.",
	}),
	theme: V2StatusPageTheme,
	show_powered_by: Schema.Boolean.annotate({ description: "Whether the page credits Maple." }),
	auto_incidents: autoIncidentsField,
	break_glass_token_suffix: Schema.NullOr(Schema.String).annotate({
		description: "Last 6 characters of the break-glass token, or `null` when none is issued.",
	}),
	revision: Schema.Number.annotate({ description: "Bumped by every change a visitor could see." }),
	published_revision: Schema.Number.annotate({
		description: "The revision now served. Behind `revision` until the next publish.",
	}),
	published_at: Schema.NullOr(Timestamp).annotate({
		description: "When the page was last published, or `null` before the first publish.",
	}),
	last_publish_error: Schema.NullOr(Schema.String).annotate({
		description: "Why the last publish failed, or `null` when it succeeded.",
	}),
	created_at: Timestamp,
	updated_at: Timestamp,
}).annotate({
	identifier: "StatusPage",
	title: "Status Page",
	description:
		"A public status page. Maple publishes it to edge storage, so it stays up when Maple does not.",
	examples: [wireExample(statusPageExample)],
})
export type V2StatusPage = Schema.Schema.Type<typeof V2StatusPage>

export const V2StatusPageCreateParams = Schema.Struct({
	name: NonEmptyString.annotate({ description: "Page title. Required.", examples: ["Acme Status"] }),
	slug: slugField,
	description: Schema.optionalKey(Schema.NullOr(Schema.String)),
	website_url: Schema.optionalKey(Schema.NullOr(Schema.String)),
	logo_url: Schema.optionalKey(Schema.NullOr(Schema.String)),
	privacy_url: Schema.optionalKey(Schema.NullOr(Schema.String)),
	terms_url: Schema.optionalKey(Schema.NullOr(Schema.String)),
	theme: Schema.optionalKey(V2StatusPageThemeParams),
	show_powered_by: Schema.optionalKey(Schema.Boolean),
	auto_incidents: Schema.optionalKey(autoIncidentsField),
}).annotate({
	identifier: "StatusPageCreateParams",
	title: "Status page create parameters",
	description: "Request body for creating a status page.",
	examples: [wireExample({ name: "Acme Status", slug: "acme-status" })],
})
export type V2StatusPageCreateParams = Schema.Schema.Type<typeof V2StatusPageCreateParams>

export const V2StatusPageUpdateParams = Schema.Struct({
	name: Schema.optionalKey(NonEmptyString),
	slug: Schema.optionalKey(slugField),
	description: Schema.optionalKey(Schema.NullOr(Schema.String)),
	website_url: Schema.optionalKey(Schema.NullOr(Schema.String)),
	logo_url: Schema.optionalKey(Schema.NullOr(Schema.String)),
	privacy_url: Schema.optionalKey(Schema.NullOr(Schema.String)),
	terms_url: Schema.optionalKey(Schema.NullOr(Schema.String)),
	theme: Schema.optionalKey(V2StatusPageThemeParams),
	show_powered_by: Schema.optionalKey(Schema.Boolean),
	auto_incidents: Schema.optionalKey(autoIncidentsField),
}).annotate({
	identifier: "StatusPageUpdateParams",
	title: "Status page update parameters",
	description: "Request body for updating a status page. Omitted fields are left unchanged.",
	examples: [wireExample({ theme: { accent: "#1a2b3c" } })],
})
export type V2StatusPageUpdateParams = Schema.Schema.Type<typeof V2StatusPageUpdateParams>

export const V2StatusPageDeleteResponse = Schema.Struct({
	id: StatusPagePublicId,
	object: Schema.Literal("status_page"),
	deleted: Schema.Literal(true),
}).annotate({
	identifier: "StatusPageDeleteResponse",
	title: "Status page delete response",
	description: "Confirmation that a status page was deleted.",
	examples: [wireExample({ id: "stp_YofPTrK9782DWwcnXhpcCw", object: "status_page", deleted: true })],
})

export const V2StatusPagePublishResult = Schema.Struct({
	id: StatusPagePublicId,
	object: Schema.Literal("status_page.publish_result"),
	outcome: Schema.Literals(["published", "unchanged", "queued"]).annotate({
		description:
			"`published` wrote a new snapshot, `unchanged` found nothing visible to change, `queued` leaves it to the next minutely publish.",
	}),
	revision: Schema.Number.annotate({ description: "The page revision this publish covered." }),
}).annotate({
	identifier: "StatusPagePublishResult",
	title: "Status page publish result",
	description: "What a publish request did.",
	examples: [
		wireExample({
			id: "stp_YofPTrK9782DWwcnXhpcCw",
			object: "status_page.publish_result",
			outcome: "published",
			revision: 4,
		}),
	],
})
export type V2StatusPagePublishResult = Schema.Schema.Type<typeof V2StatusPagePublishResult>

export const V2StatusPageBreakGlassToken = Schema.Struct({
	id: StatusPagePublicId,
	object: Schema.Literal("status_page.break_glass_token"),
	token: Schema.String.annotate({
		description:
			"Posts updates straight to the status page while Maple is unreachable. Shown once; store it outside Maple.",
	}),
	token_suffix: Schema.String.annotate({ description: "The last 6 characters, shown on the page later." }),
}).annotate({
	identifier: "StatusPageBreakGlassToken",
	title: "Status page break-glass token",
	description: "A newly issued break-glass token. Issuing one replaces any previous token.",
	examples: [
		wireExample({
			id: "stp_YofPTrK9782DWwcnXhpcCw",
			object: "status_page.break_glass_token",
			token: "mstat_Qm9vZ2xlLWJyZWFrLWdsYXNzLXRva2VuLWV4YW1wbGU",
			token_suffix: "WV4YW1",
		}),
	],
})
export type V2StatusPageBreakGlassToken = Schema.Schema.Type<typeof V2StatusPageBreakGlassToken>

// --- Components ---

const componentStatusField = StatusPageComponentStatus.annotate({
	description:
		"A manual status override: `operational`, `maintenance`, `degraded`, `partial_outage` or `major_outage`.",
})

export const V2StatusPageComponent = Schema.Struct({
	id: StatusPageComponentPublicId,
	object: Schema.Literal("status_page_component").annotate({
		description: 'The object type, always `"status_page_component"`.',
		examples: ["status_page_component"],
	}),
	page_id: StatusPagePublicId,
	name: Schema.String.annotate({ examples: ["API"] }),
	description: Schema.NullOr(Schema.String),
	group: Schema.NullOr(Schema.String).annotate({ description: "Heading the component is listed under." }),
	position: Schema.Number.annotate({ description: "Order on the page, from 0." }),
	monitor_id: Schema.NullOr(UptimeMonitorPublicId).annotate({
		description: "The uptime monitor driving its status and uptime bars, or `null`.",
	}),
	manual_status: Schema.NullOr(componentStatusField),
	show_uptime: Schema.Boolean.annotate({
		description: "Whether the page shows its 90 days of uptime bars.",
	}),
	created_at: Timestamp,
	updated_at: Timestamp,
}).annotate({
	identifier: "StatusPageComponent",
	title: "Status Page Component",
	description:
		"One line on a status page. Its status is the worst of its monitor, the manual override, and active incidents naming it.",
	examples: [
		wireExample({
			id: "stc_YofPTrK9782DWwcnXhpcCw",
			object: "status_page_component",
			page_id: "stp_YofPTrK9782DWwcnXhpcCw",
			name: "API",
			description: null,
			group: null,
			position: 0,
			monitor_id: "upm_YofPTrK9782DWwcnXhpcCw",
			manual_status: null,
			show_uptime: true,
			created_at: "2026-07-01T12:00:00.000Z",
			updated_at: "2026-07-01T12:00:00.000Z",
		}),
	],
})
export type V2StatusPageComponent = Schema.Schema.Type<typeof V2StatusPageComponent>

export const V2StatusPageComponentCreateParams = Schema.Struct({
	name: NonEmptyString.annotate({ examples: ["API"] }),
	description: Schema.optionalKey(Schema.NullOr(Schema.String)),
	group: Schema.optionalKey(Schema.NullOr(Schema.String)),
	monitor_id: Schema.optionalKey(Schema.NullOr(UptimeMonitorPublicId)),
	manual_status: Schema.optionalKey(Schema.NullOr(componentStatusField)),
	show_uptime: Schema.optionalKey(Schema.Boolean),
}).annotate({
	identifier: "StatusPageComponentCreateParams",
	title: "Status page component create parameters",
	description: "Request body for adding a component; it is appended after the existing ones.",
	examples: [wireExample({ name: "API", monitor_id: "upm_YofPTrK9782DWwcnXhpcCw" })],
})
export type V2StatusPageComponentCreateParams = Schema.Schema.Type<typeof V2StatusPageComponentCreateParams>

export const V2StatusPageComponentUpdateParams = Schema.Struct({
	name: Schema.optionalKey(NonEmptyString),
	description: Schema.optionalKey(Schema.NullOr(Schema.String)),
	group: Schema.optionalKey(Schema.NullOr(Schema.String)),
	monitor_id: Schema.optionalKey(Schema.NullOr(UptimeMonitorPublicId)),
	manual_status: Schema.optionalKey(Schema.NullOr(componentStatusField)),
	show_uptime: Schema.optionalKey(Schema.Boolean),
}).annotate({
	identifier: "StatusPageComponentUpdateParams",
	title: "Status page component update parameters",
	description: "Request body for updating a component. Omitted fields are left unchanged.",
	examples: [wireExample({ manual_status: "degraded" })],
})
export type V2StatusPageComponentUpdateParams = Schema.Schema.Type<typeof V2StatusPageComponentUpdateParams>

export const V2StatusPageComponentDeleteResponse = Schema.Struct({
	id: StatusPageComponentPublicId,
	object: Schema.Literal("status_page_component"),
	deleted: Schema.Literal(true),
}).annotate({
	identifier: "StatusPageComponentDeleteResponse",
	title: "Status page component delete response",
	description: "Confirmation that a component was removed.",
	examples: [
		wireExample({ id: "stc_YofPTrK9782DWwcnXhpcCw", object: "status_page_component", deleted: true }),
	],
})

export const V2StatusPageComponentReorderParams = Schema.Struct({
	component_ids: Schema.Array(StatusPageComponentPublicId).annotate({
		description: "Every component of the page exactly once, in the new order.",
	}),
}).annotate({
	identifier: "StatusPageComponentReorderParams",
	title: "Status page component reorder parameters",
	description: "The page's components in their new order.",
	examples: [wireExample({ component_ids: ["stc_YofPTrK9782DWwcnXhpcCw"] })],
})

const StatusPageComponentList = ListOf(V2StatusPageComponent).annotate({
	identifier: "StatusPageComponentList",
	title: "Status page component list",
	description: "A page's components in display order.",
})

// --- Config document ---

const configExample = {
	name: "Acme Status",
	slug: "acme-status",
	description: "Live status of Acme's API and dashboard.",
	website_url: "https://acme.example",
	logo_url: null,
	privacy_url: "https://acme.example/privacy",
	terms_url: null,
	show_powered_by: true,
	auto_incidents: "draft",
	theme: themeExample,
	components: [
		{
			id: "stc_YofPTrK9782DWwcnXhpcCw",
			name: "API",
			description: null,
			group: null,
			monitor_id: "upm_YofPTrK9782DWwcnXhpcCw",
			manual_status: null,
			show_uptime: true,
		},
		{ name: "Docs", group: "Websites" },
	],
} as const

export const StatusPageConfigTheme = Schema.Struct({
	preset: Schema.optionalKey(themeFields.preset),
	appearance: Schema.optionalKey(themeFields.appearance),
	accent: Schema.optionalKey(themeFields.accent),
	background: Schema.optionalKey(themeFields.background),
	text: Schema.optionalKey(themeFields.text),
	card: Schema.optionalKey(themeFields.card),
	border: Schema.optionalKey(themeFields.border),
	radius: Schema.optionalKey(themeFields.radius),
	font: Schema.optionalKey(themeFields.font),
}).annotate({
	identifier: "StatusPageConfigTheme",
	title: "Status page config theme",
	description: "The page theme. Omitted fields take the default theme's value.",
	examples: [wireExample(themeExample)],
})

export const StatusPageConfigComponent = Schema.Struct({
	id: Schema.optionalKey(
		StatusPageComponentPublicId.annotate({
			description: "An existing component of this page (`stc_…`) to update. Omit to add a new one.",
		}),
	),
	name: NonEmptyString.annotate({ examples: ["API"] }),
	description: Schema.optionalKey(Schema.NullOr(Schema.String)),
	group: Schema.optionalKey(
		Schema.NullOr(Schema.String).annotate({ description: "Heading the component is listed under." }),
	),
	monitor_id: Schema.optionalKey(
		Schema.NullOr(UptimeMonitorPublicId).annotate({
			description: "The uptime monitor (`upm_…`) driving its status, or `null`.",
		}),
	),
	manual_status: Schema.optionalKey(Schema.NullOr(componentStatusField)),
	show_uptime: Schema.optionalKey(
		Schema.Boolean.annotate({ description: "Whether the page shows its uptime bars. Default `true`." }),
	),
}).annotate({
	identifier: "StatusPageConfigComponent",
	title: "Status page config component",
	description: "One component; its place in the list is its position on the page.",
})
export type StatusPageConfigComponent = Schema.Schema.Type<typeof StatusPageConfigComponent>

/** Most components one page may have; the config and a single create both refuse more. */
export const MAX_STATUS_PAGE_COMPONENTS = 200

export const StatusPageConfig = Schema.Struct({
	version: Schema.optionalKey(
		Schema.String.annotate({
			description:
				"A tag of this document's content as read. Read-only: an apply ignores it; send it back as `if_version` to refuse the apply if the config changed since.",
			examples: ["3k9x2m1q7z"],
		}),
	),
	name: NonEmptyString.annotate({ description: "Page title.", examples: ["Acme Status"] }),
	slug: slugField,
	description: Schema.optionalKey(Schema.NullOr(Schema.String)),
	website_url: Schema.optionalKey(Schema.NullOr(Schema.String)),
	logo_url: Schema.optionalKey(Schema.NullOr(Schema.String)),
	privacy_url: Schema.optionalKey(Schema.NullOr(Schema.String)),
	terms_url: Schema.optionalKey(Schema.NullOr(Schema.String)),
	show_powered_by: Schema.optionalKey(
		Schema.Boolean.annotate({ description: "Whether the page credits Maple. Default `true`." }),
	),
	auto_incidents: Schema.optionalKey(autoIncidentsField),
	theme: Schema.optionalKey(StatusPageConfigTheme),
	components: Schema.Array(StatusPageConfigComponent)
		.check(Schema.isMaxLength(MAX_STATUS_PAGE_COMPONENTS))
		.annotate({
			description: `Every component, in display order (at most ${MAX_STATUS_PAGE_COMPONENTS}). Listed with an \`id\` updates it, without one adds it, and a component left out is deleted.`,
		}),
}).annotate({
	identifier: "StatusPageConfig",
	title: "Status page config",
	description:
		"A whole status page as one document: its settings, theme and components, without incidents, the break-glass token or publish state. Applying it replaces the page; omitted optional fields take their defaults.",
	examples: [wireExample(configExample)],
})
export type StatusPageConfig = Schema.Schema.Type<typeof StatusPageConfig>

/** Optional text as the service stores it: trimmed, blank as `null`. */
const textOrNull = (value: string | null | undefined): string | null => {
	const trimmed = value?.trim() ?? ""
	return trimmed.length === 0 ? null : trimmed
}

const hexOrNull = (value: string | null | undefined): string | null =>
	textOrNull(value)?.toLowerCase() ?? null

/**
 * A config as an apply would store it: defaults filled in, text trimmed, blank text `null`,
 * hex colours lower-cased. The apply and every preview of it diff through this.
 */
export const normalizeStatusPageConfig = (config: StatusPageConfig) => {
	const theme = { ...DEFAULT_STATUS_PAGE_THEME, ...config.theme }
	return {
		name: config.name.trim(),
		slug: config.slug,
		description: textOrNull(config.description),
		website_url: textOrNull(config.website_url),
		logo_url: textOrNull(config.logo_url),
		privacy_url: textOrNull(config.privacy_url),
		terms_url: textOrNull(config.terms_url),
		show_powered_by: config.show_powered_by ?? true,
		auto_incidents: config.auto_incidents ?? "off",
		theme: {
			...theme,
			accent: hexOrNull(theme.accent),
			background: hexOrNull(theme.background),
			text: hexOrNull(theme.text),
			card: hexOrNull(theme.card),
			border: hexOrNull(theme.border),
		},
		components: config.components.map((component) => ({
			...(component.id === undefined ? undefined : { id: component.id }),
			name: component.name.trim(),
			description: textOrNull(component.description),
			group: textOrNull(component.group),
			monitor_id: component.monitor_id ?? null,
			manual_status: component.manual_status ?? null,
			show_uptime: component.show_uptime ?? true,
		})),
	}
}

/** JSON with object keys sorted at every depth; arrays keep their order. */
const canonicalJson = (value: unknown): string => {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
	if (typeof value === "object" && value !== null)
		return `{${Object.entries(value)
			.filter(([, entry]) => entry !== undefined)
			.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
			.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
			.join(",")}}`
	return JSON.stringify(value) ?? "null"
}

/** cyrb53 over UTF-16 code units: 53 bits, the same in browsers, workerd and Node. */
const cyrb53 = (text: string): number => {
	const seed: readonly [number, number] = [0xdeadbeef, 0x41c6ce57]
	const [a, b] = Array.from({ length: text.length }, (_, index) => text.charCodeAt(index)).reduce(
		([h1, h2], code): readonly [number, number] => [
			Math.imul(h1 ^ code, 2654435761),
			Math.imul(h2 ^ code, 1597334677),
		],
		seed,
	)
	const a1 = Math.imul(a ^ (a >>> 16), 2246822507) ^ Math.imul(b ^ (b >>> 13), 3266489909)
	const b1 = Math.imul(b ^ (b >>> 16), 2246822507) ^ Math.imul(a1 ^ (a1 >>> 13), 3266489909)
	return 4294967296 * (2097151 & b1) + (a1 >>> 0)
}

/**
 * The version of a config's content: a hash of its normalized, canonical form, so only an edit
 * to the document changes it. An optimistic-concurrency tag, not a security boundary.
 */
export const statusPageConfigVersion = (config: StatusPageConfig): string =>
	cyrb53(canonicalJson(normalizeStatusPageConfig(config))).toString(36)

const PAGE_CONFIG_FIELDS = [
	"name",
	"slug",
	"description",
	"website_url",
	"logo_url",
	"privacy_url",
	"terms_url",
	"show_powered_by",
	"auto_incidents",
	"theme",
] as const

const COMPONENT_CONFIG_FIELDS = [
	"name",
	"description",
	"group",
	"monitor_id",
	"manual_status",
	"show_uptime",
] as const

/** What an apply changed: page fields, and components by name. */
export interface StatusPageConfigChangeSet {
	readonly fields: ReadonlyArray<(typeof PAGE_CONFIG_FIELDS)[number]>
	readonly created: ReadonlyArray<string>
	readonly updated: ReadonlyArray<string>
	readonly deleted: ReadonlyArray<string>
	readonly reordered: boolean
}

/** Whether an apply changed anything; a no-op apply neither republishes nor audits. */
export const hasStatusPageConfigChanges = (changes: StatusPageConfigChangeSet): boolean =>
	changes.fields.length + changes.created.length + changes.updated.length + changes.deleted.length > 0 ||
	changes.reordered

export interface StatusPageConfigChanges extends StatusPageConfigChangeSet {
	/** Ids listed that are not components of the page, or listed twice: the apply refuses both. */
	readonly unknownIds: ReadonlyArray<StatusPageComponentId>
	readonly duplicateIds: ReadonlyArray<StatusPageComponentId>
}

const sameValue = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)

/** What applying `next` over the page's current config would change; components by name. */
export const diffStatusPageConfig = (
	current: StatusPageConfig,
	next: StatusPageConfig,
): StatusPageConfigChanges => {
	const before = normalizeStatusPageConfig(current)
	const after = normalizeStatusPageConfig(next)
	const existing = new Map(
		before.components.flatMap((component) =>
			component.id === undefined ? [] : [[component.id, component] as const],
		),
	)
	const listedIds = after.components.flatMap((component) =>
		component.id === undefined ? [] : [component.id],
	)
	const listed = new Set(listedIds)
	const keptOrder = listedIds.filter((id) => existing.has(id))
	return {
		fields: PAGE_CONFIG_FIELDS.filter((field) => !sameValue(before[field], after[field])),
		created: after.components.filter((component) => component.id === undefined).map((c) => c.name),
		updated: after.components.flatMap((component) => {
			const previous = component.id === undefined ? undefined : existing.get(component.id)
			if (previous === undefined) return []
			const changed = COMPONENT_CONFIG_FIELDS.some(
				(field) => !sameValue(previous[field], component[field]),
			)
			return changed ? [component.name] : []
		}),
		deleted: before.components
			.filter((component) => component.id !== undefined && !listed.has(component.id))
			.map((component) => component.name),
		reordered: !sameValue(
			keptOrder,
			[...existing.keys()].filter((id) => listed.has(id)),
		),
		unknownIds: [...listed].filter((id) => !existing.has(id)),
		duplicateIds: [...listed].filter((id) => listedIds.indexOf(id) !== listedIds.lastIndexOf(id)),
	}
}

// --- Incidents ---

export const V2StatusPageIncidentUpdate = Schema.Struct({
	id: StatusPageIncidentUpdatePublicId,
	status: StatusPageIncidentStatus,
	body: Schema.String.annotate({ description: "The public message." }),
	source: StatusPageUpdateSource.annotate({
		description: "Where it was posted from: `dashboard`, `api`, `mcp`, `auto` or `break_glass`.",
	}),
	created_at: Timestamp,
}).annotate({ identifier: "StatusPageIncidentUpdate", title: "Status page incident update" })

const scheduledField = Timestamp.annotate({
	description: "Maintenance only: the scheduled window bound.",
})

export const V2StatusPageIncident = Schema.Struct({
	id: StatusPageIncidentPublicId,
	object: Schema.Literal("status_page_incident").annotate({
		description: 'The object type, always `"status_page_incident"`.',
		examples: ["status_page_incident"],
	}),
	page_id: StatusPagePublicId,
	kind: StatusPageIncidentKind.annotate({ description: "`incident` or scheduled `maintenance`." }),
	title: Schema.String,
	impact: StatusPageIncidentImpact.annotate({
		description: "`none`, `minor`, `major` or `critical`: how hard it hits the components it names.",
	}),
	status: StatusPageIncidentStatus.annotate({
		description:
			"Incidents: `investigating`, `identified`, `monitoring`, `resolved`. Maintenance: `scheduled`, `in_progress`, `completed`.",
	}),
	published: Schema.Boolean.annotate({ description: "Drafts (`false`) are not shown on the page." }),
	scheduled_start: Schema.NullOr(scheduledField),
	scheduled_end: Schema.NullOr(scheduledField),
	started_at: Timestamp,
	resolved_at: Schema.NullOr(Timestamp),
	component_ids: Schema.Array(StatusPageComponentPublicId),
	updates: Schema.Array(V2StatusPageIncidentUpdate).annotate({ description: "Newest first." }),
	created_at: Timestamp,
	updated_at: Timestamp,
}).annotate({
	identifier: "StatusPageIncident",
	title: "Status Page Incident",
	description: "A customer-facing incident or scheduled maintenance, with its public updates.",
	examples: [
		wireExample({
			id: "sti_YofPTrK9782DWwcnXhpcCw",
			object: "status_page_incident",
			page_id: "stp_YofPTrK9782DWwcnXhpcCw",
			kind: "incident",
			title: "Elevated API errors",
			impact: "minor",
			status: "investigating",
			published: true,
			scheduled_start: null,
			scheduled_end: null,
			started_at: "2026-07-15T09:12:00.000Z",
			resolved_at: null,
			component_ids: ["stc_YofPTrK9782DWwcnXhpcCw"],
			updates: [
				{
					id: "stu_YofPTrK9782DWwcnXhpcCw",
					status: "investigating",
					body: "We are looking into elevated error rates.",
					source: "api",
					created_at: "2026-07-15T09:12:00.000Z",
				},
			],
			created_at: "2026-07-15T09:12:00.000Z",
			updated_at: "2026-07-15T09:12:00.000Z",
		}),
	],
})
export type V2StatusPageIncident = Schema.Schema.Type<typeof V2StatusPageIncident>

export const V2StatusPageIncidentCreateParams = Schema.Struct({
	page_id: StatusPagePublicId,
	kind: Schema.optionalKey(StatusPageIncidentKind.annotate({ description: "Defaults to `incident`." })),
	title: NonEmptyString.annotate({ examples: ["Elevated API errors"] }),
	impact: Schema.optionalKey(
		StatusPageIncidentImpact.annotate({
			description: "Defaults to `minor` for an incident and `none` for maintenance.",
		}),
	),
	status: Schema.optionalKey(
		StatusPageIncidentStatus.annotate({
			description: "Defaults to `investigating` for an incident and `scheduled` for maintenance.",
		}),
	),
	body: NonEmptyString.annotate({ description: "The first public update." }),
	component_ids: Schema.optionalKey(Schema.Array(StatusPageComponentPublicId)),
	published: Schema.optionalKey(
		Schema.Boolean.annotate({ description: "`false` saves a draft. Defaults to `true`." }),
	),
	scheduled_start: Schema.optionalKey(scheduledField),
	scheduled_end: Schema.optionalKey(scheduledField),
}).annotate({
	identifier: "StatusPageIncidentCreateParams",
	title: "Status page incident create parameters",
	description: "Request body for opening an incident or scheduling maintenance.",
	examples: [
		wireExample({
			page_id: "stp_YofPTrK9782DWwcnXhpcCw",
			title: "Elevated API errors",
			body: "We are looking into elevated error rates.",
		}),
	],
})
export type V2StatusPageIncidentCreateParams = Schema.Schema.Type<typeof V2StatusPageIncidentCreateParams>

export const V2StatusPageIncidentUpdateParams = Schema.Struct({
	title: Schema.optionalKey(NonEmptyString),
	impact: Schema.optionalKey(StatusPageIncidentImpact),
	published: Schema.optionalKey(Schema.Boolean),
	scheduled_start: Schema.optionalKey(Schema.NullOr(scheduledField)),
	scheduled_end: Schema.optionalKey(Schema.NullOr(scheduledField)),
	component_ids: Schema.optionalKey(Schema.Array(StatusPageComponentPublicId)),
}).annotate({
	identifier: "StatusPageIncidentUpdateParams",
	title: "Status page incident update parameters",
	description:
		"Request body for editing an incident without posting an update. Omitted fields are left unchanged.",
	examples: [wireExample({ published: true })],
})
export type V2StatusPageIncidentUpdateParams = Schema.Schema.Type<typeof V2StatusPageIncidentUpdateParams>

export const V2StatusPageIncidentPostUpdateParams = Schema.Struct({
	status: StatusPageIncidentStatus,
	body: NonEmptyString.annotate({ description: "The public message." }),
	impact: Schema.optionalKey(StatusPageIncidentImpact),
	component_ids: Schema.optionalKey(Schema.Array(StatusPageComponentPublicId)),
}).annotate({
	identifier: "StatusPageIncidentPostUpdateParams",
	title: "Status page incident post-update parameters",
	description: "A public update; `resolved` or `completed` closes the incident.",
	examples: [wireExample({ status: "resolved", body: "Error rates are back to normal." })],
})
export type V2StatusPageIncidentPostUpdateParams = Schema.Schema.Type<
	typeof V2StatusPageIncidentPostUpdateParams
>

export const V2StatusPageIncidentDeleteResponse = Schema.Struct({
	id: StatusPageIncidentPublicId,
	object: Schema.Literal("status_page_incident"),
	deleted: Schema.Literal(true),
}).annotate({
	identifier: "StatusPageIncidentDeleteResponse",
	title: "Status page incident delete response",
	description: "Confirmation that an incident was deleted.",
	examples: [
		wireExample({ id: "sti_YofPTrK9782DWwcnXhpcCw", object: "status_page_incident", deleted: true }),
	],
})

const IncidentsQuery = Schema.Struct({
	...ListQuery.fields,
	page_id: Schema.optional(
		StatusPagePublicId.annotate({ description: "Only this page's incidents (`stp_…`)." }),
	),
	state: Schema.optional(
		Schema.Literals(["open", "closed", "all"]).annotate({
			description: "`open` (the default) is unresolved incidents and maintenance not yet completed.",
			examples: ["open"],
		}),
	),
}).annotate({
	identifier: "StatusPageIncidentListQuery",
	title: "Status page incident list query",
	description: "Pagination plus optional page and state filters.",
})

const [pageNotFound, componentNotFound, incidentNotFound, validation, slugTaken, conflict, persistence] =
	publicErrors(
		StatusPageNotFoundError,
		StatusPageComponentNotFoundError,
		StatusPageIncidentNotFoundError,
		StatusPageValidationError,
		StatusPageSlugTakenError,
		StatusPageConflictError,
		StatusPagePersistenceError,
	)

const StatusPageList = ListOf(V2StatusPage).annotate({
	identifier: "StatusPageList",
	title: "Status page list",
	description: "A cursor-paginated page of status pages.",
})

const StatusPageIncidentList = ListOf(V2StatusPageIncident).annotate({
	identifier: "StatusPageIncidentList",
	title: "Status page incident list",
	description: "A cursor-paginated page of status page incidents, newest first.",
})

const ApplyConfigQuery = Schema.Struct({
	if_version: Schema.optional(
		Schema.String.annotate({
			description:
				"The `version` the document was read with. When the page's config has changed since, the apply answers 409 `status_page_conflict` and changes nothing.",
		}),
	),
}).annotate({
	identifier: "StatusPageConfigApplyQuery",
	title: "Status page config apply query",
	description: "An optional precondition on the config version.",
})

const pageParams = { id: StatusPagePublicId }
const componentParams = { id: StatusPagePublicId, component_id: StatusPageComponentPublicId }
const adminNote = "Requires the `status_pages:write` scope and an org-admin caller."

export class V2StatusPagesApiGroup extends HttpApiGroup.make("statusPages")
	.add(
		HttpApiEndpoint.get("list", "/", {
			query: ListQuery,
			success: StatusPageList,
			error: [V2ParameterInvalid.schema, persistence],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "listStatusPages",
				summary: "List status pages",
				description:
					"Returns your organization's status pages, oldest first. Cursor-paginated. Requires the `status_pages:read` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.post("create", "/", {
			payload: V2StatusPageCreateParams,
			success: V2StatusPage,
			error: [V2InsufficientPermissions.schema, validation, slugTaken, persistence],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "createStatusPage",
				summary: "Create a status page",
				description: `Creates a status page; it is published within a minute. ${adminNote}`,
			}),
		),
	)
	.add(
		HttpApiEndpoint.get("retrieve", "/:id", {
			params: pageParams,
			success: V2StatusPage,
			error: [pageNotFound, persistence],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "getStatusPage",
				summary: "Retrieve a status page",
				description:
					"Returns a status page by its `stp_…` ID. Requires the `status_pages:read` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.patch("update", "/:id", {
			params: pageParams,
			payload: V2StatusPageUpdateParams,
			success: V2StatusPage,
			error: [V2InsufficientPermissions.schema, pageNotFound, validation, slugTaken, persistence],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "updateStatusPage",
				summary: "Update a status page",
				description: `Updates a status page; omitted fields are unchanged. ${adminNote}`,
			}),
		),
	)
	.add(
		HttpApiEndpoint.delete("delete", "/:id", {
			params: pageParams,
			success: V2StatusPageDeleteResponse,
			error: [V2InsufficientPermissions.schema, pageNotFound, persistence],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "deleteStatusPage",
				summary: "Delete a status page",
				description: `Deletes a status page with its components and incidents, and takes it offline. ${adminNote}`,
			}),
		),
	)
	.add(
		HttpApiEndpoint.post("publish", "/:id/publish", {
			params: pageParams,
			success: V2StatusPagePublishResult,
			error: [V2InsufficientPermissions.schema, pageNotFound, persistence],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "publishStatusPage",
				summary: "Publish a status page",
				description: `Publishes the page now instead of within the minute. ${adminNote}`,
			}),
		),
	)
	.add(
		HttpApiEndpoint.post("rotateBreakGlass", "/:id/rotate_break_glass", {
			params: pageParams,
			success: V2StatusPageBreakGlassToken,
			error: [V2InsufficientPermissions.schema, pageNotFound, persistence],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "rotateStatusPageBreakGlassToken",
				summary: "Issue a break-glass token",
				description: `Issues a new break-glass token, replacing any previous one, and returns it once. ${adminNote}`,
			}),
		),
	)
	.add(
		HttpApiEndpoint.delete("revokeBreakGlass", "/:id/break_glass", {
			params: pageParams,
			success: V2StatusPage,
			error: [V2InsufficientPermissions.schema, pageNotFound, persistence],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "revokeStatusPageBreakGlassToken",
				summary: "Revoke the break-glass token",
				description: `Revokes the page's break-glass token. ${adminNote}`,
			}),
		),
	)
	.add(
		HttpApiEndpoint.get("getConfig", "/:id/config", {
			params: pageParams,
			success: StatusPageConfig,
			error: [pageNotFound, persistence],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "getStatusPageConfig",
				summary: "Retrieve a status page config",
				description:
					"Returns the page's settings, theme and components as one document, the body `PUT …/config` takes, with its `version`. Requires the `status_pages:read` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.put("applyConfig", "/:id/config", {
			params: pageParams,
			query: ApplyConfigQuery,
			payload: StatusPageConfig,
			success: StatusPageConfig,
			error: [
				V2InsufficientPermissions.schema,
				V2ParameterInvalid.schema,
				pageNotFound,
				validation,
				slugTaken,
				conflict,
				persistence,
			],
		})
			// A misspelt key would otherwise be dropped and its field reset to the default.
			.annotate(HttpApi.PayloadParseOptions, { onExcessProperty: "error" })
			.annotateMerge(
				OpenApi.annotations({
					identifier: "applyStatusPageConfig",
					summary: "Apply a status page config",
					description: `Replaces the page with the document in one write: components listed with an \`id\` are updated, without one created, and left out deleted; list order is display order. Any invalid part, or a key the document does not define, rejects the whole document. With \`if_version\`, a config that changed since that version was read answers 409 and nothing is written; status flips and publishes do not change it. Returns the applied config. ${adminNote}`,
				}),
			),
	)
	.add(
		HttpApiEndpoint.get("listComponents", "/:id/components", {
			params: pageParams,
			query: ListQuery,
			success: StatusPageComponentList,
			error: [V2ParameterInvalid.schema, pageNotFound, persistence],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "listStatusPageComponents",
				summary: "List status page components",
				description:
					"Returns a page's components in display order. Requires the `status_pages:read` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.post("createComponent", "/:id/components", {
			params: pageParams,
			payload: V2StatusPageComponentCreateParams,
			success: V2StatusPageComponent,
			error: [V2InsufficientPermissions.schema, pageNotFound, validation, persistence],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "createStatusPageComponent",
				summary: "Add a status page component",
				description: `Adds a component after the existing ones; a page holds at most ${MAX_STATUS_PAGE_COMPONENTS}. ${adminNote}`,
			}),
		),
	)
	.add(
		HttpApiEndpoint.post("reorderComponents", "/:id/components/reorder", {
			params: pageParams,
			payload: V2StatusPageComponentReorderParams,
			success: StatusPageComponentList,
			error: [V2InsufficientPermissions.schema, pageNotFound, validation, persistence],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "reorderStatusPageComponents",
				summary: "Reorder status page components",
				description: `Sets the display order; the list must name every component once. ${adminNote}`,
			}),
		),
	)
	.add(
		HttpApiEndpoint.patch("updateComponent", "/:id/components/:component_id", {
			params: componentParams,
			payload: V2StatusPageComponentUpdateParams,
			success: V2StatusPageComponent,
			error: [
				V2InsufficientPermissions.schema,
				pageNotFound,
				componentNotFound,
				validation,
				persistence,
			],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "updateStatusPageComponent",
				summary: "Update a status page component",
				description: `Updates a component; omitted fields are unchanged. ${adminNote}`,
			}),
		),
	)
	.add(
		HttpApiEndpoint.delete("deleteComponent", "/:id/components/:component_id", {
			params: componentParams,
			success: V2StatusPageComponentDeleteResponse,
			error: [
				V2InsufficientPermissions.schema,
				pageNotFound,
				componentNotFound,
				validation,
				persistence,
			],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "deleteStatusPageComponent",
				summary: "Remove a status page component",
				description: `Removes a component from its page. ${adminNote}`,
			}),
		),
	)
	.prefix("/v2/status_pages")
	.middleware(AuthorizationV2)
	.annotateMerge(
		OpenApi.annotations({
			title: "Status Pages",
			description:
				"Public status pages for your customers, served from edge storage so they stay up when Maple does not. Components follow your uptime monitors.",
		}),
	) {}

export class V2StatusPageIncidentsApiGroup extends HttpApiGroup.make("statusPageIncidents")
	.add(
		HttpApiEndpoint.get("list", "/", {
			query: IncidentsQuery,
			success: StatusPageIncidentList,
			error: [V2ParameterInvalid.schema, pageNotFound, persistence],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "listStatusPageIncidents",
				summary: "List status page incidents",
				description:
					"Returns incidents and maintenance across your pages or one page, newest first. Requires the `status_page_incidents:read` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.post("create", "/", {
			payload: V2StatusPageIncidentCreateParams,
			success: V2StatusPageIncident,
			error: [pageNotFound, validation, persistence],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "createStatusPageIncident",
				summary: "Open a status page incident",
				description:
					"Opens an incident or schedules maintenance with its first public update. Published unless `published` is `false`. Requires the `status_page_incidents:write` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.get("retrieve", "/:id", {
			params: { id: StatusPageIncidentPublicId },
			success: V2StatusPageIncident,
			error: [incidentNotFound, persistence],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "getStatusPageIncident",
				summary: "Retrieve a status page incident",
				description:
					"Returns an incident with its updates. Requires the `status_page_incidents:read` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.patch("update", "/:id", {
			params: { id: StatusPageIncidentPublicId },
			payload: V2StatusPageIncidentUpdateParams,
			success: V2StatusPageIncident,
			error: [incidentNotFound, pageNotFound, validation, persistence],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "updateStatusPageIncident",
				summary: "Update a status page incident",
				description:
					"Edits the title, impact, components, window or published flag without posting an update. Requires the `status_page_incidents:write` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.delete("delete", "/:id", {
			params: { id: StatusPageIncidentPublicId },
			success: V2StatusPageIncidentDeleteResponse,
			error: [incidentNotFound, pageNotFound, validation, persistence],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "deleteStatusPageIncident",
				summary: "Delete a status page incident",
				description:
					"Deletes an incident and its updates from the page. Requires the `status_page_incidents:write` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.post("postUpdate", "/:id/updates", {
			params: { id: StatusPageIncidentPublicId },
			payload: V2StatusPageIncidentPostUpdateParams,
			success: V2StatusPageIncident,
			error: [incidentNotFound, pageNotFound, validation, persistence],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "postStatusPageIncidentUpdate",
				summary: "Post a status page update",
				description:
					"Posts a public update and moves the incident to its status; `resolved` or `completed` closes it. Requires the `status_page_incidents:write` scope.",
			}),
		),
	)
	.prefix("/v2/status_page_incidents")
	.middleware(AuthorizationV2)
	.annotateMerge(
		OpenApi.annotations({
			title: "Status Page Incidents",
			description:
				"Customer-facing incidents and scheduled maintenance on your status pages, separate from internal alert incidents.",
		}),
	) {}
