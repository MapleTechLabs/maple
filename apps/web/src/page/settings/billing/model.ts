import {
	AttachResult,
	BillingCustomer,
	BillingInvoice,
	BillingProfile,
	BillingUsage,
	CatalogPlan,
	CustomerPortalResult,
	DailySpendResponse,
} from "@maple/domain/http"
import { Schema } from "effect"
import { AsyncData } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import * as Chart from "../../../charts/chart"
import { ThemeColors } from "../../../charts/theme-colors"
import { LoadFailure } from "../../../data/load-failure"
import * as Dialog from "../../../ui/dialog"
import * as Details from "./details/model"

// The Billing tab: this cycle's spend, usage and caps, the plan, invoices and billing details. The customer
// is the settings page's (one `billingCustomerAtom`).

export const SpendFeatureId = Schema.Literals([
	"logs",
	"traces",
	"metrics",
	"browser_sessions",
	"product_events",
])
export type SpendFeatureId = typeof SpendFeatureId.Type

/** The open cap editor's input (`autoFocus`). */
export const CAP_INPUT_ID = "billing-cap-input"

/** A profile read that failed: a deployment without Stripe reads differently from an outage. */
export const ProfileFailure = Schema.Struct({ isNotConfigured: Schema.Boolean, failure: LoadFailure })

export const PlansData = AsyncData.Schema(Schema.Array(CatalogPlan), LoadFailure)
export const UsageData = AsyncData.Schema(BillingUsage, LoadFailure)
export const DailyData = AsyncData.Schema(DailySpendResponse, LoadFailure)
export const InvoicesData = AsyncData.Schema(Schema.Array(BillingInvoice), LoadFailure)
export const ProfileData = AsyncData.Schema(BillingProfile, ProfileFailure)

/** `useCheckoutReturn`: back from Stripe (`?checkout=complete`), waiting on the Autumn sync. */
export const CheckoutReturn = Schema.Literals(["Idle", "Confirming", "TimedOut"])
export type CheckoutReturn = typeof CheckoutReturn.Type

export const Model = Schema.Struct({
	isAdmin: Schema.Boolean,
	checkoutReturn: CheckoutReturn,
	plans: PlansData.schema,
	usage: UsageData.schema,
	daily: DailyData.schema,
	invoices: InvoicesData.schema,
	profile: ProfileData.schema,
	/** The usage row whose cap editor is open, and what is typed in it. */
	editingCap: Schema.NullOr(SpendFeatureId),
	capDraft: Schema.String,
	isSavingCap: Schema.Boolean,
	isBreakdownOpen: Schema.Boolean,
	isOpeningPortal: Schema.Boolean,
	compareDialog: Dialog.Model,
	/** The plan whose checkout is starting (the button stays busy through the redirect). */
	attaching: Schema.NullOr(Schema.String),
	details: Details.Model,
	themeColors: Schema.NullOr(ThemeColors),
	chart: Chart.Model,
})
export type Model = typeof Model.Type

const result = <A extends Schema.Top>(schema: A) => ({ result: Schema.Result(schema, LoadFailure) })

export const Message = defineMessageUnion({
	CompletedFetchPlans: result(Schema.Array(CatalogPlan)),
	CompletedFetchUsage: result(BillingUsage),
	CompletedFetchDaily: result(DailySpendResponse),
	CompletedFetchInvoices: result(Schema.Array(BillingInvoice)),
	CompletedFetchProfile: { result: Schema.Result(BillingProfile, ProfileFailure) },
	ClickedRetryCustomer: {},
	ClickedRetryDaily: {},
	ClickedRetryInvoices: {},
	ClickedRetryProfile: {},
	ClickedManageBilling: {},
	CompletedOpenPortal: result(CustomerPortalResult),
	CompletedRedirect: {},
	ClickedSetCaps: {},
	CompletedScrollToUsage: {},
	CompletedFocusCap: {},
	ClickedEditCap: { featureId: SpendFeatureId },
	ChangedCap: { value: Schema.String },
	PressedCapKey: { key: Schema.String },
	ClickedCancelCap: {},
	ClickedSaveCap: {},
	CompletedSaveCap: { featureId: SpendFeatureId, label: Schema.String, ...result(BillingCustomer) },
	ToggledBreakdown: {},
	ClickedCompare: {},
	GotCompareDialogMessage: { message: Dialog.Message },
	ClickedSubscribe: { planId: Schema.String },
	CompletedAttach: { planId: Schema.String, ...result(AttachResult) },
	ElapsedCheckoutPoll: {},
	ElapsedCheckoutTimeout: {},
	CompletedTrackProduct: {},
	ClickedEditDetails: {},
	GotDetailsMessage: { message: Details.Message },
	ResolvedThemeColors: { colors: ThemeColors },
	GotChartMessage: { message: Chart.Message },
})
export type Message = typeof Message.Type
