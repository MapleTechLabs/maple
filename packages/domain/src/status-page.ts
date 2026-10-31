import { Effect, Schema } from "effect"
import {
	StatusPageComponentId,
	StatusPageComponentStatus,
	StatusPageId,
	StatusPageIncidentImpact,
	StatusPageIncidentKind,
	StatusPageIncidentStatus,
	StatusPageUpdateSource,
	type UptimeMonitorStatus,
} from "./primitives"

// Status pages: the snapshot the publisher writes to edge storage and `apps/status` serves
// without touching Maple, plus the pure rules both sides share (component status, bars,
// freshness, the break-glass overlay).

export const STATUS_PAGE_SNAPSHOT_VERSION = 1
/** Days of uptime bars a snapshot carries; the page shows them a window at a time. */
export const STATUS_PAGE_HISTORY_DAYS = 365
/** Days of uptime bars in one window of the page. */
export const STATUS_PAGE_WINDOW_DAYS = 90
/** Resolved incidents stay listed, with their updates, this long. */
export const STATUS_PAGE_INCIDENT_HISTORY_DAYS = 14
/** Past this, the page says live checks are delayed instead of implying all is well. */
export const STATUS_PAGE_STALE_AFTER_MS = 5 * 60_000
/** Longest page link (website, logo, privacy, terms) the service stores; the editor checks it too. */
export const STATUS_PAGE_MAX_URL_LENGTH = 2048

/** Lowercase letters, digits and inner hyphens: the `<slug>` in `<slug>.<status domain>`. */
export const StatusPageSlug = Schema.String.check(
	Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$/u),
).annotate({ identifier: "@maple/StatusPageSlug", title: "Status Page Slug" })
export type StatusPageSlug = Schema.Schema.Type<typeof StatusPageSlug>

/** `YYYY-MM-DD`, UTC. */
export const StatusPageDay = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/u))

export const StatusPageDayState = Schema.Literals(["none", "ok", "degraded", "down"])
export type StatusPageDayState = Schema.Schema.Type<typeof StatusPageDayState>

export const StatusPageDayBar = Schema.Struct({
	day: StatusPageDay,
	checks: Schema.Number,
	failures: Schema.Number,
	/** Checks taken while the monitor was down: the downtime share of the day. */
	downChecks: Schema.Number,
})
export type StatusPageDayBar = Schema.Schema.Type<typeof StatusPageDayBar>

export const StatusPageSnapshotComponent = Schema.Struct({
	id: StatusPageComponentId,
	name: Schema.String,
	description: Schema.NullOr(Schema.String),
	group: Schema.NullOr(Schema.String),
	status: StatusPageComponentStatus,
	/** The status before incidents apply (monitor and manual override); the overlay derives from it. */
	baseStatus: StatusPageComponentStatus,
	showUptime: Schema.Boolean,
	/** Backed by an uptime monitor, so its status goes stale when the probes stop. */
	monitored: Schema.Boolean,
	/** Oldest first; empty when the component has no monitor or hides uptime. */
	days: Schema.Array(StatusPageDayBar),
})
export type StatusPageSnapshotComponent = Schema.Schema.Type<typeof StatusPageSnapshotComponent>

export const StatusPageSnapshotUpdate = Schema.Struct({
	id: Schema.String,
	status: StatusPageIncidentStatus,
	body: Schema.String,
	at: Schema.Number,
	source: StatusPageUpdateSource,
	/** The break-glass entry this update was imported from, so the edge stops overlaying it. */
	overlayEntryId: Schema.NullOr(Schema.String),
})
export type StatusPageSnapshotUpdate = Schema.Schema.Type<typeof StatusPageSnapshotUpdate>

export const StatusPageSnapshotIncident = Schema.Struct({
	id: Schema.String,
	kind: StatusPageIncidentKind,
	title: Schema.String,
	impact: StatusPageIncidentImpact,
	status: StatusPageIncidentStatus,
	startedAt: Schema.Number,
	resolvedAt: Schema.NullOr(Schema.Number),
	scheduledStart: Schema.NullOr(Schema.Number),
	scheduledEnd: Schema.NullOr(Schema.Number),
	componentIds: Schema.Array(Schema.String),
	/** The break-glass entry that opened it, so follow-ups posted against `bg-<entry>` still land. */
	openedByOverlayEntryId: Schema.NullOr(Schema.String),
	/** Newest first. */
	updates: Schema.Array(StatusPageSnapshotUpdate),
})
export type StatusPageSnapshotIncident = Schema.Schema.Type<typeof StatusPageSnapshotIncident>

/** One incident in the year-long calendar index: enough to mark its days, without updates. */
export const StatusPageIncidentHistoryEntry = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	kind: StatusPageIncidentKind,
	impact: StatusPageIncidentImpact,
	startedAt: Schema.Number,
	resolvedAt: Schema.NullOr(Schema.Number),
})
export type StatusPageIncidentHistoryEntry = Schema.Schema.Type<typeof StatusPageIncidentHistoryEntry>

// --- Theme ---

export const StatusPageThemePreset = Schema.Literals(["default", "mono", "midnight", "paper"])
export type StatusPageThemePreset = Schema.Schema.Type<typeof StatusPageThemePreset>
export const StatusPageThemeAppearance = Schema.Literals(["auto", "light", "dark"])
export type StatusPageThemeAppearance = Schema.Schema.Type<typeof StatusPageThemeAppearance>
export const StatusPageThemeRadius = Schema.Literals(["none", "sm", "md", "lg"])
export type StatusPageThemeRadius = Schema.Schema.Type<typeof StatusPageThemeRadius>
export const StatusPageThemeFont = Schema.Literals(["sans", "serif", "mono"])
export type StatusPageThemeFont = Schema.Schema.Type<typeof StatusPageThemeFont>

export const STATUS_PAGE_HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/u
/** `#rrggbb`: the only colour form a theme stores, so nothing else can reach a stylesheet. */
export const StatusPageHexColor = Schema.String.check(Schema.isPattern(STATUS_PAGE_HEX_COLOR_PATTERN))

export const StatusPageTheme = Schema.Struct({
	preset: StatusPageThemePreset,
	appearance: StatusPageThemeAppearance,
	/** Links and highlights; applies in every appearance. */
	accent: Schema.NullOr(StatusPageHexColor),
	/** The overrides below apply only when the appearance is forced to light or dark. */
	background: Schema.NullOr(StatusPageHexColor),
	text: Schema.NullOr(StatusPageHexColor),
	card: Schema.NullOr(StatusPageHexColor),
	border: Schema.NullOr(StatusPageHexColor),
	radius: StatusPageThemeRadius,
	font: StatusPageThemeFont,
})
export type StatusPageTheme = Schema.Schema.Type<typeof StatusPageTheme>

export const DEFAULT_STATUS_PAGE_THEME: StatusPageTheme = {
	preset: "default",
	appearance: "auto",
	accent: null,
	background: null,
	text: null,
	card: null,
	border: null,
	radius: "md",
	font: "sans",
}

/** The colour overrides a forced appearance takes; Auto ignores them. */
export const STATUS_PAGE_THEME_COLOR_FIELDS = ["background", "text", "card", "border"] as const

/** Concrete CSS tokens for one colour scheme. */
export interface StatusPageThemeTokens {
	readonly bg: string
	readonly fg: string
	readonly muted: string
	readonly line: string
	readonly card: string
	readonly link: string
	readonly ok: string
	readonly degraded: string
	readonly partial: string
	readonly major: string
	readonly maint: string
	readonly none: string
}

/**
 * A scheme's tokens as rendered: `secondary` colours the site name and footer links; the
 * `*Tint` colours fill the status banner, each a mix of the status into the card colour.
 */
export interface ResolvedStatusPageThemeTokens extends StatusPageThemeTokens {
	readonly secondary: string
	readonly okTint: string
	readonly degradedTint: string
	readonly partialTint: string
	readonly majorTint: string
	readonly maintTint: string
}

export interface ResolvedStatusPageTheme {
	/** `auto` follows the visitor's scheme with both sets; `light`/`dark` forces that one set. */
	readonly appearance: StatusPageThemeAppearance
	/** The custom accent, or null; also folded into each set's `link`. */
	readonly accent: string | null
	readonly light: ResolvedStatusPageThemeTokens
	readonly dark: ResolvedStatusPageThemeTokens
	readonly radiusPx: number
	readonly fontStack: string
}

const PRESET_TOKENS = {
	default: {
		light: {
			bg: "#ffffff",
			fg: "#0a0a0a",
			muted: "#666666",
			line: "#eaeaea",
			card: "#fafafa",
			link: "#0a0a0a",
			ok: "#11813b",
			degraded: "#aa5d05",
			partial: "#c3490a",
			major: "#dc2626",
			maint: "#2563eb",
			none: "#e5e5e5",
		},
		dark: {
			bg: "#0a0a0a",
			fg: "#ededed",
			muted: "#a1a1a1",
			line: "#262626",
			card: "#111111",
			link: "#ededed",
			ok: "#22c55e",
			degraded: "#f59e0b",
			partial: "#f97316",
			major: "#ef4444",
			maint: "#3b82f6",
			none: "#2a2a2a",
		},
	},
	mono: {
		light: {
			bg: "#ffffff",
			fg: "#111111",
			muted: "#6b6b6b",
			line: "#d4d4d4",
			card: "#f4f4f4",
			link: "#111111",
			ok: "#3d7a56",
			degraded: "#91651d",
			partial: "#ac552a",
			major: "#b33a3a",
			maint: "#4b6a99",
			none: "#e0e0e0",
		},
		dark: {
			bg: "#000000",
			fg: "#f2f2f2",
			muted: "#9a9a9a",
			line: "#303030",
			card: "#0c0c0c",
			link: "#f2f2f2",
			ok: "#5fae7f",
			degraded: "#d0a14e",
			partial: "#d47e52",
			major: "#d86464",
			maint: "#7a98c6",
			none: "#262626",
		},
	},
	midnight: {
		light: {
			bg: "#f5f7fb",
			fg: "#0f172a",
			muted: "#556079",
			line: "#dbe1ec",
			card: "#ffffff",
			link: "#4338ca",
			ok: "#15803d",
			degraded: "#b45309",
			partial: "#c2410c",
			major: "#b91c1c",
			maint: "#1d4ed8",
			none: "#dfe4ee",
		},
		dark: {
			bg: "#0b1020",
			fg: "#e6e9f2",
			muted: "#8e99b3",
			line: "#1f2a44",
			card: "#10172d",
			link: "#a5b4fc",
			ok: "#34d399",
			degraded: "#fbbf24",
			partial: "#fb923c",
			major: "#f87171",
			maint: "#60a5fa",
			none: "#1c2540",
		},
	},
	paper: {
		light: {
			bg: "#fbf8f1",
			fg: "#2b2620",
			muted: "#6c6356",
			line: "#e6dcc8",
			card: "#f4eee1",
			link: "#9a3f12",
			ok: "#3c7839",
			degraded: "#936016",
			partial: "#a95323",
			major: "#b23a2c",
			maint: "#3f6497",
			none: "#e7dfcf",
		},
		dark: {
			bg: "#1b1814",
			fg: "#ece5d8",
			muted: "#a59b8a",
			line: "#36302a",
			card: "#231f1a",
			link: "#e7a274",
			ok: "#7bb36f",
			degraded: "#d9a548",
			partial: "#dc8653",
			major: "#de6b5b",
			maint: "#7d9ccc",
			none: "#2e2924",
		},
	},
} as const satisfies Record<
	StatusPageThemePreset,
	{ readonly light: StatusPageThemeTokens; readonly dark: StatusPageThemeTokens }
>

const RADIUS_PX = { none: 0, sm: 4, md: 8, lg: 14 } as const satisfies Record<StatusPageThemeRadius, number>

const FONT_STACKS = {
	sans: 'ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif',
	serif: 'ui-serif,Georgia,Cambria,"Times New Roman",Times,serif',
	mono: "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace",
} as const satisfies Record<StatusPageThemeFont, string>

const hexChannels = (hex: string): readonly [number, number, number] => [
	Number.parseInt(hex.slice(1, 3), 16),
	Number.parseInt(hex.slice(3, 5), 16),
	Number.parseInt(hex.slice(5, 7), 16),
]

/** `weight` of `a` mixed into `b`, as `#rrggbb`. */
const mixHex = (a: string, b: string, weight: number): string => {
	const [ar, ag, ab] = hexChannels(a)
	const [br, bg, bb] = hexChannels(b)
	const channel = (x: number, y: number) =>
		Math.round(x * weight + y * (1 - weight))
			.toString(16)
			.padStart(2, "0")
	return `#${channel(ar, br)}${channel(ag, bg)}${channel(ab, bb)}`
}

/** WCAG 2 relative luminance of a `#rrggbb` colour. */
export const relativeLuminance = (hex: string): number => {
	const [r, g, b] = hexChannels(hex).map((value) => {
		const c = value / 255
		return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
	})
	return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0)
}

/** WCAG 2 contrast ratio, 1 to 21. */
export const contrastRatio = (a: string, b: string): number => {
	const [light, dark] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x)
	return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05)
}

/** The most-blended mix of `fg` into `bg` (from 62% up to 100%) that keeps AA on `bg` and `card`. */
const readableMix = (fg: string, bg: string, card: string): string =>
	MUTED_WEIGHTS.map((weight) => mixHex(fg, bg, weight)).find(
		(muted) =>
			contrastRatio(muted, bg) >= STATUS_PAGE_MIN_CONTRAST &&
			contrastRatio(muted, card) >= STATUS_PAGE_MIN_CONTRAST,
	) ?? fg

const MUTED_WEIGHTS = Array.from({ length: 39 }, (_, step) => 0.62 + step * 0.01)

const withOverrides = (tokens: StatusPageThemeTokens, theme: StatusPageTheme): StatusPageThemeTokens => {
	const bg = theme.background ?? tokens.bg
	const fg = theme.text ?? tokens.fg
	const card = theme.card ?? tokens.card
	// Muted text follows a custom text or background, blended toward it only as far as stays readable.
	const presetReads =
		contrastRatio(tokens.muted, bg) >= STATUS_PAGE_MIN_CONTRAST &&
		contrastRatio(tokens.muted, card) >= STATUS_PAGE_MIN_CONTRAST
	const muted =
		theme.background === null && theme.text === null && presetReads
			? tokens.muted
			: readableMix(fg, bg, card)
	return {
		...tokens,
		bg,
		fg,
		muted,
		card,
		line: theme.border ?? tokens.line,
	}
}

const TINT_WEIGHTS = Array.from({ length: 10 }, (_, step) => 0.22 - step * 0.02)

/** The strongest mix of `status` into `card` (22% down to 4%) that keeps `fg` text at AA on it. */
const statusTint = (status: string, card: string, fg: string): string =>
	TINT_WEIGHTS.map((weight) => mixHex(status, card, weight)).find(
		(tint) => contrastRatio(fg, tint) >= STATUS_PAGE_MIN_CONTRAST,
	) ?? card

/**
 * Links take the accent only where it stays readable on that mode's background; else the text
 * colour. The site name and footer links take it too, else the muted colour.
 */
const withAccent = (tokens: StatusPageThemeTokens, accent: string | null): ResolvedStatusPageThemeTokens => {
	const tints = {
		okTint: statusTint(tokens.ok, tokens.card, tokens.fg),
		degradedTint: statusTint(tokens.degraded, tokens.card, tokens.fg),
		partialTint: statusTint(tokens.partial, tokens.card, tokens.fg),
		majorTint: statusTint(tokens.major, tokens.card, tokens.fg),
		maintTint: statusTint(tokens.maint, tokens.card, tokens.fg),
	}
	return accent === null || contrastRatio(accent, tokens.bg) < STATUS_PAGE_MIN_CONTRAST
		? { ...tokens, ...tints, secondary: tokens.muted }
		: { ...tokens, ...tints, link: accent, secondary: accent }
}

/**
 * The concrete tokens a theme renders with. Auto takes the preset and accent only; a forced
 * appearance also takes the colour overrides for that mode. Status colours always come from the preset.
 */
export const resolveStatusPageTheme = (theme: StatusPageTheme): ResolvedStatusPageTheme => {
	const preset = PRESET_TOKENS[theme.preset]
	const accent = theme.accent?.toLowerCase() ?? null
	const forced = (mode: "light" | "dark") =>
		theme.appearance === mode ? withOverrides(preset[mode], theme) : preset[mode]
	return {
		appearance: theme.appearance,
		accent,
		light: withAccent(forced("light"), accent),
		dark: withAccent(forced("dark"), accent),
		radiusPx: RADIUS_PX[theme.radius],
		fontStack: FONT_STACKS[theme.font],
	}
}

/** The token sets a visitor can actually see. */
export const visibleThemeTokens = (
	resolved: ResolvedStatusPageTheme,
): ReadonlyArray<ResolvedStatusPageThemeTokens> =>
	resolved.appearance === "auto"
		? [resolved.light, resolved.dark]
		: [resolved.appearance === "light" ? resolved.light : resolved.dark]

export const STATUS_PAGE_MIN_CONTRAST = 4.5

/** Two decimals, never rounded up to a passing 4.50. */
const formatRatio = (ratio: number): string => {
	const rounded = Math.round(ratio * 100) / 100
	const shown = rounded >= STATUS_PAGE_MIN_CONTRAST && ratio < STATUS_PAGE_MIN_CONTRAST ? 4.49 : rounded
	return `${shown.toFixed(2)}:1`
}

const STATUS_COLOR_TOKENS = ["ok", "degraded", "partial", "major", "maint"] as const

/** Why the theme's text would be hard to read (below WCAG AA 4.5:1), or null when it is readable. */
export const themeContrastIssue = (theme: StatusPageTheme): string | null => {
	const issues = visibleThemeTokens(resolveStatusPageTheme(theme)).flatMap((tokens) => {
		const onBackground = contrastRatio(tokens.fg, tokens.bg)
		const onCard = contrastRatio(tokens.fg, tokens.card)
		if (onBackground < STATUS_PAGE_MIN_CONTRAST)
			return [
				`Text on the background has a contrast of ${formatRatio(onBackground)}; it needs at least 4.5:1.`,
			]
		if (onCard < STATUS_PAGE_MIN_CONTRAST)
			return [`Text on cards has a contrast of ${formatRatio(onCard)}; it needs at least 4.5:1.`]
		// Status colours come from the preset, so an overridden card or background can wash them out.
		const statusRatio = Math.min(
			...STATUS_COLOR_TOKENS.flatMap((key) => [
				contrastRatio(tokens[key], tokens.bg),
				contrastRatio(tokens[key], tokens.card),
			]),
		)
		if (statusRatio < STATUS_PAGE_MIN_CONTRAST)
			return [
				`Status labels have a contrast of ${formatRatio(statusRatio)} on this background or card; they need at least 4.5:1.`,
			]
		return []
	})
	return issues[0] ?? null
}

export const StatusPageSnapshotPage = Schema.Struct({
	name: Schema.String,
	slug: StatusPageSlug,
	description: Schema.NullOr(Schema.String),
	websiteUrl: Schema.NullOr(Schema.String),
	logoUrl: Schema.NullOr(Schema.String),
	// Snapshots published before themes existed carry none; they render the default until republished.
	theme: StatusPageTheme.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(DEFAULT_STATUS_PAGE_THEME))),
	showPoweredBy: Schema.Boolean,
	// Footer links; absent from snapshots published before they existed.
	privacyUrl: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(null))),
	termsUrl: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(null))),
})
export type StatusPageSnapshotPage = Schema.Schema.Type<typeof StatusPageSnapshotPage>

/** Everything a status page shows, self-contained: serving it needs no other read. */
export const StatusPageSnapshot = Schema.Struct({
	schemaVersion: Schema.Literal(STATUS_PAGE_SNAPSHOT_VERSION),
	pageId: StatusPageId,
	revision: Schema.Number,
	generatedAt: Schema.Number,
	page: StatusPageSnapshotPage,
	/** SHA-256 (base64url) of the break-glass token; null when none is issued. */
	breakGlassTokenSha256: Schema.NullOr(Schema.String),
	components: Schema.Array(StatusPageSnapshotComponent),
	/** Open incidents, upcoming and active maintenance, and recently resolved ones; newest first. */
	incidents: Schema.Array(StatusPageSnapshotIncident),
	/**
	 * Incidents and maintenance that started, or were still open, in the last
	 * `STATUS_PAGE_HISTORY_DAYS`, newest first. Older snapshots carry none.
	 */
	incidentHistory: Schema.Array(StatusPageIncidentHistoryEntry).pipe(
		Schema.withDecodingDefaultTypeKey(Effect.succeed([])),
	),
})
export type StatusPageSnapshot = Schema.Schema.Type<typeof StatusPageSnapshot>

/**
 * Written after each successful publish sweep. `probesSeenAt` is the newest scheduled check result
 * across all monitors: when the prober stops, every monitored page goes delayed together.
 */
export const StatusPagePublisherHeartbeat = Schema.Struct({
	at: Schema.Number,
	probesSeenAt: Schema.NullOr(Schema.Number),
})
export type StatusPagePublisherHeartbeat = Schema.Schema.Type<typeof StatusPagePublisherHeartbeat>

// --- Break-glass overlay ---

/** An update posted straight to the status Worker while Maple is down; imported into Postgres later. */
export const StatusPageOverlayEntry = Schema.Struct({
	/** Random UUID; the import is idempotent on it. */
	id: Schema.String,
	at: Schema.Number,
	/** The incident to update; null opens a new one titled `title`. */
	incidentId: Schema.NullOr(Schema.String),
	title: Schema.NullOr(Schema.String),
	/** Null keeps the incident's current status (a new incident starts `investigating`). */
	status: Schema.NullOr(StatusPageIncidentStatus),
	/** Null keeps the incident's current impact (a new incident starts `major`). */
	impact: Schema.NullOr(StatusPageIncidentImpact),
	body: Schema.String,
	componentIds: Schema.Array(Schema.String),
})
export type StatusPageOverlayEntry = Schema.Schema.Type<typeof StatusPageOverlayEntry>

export const StatusPageOverlay = Schema.Struct({ entries: Schema.Array(StatusPageOverlayEntry) })
export type StatusPageOverlay = Schema.Schema.Type<typeof StatusPageOverlay>

const INCIDENT_STATUSES = ["investigating", "identified", "monitoring", "resolved"] as const
const MAINTENANCE_STATUSES = ["scheduled", "in_progress", "completed"] as const

/** Whether a status belongs to the kind: incidents and maintenance have separate lifecycles. */
export const statusFitsKind = (kind: StatusPageIncidentKind, status: StatusPageIncidentStatus): boolean =>
	kind === "incident"
		? INCIDENT_STATUSES.some((allowed) => allowed === status)
		: MAINTENANCE_STATUSES.some((allowed) => allowed === status)

export const STATUS_PAGE_OVERLAY_MAX_ENTRIES = 50

/** The incident an overlay entry opens: keyed by the entry id so a later entry can update it. */
export const overlayIncidentId = (entryId: string): string => `bg-${entryId}`

const isResolvedStatus = (status: StatusPageIncidentStatus): boolean =>
	status === "resolved" || status === "completed"

/** Break-glass entries already imported into the snapshot; the edge skips them. */
const importedEntryIds = (snapshot: StatusPageSnapshot): ReadonlySet<string> =>
	new Set(
		snapshot.incidents.flatMap((incident) =>
			incident.updates.flatMap((update) =>
				update.overlayEntryId === null ? [] : [update.overlayEntryId],
			),
		),
	)

/** Which incident an entry targets: `bg-<entry>` also matches the imported incident it opened. */
const matchesTarget = (incident: StatusPageSnapshotIncident, targetId: string): boolean =>
	incident.id === targetId ||
	(incident.openedByOverlayEntryId !== null &&
		overlayIncidentId(incident.openedByOverlayEntryId) === targetId)

/** The snapshot as visitors should see it, with break-glass updates not yet imported applied in order. */
export const applyOverlay = (
	snapshot: StatusPageSnapshot,
	overlay: StatusPageOverlay,
): StatusPageSnapshot => {
	const imported = importedEntryIds(snapshot)
	const entries = overlay.entries.filter((entry) => !imported.has(entry.id)).sort((a, b) => a.at - b.at)
	if (entries.length === 0) return snapshot
	const incidents = entries.reduce<ReadonlyArray<StatusPageSnapshotIncident>>((list, entry) => {
		const targetId = entry.incidentId ?? overlayIncidentId(entry.id)
		const existing = list.find((incident) => matchesTarget(incident, targetId))
		if (existing === undefined) {
			const status =
				entry.status !== null && statusFitsKind("incident", entry.status)
					? entry.status
					: "investigating"
			const opened: StatusPageSnapshotIncident = {
				id: targetId,
				kind: "incident",
				title: entry.title ?? "Service disruption",
				impact: entry.impact ?? "major",
				status,
				startedAt: entry.at,
				resolvedAt: isResolvedStatus(status) ? entry.at : null,
				scheduledStart: null,
				scheduledEnd: null,
				componentIds: entry.componentIds,
				openedByOverlayEntryId: entry.id,
				updates: [
					{
						id: entry.id,
						status,
						body: entry.body,
						at: entry.at,
						source: "break_glass",
						overlayEntryId: entry.id,
					},
				],
			}
			return [opened, ...list]
		}
		// A status from the other lifecycle (an incident status on maintenance) is ignored, not applied.
		const status =
			entry.status !== null && statusFitsKind(existing.kind, entry.status)
				? entry.status
				: existing.status
		const update: StatusPageSnapshotUpdate = {
			id: entry.id,
			status,
			body: entry.body,
			at: entry.at,
			source: "break_glass",
			overlayEntryId: entry.id,
		}
		return list.map((incident) =>
			incident === existing
				? {
						...incident,
						title: entry.title ?? incident.title,
						impact: entry.impact ?? incident.impact,
						status,
						resolvedAt: isResolvedStatus(status) ? (incident.resolvedAt ?? entry.at) : null,
						componentIds:
							entry.componentIds.length > 0 ? entry.componentIds : incident.componentIds,
						updates: [update, ...incident.updates],
					}
				: incident,
		)
	}, snapshot.incidents)
	return { ...snapshot, incidents, components: withIncidentImpact(snapshot.components, incidents) }
}

// --- Component status ---

const STATUS_RANK = {
	operational: 0,
	maintenance: 1,
	degraded: 2,
	partial_outage: 3,
	major_outage: 4,
} as const satisfies Record<StatusPageComponentStatus, number>

export const worstStatus = (statuses: ReadonlyArray<StatusPageComponentStatus>): StatusPageComponentStatus =>
	statuses.reduce<StatusPageComponentStatus>(
		(worst, status) => (STATUS_RANK[status] > STATUS_RANK[worst] ? status : worst),
		"operational",
	)

const IMPACT_STATUS = {
	none: "operational",
	minor: "degraded",
	major: "partial_outage",
	critical: "major_outage",
} as const satisfies Record<StatusPageIncidentImpact, StatusPageComponentStatus>

export const isActiveIncident = (incident: {
	readonly kind: StatusPageIncidentKind
	readonly status: StatusPageIncidentStatus
}): boolean =>
	incident.kind === "incident" ? incident.status !== "resolved" : incident.status === "in_progress"

/** What an active incident or maintenance does to the components it names. */
export const incidentComponentStatus = (incident: {
	readonly kind: StatusPageIncidentKind
	readonly impact: StatusPageIncidentImpact
}): StatusPageComponentStatus =>
	incident.kind === "maintenance" ? "maintenance" : IMPACT_STATUS[incident.impact]

/**
 * A component's status: the worst of its monitor (down is a major outage), a manual
 * override, and the active incidents or maintenance naming it.
 */
export const deriveComponentStatus = (input: {
	readonly monitorStatus: UptimeMonitorStatus | null
	readonly manualStatus: StatusPageComponentStatus | null
	readonly incidentStatuses: ReadonlyArray<StatusPageComponentStatus>
}): StatusPageComponentStatus =>
	worstStatus([
		input.monitorStatus === "down" ? "major_outage" : "operational",
		input.manualStatus ?? "operational",
		...input.incidentStatuses,
	])

const withIncidentImpact = (
	components: ReadonlyArray<StatusPageSnapshotComponent>,
	incidents: ReadonlyArray<StatusPageSnapshotIncident>,
): ReadonlyArray<StatusPageSnapshotComponent> => {
	const active = incidents.filter(isActiveIncident)
	// From `baseStatus`, not `status`: an incident the overlay resolves must stop counting.
	return components.map((component) => ({
		...component,
		status: worstStatus([
			component.baseStatus,
			...active
				.filter((incident) => incident.componentIds.includes(component.id))
				.map(incidentComponentStatus),
		]),
	}))
}

/** The banner status: the worst component, or `operational` for an empty page. */
export const overallStatus = (snapshot: StatusPageSnapshot): StatusPageComponentStatus =>
	worstStatus(snapshot.components.map((component) => component.status))

// --- Bars ---

export const dayState = (bar: StatusPageDayBar): StatusPageDayState =>
	bar.checks === 0 ? "none" : bar.downChecks > 0 ? "down" : bar.failures > 0 ? "degraded" : "ok"

/** Share of checks not taken while down, as a percentage; null when nothing was checked. */
export const uptimePercent = (days: ReadonlyArray<StatusPageDayBar>): number | null => {
	const checks = days.reduce((sum, day) => sum + day.checks, 0)
	if (checks === 0) return null
	const down = days.reduce((sum, day) => sum + day.downChecks, 0)
	return ((checks - down) / checks) * 100
}

export const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10)

/** The last `count` UTC days ending today, oldest first. */
export const lastDays = (nowMs: number, count: number): ReadonlyArray<string> =>
	Array.from({ length: count }, (_, index) => utcDay(nowMs - (count - 1 - index) * 86_400_000))

/** One bar per day of the window, empty where no row exists. */
export const fillDays = (
	days: ReadonlyArray<string>,
	rows: ReadonlyArray<StatusPageDayBar>,
): ReadonlyArray<StatusPageDayBar> => {
	const byDay = new Map(rows.map((row) => [row.day, row]))
	return days.map((day) => byDay.get(day) ?? { day, checks: 0, failures: 0, downChecks: 0 })
}

// --- Freshness ---

export type StatusPageFreshness =
	| { readonly _tag: "live"; readonly updatedAt: number }
	| { readonly _tag: "delayed"; readonly updatedAt: number }

/**
 * Whether the page reflects live checks. `updatedAt` is when its state was last confirmed:
 * the publisher's last good sweep, and for a page with monitors also the newest probe result.
 * Either going quiet (Maple down, or the probes stopped) makes the page say so rather than look green.
 */
export const pageFreshness = (input: {
	readonly snapshot: StatusPageSnapshot
	readonly heartbeat: StatusPagePublisherHeartbeat | null
	readonly nowMs: number
}): StatusPageFreshness => {
	const publisherAt = Math.max(input.snapshot.generatedAt, input.heartbeat?.at ?? 0)
	const monitored = input.snapshot.components.some((component) => component.monitored)
	const probesSeenAt = input.heartbeat?.probesSeenAt ?? null
	// Monitors with no probe time to confirm them (heartbeat unreadable, or no probe ran) are not live.
	if (monitored && probesSeenAt === null) return { _tag: "delayed", updatedAt: publisherAt }
	const updatedAt = monitored && probesSeenAt !== null ? Math.min(publisherAt, probesSeenAt) : publisherAt
	return input.nowMs - updatedAt > STATUS_PAGE_STALE_AFTER_MS
		? { _tag: "delayed", updatedAt }
		: { _tag: "live", updatedAt }
}

// --- Break-glass token ---

export const STATUS_PAGE_BREAK_GLASS_PREFIX = "mstat_"

/** SHA-256 of the token, base64url: the token carries 256 random bits, so no key is needed. */
export const sha256Base64Url = async (value: string): Promise<string> => {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
	return btoa(String.fromCharCode(...new Uint8Array(digest)))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/u, "")
}

/** Edge storage keys, shared by the publisher and the status Worker. */
export const StatusPageKeys = {
	host: (hostname: string) => `host:${hostname.toLowerCase()}`,
	/** Path addressing (`/s/<slug>`), for hosts without a page of their own such as workers.dev. */
	slug: (slug: string) => `slug:${slug}`,
	snapshot: (pageId: string) => `page:${pageId}:snapshot`,
	/**
	 * One key per break-glass entry, written once by the status Worker and deleted by the
	 * reconciler once a published snapshot carries it: nothing rewrites a shared value.
	 */
	overlayEntry: (pageId: string, entryId: string) => `overlay:${pageId}:${entryId}`,
	overlayPage: (pageId: string) => `overlay:${pageId}:`,
	overlayAll: "overlay:",
	heartbeat: "meta:heartbeat",
	/** R2 copy of the snapshot, read when KV fails. */
	snapshotObject: (pageId: string) => `pages/${pageId}/snapshot.json`,
	hostObject: (hostname: string) => `hosts/${hostname.toLowerCase()}`,
	slugObject: (slug: string) => `slugs/${slug}`,
} as const

export const decodeStatusPageSnapshotJson = Schema.decodeUnknownOption(
	Schema.fromJsonString(StatusPageSnapshot),
)
export const decodeStatusPageOverlayEntryJson = Schema.decodeUnknownOption(
	Schema.fromJsonString(StatusPageOverlayEntry),
)
export const decodeStatusPageHeartbeatJson = Schema.decodeUnknownOption(
	Schema.fromJsonString(StatusPagePublisherHeartbeat),
)
