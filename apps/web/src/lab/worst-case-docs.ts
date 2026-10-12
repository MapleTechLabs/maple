/**
 * The decoded half of the `/lab/worst-case` fixture: documents that carry
 * branded ids, built through their real schemas so no value is cast to a brand.
 */
import { ActorDocument, AlertRuleDocument, ErrorIssueSampleTrace } from "@maple/domain/http"
import { V2Investigation } from "@maple/domain/http/v2"
import { Schema } from "effect"

import { resolveActorIdentity, type ActorIdentity } from "@/components/errors/actor-chip"
import type { ActorDirectory, DirectoryPerson } from "@/hooks/use-actor-directory"
import type { DerivedRuleStatus } from "@/lib/alerts/rule-status"
import type { AlertRuleStateRow } from "@/lib/collections/alerts"
import type { ErrorSignal } from "@/lib/models/error-signal"
import { VERDICT_LAB_CASES } from "@/lab/verdict-fixture"
import { LONG_SERVICE, LONG_URL, type WorstCaseMode } from "@/lab/worst-case-fixture"

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const NOW = Date.now()

/* Verdict ---------------------------------------------------------------------------------- */

const decodeInvestigation = Schema.decodeUnknownSync(Schema.toType(V2Investigation))

export function verdict(mode: WorstCaseMode): V2Investigation {
	const base = VERDICT_LAB_CASES[0]!.investigation
	if (mode === "demo") return base
	return decodeInvestigation({
		...base,
		report: {
			...base.report,
			headline: `\`${LONG_SERVICE}\` exhausted its retry budget; see ${LONG_URL}`,
			summary: `Latency on \`POST /api/v2/organizations/{orgId}/projects/{projectId}/checkout\` rose at 08:51. Dashboard: ${LONG_URL}. Every failing request spent its full 30s inside \`PaymentClient.captureWithRetry()\`.`,
			suspectedCause: `Deploy \`8f21c0d9e4b7a6f5c3d2e1f0a9b8c7d6e5f4a3b2\` raised \`PAYMENT_RETRY_ATTEMPTS\` from 2 to 5. Evidence: ${LONG_URL}`,
			suggestedActions: [
				`Open ${LONG_URL} and compare the p99 panel before and after 08:51.`,
				"Set `PAYMENT_RETRY_ATTEMPTS=2` on `checkout-service-payments-reconciliation-worker-eu-west-1`.",
				"x".repeat(240),
			],
		},
	})
}

/* Errors ----------------------------------------------------------------------------------- */

const decodeSample = Schema.decodeUnknownSync(ErrorIssueSampleTrace)

/** A proxy's HTML 502 page, flattened onto one line, about 8KB. */
const PROXY_502 = (
	"<!DOCTYPE html><html><head><title>502 Bad Gateway</title><style>body{font-family:sans-serif;margin:0}</style></head><body><center><h1>502 Bad Gateway</h1></center><hr><center>nginx/1.25.3</center>" +
	"<!-- a padding to disable MSIE and Chrome friendly error page -->".repeat(120) +
	"</body></html>"
).slice(0, 8192)

export function sampleTraces(mode: WorstCaseMode): ReadonlyArray<ErrorIssueSampleTrace> {
	const sample = (n: number, serviceName: string, exceptionMessage: string) =>
		decodeSample({
			traceId: `4bf92f3577b34da6a3ce929d0e0e47${String(n).padStart(2, "0")}`,
			spanId: `00f067aa0ba902${String(n).padStart(2, "0")}`,
			serviceName,
			timestamp: new Date(NOW - n * 60_000).toISOString(),
			exceptionMessage,
			durationMicros: 30_000_000,
		})
	if (mode === "demo") return [sample(1, "api", "Bad Gateway"), sample(2, "api", "Bad Gateway")]
	return [sample(1, LONG_SERVICE, PROXY_502), sample(2, "unknown_service:node", "")]
}

/** A row from the errors lab, renamed to the generic case and seen in the future. */
export function errorSignal(mode: WorstCaseMode, base: ErrorSignal): ErrorSignal {
	if (mode === "demo") return base
	return {
		...base,
		title: "Error",
		detail: PROXY_502,
		serviceName: LONG_SERVICE,
		lastSeenAt: new Date(NOW + 3 * 60 * 60 * 1000).toISOString(),
		windowCount: 12_849_302,
		totalCount: 9_007_199_254_740_993,
	}
}

/* Actors ----------------------------------------------------------------------------------- */

const decodeActor = Schema.decodeUnknownSync(ActorDocument)

const PEOPLE = {
	demo: [
		{ userId: "user_demo_1", name: "Asha Rao", email: "asha@example.com", imageUrl: null },
		{ userId: "user_demo_2", name: "Ren Ito", email: "ren@example.com", imageUrl: null },
	],
	worst: [
		{ userId: "user_wc_fox", name: "🦊 Fox", email: "fox@example.com", imageUrl: null },
		{
			userId: "user_wc_han",
			name: "Đặng Thị Ngọc Hân",
			email: "dang.thi.ngoc.han.with.a.very.long.address@subsidiary.example.co.uk",
			imageUrl: "https://img.example.com/avatars/does-not-exist-404.png",
		},
		{ userId: "user_wc_han_noimg", name: "Đặng Thị Ngọc Hân", email: null, imageUrl: null },
	],
} satisfies Record<WorstCaseMode, ReadonlyArray<DirectoryPerson>>

export function actorIdentities(mode: WorstCaseMode): ReadonlyArray<ActorIdentity> {
	const people = PEOPLE[mode]
	const directory: ActorDirectory = {
		lookup: (userId) => people.find((p) => p.userId === userId) ?? null,
		me: null,
		isLoaded: true,
	}
	return people.map((person, i) =>
		resolveActorIdentity(
			decodeActor({
				id: uuid(900 + i),
				type: "user",
				userId: person.userId,
				agentName: null,
				model: null,
				capabilities: [],
				lastActiveAt: null,
			}),
			directory,
		),
	)
}

/* Alert rules ------------------------------------------------------------------------------ */

const decodeRule = Schema.decodeUnknownSync(AlertRuleDocument)

export interface RulesFixture {
	readonly rules: ReadonlyArray<AlertRuleDocument>
	readonly derived: Map<string, DerivedRuleStatus>
	readonly states: Map<string, AlertRuleStateRow[]>
}

export function rulesFixture(mode: WorstCaseMode): RulesFixture {
	const worst = mode === "worst"
	const rule = (n: number, name: string, threshold: number, tags: ReadonlyArray<string>) =>
		decodeRule({
			id: uuid(500 + n),
			name,
			notes: null,
			notificationTemplate: null,
			enabled: true,
			severity: "critical",
			serviceNames: [worst ? LONG_SERVICE : "api"],
			excludeServiceNames: [],
			environments: [],
			tags,
			groupBy: null,
			signalType: "error_rate",
			comparator: "gt",
			threshold,
			thresholdUpper: null,
			windowMinutes: 5,
			minimumSampleCount: 0,
			consecutiveBreachesRequired: 1,
			consecutiveHealthyRequired: 1,
			renotifyIntervalMinutes: 60,
			apdexThresholdMs: null,
			queryBuilderDraft: null,
			rawQuerySql: null,
			rawQueryReducer: null,
			destinationIds: [],
			noDataBehavior: "skip",
			lastEvaluationError: worst ? `Query failed: ${"x".repeat(400)}` : null,
			lastEvaluatedAt: new Date(NOW - 60_000).toISOString(),
			lastScheduledAt: null,
			createdAt: "2026-09-01T00:00:00.000Z",
			updatedAt: "2026-09-01T00:00:00.000Z",
			createdBy: "user_wc",
			updatedBy: "user_wc",
		})
	const rules = worst
		? [
				rule(1, "[P1] Checkout p99 latency > 2s for 5m (EU prod, excl. synthetic traffic)", 0.07, [
					"team:payments-reconciliation-eu",
					"tier:p1",
					"region:eu-west-1",
					"owner:checkout-service-payments-reconciliation-worker",
				]),
				rule(2, "x", 0.29, []),
			]
		: [rule(1, "Checkout error rate", 0.05, ["team:payments"])]
	const derived = new Map<string, DerivedRuleStatus>(
		rules.map((r, i) => [
			r.id,
			{
				status: worst && i === 0 ? "error" : "healthy",
				attention: { noDestinations: true, recentDeliveryFailure: false },
				reason: worst && i === 0 ? r.lastEvaluationError : null,
			},
		]),
	)
	const states = new Map<string, AlertRuleStateRow[]>(
		rules.map((r, i) => [
			r.id,
			[
				{
					org_id: "org_wc",
					rule_id: r.id,
					group_key: "",
					consecutive_breaches: 0,
					consecutive_healthy: 1,
					last_status: "healthy",
					last_value: worst ? (i === 0 ? 0.29 : 0.07) : 0.01,
					last_sample_count: 100,
					last_evaluated_at: new Date(NOW - 60_000).toISOString(),
					last_error: null,
					updated_at: new Date(NOW - 60_000).toISOString(),
				},
			],
		]),
	)
	return { rules, derived, states }
}
