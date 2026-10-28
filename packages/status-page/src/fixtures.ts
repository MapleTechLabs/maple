import { Schema } from "effect"
import {
	DEFAULT_STATUS_PAGE_THEME,
	lastDays,
	StatusPageSnapshot,
	STATUS_PAGE_HISTORY_DAYS,
	type StatusPageDayState,
} from "@maple/domain/status-page"

// Snapshot builders for tests and sample renders. Values are decoded, so brands are real.

type Encoded = typeof StatusPageSnapshot.Encoded
type EncodedComponent = Encoded["components"][number]
type EncodedIncident = Encoded["incidents"][number]
type EncodedDay = EncodedComponent["days"][number]

export const FIXTURE_PAGE_ID = "0b4c9b8e-6f2a-4d1e-9a5b-2f6c8d7e1a01"
export const FIXTURE_NOW = Date.UTC(2026, 9, 28, 12, 0, 0)

const COMPONENT_IDS = [
	"1c4c9b8e-6f2a-4d1e-9a5b-2f6c8d7e1a01",
	"1c4c9b8e-6f2a-4d1e-9a5b-2f6c8d7e1a02",
	"1c4c9b8e-6f2a-4d1e-9a5b-2f6c8d7e1a03",
	"1c4c9b8e-6f2a-4d1e-9a5b-2f6c8d7e1a04",
] as const

export const fixtureComponentId = (index: number): string =>
	COMPONENT_IDS[index] ?? "1c4c9b8e-6f2a-4d1e-9a5b-2f6c8d7e1aff"

const DAY_COUNTS = {
	none: { checks: 0, failures: 0, downChecks: 0 },
	ok: { checks: 1440, failures: 0, downChecks: 0 },
	degraded: { checks: 1440, failures: 3, downChecks: 0 },
	down: { checks: 1440, failures: 30, downChecks: 30 },
} as const satisfies Record<StatusPageDayState, Omit<EncodedDay, "day">>

/** 90 days ending on `nowMs`, all `ok` except the given overrides (index 0 is the oldest). */
export const makeDays = (
	nowMs: number = FIXTURE_NOW,
	overrides: Readonly<Record<number, StatusPageDayState>> = {},
): ReadonlyArray<EncodedDay> =>
	lastDays(nowMs, STATUS_PAGE_HISTORY_DAYS).map((day, index) => ({
		day,
		...DAY_COUNTS[overrides[index] ?? "ok"],
	}))

export const makeComponent = (index: number, fields: Partial<EncodedComponent> = {}): EncodedComponent => ({
	id: fixtureComponentId(index),
	name: `Component ${index + 1}`,
	description: null,
	group: null,
	status: "operational",
	// A fixture's status is its base unless a test says otherwise.
	baseStatus: fields.status ?? "operational",
	showUptime: true,
	monitored: true,
	days: makeDays(),
	...fields,
})

export const makeIncident = (id: string, fields: Partial<EncodedIncident> = {}): EncodedIncident => ({
	id,
	kind: "incident",
	title: `Incident ${id}`,
	impact: "minor",
	status: "investigating",
	startedAt: FIXTURE_NOW - 30 * 60_000,
	resolvedAt: null,
	scheduledStart: null,
	scheduledEnd: null,
	componentIds: [],
	openedByOverlayEntryId: null,
	updates: [],
	...fields,
})

export const makeSnapshot = (fields: Partial<Encoded> = {}): StatusPageSnapshot =>
	Schema.decodeUnknownSync(StatusPageSnapshot)({
		schemaVersion: 1,
		pageId: FIXTURE_PAGE_ID,
		revision: 1,
		generatedAt: FIXTURE_NOW - 60_000,
		page: {
			name: "Acme",
			slug: "acme",
			description: "Status of Acme services",
			websiteUrl: "https://acme.example",
			logoUrl: null,
			theme: DEFAULT_STATUS_PAGE_THEME,
			showPoweredBy: true,
		},
		breakGlassTokenSha256: null,
		components: [
			makeComponent(0, { name: "API", group: "Platform" }),
			makeComponent(1, { name: "Dashboard", group: "Platform" }),
			makeComponent(2, { name: "Docs", showUptime: false, monitored: false, days: [] }),
		],
		incidents: [],
		...fields,
	})
