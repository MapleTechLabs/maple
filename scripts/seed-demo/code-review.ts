#!/usr/bin/env bun
/**
 * `bun run seed:demo:code-review`: the Code Review pages for the Acme Shop demo org.
 *
 *   bun --env-file=.env.screenshots scripts/seed-demo/code-review.ts
 *
 * Writes a GitHub installation, four repositories, ~55 pull request reviews over the last month
 * (most in the last 14 days), their findings and the featured PR's before-merge steps. Idempotent:
 * the demo org's rows in these tables are deleted first. Refuses any database but `maple_screenshots`.
 */
import { NodeRuntime } from "@effect/platform-node"
import * as PgClient from "@effect/sql-pg/PgClient"
import { makeMapleDb } from "@maple/db/client"
import {
	PrReviewFindingEmbeddings,
	PrReviewFindings,
	PrReviewMergeSteps,
	PrReviewReplies,
	PrReviewSettings,
	PrReviews,
	Sources,
	VcsCommits,
	VcsInstallations,
	VcsRepositories,
	VcsRepositoryBranches,
} from "@maple/db/tables"
import {
	GitCommitSha,
	PrReviewContractBreak,
	PrReviewCostNote,
	PrReviewCoverageUnit,
	PrReviewFinding,
	PrReviewHotFile,
	PrReviewId,
	PrReviewLinkedIssue,
	PrReviewMergeStep,
	PrReviewOperationTraffic,
	PrReviewPostMerge,
	PrReviewPostMergeIssue,
	PrReviewPostMergeOperation,
	PrReviewReport,
	PrReviewRepositoryConfig,
	PrReviewTelemetry,
	PrReviewTelemetryChange,
	PrReviewTelemetryReference,
	VcsBranchId,
	VcsInstallationId,
	VcsRepositoryId,
	confidencePrReview,
	mergeStepKey,
	scorePrReview,
	type PrReviewCategory,
	type PrReviewFindingStatus,
	type PrReviewRisk,
	type PrReviewSeverity,
	type PrReviewSkipReason,
	type PrReviewTestSignal,
} from "@maple/domain/http"
import { OrgId, SourceId, UserId } from "@maple/domain/primitives"
import * as PG from "@maple-dev/effect-orm/postgres"
import { Clock, Config, Console, DateTime, Effect, Layer, Redacted, Schema } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import { Rng } from "./rng"

const DEMO_GITHUB_SOURCE = Schema.decodeUnknownSync(SourceId)("5e0a1c3b-0000-4000-8000-00000000de01")

// Same value as `DEMO_ORG_ID` in make-env.ts; importing that module would run its program.
const DEMO_ORG = "org_3AcmeShopDemo0000000000000"
const SCREENSHOT_DATABASE = "maple_screenshots"

class SeedCodeReviewError extends Schema.TaggedError<SeedCodeReviewError>()(
	"@maple/seed-demo/SeedCodeReviewError",
	{ message: Schema.String },
) {}

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

const orgId = Schema.decodeUnknownSync(OrgId)(DEMO_ORG)
const toReviewId = Schema.decodeUnknownSync(PrReviewId)
const toRepositoryId = Schema.decodeUnknownSync(VcsRepositoryId)
const toInstallationId = Schema.decodeUnknownSync(VcsInstallationId)
const toBranchId = Schema.decodeUnknownSync(VcsBranchId)
const toSha = Schema.decodeUnknownSync(GitCommitSha)
const encodePostMerge = Schema.encodeSync(PrReviewPostMerge)

/** A v4-shaped UUID off the seeded generator, so ids (and the featured deep link) survive a re-seed. */
const uuid = (rng: Rng) => {
	const h = rng.hex(16)
	const variant = rng.pick(["8", "9", "a", "b"])
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`
}

type RepoKey = "web" | "checkout" | "payments" | "infra"

interface RepoDef {
	readonly key: RepoKey
	readonly name: string
	readonly externalId: string
	readonly reviewed: boolean
	readonly config: PrReviewRepositoryConfig | null
}

const REPOS = {
	web: { key: "web", name: "web", externalId: "812734001", reviewed: true, config: null },
	checkout: {
		key: "checkout",
		name: "checkout-api",
		externalId: "812734002",
		reviewed: true,
		config: new PrReviewRepositoryConfig({ minInlineSeverity: "warn", automaticReviewLimit: 5 }),
	},
	payments: {
		key: "payments",
		name: "payments",
		externalId: "812734003",
		reviewed: true,
		config: new PrReviewRepositoryConfig({
			instructions:
				"Every charge path must pass an idempotency key to the provider. Flag any log line that carries card data or an email address.",
			blockOnContractBreaks: true,
		}),
	},
	infra: { key: "infra", name: "infra", externalId: "812734004", reviewed: false, config: null },
} satisfies Record<RepoKey, RepoDef>

interface FindingSpec {
	readonly path: string
	readonly line: number
	readonly category: PrReviewCategory
	readonly severity: PrReviewSeverity
	readonly title: string
	readonly body: string
	readonly checkId?: string
	/** Defaults to `resolved` when the PR has a fixing push, `open` otherwise. */
	readonly status?: PrReviewFindingStatus
}

interface PrSpec {
	readonly repo: RepoKey
	readonly number: number
	readonly title: string
	readonly author: string
	readonly daysAgo: number
	readonly outcome?:
		| { readonly kind: "failed"; readonly error: string }
		| { readonly kind: "skipped"; readonly reason: PrReviewSkipReason }
		| { readonly kind: "running" }
	/** A second push fixed the findings and was reviewed clean. */
	readonly fixedOnPush?: boolean
	/** A quick second push superseded the first review before it ran. */
	readonly superseded?: boolean
	readonly notApplicable?: boolean
	readonly merged?: boolean
	readonly summary?: string
	readonly keyChanges?: ReadonlyArray<string>
	readonly checked?: ReadonlyArray<string>
	readonly tests?: PrReviewTestSignal
	readonly risk?: PrReviewRisk
	/** The reviewer's own number; the computed one may move by a point toward it. */
	readonly confidence?: number
	readonly coverage?: ReadonlyArray<
		readonly [unit: string, kind: string, instrumented: boolean, evidence: string]
	>
	readonly findings?: ReadonlyArray<FindingSpec>
}

const SPECS: ReadonlyArray<PrSpec> = [
	{
		repo: "checkout",
		number: 218,
		title: "Split tax calculation into its own module",
		author: "lena-h",
		daysAgo: 0.003,
		outcome: { kind: "running" },
	},
	{
		repo: "checkout",
		number: 219,
		title: "Validate coupon codes before pricing",
		author: "mkowalski",
		daysAgo: 0.6,
		summary:
			"Moves coupon validation ahead of the pricing call so an invalid code fails fast with a 422 instead of a priced cart that later rejects.",
		keyChanges: [
			"Adds validateCoupon in src/coupons/validate.ts and calls it from the checkout route",
			"Returns 422 with a coupon_invalid code for expired or unknown coupons",
		],
		checked: ["Coupon lookups go through the existing cached repository, so no new database load"],
		tests: "partial",
		risk: "medium",
		coverage: [["validateCoupon", "function", true, "Runs inside the POST /checkout server span"]],
		findings: [
			{
				path: "src/coupons/validate.ts",
				line: 48,
				category: "correctness",
				severity: "warn",
				title: "Expired coupons pass validation when the server timezone is not UTC",
				body: "`expiresAt` is compared against `new Date().toDateString()`, which uses the local timezone. On the eu-west pods a coupon that expired at midnight UTC stays valid for another hour.",
			},
		],
	},
	{
		repo: "web",
		number: 479,
		title: "Cache product detail responses at the edge for 60 seconds",
		author: "ada-l",
		daysAgo: 2.1,
		merged: true,
		summary:
			"Adds a 60 second edge cache in front of the product detail loader and purges it when catalog-api publishes a price change.",
		keyChanges: [
			"Wraps the product loader in src/catalog/product-cache.ts",
			"Subscribes to catalog.price_changed to purge cached entries",
		],
		checked: ["Purge runs on the existing catalog event consumer, no new subscription"],
		tests: "covered",
		risk: "medium",
		findings: [
			{
				path: "src/catalog/product-cache.ts",
				line: 44,
				category: "correctness",
				severity: "warn",
				title: "Cache key ignores the currency cookie",
				body: "The key is built from the product slug alone, so a shopper browsing in EUR can be served a page cached for a USD shopper. Add the resolved currency to the key.",
			},
		],
	},
	{
		repo: "checkout",
		number: 216,
		title: "Record payment provider latency as a histogram",
		author: "ada-l",
		daysAgo: 1.9,
		merged: true,
		summary:
			"Adds a payment.provider.duration histogram around the Stripe call, labelled by provider and outcome.",
		keyChanges: [
			"Adds the histogram in src/metrics/provider.ts",
			"Records it from the charge client wrapper",
		],
		tests: "covered",
		risk: "low",
		findings: [
			{
				path: "src/metrics/provider.ts",
				line: 22,
				category: "observability",
				checkId: "MET-02",
				severity: "info",
				title: "Histogram buckets stop at 2 s while the provider p99 is 3.1 s",
				body: "Over the last 7 days `POST /v1/payment_intents` had a p99 of 3.1 s. With a top bucket of 2 s the slow tail lands in +Inf and the p99 panel flattens.",
			},
		],
	},
	{
		repo: "payments",
		number: 93,
		title: "Retry Stripe charges with exponential backoff",
		author: "jtanaka",
		daysAgo: 2.4,
		fixedOnPush: true,
		merged: true,
		summary:
			"Retries a failed payment intent up to three times with exponential backoff and jitter, only for network errors and 5xx responses.",
		keyChanges: [
			"Adds withChargeRetry in services/payment-svc/src/charge.ts",
			"Classifies Stripe errors into retryable and final",
		],
		checked: ["Card declines are classified final and never retried"],
		tests: "covered",
		risk: "medium",
		confidence: 4,
		findings: [
			{
				path: "services/payment-svc/src/charge.ts",
				line: 142,
				category: "correctness",
				severity: "critical",
				title: "Each retry creates a second payment intent",
				body: "The idempotency key is generated inside the retried function, so every attempt sends a new key and Stripe creates a new intent. A timeout followed by a retry can charge the customer twice. Generate the key once per order.",
			},
			{
				path: "services/payment-svc/src/charge.ts",
				line: 151,
				category: "observability",
				checkId: "SPAN-05",
				severity: "warn",
				title: "All attempts share one span, so retry latency is hidden",
				body: "The retries run inside the existing `ChargeService.charge` span with no child span or attempt attribute. Add a span per attempt with `payment.retry.attempt`.",
			},
		],
	},
	{
		repo: "web",
		number: 477,
		title: "Add cart item count to the cart span",
		author: "jtanaka",
		daysAgo: 2.8,
		merged: true,
		summary:
			"Sets the number of items on the GET /cart server span so slow carts can be grouped by size.",
		keyChanges: ["Sets the attribute in src/cart/load.ts after the cart is read"],
		tests: "not_needed",
		risk: "low",
		findings: [
			{
				path: "src/cart/load.ts",
				line: 31,
				category: "convention",
				severity: "info",
				title: "Name the attribute cart.items.count to match the other cart attributes",
				body: "The service already emits `cart.items.total_cents`. `cart.item_count` breaks the `cart.items.*` grouping in the attribute explorer.",
			},
		],
	},
	{
		repo: "web",
		number: 476,
		title: "Lazy-load the reviews widget on product pages",
		author: "sofia-r",
		daysAgo: 3.0,
		merged: true,
		summary:
			"Defers the reviews widget until it scrolls into view, which takes 38 KB off the product page's initial bundle.",
		keyChanges: ["Wraps ReviewsWidget in a lazy boundary with an IntersectionObserver trigger"],
		checked: ["The widget's render span still fires once it mounts"],
		tests: "covered",
		risk: "low",
	},
	{
		repo: "checkout",
		number: 214,
		title: "Return 409 when the cart changed during checkout",
		author: "jtanaka",
		daysAgo: 3.3,
		fixedOnPush: true,
		merged: true,
		summary:
			"Compares the cart version sent by the client with the stored one and returns 409 when they differ.",
		keyChanges: [
			"Adds a cart_version check to src/routes/checkout.ts",
			"Maps the new CartChanged error to 409",
		],
		tests: "partial",
		risk: "medium",
		findings: [
			{
				path: "src/routes/checkout.ts",
				line: 131,
				category: "correctness",
				severity: "warn",
				title: "Every conflict becomes a 409, including stock conflicts the client retries",
				body: "The catch maps any `ConflictError` to 409. The storefront retries 409s, so an out of stock item now loops until the client gives up. Match `CartChanged` only.",
			},
			{
				path: "src/routes/checkout.test.ts",
				line: 212,
				category: "tests",
				severity: "info",
				title: "No test for a cart version mismatch",
				body: "The new branch is not exercised. Add a case that bumps the stored version between load and submit.",
			},
		],
	},
	{
		repo: "web",
		number: 474,
		title: "Retry inventory reservation once on a 409",
		author: "mkowalski",
		daysAgo: 3.6,
		fixedOnPush: true,
		merged: true,
		summary: "Retries the inventory-svc reservation once when it returns 409, after re-reading stock.",
		keyChanges: ["Adds a single retry in src/checkout/reserve.ts"],
		tests: "covered",
		risk: "medium",
		findings: [
			{
				path: "src/checkout/reserve.ts",
				line: 61,
				category: "correctness",
				severity: "warn",
				title: "The retry re-sends the reservation without the idempotency key",
				body: "The first call passes `Idempotency-Key`, the retry builds a fresh request without it. inventory-svc can hold stock twice for the same order.",
			},
			{
				path: "src/checkout/reserve.ts",
				line: 66,
				category: "observability",
				checkId: "SPAN-05",
				severity: "warn",
				title: "The retry is not visible on the span",
				body: "Nothing records that a retry happened. Set `inventory.reserve.retried` on the client span so retry rates show up next to the 409 rate.",
			},
		],
	},
	{
		repo: "payments",
		number: 91,
		title: "Raise the payments pool to 20 connections",
		author: "mkowalski",
		daysAgo: 3.9,
		merged: true,
		summary:
			"Raises the payment-svc Postgres pool from 10 to 20 connections per replica to stop pool timeouts during peaks.",
		keyChanges: ["Changes max in services/payment-svc/src/db/pool.ts from 10 to 20"],
		checked: ["The pool timeout error rate in the last 7 days peaked at 4.2 percent on POST /charges"],
		tests: "not_needed",
		risk: "high",
		findings: [
			{
				path: "services/payment-svc/src/db/pool.ts",
				line: 9,
				category: "performance",
				severity: "warn",
				title: "20 connections per replica exceeds max_connections at 4 replicas",
				body: "The payments database allows 60 connections. Two replicas at 20 fit, but the HPA scales payment-svc to 4 during peaks, which asks for 80. Size the pool from the replica ceiling or put a pooler in front.",
			},
		],
	},
	{
		repo: "checkout",
		number: 212,
		title: "Bump undici to 7.4",
		author: "devon-b",
		daysAgo: 4.0,
		outcome: { kind: "skipped", reason: "automatic_limit" },
		merged: true,
	},
	{
		repo: "web",
		number: 471,
		title: "Update eslint and prettier configs",
		author: "devon-b",
		daysAgo: 4.2,
		notApplicable: true,
		merged: true,
		summary: "Config and formatting only. Nothing in the diff runs in production.",
	},
	{
		repo: "web",
		number: 470,
		title: "Show estimated delivery date in the cart drawer",
		author: "lena-h",
		daysAgo: 4.9,
		merged: true,
		summary:
			"Shows an estimated delivery date in the cart drawer, computed from the warehouse cutoff and the shipping method.",
		keyChanges: [
			"Adds estimateDelivery in src/checkout/delivery-estimate.ts",
			"Renders it under the cart total",
		],
		tests: "partial",
		risk: "low",
		findings: [
			{
				path: "src/checkout/delivery-estimate.ts",
				line: 27,
				category: "tests",
				severity: "info",
				title: "No test for the weekend cutoff branch",
				body: "Orders after Friday's cutoff skip to Tuesday. That branch has no test and is the one most likely to be off by a day.",
			},
		],
	},
	{
		repo: "checkout",
		number: 210,
		title: "Publish orders.created after the payment commits",
		author: "priya-dev",
		daysAgo: 5.0,
		fixedOnPush: true,
		merged: true,
		summary:
			"Moves the orders.created publish out of the request handler and into the order repository's commit hook.",
		keyChanges: [
			"Adds publishAfterCommit in src/orders/publish.ts",
			"Removes the publish call from the checkout route",
		],
		tests: "covered",
		risk: "medium",
		confidence: 4,
		findings: [
			{
				path: "src/orders/publish.ts",
				line: 66,
				category: "correctness",
				severity: "critical",
				title: "The event is still published before the transaction commits",
				body: "`publishAfterCommit` registers the callback on the outer connection, not the transaction, so it fires immediately. order-worker can read the order before it exists and drop the receipt.",
			},
			{
				path: "src/orders/publish.ts",
				line: 72,
				category: "observability",
				checkId: "SPAN-02",
				severity: "warn",
				title: "The new publish span has no messaging.destination.name",
				body: "Without the destination the service map cannot draw the checkout-api to order-worker edge for this topic.",
			},
		],
	},
	{
		repo: "web",
		number: 468,
		title: "Move session refresh into auth-svc middleware",
		author: "ada-l",
		daysAgo: 5.4,
		fixedOnPush: true,
		merged: true,
		summary:
			"Moves refresh token rotation from the storefront into auth-svc middleware so every client gets the same rotation rules.",
		keyChanges: [
			"Adds the rotation middleware in services/auth-svc/internal/session/refresh.go",
			"Deletes the storefront's own refresh call",
		],
		tests: "covered",
		risk: "medium",
		findings: [
			{
				path: "services/auth-svc/internal/session/refresh.go",
				line: 112,
				category: "security",
				checkId: "PII-01",
				severity: "critical",
				title: "The refresh token is logged at info level on rotation",
				body: '`slog.Info("rotated session", "token", newToken)` writes the raw token to the log pipeline, where anyone with log access can replay it. Log the session id instead.',
			},
		],
	},
	{
		repo: "checkout",
		number: 207,
		title: "Drop the legacy /v1/checkout route",
		author: "devon-b",
		daysAgo: 6.5,
		merged: true,
		summary:
			"Removes the /v1/checkout route. The storefront moved to /checkout two releases ago and v1 traffic has been zero for 9 days.",
		keyChanges: ["Deletes src/routes/legacy.ts and its router registration"],
		checked: ["No requests to POST /v1/checkout in the last 7 days of traces"],
		tests: "not_needed",
		risk: "low",
		findings: [
			{
				path: "src/routes/index.ts",
				line: 14,
				category: "observability",
				checkId: "REN-02",
				severity: "warn",
				title: "The Checkout error rate alert still filters on POST /v1/checkout",
				body: "The alert's query includes `span.name = 'POST /v1/checkout'`. With the route gone that half of the filter matches nothing. Update the alert in the same change.",
				status: "dismissed",
			},
		],
	},
	{
		repo: "web",
		number: 466,
		title: "Paginate order history with cursors",
		author: "priya-dev",
		daysAgo: 6.1,
		summary: "Replaces offset pagination on the order history page with a created_at cursor.",
		keyChanges: [
			"Adds cursor support to services/order-worker/src/history.ts",
			"Updates the account page to load more on scroll",
		],
		tests: "covered",
		risk: "medium",
		findings: [
			{
				path: "services/order-worker/src/history.ts",
				line: 38,
				category: "performance",
				severity: "warn",
				title: "The cursor query has no matching index",
				body: "`ORDER BY created_at DESC WHERE customer_id = $1 AND created_at < $2` needs `(customer_id, created_at)`. The table only has `(customer_id)`, so large accounts sort in memory.",
			},
		],
	},
	{
		repo: "web",
		number: 463,
		title: "Add checkout funnel product events",
		author: "jtanaka",
		daysAgo: 6.8,
		fixedOnPush: true,
		merged: true,
		summary: "Emits product events for each checkout step so the funnel can be built in Maple.",
		keyChanges: [
			"Adds trackCheckoutStep in src/analytics/checkout-events.ts",
			"Calls it from the four checkout steps",
		],
		tests: "partial",
		risk: "low",
		findings: [
			{
				path: "src/analytics/checkout-events.ts",
				line: 19,
				category: "security",
				checkId: "PII-02",
				severity: "warn",
				title: "The shopper's email is sent as an event property",
				body: "`email: customer.email` goes into every event. Use the hashed customer id the other events already carry.",
			},
		],
	},
	{
		repo: "payments",
		number: 90,
		title: "Add refund webhook handler",
		author: "priya-dev",
		daysAgo: 7.1,
		fixedOnPush: true,
		merged: true,
		summary: "Handles Stripe charge.refunded webhooks and marks the payment refunded.",
		keyChanges: [
			"Adds services/payment-svc/src/webhooks/refund.ts",
			"Registers the route behind the webhook signature check",
		],
		tests: "partial",
		risk: "high",
		findings: [
			{
				path: "services/payment-svc/src/webhooks/refund.ts",
				line: 17,
				category: "security",
				severity: "warn",
				title: "The signature is verified after the body is parsed",
				body: "The JSON parser runs first, so verification sees a re-serialized body and the signature check can be bypassed by key order. Verify the raw body.",
			},
			{
				path: "services/payment-svc/src/webhooks/refund.test.ts",
				line: 5,
				category: "tests",
				severity: "info",
				title: "No test for a replayed webhook",
				body: "The handler is idempotent by design, but nothing asserts that a second delivery leaves the payment unchanged.",
				status: "open",
			},
		],
	},
	{
		repo: "web",
		number: 461,
		title: "Rewrite catalog search on the new query builder",
		author: "mkowalski",
		daysAgo: 7.3,
		outcome: { kind: "failed", error: "time_limit: the review ran past 15 minutes on a 212 file diff" },
	},
	{
		repo: "checkout",
		number: 205,
		title: "Add request id to error responses",
		author: "sofia-r",
		daysAgo: 7.7,
		merged: true,
		summary:
			"Adds the request id to every error body so support can find the trace from a customer screenshot.",
		keyChanges: ["Reads the trace id in the error middleware and returns it as request_id"],
		checked: ["The id is the trace id, not a new identifier, so it links straight to the trace"],
		tests: "covered",
		risk: "low",
	},
	{
		repo: "web",
		number: 459,
		title: "Split the account pages out of the storefront bundle",
		author: "sofia-r",
		daysAgo: 8.0,
		merged: true,
		summary: "Moves the account pages into their own chunk, which cuts the initial bundle by 61 KB.",
		keyChanges: ["Adds a route level split for /account/*"],
		tests: "covered",
		risk: "low",
	},
	{
		repo: "web",
		number: 457,
		title: "Fix flaky total assertion in cart.test.ts",
		author: "devon-b",
		daysAgo: 8.6,
		superseded: true,
		merged: true,
		summary:
			"Rounds the cart total in the assertion so the test stops failing on currency conversion drift.",
		keyChanges: ["Rounds both sides of the assertion at src/checkout/cart.test.ts:88"],
		tests: "covered",
		risk: "low",
		findings: [
			{
				path: "src/checkout/cart.test.ts",
				line: 88,
				category: "tests",
				severity: "info",
				title: "The test still depends on the current date",
				body: "The fixture's exchange rate is picked by `Date.now()`. Pin the clock so the test cannot drift at the month boundary.",
			},
		],
	},
	{
		repo: "payments",
		number: 88,
		title: "Index payments by order_id",
		author: "devon-b",
		daysAgo: 8.9,
		merged: true,
		summary: "Adds an index on payments(order_id) for the charge status lookup.",
		keyChanges: ["Adds migration 0031_payments_order_id_idx.sql, created concurrently"],
		checked: ["The index is created CONCURRENTLY, so the table is not locked during deploy"],
		tests: "not_needed",
		risk: "medium",
	},
	{
		repo: "checkout",
		number: 203,
		title: "Regenerate the OpenAPI client",
		author: "mkowalski",
		daysAgo: 9.1,
		outcome: { kind: "failed", error: "context_limit: the generated client is 41,000 lines" },
	},
	{
		repo: "web",
		number: 455,
		title: "Emit order placed as a span event instead of a log line",
		author: "lena-h",
		daysAgo: 9.4,
		fixedOnPush: true,
		merged: true,
		summary: "Replaces the `order placed` info log with an event on the checkout span.",
		keyChanges: ["Adds the span event in src/checkout/place-order.ts", "Removes the logger call"],
		tests: "not_needed",
		risk: "low",
		findings: [
			{
				path: "src/checkout/place-order.ts",
				line: 52,
				category: "observability",
				checkId: "LOG-04",
				severity: "warn",
				title: "The Orders per minute dashboard reads the removed log line",
				body: "The dashboard counts logs with body `order placed`. Point the widget at the span event before this merges, or it drops to zero.",
			},
		],
	},
	{
		repo: "web",
		number: 452,
		title: "Add a feature flag for one-page checkout",
		author: "ada-l",
		daysAgo: 10.2,
		merged: true,
		summary: "Adds a one_page_checkout flag and renders the new layout behind it.",
		keyChanges: ["Adds the flag in src/checkout/flags.ts", "Branches the checkout route on it"],
		tests: "covered",
		risk: "low",
		findings: [
			{
				path: "src/checkout/flags.ts",
				line: 12,
				category: "maintainability",
				severity: "info",
				title: "The flag default is defined in two places",
				body: "The default is `false` here and `true` in the server loader. One source avoids a layout flash on first render.",
			},
		],
	},
	{
		repo: "checkout",
		number: 201,
		title: "Rate limit checkout per customer",
		author: "ada-l",
		daysAgo: 10.8,
		merged: true,
		summary: "Adds a per customer token bucket on POST /checkout, 10 requests per minute.",
		keyChanges: ["Adds src/middleware/rate-limit.ts", "Returns 429 with Retry-After"],
		tests: "covered",
		risk: "medium",
		findings: [
			{
				path: "src/middleware/rate-limit.ts",
				line: 29,
				category: "performance",
				severity: "warn",
				title: "All guest checkouts share one bucket",
				body: "Guests have an empty customer id, so every guest checkout draws from the same bucket. At peak that is about 40 a minute and the 11th guest gets a 429. Key guests by session id.",
			},
		],
	},
	{
		repo: "web",
		number: 450,
		title: "Serve product images through the resize worker",
		author: "priya-dev",
		daysAgo: 11.0,
		merged: true,
		summary: "Routes product images through the resize worker and requests the width the layout needs.",
		keyChanges: ["Adds imageUrl in src/catalog/images.ts", "Uses srcset on product cards"],
		tests: "partial",
		risk: "low",
		findings: [
			{
				path: "src/catalog/images.ts",
				line: 57,
				category: "performance",
				severity: "warn",
				title: "The server side size probe has no timeout",
				body: "The loader awaits a HEAD request to the resize worker with no timeout. A slow origin holds the product page render until the 30 s platform limit.",
			},
		],
	},
	{
		repo: "payments",
		number: 86,
		title: "Log provider decline codes",
		author: "sofia-r",
		daysAgo: 11.6,
		summary: "Logs the provider decline code and reason on every declined charge.",
		keyChanges: ["Adds a warn log in services/payment-svc/src/charge.ts on decline"],
		tests: "not_needed",
		risk: "medium",
		findings: [
			{
				path: "services/payment-svc/src/charge.ts",
				line: 188,
				category: "security",
				checkId: "PII-03",
				severity: "warn",
				title: "The decline log carries the card's last four digits and the customer email",
				body: "The whole `charge` object is spread into the log attributes. Log `decline_code`, `provider` and the payment id only.",
			},
		],
	},
	{
		repo: "web",
		number: 447,
		title: "Store the guest cart in a signed cookie",
		author: "jtanaka",
		daysAgo: 12.1,
		fixedOnPush: true,
		merged: true,
		summary:
			"Keeps guest carts in a signed cookie instead of cart-svc, which removes a cart-svc call from every guest page view.",
		keyChanges: ["Adds src/cart/guest-cookie.ts", "Reads the cookie before falling back to cart-svc"],
		tests: "covered",
		risk: "medium",
		findings: [
			{
				path: "src/cart/guest-cookie.ts",
				line: 33,
				category: "security",
				severity: "critical",
				title: "The signature is compared with === instead of a constant time compare",
				body: "A string compare leaks timing. Use `crypto.timingSafeEqual` on the decoded buffers.",
			},
		],
	},
	{
		repo: "checkout",
		number: 198,
		title: "Cache shipping quotes for five minutes",
		author: "lena-h",
		daysAgo: 12.6,
		merged: true,
		summary: "Caches carrier shipping quotes per destination and weight band for five minutes.",
		keyChanges: ["Adds src/shipping/quote-cache.ts"],
		tests: "covered",
		risk: "low",
		findings: [
			{
				path: "src/shipping/quote-cache.ts",
				line: 18,
				category: "correctness",
				severity: "info",
				title: "The cache key does not include the carrier",
				body: "Only one carrier is enabled today, so this is fine now, but adding a second carrier would return the first carrier's quote.",
			},
		],
	},
	{
		repo: "web",
		number: 445,
		title: "Upgrade to React Router 8",
		author: "sofia-r",
		daysAgo: 12.9,
		outcome: { kind: "failed", error: "model_error: the provider returned 529 overloaded three times" },
	},
	{
		repo: "payments",
		number: 85,
		title: "Rename the charge status enum",
		author: "ada-l",
		daysAgo: 13.0,
		outcome: { kind: "skipped", reason: "superseded" },
		merged: true,
	},
	{
		repo: "web",
		number: 443,
		title: "Add structured logging to notification-svc",
		author: "devon-b",
		daysAgo: 13.4,
		merged: true,
		summary: "Replaces print calls in notification-svc with structlog and the OTel log handler.",
		keyChanges: [
			"Configures structlog in services/notification-svc/app/logging.py",
			"Converts the send path to structured fields",
		],
		tests: "not_needed",
		risk: "low",
		coverage: [
			[
				"send_receipt",
				"consumer",
				true,
				"Logs carry the trace id from the orders.created consumer span",
			],
		],
		findings: [
			{
				path: "services/notification-svc/app/send.py",
				line: 74,
				category: "observability",
				checkId: "LOG-01",
				severity: "info",
				title: "The template id is part of the message, not an attribute",
				body: '`log.info(f"sent {template_id}")` makes every template a distinct message. Pass `template_id` as a field so patterns group.',
			},
		],
	},
	// The weeks before: the team turning reviews on.
	{
		repo: "web",
		number: 431,
		title: "Add OpenTelemetry to the storefront server",
		author: "ada-l",
		daysAgo: 16.2,
		merged: true,
		summary: "Wires the OTel Node SDK into the storefront server with HTTP and fetch instrumentation.",
		keyChanges: ["Adds src/instrumentation.ts", "Sets service.name and deployment.environment"],
		tests: "not_needed",
		risk: "low",
	},
	{
		repo: "web",
		number: 428,
		title: "Introduce the cart-svc gRPC client",
		author: "jtanaka",
		daysAgo: 19.1,
		merged: true,
		summary: "Replaces the REST calls to cart-svc with a generated gRPC client.",
		keyChanges: ["Adds src/cart/grpc-client.ts"],
		tests: "covered",
		risk: "medium",
		findings: [
			{
				path: "src/cart/grpc-client.ts",
				line: 21,
				category: "performance",
				severity: "warn",
				title: "A new channel is opened per request",
				body: "`createChannel` runs inside the handler. Create it once at startup and reuse it, or every request pays a TLS handshake.",
			},
		],
	},
	{
		repo: "checkout",
		number: 190,
		title: "Move pricing to integer cents",
		author: "mkowalski",
		daysAgo: 21.0,
		fixedOnPush: true,
		merged: true,
		summary: "Stores and computes all prices in integer cents.",
		keyChanges: ["Converts src/pricing/*.ts to cents", "Adds a migration for the stored totals"],
		tests: "covered",
		risk: "high",
		findings: [
			{
				path: "src/pricing/discount.ts",
				line: 40,
				category: "correctness",
				severity: "warn",
				title: "Percentage discounts still round with Math.round on floats",
				body: "A 15 percent discount on 1999 cents gives 299.85 and rounds up, so the shopper pays one cent less than the receipt shows.",
			},
		],
	},
	{
		repo: "payments",
		number: 80,
		title: "Add charge status polling endpoint",
		author: "priya-dev",
		daysAgo: 23.3,
		merged: true,
		summary: "Adds GET /charges/{id} so the confirmation page can poll until a charge settles.",
		keyChanges: ["Adds services/payment-svc/src/routes/charge-status.ts"],
		tests: "covered",
		risk: "low",
		findings: [
			{
				path: "services/payment-svc/src/routes/charge-status.ts",
				line: 18,
				category: "observability",
				checkId: "SPAN-03",
				severity: "info",
				title: "Set payment.status on the server span",
				body: "The poll loop is the busiest route in payment-svc. The settled status on the span lets you split latency by outcome.",
			},
		],
	},
	{
		repo: "web",
		number: 420,
		title: "Add .maple/review.md",
		author: "lena-h",
		daysAgo: 25.4,
		notApplicable: true,
		merged: true,
		summary: "Adds the repository's review instructions. Nothing in the diff runs in production.",
	},
	{
		repo: "checkout",
		number: 186,
		title: "Move checkout-api to Node 24",
		author: "sofia-r",
		daysAgo: 27.2,
		outcome: { kind: "failed", error: "agent_error: the sandbox clone timed out" },
	},
]

const MODELS = [
	["anthropic/claude-sonnet-5.5", 6],
	["openai/gpt-6.1-sol", 3],
	["z-ai/glm-5.3-flash:nitro", 1],
] as const

// The featured PR: a retry rework that drops a span an alert reads, merged, then looked at in production.
const FEATURED = {
	repo: "web",
	number: 482,
	title: "Move checkout retries onto a queue consumer",
	author: "priya-dev",
	daysAgo: 1.3,
} as const

type Repo = RepoDef & {
	readonly id: VcsRepositoryId
	readonly fullName: string
	readonly htmlUrl: string
}

const buildWorld = (now: number) => {
	const rng = new Rng(482)
	const ids = new Rng(7_482)
	const toRepo = (def: RepoDef): Repo => ({
		...def,
		id: toRepositoryId(uuid(ids)),
		fullName: `acme/${def.name}`,
		htmlUrl: `https://github.com/acme/${def.name}`,
	})
	const byKey = {
		web: toRepo(REPOS.web),
		checkout: toRepo(REPOS.checkout),
		payments: toRepo(REPOS.payments),
		infra: toRepo(REPOS.infra),
	} satisfies Record<RepoKey, Repo>
	const repos = [byKey.web, byKey.checkout, byKey.payments, byKey.infra]
	const repoOf = (key: RepoKey) => byKey[key]
	const installationId = toInstallationId(uuid(ids))
	const sha = () => toSha(rng.hex(20))
	const model = () => rng.weighted([MODELS[0], MODELS[1], MODELS[2]])

	/** One review row; a report-less status leaves the report columns null. */
	const reviewRow = (input: {
		readonly repo: Repo
		readonly number: number
		readonly title: string
		readonly author: string
		readonly createdAt: number
		readonly status: "completed" | "failed" | "skipped" | "running"
		readonly report?: PrReviewReport
		readonly skipReason?: PrReviewSkipReason
		readonly error?: string
		readonly mergedAt: number | null
		readonly model?: string
		readonly telemetry?: PrReviewTelemetry
	}) => {
		const id = toReviewId(uuid(ids))
		const headSha = sha()
		const startedAt = input.status === "skipped" ? null : input.createdAt + rng.int(4, 20) * 1000
		const runSeconds = rng.int(60, 360)
		const finishedAt =
			startedAt === null
				? input.createdAt + 2_000
				: input.status === "running"
					? null
					: startedAt + (input.status === "failed" ? rng.int(240, 900) : runSeconds) * 1000
		const ran = input.status !== "skipped"
		const url = `${input.repo.htmlUrl}/pull/${input.number}`
		const posted = input.status === "completed"
		const commentId = rng.int(2_400_000_000, 2_499_999_999)
		return {
			id,
			orgId,
			repositoryId: input.repo.id,
			number: input.number,
			headSha,
			baseSha: sha(),
			url,
			title: input.title,
			authorLogin: input.author,
			status: input.status,
			skipReason: input.skipReason ?? null,
			sessionId: ran ? `${DEMO_ORG}:pr-${id}` : null,
			reportJson: input.report ?? null,
			score: input.report === undefined ? null : scorePrReview(input.report).score,
			checkRunUrl: ran ? `${input.repo.htmlUrl}/runs/${rng.int(31_000_000_000, 31_999_999_999)}` : null,
			commentUrl: posted ? `${url}#issuecomment-${commentId}` : null,
			reviewUrl:
				posted && (input.report?.findings.length ?? 0) > 0
					? `${url}#pullrequestreview-${commentId + 17}`
					: null,
			error: input.error ?? null,
			model: ran ? (input.model ?? model()) : null,
			inputTokens: ran && input.status !== "running" ? rng.int(48_000, 420_000) : null,
			outputTokens: ran && input.status !== "running" ? rng.int(2_800, 16_000) : null,
			startedAt,
			finishedAt,
			mergedAt: input.mergedAt,
			telemetryJson: input.telemetry ?? null,
			createdAt: input.createdAt,
			updatedAt: finishedAt ?? input.createdAt,
		}
	}
	type ReviewRow = ReturnType<typeof reviewRow>

	/** The report as the service stores it: handles set, confidence computed and capped. */
	const settle = (fields: ConstructorParameters<typeof PrReviewReport>[0], reason?: string) => {
		const draft = new PrReviewReport(fields)
		const confidence = confidencePrReview(draft)
		if (confidence === undefined) return draft
		const confidenceReason = confidence.capped ? confidence.reason : reason
		return new PrReviewReport({
			...fields,
			confidence: confidence.confidence,
			...(confidenceReason === undefined ? undefined : { confidenceReason }),
		})
	}

	const toFinding = (spec: FindingSpec, handle: string) =>
		new PrReviewFinding({
			path: spec.path,
			line: spec.line,
			category: spec.category,
			...(spec.checkId === undefined ? undefined : { checkId: spec.checkId }),
			severity: spec.severity,
			title: spec.title,
			body: spec.body,
			handle,
		})

	const findingRow = (input: {
		readonly review: ReviewRow
		readonly handle: string
		readonly spec: FindingSpec
		readonly status: PrReviewFindingStatus
		readonly resolvedSha: GitCommitSha | null
	}) => {
		const at = input.review.finishedAt ?? input.review.createdAt
		return {
			id: uuid(ids),
			orgId,
			repositoryId: input.review.repositoryId,
			number: input.review.number,
			reviewId: input.review.id,
			handle: input.handle,
			path: input.spec.path,
			line: input.spec.line,
			category: input.spec.category,
			severity: input.spec.severity,
			title: input.spec.title,
			status: input.status,
			commentId: input.spec.severity === "info" ? null : String(rng.int(1_900_000_000, 1_999_999_999)),
			resolvedSha: input.resolvedSha,
			reactionsUp:
				input.status === "dismissed"
					? 0
					: rng.weighted([
							[0, 3],
							[1, 4],
							[2, 2],
						]),
			reactionsDown:
				input.status === "dismissed"
					? 1
					: rng.weighted([
							[0, 9],
							[1, 1],
						]),
			createdAt: at,
			updatedAt: at,
		}
	}
	type FindingRow = ReturnType<typeof findingRow>

	const mergedAtFor = (spec: { readonly merged?: boolean }, lastReviewAt: number) =>
		spec.merged === true ? Math.min(lastReviewAt + rng.int(2, 30) * HOUR, now - 25 * MIN) : null

	const reportOf = (spec: PrSpec) =>
		settle({
			verdict: spec.notApplicable
				? "not_applicable"
				: (spec.findings ?? []).some((finding) => finding.severity !== "info")
					? "issues"
					: "clean",
			summary: spec.summary ?? "",
			...(spec.keyChanges === undefined ? undefined : { keyChanges: spec.keyChanges }),
			...(spec.confidence === undefined ? undefined : { confidence: spec.confidence }),
			...(spec.checked === undefined ? undefined : { checked: spec.checked }),
			...(spec.tests === undefined ? undefined : { tests: spec.tests }),
			...(spec.risk === undefined ? undefined : { risk: spec.risk }),
			coverage: (spec.coverage ?? []).map(
				([unit, kind, instrumented, evidence]) =>
					new PrReviewCoverageUnit({ unit, kind, instrumented, evidence }),
			),
			findings: (spec.findings ?? []).map((finding, index) => toFinding(finding, `F${index + 1}`)),
		})

	/** Every review and finding one spec produces. */
	const fromSpec = (
		spec: PrSpec,
	): { readonly reviews: ReadonlyArray<ReviewRow>; readonly findings: ReadonlyArray<FindingRow> } => {
		const repo = repoOf(spec.repo)
		const createdAt = Math.round(now - spec.daysAgo * DAY)
		const base = { repo, number: spec.number, title: spec.title, author: spec.author }
		if (spec.outcome !== undefined) {
			const outcome = spec.outcome
			const mergedAt = mergedAtFor(spec, createdAt)
			return {
				reviews: [
					reviewRow({
						...base,
						createdAt,
						status: outcome.kind,
						mergedAt,
						...(outcome.kind === "failed" ? { error: outcome.error } : undefined),
						...(outcome.kind === "skipped" ? { skipReason: outcome.reason } : undefined),
					}),
				],
				findings: [],
			}
		}
		const report = reportOf(spec)
		const fixAt = createdAt + rng.int(3, 9) * HOUR
		const mergedAt = mergedAtFor(spec, spec.fixedOnPush === true ? fixAt : createdAt)
		const supersededRow = spec.superseded
			? [
					reviewRow({
						...base,
						createdAt: createdAt - rng.int(4, 12) * MIN,
						status: "skipped",
						skipReason: "superseded",
						mergedAt,
					}),
				]
			: []
		const first = reviewRow({ ...base, createdAt, status: "completed", report, mergedAt })
		const fix =
			spec.fixedOnPush === true
				? reviewRow({
						...base,
						createdAt: fixAt,
						status: "completed",
						mergedAt,
						report: settle(
							{
								verdict: "clean",
								summary: `This push fixes ${report.findings
									.filter((finding) => finding.severity !== "info")
									.map((finding) => finding.handle ?? "")
									.join(" and ")} from the earlier review. Nothing new to flag.`,
								...(spec.tests === undefined ? undefined : { tests: spec.tests }),
								...(spec.risk === undefined ? undefined : { risk: spec.risk }),
								coverage: [],
								findings: [],
							},
							"The earlier findings are fixed at this head and the new code is covered.",
						),
					})
				: undefined
		return {
			reviews: [...supersededRow, first, ...(fix === undefined ? [] : [fix])],
			findings: (spec.findings ?? []).map((finding, index) =>
				findingRow({
					review: first,
					handle: `F${index + 1}`,
					spec: finding,
					status: finding.status ?? (fix === undefined ? "open" : "resolved"),
					resolvedSha:
						fix !== undefined && (finding.status ?? "resolved") === "resolved"
							? fix.headSha
							: null,
				}),
			),
		}
	}

	const buildFeatured = (repo: Repo) => {
		const createdAt = Math.round(now - FEATURED.daysAgo * DAY)
		const mergedAt = createdAt + 9 * HOUR + 12 * MIN
		const mergeCommitSha = rng.hex(20)
		const base = { repo, number: FEATURED.number, title: FEATURED.title, author: FEATURED.author }

		const telemetry = new PrReviewTelemetry({
			windowDays: 7,
			services: ["checkout-api", "payment-svc", "order-worker"],
			contractBreaks: [
				new PrReviewContractBreak({
					kind: "span",
					name: "checkout.retry.schedule",
					path: "services/checkout-api/src/retries/schedule.ts",
					line: 37,
					references: [
						new PrReviewTelemetryReference({
							kind: "alert",
							id: "alr_checkout_retry_backlog",
							name: "Checkout retry backlog",
						}),
						new PrReviewTelemetryReference({
							kind: "dashboard",
							id: "dsh_checkout_health",
							name: "Checkout health",
						}),
					],
					perDay: 182_000,
				}),
			],
			hotFiles: [
				new PrReviewHotFile({
					path: "services/checkout-api/src/retries/schedule.ts",
					perDay: 182_000,
					operations: [
						new PrReviewOperationTraffic({
							service: "checkout-api",
							spanName: "checkout.retry.schedule",
							perDay: 182_000,
							errorRate: 0.011,
							p95Ms: 38,
						}),
					],
				}),
				new PrReviewHotFile({
					path: "services/checkout-api/src/routes/checkout.ts",
					perDay: 1_240_000,
					operations: [
						new PrReviewOperationTraffic({
							service: "checkout-api",
							spanName: "POST /checkout",
							perDay: 1_240_000,
							errorRate: 0.014,
							p95Ms: 612,
						}),
					],
				}),
				new PrReviewHotFile({
					path: "services/payment-svc/src/charge.ts",
					perDay: 1_180_000,
					operations: [
						new PrReviewOperationTraffic({
							service: "payment-svc",
							spanName: "POST /charges",
							perDay: 1_180_000,
							errorRate: 0.009,
							p95Ms: 455,
						}),
					],
				}),
			],
			linkedIssues: [
				new PrReviewLinkedIssue({
					issueId: "8d3f6a1e-2b47-4c90-9e15-7a6b0c2d4f81",
					fingerprintHash: "11893045522017746120",
					title: "TimeoutError: retry budget exhausted in scheduleRetry",
					service: "checkout-api",
					path: "services/checkout-api/src/retries/schedule.ts",
					topFrame: "scheduleRetry (services/checkout-api/src/retries/schedule.ts:52:11)",
					occurrences: 2_314,
					lastSeenAt: createdAt - 26 * MIN,
				}),
			],
			costNotes: [
				new PrReviewCostNote({
					path: "services/checkout-api/src/retries/queue-consumer.ts",
					line: 64,
					kind: "log",
					gbPerMonth: 41,
					note: "One info line with the job payload per retry attempt, at about 210,000 attempts a day.",
				}),
			],
			added: [
				new PrReviewTelemetryChange({
					kind: "span",
					name: "checkout.retry.consume",
					path: "services/checkout-api/src/retries/queue-consumer.ts",
					line: 41,
				}),
				new PrReviewTelemetryChange({
					kind: "attribute",
					name: "checkout.retry.attempt",
					path: "services/checkout-api/src/retries/queue-consumer.ts",
					line: 47,
				}),
				new PrReviewTelemetryChange({
					kind: "metric",
					name: "checkout.retry.queue.depth",
					path: "services/checkout-api/src/retries/metrics.ts",
					line: 12,
				}),
			],
			removed: [
				new PrReviewTelemetryChange({
					kind: "span",
					name: "checkout.retry.schedule",
					path: "services/checkout-api/src/retries/schedule.ts",
					line: 37,
					perDay: 182_000,
				}),
			],
		})

		const migration = new PrReviewMergeStep({
			kind: "migration",
			title: "Run 0042_checkout_retry_jobs.sql before the consumer deploys",
			subject: "services/checkout-api/migrations/0042_checkout_retry_jobs.sql",
			path: "services/checkout-api/migrations/0042_checkout_retry_jobs.sql",
			source: "diff",
		})
		const env = new PrReviewMergeStep({
			kind: "env",
			title: "Set CHECKOUT_RETRY_QUEUE_URL in production",
			subject: "CHECKOUT_RETRY_QUEUE_URL",
			path: "services/checkout-api/src/config.ts",
			line: 18,
			source: "diff",
		})
		const alert = new PrReviewMergeStep({
			kind: "manual",
			title: "Point the Checkout retry backlog alert at checkout.retry.consume",
			source: "reviewer",
		})
		const steps = [
			{ step: migration, done: true, doneBy: "priya-dev" },
			{ step: env, done: true, doneBy: "mkowalski" },
			{ step: alert, done: false, doneBy: undefined },
		].map(({ step, done, doneBy }) => ({ step, done, doneBy, key: mergeStepKey(step) }))

		const report = settle(
			{
				verdict: "issues",
				summary:
					"Replaces the in-process setTimeout retries in checkout-api with a queue consumer: a failed charge is written to checkout_retry_jobs and picked up by a consumer with exponential backoff, so retries survive a pod restart. The rework drops the checkout.retry.schedule span that an alert and a dashboard read, and adds a per-attempt log line that is expensive at this volume.",
				keyChanges: [
					"Adds a retry queue consumer in services/checkout-api/src/retries/queue-consumer.ts with backoff from 2 s to 5 min",
					"Deletes the setTimeout scheduler in schedule.ts and enqueues a job row instead",
					"Adds the checkout_retry_jobs table and a dead letter topic after 5 attempts",
					"Emits a checkout.retry.consume span per attempt and a queue depth gauge",
				],
				checked: [
					"Enqueue and consume share the order's idempotency key, so a redelivered job cannot double charge",
					"The consumer acks only after the charge result is stored, so a crash mid attempt is retried",
					"Open errors in schedule.ts are the timeouts this change removes, not new ones",
				],
				tests: "covered",
				risk: "medium",
				confidence: 4,
				coverage: [
					new PrReviewCoverageUnit({
						unit: "RetryQueueConsumer.handle",
						kind: "consumer",
						instrumented: true,
						evidence:
							"Starts checkout.retry.consume with checkout.retry.attempt and the order id",
					}),
					new PrReviewCoverageUnit({
						unit: "enqueueRetry",
						kind: "function",
						instrumented: true,
						evidence: "Runs inside the POST /checkout server span and records the job id",
					}),
					new PrReviewCoverageUnit({
						unit: "sendToDeadLetter",
						kind: "function",
						instrumented: true,
						evidence:
							"Increments checkout.retry.dead_lettered with the failure reason before publishing to checkout.retries.dlq",
					}),
				],
				findings: FEATURED_FINDINGS.map((finding, index) => toFinding(finding, `F${index + 1}`)),
				telemetry,
				beforeMerge: steps.map(
					({ step, done, doneBy, key }) =>
						new PrReviewMergeStep({
							...step,
							key,
							done,
							...(doneBy === undefined ? undefined : { doneBy }),
						}),
				),
			},
			"The queue rework is sound and tested. The dropped span, which an alert and a dashboard still read, is what holds this at 4.",
		)

		const superseded = reviewRow({
			...base,
			createdAt: createdAt - 7 * MIN,
			status: "skipped",
			skipReason: "superseded",
			mergedAt,
		})
		const review = reviewRow({
			...base,
			createdAt,
			status: "completed",
			report,
			mergedAt,
			model: "anthropic/claude-sonnet-5.5",
			telemetry,
		})
		const firstSeen = mergedAt + 23 * MIN
		const postMerge = new PrReviewPostMerge({
			deploy: {
				service: "checkout-api",
				environment: "production",
				commitSha: mergeCommitSha,
				firstSeen: DateTime.makeUnsafe(firstSeen),
				exact: true,
			},
			windowMinutes: 60,
			operations: [
				new PrReviewPostMergeOperation({
					service: "checkout-api",
					spanName: "POST /checkout",
					before: { perHour: 51_400, errorRate: 0.014, p95Ms: 612 },
					after: { perHour: 52_100, errorRate: 0.006, p95Ms: 431 },
					regressed: false,
				}),
				new PrReviewPostMergeOperation({
					service: "checkout-api",
					spanName: "checkout.retry.consume",
					before: { perHour: 0, errorRate: 0, p95Ms: 0 },
					after: { perHour: 8_700, errorRate: 0.004, p95Ms: 212 },
					regressed: false,
				}),
			],
			newIssues: [],
			linkedIssues: [
				new PrReviewPostMergeIssue({
					issueId: "8d3f6a1e-2b47-4c90-9e15-7a6b0c2d4f81",
					title: "TimeoutError: retry budget exhausted in scheduleRetry",
					service: "checkout-api",
					beforePerHour: 14,
					afterPerHour: 0,
				}),
			],
			missing: ["checkout.retry.schedule"],
			verdict: "regressed",
		})

		return {
			review,
			reviews: [
				superseded,
				{
					...review,
					mergeCommitSha,
					postMergeStatus: "reported" as const,
					postMergeAfter: null,
					postMergeJson: encodePostMerge(postMerge),
					updatedAt: firstSeen + 61 * MIN,
				},
			],
			findings: FEATURED_FINDINGS.map((finding, index) =>
				findingRow({
					review,
					handle: `F${index + 1}`,
					spec: finding,
					status: finding.status,
					resolvedSha: null,
				}),
			),
			mergeSteps: steps.map(({ step, done, doneBy, key }) => ({
				id: uuid(rng),
				orgId,
				repositoryId: repo.id,
				number: FEATURED.number,
				key,
				kind: step.kind,
				title: step.title,
				source: step.source,
				path: step.path ?? null,
				status: done ? ("done" as const) : ("open" as const),
				doneBy: doneBy ?? null,
				doneAt: done ? createdAt + rng.int(1, 6) * HOUR : null,
				remindedAt: done ? null : mergedAt,
				firstReviewId: review.id,
				lastReviewId: review.id,
				createdAt: review.finishedAt ?? createdAt,
				updatedAt: review.finishedAt ?? createdAt,
			})),
		}
	}

	const built = SPECS.map(fromSpec)
	const featured = buildFeatured(repoOf(FEATURED.repo))

	return {
		installation: {
			id: installationId,
			orgId,
			provider: "github" as const,
			externalInstallationId: "60482113",
			accountLogin: "acme",
			accountType: "organization" as const,
			externalAccountId: "182730551",
			accountAvatarUrl: null,
			repositorySelection: "selected" as const,
			status: "active" as const,
			suspendedAt: null,
			ciTracesEnabled: true,
			installedByUserId: Schema.decodeUnknownSync(UserId)("user_3AcmeShopDemoAdmin0000000"),
			createdAt: now - 41 * DAY,
			updatedAt: now - 41 * DAY,
		},
		repositories: repos.map((repo) => ({
			id: repo.id,
			orgId,
			provider: "github" as const,
			installationId,
			externalRepoId: repo.externalId,
			owner: "acme",
			name: repo.name,
			fullName: repo.fullName,
			defaultBranch: "main",
			trackedBranch: "main",
			htmlUrl: repo.htmlUrl,
			isPrivate: true,
			isArchived: false,
			status: "active" as const,
			syncStatus: "ready" as const,
			lastSyncedAt: now - rng.int(3, 40) * MIN,
			lastSyncError: null,
			prReviewEnabled: repo.reviewed,
			prReviewConfig: repo.config,
			createdAt: now - 41 * DAY,
			updatedAt: now - 2 * DAY,
		})),
		branches: repos.flatMap((repo) =>
			["main", ...(repo.key === "web" ? ["release/2026.10"] : [])].map((name) => ({
				id: toBranchId(uuid(ids)),
				orgId,
				provider: "github" as const,
				repositoryId: repo.id,
				name,
				isDefault: name === "main",
				headSha: sha(),
				createdAt: now - 41 * DAY,
				updatedAt: now - rng.int(1, 30) * HOUR,
			})),
		),
		reviews: [...built.flatMap((item) => item.reviews), ...featured.reviews],
		findings: [...built.flatMap((item) => item.findings), ...featured.findings],
		mergeSteps: featured.mergeSteps,
		featured: featured.review,
	}
}

const FEATURED_FINDINGS: ReadonlyArray<FindingSpec & { readonly status: PrReviewFindingStatus }> = [
	{
		path: "services/checkout-api/src/retries/schedule.ts",
		line: 37,
		category: "observability",
		checkId: "REN-01",
		severity: "critical",
		title: "Removes the checkout.retry.schedule span that the Checkout retry backlog alert reads",
		body: "`scheduleRetry` was the only place `checkout.retry.schedule` was started, and the new consumer starts `checkout.retry.consume` instead. The alert **Checkout retry backlog** and the **Checkout health** dashboard both count `checkout.retry.schedule`, which arrived 182,000 times a day over the last 7 days. After this merges the alert reads zero and can never fire. Keep the old name on the enqueue side, or move the alert and dashboard to the new span in the same change.",
		status: "open",
	},
	{
		path: "services/checkout-api/src/retries/queue-consumer.ts",
		line: 64,
		category: "observability",
		checkId: "LOG-02",
		severity: "warn",
		title: "The per-attempt info log adds about 41 GB of ingest a month",
		body: '`logger.info("retry attempt", { attempt, orderId, payload })` runs once per attempt, and the consumer handles about 210,000 attempts a day. With the serialized payload each line is about 6.5 KB. The attempt number is already on the span. Drop the log, or log at debug without the payload.',
		status: "dismissed",
	},
	{
		path: "services/checkout-api/src/retries/dead-letter.ts",
		line: 22,
		category: "tests",
		severity: "info",
		title: "No test covers the max attempts branch that sends a job to the dead letter queue",
		body: "The happy path and a single retry are tested. The branch that gives up after 5 attempts and publishes to `checkout.retries.dlq` is not, and it is the one that decides whether a customer's order is dropped.",
		status: "open",
	},
]

/** The URL's database must be the screenshot one; anything else is refused before a connection opens. */
const screenshotUrl = Effect.gen(function* () {
	const raw = yield* Config.String("MAPLE_PG_URL").pipe(
		Effect.mapError(
			() =>
				new SeedCodeReviewError({
					message: "MAPLE_PG_URL is not set; run with --env-file=.env.screenshots",
				}),
		),
	)
	const database = yield* Effect.try({
		try: () => decodeURIComponent(new URL(raw).pathname.replace(/^\//, "")),
		catch: () => new SeedCodeReviewError({ message: "MAPLE_PG_URL is not a valid URL" }),
	})
	if (database !== SCREENSHOT_DATABASE)
		return yield* new SeedCodeReviewError({
			message: `Refusing to seed database "${database}": only ${SCREENSHOT_DATABASE} may be written`,
		})
	return raw
})

const program = Effect.gen(function* () {
	const db = makeMapleDb(yield* SqlClient.SqlClient)
	const world = buildWorld(yield* Clock.currentTimeMillis)
	const byOrg = <T extends { readonly orgId: PG.Expr<OrgId> }>($: T) => [$.orgId.eq(orgId)]

	yield* db.transaction(
		Effect.gen(function* () {
			yield* db.run(PG.deleteFrom(PrReviewMergeSteps).where(byOrg))
			yield* db.run(PG.deleteFrom(PrReviewFindingEmbeddings).where(byOrg))
			yield* db.run(PG.deleteFrom(PrReviewFindings).where(byOrg))
			yield* db.run(PG.deleteFrom(PrReviewReplies).where(byOrg))
			yield* db.run(PG.deleteFrom(PrReviews).where(byOrg))
			yield* db.run(PG.deleteFrom(PrReviewSettings).where(byOrg))
			yield* db.run(PG.deleteFrom(VcsCommits).where(byOrg))
			yield* db.run(PG.deleteFrom(VcsRepositoryBranches).where(byOrg))
			yield* db.run(PG.deleteFrom(VcsRepositories).where(byOrg))
			yield* db.run(PG.deleteFrom(VcsInstallations).where(byOrg))
			yield* db.run(PG.deleteFrom(Sources).where(($) => [$.id.eq(DEMO_GITHUB_SOURCE)]))

			// The installation sends as its source, as the GitHub connect flow creates it.
			yield* db.run(
				PG.insertInto(Sources).values({
					id: DEMO_GITHUB_SOURCE,
					orgId,
					name: "GitHub acme",
					platform: "github",
					kind: "integration",
					createdAt: world.installation.createdAt,
					updatedAt: world.installation.createdAt,
				}),
			)
			yield* db.run(
				PG.insertInto(VcsInstallations).values([{ ...world.installation, sourceId: DEMO_GITHUB_SOURCE }]),
			)
			yield* db.run(PG.insertInto(VcsRepositories).values(world.repositories))
			yield* db.run(PG.insertInto(VcsRepositoryBranches).values(world.branches))
			yield* db.run(
				PG.insertInto(PrReviewSettings).values([
					{
						orgId,
						model: "anthropic/claude-sonnet-5.5",
						defaults: new PrReviewRepositoryConfig({
							ignorePaths: ["*.snap", "**/generated/**", "pnpm-lock.yaml"],
							postMergeCheck: true,
						}),
						updatedAt: world.installation.createdAt,
						updatedBy: null,
					},
				]),
			)
			yield* db.run(PG.insertInto(PrReviews).values(world.reviews))
			yield* db.run(PG.insertInto(PrReviewFindings).values(world.findings))
			yield* db.run(PG.insertInto(PrReviewMergeSteps).values(world.mergeSteps))
		}),
	)

	const repo = world.repositories.find((row) => row.id === world.featured.repositoryId)
	yield* Console.log(
		[
			`seeded code review for ${DEMO_ORG}: 1 installation, ${world.repositories.length} repositories, ${world.reviews.length} reviews, ${world.findings.length} findings, ${world.mergeSteps.length} merge steps`,
			`featured: ${repo?.fullName ?? ""} #${world.featured.number} "${FEATURED.title}"`,
			`  review id ${world.featured.id}`,
			`  /code-review/pull-requests?review=${world.featured.id}`,
		].join("\n"),
	)
})

const Driver = Layer.unwrap(
	Effect.map(screenshotUrl, (url) =>
		PgClient.layer({ url: Redacted.make(url), maxConnections: 2, prepare: false }),
	),
)

// oxlint-disable-next-line effecttsgo/strict-effect-provide
program.pipe(Effect.provide(Driver), NodeRuntime.runMain)
