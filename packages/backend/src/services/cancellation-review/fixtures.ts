/**
 * Synthetic cancelling orgs, one per way an org leaves, for the rule tests.
 * None is a real customer. Add a case here when a real cancellation is read
 * wrongly.
 */
import { CancellationSnapshot, type CancellationReason } from "@maple/domain/http"

export interface CancellationFixture {
	readonly id: string
	readonly expected: CancellationReason
	readonly snapshot: CancellationSnapshot
}

type Fields = ConstructorParameters<typeof CancellationSnapshot>[0]

const volume = (totalGB: number, activeDays: number, browserSessions = 0) => ({
	logsGB: totalGB * 0.5,
	tracesGB: totalGB * 0.4,
	metricsGB: totalGB * 0.1,
	browserSessions,
	activeDays,
})

/** An org nothing is wrong with: nine months in, steady volume, people in the app most days. */
const healthy: Fields = {
	plan: {
		planId: "startup",
		phase: "scheduled",
		trial: false,
		pastDue: false,
		tenureDays: 270,
		daysUntilEnd: 12,
	},
	org: { ageDays: 300, members: 5, everReceivedData: true, supportChannel: false },
	ingest: { recent: volume(38, 30), prior: volume(35, 30), daysSinceLastData: 0 },
	visits: {
		recent: { activeDays: 22, peakDailyUsers: 4 },
		prior: { activeDays: 24, peakDailyUsers: 5 },
		daysSinceLastVisit: 1,
	},
	adoption: { dashboards: 9, alertRules: 14, integrations: 2 },
	billing: { lastInvoiceTotal: 39, previousInvoiceTotal: 39, overAllowance: [] },
}

const fixture = (id: string, expected: CancellationReason, overrides: Partial<Fields>): CancellationFixture => ({
	id,
	expected,
	snapshot: new CancellationSnapshot({ ...healthy, ...overrides }),
})

const noVisits = {
	recent: { activeDays: 0, peakDailyUsers: 0 },
	prior: { activeDays: 0, peakDailyUsers: 0 },
	daysSinceLastVisit: null,
}

const noAdoption = { dashboards: 0, alertRules: 0, integrations: 0 }

export const CANCELLATION_FIXTURES: ReadonlyArray<CancellationFixture> = [
	fixture("never-sent", "never_activated", {
		plan: { ...healthy.plan, trial: true, tenureDays: 9, daysUntilEnd: 5 },
		org: { ageDays: 9, members: 1, everReceivedData: false, supportChannel: false },
		ingest: { recent: volume(0, 0), prior: volume(0, 0), daysSinceLastData: null },
		visits: {
			recent: { activeDays: 2, peakDailyUsers: 1 },
			prior: { activeDays: 0, peakDailyUsers: 0 },
			daysSinceLastVisit: 7,
		},
		adoption: noAdoption,
		billing: { lastInvoiceTotal: null, previousInvoiceTotal: null, overAllowance: [] },
	}),
	fixture("trial-run", "never_activated", {
		plan: { ...healthy.plan, tenureDays: 21, daysUntilEnd: 9 },
		org: { ageDays: 23, members: 2, everReceivedData: true, supportChannel: false },
		ingest: { recent: volume(0.04, 2), prior: volume(0, 0), daysSinceLastData: 17 },
		visits: {
			recent: { activeDays: 3, peakDailyUsers: 2 },
			prior: { activeDays: 0, peakDailyUsers: 0 },
			daysSinceLastVisit: 16,
		},
		adoption: noAdoption,
		billing: { lastInvoiceTotal: 39, previousInvoiceTotal: null, overAllowance: [] },
	}),
	fixture("pipeline-off", "stopped_sending", {
		plan: { ...healthy.plan, tenureDays: 240 },
		ingest: { recent: volume(3, 4), prior: volume(42, 30), daysSinceLastData: 24 },
		visits: {
			recent: { activeDays: 2, peakDailyUsers: 1 },
			prior: { activeDays: 15, peakDailyUsers: 3 },
			daysSinceLastVisit: 20,
		},
	}),
	fixture("wound-down", "stopped_sending", {
		ingest: { recent: volume(6, 30), prior: volume(80, 30), daysSinceLastData: 0 },
		visits: {
			recent: { activeDays: 4, peakDailyUsers: 1 },
			prior: { activeDays: 18, peakDailyUsers: 4 },
			daysSinceLastVisit: 6,
		},
	}),
	fixture("long-silent", "stopped_sending", {
		plan: { ...healthy.plan, tenureDays: 400 },
		ingest: { recent: volume(0, 0), prior: volume(0, 0), daysSinceLastData: null },
		visits: noVisits,
	}),
	fixture("nobody-looking", "not_engaged", {
		ingest: { recent: volume(25, 30), prior: volume(26, 30), daysSinceLastData: 0 },
		visits: noVisits,
		adoption: { ...noAdoption, dashboards: 1 },
	}),
	fixture("bill-jump", "cost", {
		ingest: { recent: volume(140, 30), prior: volume(30, 30), daysSinceLastData: 0 },
		billing: {
			lastInvoiceTotal: 212,
			previousInvoiceTotal: 39,
			overAllowance: ["logs", "traces"],
		},
	}),
	fixture(
		"bill-jump-then-off",
		"cost",
		{
			ingest: { recent: volume(20, 16), prior: volume(160, 30), daysSinceLastData: 12 },
			visits: {
				recent: { activeDays: 9, peakDailyUsers: 3 },
				prior: { activeDays: 20, peakDailyUsers: 4 },
				daysSinceLastVisit: 2,
			},
			billing: { lastInvoiceTotal: 260, previousInvoiceTotal: 45, overAllowance: [] },
		},
	),
	fixture("past-due", "payment_failure", {
		plan: { ...healthy.plan, phase: "ended", pastDue: true, daysUntilEnd: 0 },
	}),
	fixture("healthy-team", "unclear", {}),
	fixture("healthy-solo", "unclear", {
		plan: { ...healthy.plan, tenureDays: 95 },
		org: { ageDays: 96, members: 1, everReceivedData: true, supportChannel: false },
		ingest: { recent: volume(1.2, 28), prior: volume(1.1, 30), daysSinceLastData: 0 },
		visits: {
			recent: { activeDays: 10, peakDailyUsers: 1 },
			prior: { activeDays: 12, peakDailyUsers: 1 },
			daysSinceLastVisit: 1,
		},
		adoption: { ...noAdoption, dashboards: 2, alertRules: 3 },
	}),
	fixture(
		"drifting-away",
		"not_engaged",
		{
			visits: {
				recent: { activeDays: 1, peakDailyUsers: 1 },
				prior: { activeDays: 14, peakDailyUsers: 3 },
				daysSinceLastVisit: 9,
			},
		},
	),
	fixture(
		"quieter-month",
		"unclear",
		{
			ingest: { recent: volume(17, 30), prior: volume(38, 30), daysSinceLastData: 0 },
			visits: {
				recent: { activeDays: 15, peakDailyUsers: 3 },
				prior: { activeDays: 19, peakDailyUsers: 4 },
				daysSinceLastVisit: 1,
			},
		},
	),
]
