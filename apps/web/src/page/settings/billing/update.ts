import {
	AttachRequest,
	type BillingAccount,
	type BillingCustomer,
	BillingLinkRejectedError,
	type BillingProfile,
	BillingNotConfiguredError,
	CustomerPortalRequest,
	LinkBillingOrgRequest,
} from "@maple/domain/http"
import { OrgId } from "@maple/domain"
import {
	buildCheckoutSuccessUrl,
	CHECKOUT_CONFIRM_POLL_MS,
	CHECKOUT_CONFIRM_TIMEOUT_MS,
} from "../../../lib/billing/checkout-return"
import { hasSelectedPlan } from "../../../lib/billing/plan-gating"
import {
	parseCapInput,
	spendLimitFor,
	uncappedFeatures,
	updateFeatureControls,
} from "../../../lib/billing/controls"
import { buildSpendModel, SPEND_FEATURES, type SpendModel } from "../../../lib/billing/spend"
import { NetworkErrorBody } from "@maple/web-data/lib/error-messages"
import { Cause, Clock, Duration, Effect, Option, Result, Schema } from "effect"
import { AsyncData, Command, Dom } from "foldkit"
import * as Chart from "../../../charts/chart"
import { trackProduct } from "../../../data/analytics"
import { toLoadFailure } from "../../../data/load-failure"
import { MapleApiClient, MapleApiV2Client, MapleInternalApiClient } from "../../../platform/api-clients"
import { currentClerkUser } from "../../../platform/clerk"
import * as Dialog from "../../../ui/dialog"
import { PageOutMessage, type PageReturn } from "../../contract"
import { revisitData } from "../kit/revisit"
import * as Details from "./details/update"
import { CAP_INPUT_ID, Message, type Model, type OrgChoice, SpendFeatureId } from "./model"

type Return = PageReturn<Model, Message>

/**
 * A step plus whether the settings page's customer must be read again (`BILLING_CUSTOMER_KEY`),
 * and where a checkout return stands: a poll re-reads only the page's copy, a confirmed plan
 * refreshes the app's customer once, and a settled return drops `checkout=complete` (replace).
 */
export type Step = Readonly<{
	step: Return
	isCustomerStale: boolean
	checkout?: "Polled" | "Confirmed" | "TimedOut"
}>

// READS

// A defect settles the slot as a failure too; otherwise the message never arrives and it shimmers forever.
const loaded =
	<A, B>(toMessage: (result: Result.Result<A, ReturnType<typeof toLoadFailure>>) => B) =>
	<E, R>(effect: Effect.Effect<A, E, R>) =>
		effect.pipe(
			Effect.catchDefect((defect) => Effect.fail(defect)),
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map(toMessage),
		)

/** Usage and plans gate every spend view: still pending after this, they read as unreachable. */
const READ_TIMEOUT = Duration.seconds(10)

const withinDeadline = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	Effect.timeoutOrElse(effect, { duration: READ_TIMEOUT, orElse: () => Effect.fail(NetworkErrorBody) })

const FetchPlans = Command.define("FetchBillingPlans", {
	messages: [Message.CompletedFetchPlans],
	execute: Effect.flatMap(MapleApiClient, (client) => client.billingPublic.listPlans()).pipe(
		Effect.map((response) => response.plans),
		withinDeadline,
		loaded((result) => Message.CompletedFetchPlans({ result })),
	),
})

/** The five metered features over the current cycle (the API resolves the window). */
const FetchUsage = Command.define("FetchBillingUsage", {
	messages: [Message.CompletedFetchUsage],
	execute: Effect.flatMap(MapleInternalApiClient, (client) =>
		client.billing.getUsage({ query: { featureId: [...SPEND_FEATURES] } }),
	).pipe(
		withinDeadline,
		loaded((result) => Message.CompletedFetchUsage({ result })),
	),
})

/**
 * `SpendChartError` renders `dailySpendResult.cause` as the unexpected body (a retry button), so
 * the slot keeps that body too.
 */
const FetchDaily = Command.define("FetchBillingDailySpend", {
	messages: [Message.CompletedFetchDaily],
	execute: Effect.flatMap(MapleInternalApiClient, (client) => client.billing.getDailySpend()).pipe(
		Effect.mapError((error) => toLoadFailure(Cause.die(error))),
		Effect.result,
		Effect.map((result) => Message.CompletedFetchDaily({ result })),
	),
})

const FetchInvoices = Command.define("FetchBillingInvoices", {
	messages: [Message.CompletedFetchInvoices],
	execute: Effect.flatMap(MapleInternalApiClient, (client) => client.billing.listInvoices()).pipe(
		Effect.map((response) => response.invoices),
		loaded((result) => Message.CompletedFetchInvoices({ result })),
	),
})

const isNotConfigured = Schema.is(BillingNotConfiguredError)

/** A self-hosted API without Stripe answers every profile read with `BillingNotConfiguredError`. */
const FetchProfile = Command.define("FetchBillingProfile", {
	messages: [Message.CompletedFetchProfile],
	execute: Effect.flatMap(MapleInternalApiClient, (client) => client.billing.getBillingProfile()).pipe(
		// Like `loaded`: a defect must still settle the read, or the details shimmer forever.
		Effect.catchDefect((defect) => Effect.fail(defect)),
		Effect.mapError((error) => ({
			isNotConfigured: isNotConfigured(error),
			failure: toLoadFailure(error),
		})),
		Effect.result,
		Effect.map((result) => Message.CompletedFetchProfile({ result })),
	),
})

/** The stats endpoint reads at most 62 days back. */
const RULE_STATS_MAX_MS = 62 * 24 * 60 * 60 * 1000

/** Bytes ingest rules dropped, from the cycle start to now. */
const FetchRuleStats = Command.define("FetchBillingRuleStats", {
	args: { startMs: Schema.Number },
	messages: [Message.CompletedFetchRuleStats],
	execute: ({ startMs }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			const nowMs = yield* Clock.currentTimeMillis
			const start = new Date(Math.max(startMs, nowMs - RULE_STATS_MAX_MS)).toISOString()
			return yield* client.ingestRules.stats({
				query: { start_time: start, end_time: new Date(nowMs).toISOString() },
			})
		}).pipe(loaded((result) => Message.CompletedFetchRuleStats({ result }))),
})

/** Which org pays for this one: it decides what else the tab may read. */
const FetchAccount = Command.define("FetchBillingAccount", {
	messages: [Message.CompletedFetchAccount],
	execute: Effect.flatMap(MapleInternalApiClient, (client) => client.billing.getBillingAccount()).pipe(
		withinDeadline,
		loaded((result) => Message.CompletedFetchAccount({ result })),
	),
})

const FetchAccountUsage = Command.define("FetchBillingAccountUsage", {
	messages: [Message.CompletedFetchAccountUsage],
	execute: Effect.flatMap(MapleInternalApiClient, (client) => client.billing.getBillingAccountUsage()).pipe(
		loaded((result) => Message.CompletedFetchAccountUsage({ result })),
	),
})

/** The viewer's other orgs where they are an admin: linking needs admin on both sides. */
const FetchOrgChoices = Command.define("FetchBillingOrgChoices", {
	messages: [Message.CompletedFetchOrgChoices],
	execute: currentClerkUser.pipe(
		Effect.map((user): ReadonlyArray<OrgChoice> => {
			const activeId = window.Clerk?.organization?.id
			return (user.organizationMemberships ?? [])
				.filter(
					(membership) =>
						membership.role === "org:admin" && membership.organization.id !== activeId,
				)
				.map(({ organization }) => ({
					orgId: OrgId.make(organization.id),
					name: organization.name,
					imageUrl: organization.hasImage ? (organization.imageUrl ?? "") : "",
				}))
				.toSorted((a, b) => a.name.localeCompare(b.name))
		}),
		loaded((result) => Message.CompletedFetchOrgChoices({ result })),
	),
})

const isLinkRejected = Schema.is(BillingLinkRejectedError)

/** A refusal keeps the server's sentence for the person who asked; anything else is a plain failure. */
/** Above the server's 10s budget for cancelling the org's own plans, plus a wait on the link lock. */
const LINK_TIMEOUT = Duration.seconds(30)

const withinLinkDeadline = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	Effect.timeoutOrElse(effect, { duration: LINK_TIMEOUT, orElse: () => Effect.fail(NetworkErrorBody) })

const toLinkFailure = (error: unknown) => ({
	rejection: isLinkRejected(error) ? error.message : null,
	failure: toLoadFailure(error),
})

const Link = Command.define("LinkBillingOrg", {
	args: { billingOrgId: OrgId, orgName: Schema.String },
	messages: [Message.CompletedLink],
	execute: ({ billingOrgId, orgName }) =>
		Effect.flatMap(MapleInternalApiClient, (client) =>
			client.billing.linkBillingOrg({ payload: new LinkBillingOrgRequest({ billingOrgId }) }),
		).pipe(
			withinLinkDeadline,
			Effect.catchDefect((defect) => Effect.fail(defect)),
			Effect.mapError(toLinkFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedLink({ orgName, result })),
		),
})

const Unlink = Command.define("UnlinkBillingOrg", {
	args: { orgId: OrgId, isSelf: Schema.Boolean },
	messages: [Message.CompletedUnlink],
	execute: ({ orgId, isSelf }) =>
		Effect.flatMap(MapleInternalApiClient, (client) =>
			client.billing.unlinkBillingOrg({ params: { orgId } }),
		).pipe(
			withinLinkDeadline,
			Effect.catchDefect((defect) => Effect.fail(defect)),
			Effect.mapError(toLinkFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedUnlink({ isSelf, result })),
		),
})

// WRITES

/** `openCustomerPortal({ returnUrl: window.location.href })`. */
const OpenPortal = Command.define("OpenBillingPortal", {
	messages: [Message.CompletedOpenPortal],
	execute: Effect.flatMap(MapleInternalApiClient, (client) =>
		client.billing.openCustomerPortal({
			payload: new CustomerPortalRequest({ returnUrl: window.location.href }),
		}),
	).pipe(loaded((result) => Message.CompletedOpenPortal({ result }))),
})

/** Checkout and the portal leave the app. */
const Redirect = Command.define("RedirectToBilling", {
	args: { url: Schema.String },
	messages: [Message.CompletedRedirect],
	execute: ({ url }) =>
		Effect.sync(() => {
			window.location.href = url
			return Message.CompletedRedirect()
		}),
})

const SaveCap = Command.define("UpdateBillingControls", {
	args: { featureId: SpendFeatureId, label: Schema.String, overageLimit: Schema.NullOr(Schema.Number) },
	messages: [Message.CompletedSaveCap],
	execute: ({ featureId, label, overageLimit }) =>
		Effect.flatMap(MapleInternalApiClient, (client) =>
			client.billing.updateBillingControls({
				payload: updateFeatureControls({ featureId, overageLimit }),
			}),
		).pipe(loaded((result) => Message.CompletedSaveCap({ featureId, label, result }))),
})

const Attach = Command.define("AttachBillingPlan", {
	args: { planId: Schema.String },
	messages: [Message.CompletedAttach],
	execute: ({ planId }) =>
		Effect.flatMap(MapleInternalApiClient, (client) =>
			client.billing.attach({
				payload: new AttachRequest({
					planId,
					successUrl: buildCheckoutSuccessUrl(window.location.href),
				}),
			}),
		).pipe(loaded((result) => Message.CompletedAttach({ planId, result }))),
})

/** `CHECKOUT_CONFIRM_POLL_MS`: the customer is re-read this often while confirming. */
const WaitCheckoutPoll = Command.define("WaitBillingCheckoutPoll", {
	messages: [Message.ElapsedCheckoutPoll],
	execute: Effect.sleep(Duration.millis(CHECKOUT_CONFIRM_POLL_MS)).pipe(
		Effect.as(Message.ElapsedCheckoutPoll()),
	),
})

/** `CHECKOUT_CONFIRM_TIMEOUT_MS`: then the wait gives up with the timed-out notice. */
const WaitCheckoutTimeout = Command.define("WaitBillingCheckoutTimeout", {
	messages: [Message.ElapsedCheckoutTimeout],
	execute: Effect.sleep(Duration.millis(CHECKOUT_CONFIRM_TIMEOUT_MS)).pipe(
		Effect.as(Message.ElapsedCheckoutTimeout()),
	),
})

/** `plan_checkout_started` and `plan_checkout_returned` (apps/web/src/lib/analytics.ts). */
const TrackCheckout = Command.define("TrackBillingCheckout", {
	args: {
		event: Schema.Literals(["plan_checkout_started", "plan_checkout_returned"]),
		props: Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Boolean])),
	},
	messages: [Message.CompletedTrackProduct],
	execute: ({ event, props }) =>
		trackProduct(event, props).pipe(Effect.as(Message.CompletedTrackProduct())),
})

/** `usageRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })`. */
const ScrollToUsage = Command.define("ScrollToBillingUsage", {
	messages: [Message.CompletedScrollToUsage],
	execute: Effect.sync(() => {
		document.getElementById(USAGE_HEADING_ID)?.closest("section")?.parentElement?.scrollIntoView({
			behavior: "smooth",
			block: "start",
		})
		return Message.CompletedScrollToUsage()
	}),
})

export const USAGE_HEADING_ID = "settings-billing-usage"

/** The cap editor's input takes focus as it opens (`autoFocus`). */
const FocusCap = Command.define("FocusBillingCapInput", {
	messages: [Message.CompletedFocusCap],
	execute: Dom.focus(`#${CAP_INPUT_ID}`).pipe(Effect.ignore, Effect.as(Message.CompletedFocusCap())),
})

// DERIVED

/** One spend model feeds every figure, so no two numbers on the tab can disagree. */
export const spendModelOf = (
	model: Model,
	customer: BillingCustomer | null,
	nowMs: number,
): SpendModel | null =>
	buildSpendModel({
		customer: customer ?? undefined,
		plans: AsyncData.getOrElse(model.plans, () => undefined),
		usage: AsyncData.getOrElse(
			AsyncData.map(model.usage, (usage) => usage.total),
			() => undefined,
		),
		nowMs,
	})

export const profileOf = (model: Model): Option.Option<BillingProfile> => AsyncData.getData(model.profile)

// UPDATE

/**
 * `isReturning`: the tab opened with `?checkout=complete`, so it waits on the Stripe to Autumn sync.
 * Invoices and details wait for the account: a member org's billing lives on its billing org.
 */
export const init = (isAdmin: boolean, isReturning: boolean, isClerk: boolean): Return => ({
	model: {
		isAdmin,
		isClerk,
		checkoutReturn: isReturning ? "Confirming" : "Idle",
		plans: AsyncData.Loading(),
		usage: AsyncData.Loading(),
		daily: AsyncData.Loading(),
		invoices: AsyncData.Idle(),
		profile: AsyncData.Idle(),
		ruleStats: AsyncData.Idle(),
		editingCap: null,
		capDraft: "",
		isSavingCap: false,
		isBreakdownOpen: true,
		isOpeningPortal: false,
		compareDialog: Dialog.init("billing-compare", "dialog"),
		attaching: null,
		details: Details.init(),
		themeColors: null,
		chart: Chart.init(),
		account: AsyncData.Loading(),
		accountUsage: AsyncData.Idle(),
		orgChoices: AsyncData.Idle(),
		linkOrgId: null,
		linkDialog: Dialog.init("billing-link", "alert-dialog"),
		isLinking: false,
		linkRejection: null,
		unlinkOrgId: null,
		unlinkDialog: Dialog.init("billing-unlink", "alert-dialog"),
		isUnlinking: false,
	},
	commands: [
		FetchPlans(),
		FetchUsage(),
		FetchDaily(),
		FetchAccount(),
		...(isReturning ? [WaitCheckoutPoll(), WaitCheckoutTimeout()] : []),
	],
})

const toast = (type: "success" | "error", title: string, description = "") =>
	PageOutMessage.RequestedToast({ type, title, description })

const same = (step: Return): Step => ({ step, isCustomerStale: false })
const staleCustomer = (step: Return): Step => ({ step, isCustomerStale: true })

const revalidate = <A, E>(data: AsyncData.AsyncData<A, E>) =>
	Option.getOrElse(AsyncData.revalidate(data), () => data)

const liftCompare = (model: Model, step: ReturnType<typeof Dialog.update>): Return => ({
	model: { ...model, compareDialog: step.model },
	commands: Command.mapMessages(step.commands ?? [], (message) =>
		Message.GotCompareDialogMessage({ message }),
	),
})

/** `CapEditor`'s draft starts from the cap on file. */
const openCap = (model: Model, featureId: SpendFeatureId, customer: BillingCustomer | null): Model => {
	const existing = spendLimitFor(customer ?? undefined, featureId)?.overageLimit
	return { ...model, editingCap: featureId, capDraft: existing === undefined ? "" : String(existing) }
}

const saveCap = (model: Model, customer: BillingCustomer | null, nowMs: number): Return => {
	const featureId = model.editingCap
	const parsed = parseCapInput(model.capDraft)
	if (featureId === null || !parsed.valid || model.isSavingCap) return { model }
	const label =
		spendModelOf(model, customer, nowMs)?.features.find((feature) => feature.featureId === featureId)
			?.label ?? ""
	return {
		model: { ...model, isSavingCap: true },
		commands: [SaveCap({ featureId, label, overageLimit: parsed.cap })],
	}
}

/** `revisitData` for a read the account gates: one never asked for stays unasked. */
const revisitIfRead = <A, E, C>(data: AsyncData.AsyncData<A, E>, read: () => C) =>
	AsyncData.isIdle(data) ? { data, commands: [] } : revisitData(data, read)

/** Back on the tab: plans, usage, spend, invoices and details stay up while they load again. */
export const revisit = (model: Model): Return => {
	const plans = revisitData(model.plans, FetchPlans)
	const usage = revisitData(model.usage, FetchUsage)
	const daily = revisitData(model.daily, FetchDaily)
	const account = revisitData(model.account, FetchAccount)
	const invoices = revisitIfRead(model.invoices, FetchInvoices)
	const profile = revisitIfRead(model.profile, FetchProfile)
	const accountUsage = revisitIfRead(model.accountUsage, FetchAccountUsage)
	return {
		model: {
			...model,
			plans: plans.data,
			usage: usage.data,
			daily: daily.data,
			account: account.data,
			invoices: invoices.data,
			profile: profile.data,
			accountUsage: accountUsage.data,
			// Back to idle so the settings page asks again for the current cycle; this is also the retry.
			ruleStats: AsyncData.Idle(),
		},
		commands: [
			...plans.commands,
			...usage.commands,
			...daily.commands,
			...account.commands,
			...invoices.commands,
			...profile.commands,
			...accountUsage.commands,
		],
	}
}

/** A gated read: started when the account allows it and it is not already up, dropped when not. */
const gated = <A, E, C>(
	data: AsyncData.AsyncData<A, E>,
	isWanted: boolean,
	isFresh: boolean,
	read: () => C,
): { data: AsyncData.AsyncData<A, E>; commands: ReadonlyArray<C> } => {
	if (!isWanted) return { data: AsyncData.Idle(), commands: [] }
	if (AsyncData.isIdle(data) || AsyncData.isFailure(data))
		return { data: AsyncData.Loading(), commands: [read()] }
	return isFresh ? { data: revalidate(data), commands: [read()] } : { data, commands: [] }
}

/** The account settled: start the reads its role allows. `isFresh` re-reads ones already loaded (after a link change). */
const applyAccount = (model: Model, account: BillingAccount, isFresh: boolean): Return => {
	const isMember = account.role === "member"
	const invoices = gated(model.invoices, !isMember, isFresh, FetchInvoices)
	const profile = gated(model.profile, !isMember, isFresh, FetchProfile)
	const accountUsage = gated(
		model.accountUsage,
		account.role === "billing_org" && account.members.length > 0,
		isFresh,
		FetchAccountUsage,
	)
	const orgChoices = gated(
		model.orgChoices,
		account.role === "standalone" && model.isAdmin && model.isClerk,
		false,
		FetchOrgChoices,
	)
	return {
		model: {
			...model,
			account: AsyncData.Success({ data: account }),
			invoices: invoices.data,
			profile: profile.data,
			accountUsage: accountUsage.data,
			orgChoices: orgChoices.data,
		},
		commands: [
			...invoices.commands,
			...profile.commands,
			...accountUsage.commands,
			...orgChoices.commands,
		],
	}
}

export const accountOf = (model: Model): BillingAccount | null =>
	AsyncData.getOrElse(model.account, () => null)

const liftLinkDialog = (model: Model, step: ReturnType<typeof Dialog.update>): Return => ({
	model: { ...model, linkDialog: step.model },
	commands: Command.mapMessages(step.commands ?? [], (message) =>
		Message.GotLinkDialogMessage({ message }),
	),
})

const liftUnlinkDialog = (model: Model, step: ReturnType<typeof Dialog.update>): Return => ({
	model: { ...model, unlinkDialog: step.model },
	commands: Command.mapMessages(step.commands ?? [], (message) =>
		Message.GotUnlinkDialogMessage({ message }),
	),
})

/** The org picked to pay for this one: the draft, else the first choice the select shows. */
export const linkTargetOf = (model: Model): OrgChoice | null => {
	const choices = AsyncData.getOrElse(model.orgChoices, () => [])
	return choices.find((choice) => choice.orgId === model.linkOrgId) ?? choices[0] ?? null
}

/** The account changed hands: the customer, its usage and spend are now another org's. */
const afterLinkChange = (model: Model, account: BillingAccount): Return => {
	const applied = applyAccount(
		{
			...model,
			plans: revalidate(model.plans),
			usage: revalidate(model.usage),
			daily: revalidate(model.daily),
			ruleStats: AsyncData.Idle(),
		},
		account,
		true,
	)
	return { ...applied, commands: [FetchPlans(), FetchUsage(), FetchDaily(), ...(applied.commands ?? [])] }
}

export const update = (
	model: Model,
	message: Message,
	customer: BillingCustomer | null,
	nowMs: number,
): Step =>
	Message.match<Step>(message, {
		CompletedFetchPlans: ({ result }) =>
			same({ model: { ...model, plans: AsyncData.settle(model.plans, result) } }),
		CompletedFetchUsage: ({ result }) =>
			same({ model: { ...model, usage: AsyncData.settle(model.usage, result) } }),
		CompletedFetchDaily: ({ result }) =>
			same({ model: { ...model, daily: AsyncData.settle(model.daily, result) } }),
		CompletedFetchInvoices: ({ result }) =>
			same({ model: { ...model, invoices: AsyncData.settle(model.invoices, result) } }),
		CompletedFetchProfile: ({ result }) =>
			same({ model: { ...model, profile: AsyncData.settle(model.profile, result) } }),
		CompletedFetchRuleStats: ({ result }) =>
			same({ model: { ...model, ruleStats: AsyncData.settle(model.ruleStats, result) } }),
		// The account error also stands in for failed usage or plans reads, so Retry reloads those too.
		ClickedRetryCustomer: () =>
			staleCustomer({
				model: {
					...model,
					...(AsyncData.isFailure(model.usage) && { usage: AsyncData.Loading() }),
					...(AsyncData.isFailure(model.plans) && { plans: AsyncData.Loading() }),
				},
				commands: [
					...(AsyncData.isFailure(model.usage) ? [FetchUsage()] : []),
					...(AsyncData.isFailure(model.plans) ? [FetchPlans()] : []),
				],
			}),
		ClickedRetryDaily: () =>
			same({ model: { ...model, daily: AsyncData.Loading() }, commands: [FetchDaily()] }),
		ClickedRetryInvoices: () =>
			same({ model: { ...model, invoices: AsyncData.Loading() }, commands: [FetchInvoices()] }),
		ClickedRetryProfile: () =>
			same({ model: { ...model, profile: AsyncData.Loading() }, commands: [FetchProfile()] }),
		ClickedManageBilling: () =>
			model.isOpeningPortal
				? same({ model })
				: same({ model: { ...model, isOpeningPortal: true }, commands: [OpenPortal()] }),
		CompletedOpenPortal: ({ result }) =>
			Result.match(result, {
				// The portal changes the customer, its eligibility and its invoices: read them again, then leave.
				onSuccess: ({ url }) =>
					staleCustomer({
						model: {
							...model,
							isOpeningPortal: false,
							plans: revalidate(model.plans),
							invoices: revalidate(model.invoices),
							daily: revalidate(model.daily),
						},
						commands: [FetchPlans(), FetchInvoices(), FetchDaily(), Redirect({ url })],
					}),
				onFailure: (error) =>
					same({
						model: { ...model, isOpeningPortal: false },
						outMessage: toast("error", error.message || "Couldn't open the billing portal."),
					}),
			}),
		CompletedRedirect: () => same({ model }),
		ClickedSetCaps: () => {
			if (model.isSavingCap) return same({ model })
			const spend = spendModelOf(model, customer, nowMs)
			const first = spend === null ? undefined : uncappedFeatures(spend, customer ?? undefined)[0]
			const opened =
				first === undefined
					? { ...model, editingCap: null }
					: openCap(model, Schema.decodeUnknownSync(SpendFeatureId)(first.featureId), customer)
			return same({
				model: opened,
				commands: [ScrollToUsage(), ...(opened.editingCap === null ? [] : [FocusCap()])],
			})
		},
		CompletedScrollToUsage: () => same({ model }),
		ClickedEditCap: ({ featureId }) =>
			same({ model: openCap(model, featureId, customer), commands: [FocusCap()] }),
		CompletedFocusCap: () => same({ model }),
		ChangedCap: ({ value }) => same({ model: { ...model, capDraft: value } }),
		PressedCapKey: ({ key }) =>
			key === "Enter"
				? same(saveCap(model, customer, nowMs))
				: // Cancel is disabled mid-save, so Escape must not close the editor either.
					key === "Escape" && !model.isSavingCap
					? same({ model: { ...model, editingCap: null } })
					: same({ model }),
		ClickedCancelCap: () => same({ model: { ...model, editingCap: null } }),
		ClickedSaveCap: () => same(saveCap(model, customer, nowMs)),
		CompletedSaveCap: ({ featureId, label, result }) =>
			Result.match(result, {
				onSuccess: () =>
					staleCustomer({
						model: {
							...model,
							isSavingCap: false,
							editingCap: model.editingCap === featureId ? null : model.editingCap,
							daily: revalidate(model.daily),
						},
						commands: [FetchDaily()],
						outMessage: toast("success", `${label} cap saved`),
					}),
				onFailure: (error) =>
					same({
						model: { ...model, isSavingCap: false },
						outMessage: toast("error", "The overage cap could not be saved.", error.message),
					}),
			}),
		ToggledBreakdown: () => same({ model: { ...model, isBreakdownOpen: !model.isBreakdownOpen } }),
		ClickedCompare: () => same(liftCompare(model, Dialog.open(model.compareDialog))),
		GotCompareDialogMessage: ({ message: child }) =>
			same(liftCompare(model, Dialog.update(model.compareDialog, child))),
		ClickedSubscribe: ({ planId }) =>
			model.attaching !== null
				? same({ model })
				: same({ model: { ...model, attaching: planId }, commands: [Attach({ planId })] }),
		CompletedAttach: ({ planId, result }) =>
			Result.match(result, {
				onSuccess: ({ paymentUrl }) =>
					// Keep the button busy through the redirect: a second click is a 409 from Autumn.
					paymentUrl !== undefined && paymentUrl !== null && paymentUrl !== ""
						? same({
								model,
								commands: [
									TrackCheckout({
										event: "plan_checkout_started",
										props: { plan_id: planId },
									}),
									Redirect({ url: paymentUrl }),
								],
							})
						: staleCustomer({
								model: {
									...model,
									attaching: null,
									plans: revalidate(model.plans),
									invoices: revalidate(model.invoices),
									daily: revalidate(model.daily),
								},
								commands: [FetchPlans(), FetchInvoices(), FetchDaily()],
								outMessage: toast("success", "Plan updated successfully"),
							}),
				onFailure: (error) =>
					same({
						model: { ...model, attaching: null },
						outMessage: toast("error", "Failed to update your plan", error.message),
					}),
			}),
		ElapsedCheckoutPoll: () =>
			model.checkoutReturn === "Confirming"
				? {
						step: { model, commands: [WaitCheckoutPoll()] },
						isCustomerStale: true,
						checkout: "Polled",
					}
				: same({ model }),
		ElapsedCheckoutTimeout: () =>
			model.checkoutReturn === "Confirming"
				? {
						step: {
							model: { ...model, checkoutReturn: "TimedOut" },
							commands: [
								TrackCheckout({
									event: "plan_checkout_returned",
									props: { confirmed: false },
								}),
							],
						},
						isCustomerStale: false,
						checkout: "TimedOut",
					}
				: same({ model }),
		CompletedTrackProduct: () => same({ model }),
		ClickedEditDetails: () => same(openDetails(model)),
		GotDetailsMessage: ({ message: child }) => {
			const { step, isProfileStale } = Details.update(model.details, child)
			return same({
				model: {
					...model,
					details: step.model,
					...(isProfileStale && { profile: revalidate(model.profile) }),
				},
				commands: [
					...Command.mapMessages(step.commands ?? [], (inner) =>
						Message.GotDetailsMessage({ message: inner }),
					),
					...(isProfileStale ? [FetchProfile()] : []),
				],
				outMessage: step.outMessage,
			})
		},
		CompletedFetchAccount: ({ result }) =>
			Result.match(result, {
				onSuccess: (account) => {
					const previous = accountOf(model)
					// A re-read after a failed link or unlink can find that it landed after all.
					const moved =
						previous !== null &&
						(previous.role !== account.role ||
							previous.billingOrg.orgId !== account.billingOrg.orgId)
					return moved
						? staleCustomer(afterLinkChange(model, account))
						: same(applyAccount(model, account, false))
				},
				onFailure: () =>
					same({ model: { ...model, account: AsyncData.settle(model.account, result) } }),
			}),
		CompletedFetchAccountUsage: ({ result }) =>
			same({ model: { ...model, accountUsage: AsyncData.settle(model.accountUsage, result) } }),
		CompletedFetchOrgChoices: ({ result }) =>
			same({ model: { ...model, orgChoices: AsyncData.settle(model.orgChoices, result) } }),
		ClickedRetryAccount: () =>
			same({ model: { ...model, account: AsyncData.Loading() }, commands: [FetchAccount()] }),
		ClickedRetryAccountUsage: () =>
			same({ model: { ...model, accountUsage: AsyncData.Loading() }, commands: [FetchAccountUsage()] }),
		ChangedLinkOrg: ({ value }) => {
			const choice = AsyncData.getOrElse(model.orgChoices, () => []).find((org) => org.orgId === value)
			return same({ model: { ...model, linkOrgId: choice?.orgId ?? null, linkRejection: null } })
		},
		ClickedLink: () =>
			linkTargetOf(model) === null || model.isLinking
				? same({ model })
				: same(liftLinkDialog({ ...model, linkRejection: null }, Dialog.open(model.linkDialog))),
		GotLinkDialogMessage: ({ message: child }) =>
			model.isLinking
				? same({ model })
				: same(liftLinkDialog(model, Dialog.update(model.linkDialog, child))),
		ClickedConfirmLink: () => {
			const target = linkTargetOf(model)
			return target === null || model.isLinking
				? same({ model })
				: same({
						model: { ...model, isLinking: true },
						commands: [Link({ billingOrgId: target.orgId, orgName: target.name })],
					})
		},
		CompletedLink: ({ orgName, result }) => {
			const closed = liftLinkDialog({ ...model, isLinking: false }, Dialog.close(model.linkDialog))
			return Result.match(result, {
				onSuccess: (account) => {
					const changed = afterLinkChange(closed.model, account)
					return staleCustomer({
						model: { ...changed.model, linkOrgId: null },
						commands: [...(closed.commands ?? []), ...(changed.commands ?? [])],
						outMessage: toast("success", `Now billed through ${orgName}`),
					})
				},
				// Either way, read where billing stands now: an unexplained failure may have landed
				// after all, and a rejection can mean another session changed the link.
				onFailure: ({ rejection, failure }) =>
					rejection === null
						? same({
								...closed,
								commands: [...(closed.commands ?? []), FetchAccount()],
								outMessage: toast(
									"error",
									"Couldn't change how this org is billed",
									failure.message,
								),
							})
						: same({
								model: { ...closed.model, linkRejection: rejection },
								commands: [...(closed.commands ?? []), FetchAccount()],
							}),
			})
		},
		ClickedUnlink: ({ orgId }) =>
			model.isUnlinking
				? same({ model })
				: same(liftUnlinkDialog({ ...model, unlinkOrgId: orgId }, Dialog.open(model.unlinkDialog))),
		GotUnlinkDialogMessage: ({ message: child }) =>
			model.isUnlinking
				? same({ model })
				: same(liftUnlinkDialog(model, Dialog.update(model.unlinkDialog, child))),
		ClickedConfirmUnlink: () => {
			const account = accountOf(model)
			const orgId = model.unlinkOrgId
			if (account === null || orgId === null || model.isUnlinking) return same({ model })
			// A member leaves its billing org by unlinking itself, never the org that pays.
			const isSelf = account.role === "member"
			return same({
				model: { ...model, isUnlinking: true },
				commands: [Unlink({ orgId: isSelf ? account.orgId : orgId, isSelf })],
			})
		},
		CompletedUnlink: ({ isSelf, result }) => {
			const closed = liftUnlinkDialog(
				{ ...model, isUnlinking: false, unlinkOrgId: null },
				Dialog.close(model.unlinkDialog),
			)
			return Result.match(result, {
				onSuccess: (account) => {
					const changed = afterLinkChange(closed.model, account)
					const step = {
						model: changed.model,
						commands: [...(closed.commands ?? []), ...(changed.commands ?? [])],
						outMessage: toast(
							"success",
							isSelf ? "This org now has its own billing" : "Organization removed from billing",
						),
					}
					// Only this org's own payer changes when it leaves; a removed member's is not ours.
					return isSelf ? staleCustomer(step) : same(step)
				},
				// The unlink may have committed before the failure, or another session may have
				// removed the link already: read where billing stands now.
				onFailure: ({ rejection, failure }) =>
					same({
						...closed,
						commands: [...(closed.commands ?? []), FetchAccount()],
						outMessage: toast(
							"error",
							"Couldn't stop the billing link",
							rejection ?? failure.message,
						),
					}),
			})
		},
		ResolvedThemeColors: ({ colors }) => same({ model: { ...model, themeColors: colors } }),
		GotChartMessage: ({ message: child }) => {
			const step = Chart.update(model.chart, child)
			return same({
				model: { ...model, chart: step.model },
				commands: Command.mapMessages(step.commands ?? [], (inner) =>
					Message.GotChartMessage({ message: inner }),
				),
			})
		},
	})

/** The cycle is known once the customer and the clock are: then the rule stats are read, once. */
export const requestRuleStats = (
	model: Model,
	customer: BillingCustomer | null,
	nowMs: number,
): Return | null => {
	const account = accountOf(model)
	if (!AsyncData.isIdle(model.ruleStats) || nowMs <= 0 || account === null || account.role === "member")
		return null
	const spend = spendModelOf(model, customer, nowMs)
	return spend === null
		? null
		: {
				model: { ...model, ruleStats: AsyncData.Loading() },
				commands: [FetchRuleStats({ startMs: spend.cycle.startMs })],
			}
}

/** The customer settled: once it carries a plan, the wait is over (`confirmed`). */
export const customerChanged = (model: Model, customer: BillingCustomer): Step | null =>
	model.checkoutReturn === "Confirming" && hasSelectedPlan(customer)
		? {
				step: {
					model: { ...model, checkoutReturn: "Idle" },
					commands: [
						TrackCheckout({ event: "plan_checkout_returned", props: { confirmed: true } }),
					],
				},
				isCustomerStale: false,
				checkout: "Confirmed",
			}
		: null

/** "Edit" on the billing details: the dialog opens on the profile on file. */
export const openDetails = (model: Model): Return =>
	Option.match(profileOf(model), {
		onNone: () => ({ model }),
		onSome: (profile) => {
			const step = Details.open(model.details, profile)
			return {
				model: { ...model, details: step.model },
				commands: Command.mapMessages(step.commands ?? [], (inner) =>
					Message.GotDetailsMessage({ message: inner }),
				),
			}
		},
	})
