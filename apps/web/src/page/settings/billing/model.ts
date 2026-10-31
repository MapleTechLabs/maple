import {
	AttachResult,
	BillingAccount,
	BillingAccountUsageResponse,
	BillingCustomer,
	BillingInvoice,
	BillingProfile,
	BillingUsage,
	CatalogPlan,
	CustomerPortalResult,
	DailySpendResponse,
} from "@maple/domain/http"
import { V2IngestRuleStats } from "@maple/domain/http/v2"
import { OrgId } from "@maple/domain"
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
export const RuleStatsData = AsyncData.Schema(V2IngestRuleStats, LoadFailure)
export const AccountData = AsyncData.Schema(BillingAccount, LoadFailure)
export const AccountUsageData = AsyncData.Schema(BillingAccountUsageResponse, LoadFailure)

/** Another org the viewer administers, which this org could be billed through. */
export const OrgChoice = Schema.Struct({ orgId: OrgId, name: Schema.String, imageUrl: Schema.String })
export type OrgChoice = typeof OrgChoice.Type
export const OrgChoicesData = AsyncData.Schema(Schema.Array(OrgChoice), LoadFailure)

/** A failed link or unlink: `rejection` is the server's message when the rules refused it. */
export const LinkFailure = Schema.Struct({ rejection: Schema.NullOr(Schema.String), failure: LoadFailure })

/** `useCheckoutReturn`: back from Stripe (`?checkout=complete`), waiting on the Autumn sync. */
export const CheckoutReturn = Schema.Literals(["Idle", "Confirming", "TimedOut"])
export type CheckoutReturn = typeof CheckoutReturn.Type

export const Model = Schema.Struct({
	isAdmin: Schema.Boolean,
	/** Clerk mode: the viewer's other orgs are known, so this org can be billed through one. */
	isClerk: Schema.Boolean,
	checkoutReturn: CheckoutReturn,
	plans: PlansData.schema,
	usage: UsageData.schema,
	daily: DailyData.schema,
	invoices: InvoicesData.schema,
	profile: ProfileData.schema,
	/** What ingest rules dropped this cycle; read once the cycle is known. */
	ruleStats: RuleStatsData.schema,
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
	/** Which org pays. Invoices and details are read only once it says this org is not a member. */
	account: AccountData.schema,
	/** Each org's volume this cycle; read only by a billing org with members. */
	accountUsage: AccountUsageData.schema,
	/** Read only for a standalone org's admin in Clerk mode. */
	orgChoices: OrgChoicesData.schema,
	linkOrgId: Schema.NullOr(OrgId),
	linkDialog: Dialog.Model,
	isLinking: Schema.Boolean,
	linkRejection: Schema.NullOr(Schema.String),
	/** The org a confirmed unlink removes: this org itself when it is a member. */
	unlinkOrgId: Schema.NullOr(OrgId),
	unlinkDialog: Dialog.Model,
	isUnlinking: Schema.Boolean,
})
export type Model = typeof Model.Type

const result = <A extends Schema.Top>(schema: A) => ({ result: Schema.Result(schema, LoadFailure) })

export const Message = defineMessageUnion({
	CompletedFetchPlans: result(Schema.Array(CatalogPlan)),
	CompletedFetchUsage: result(BillingUsage),
	CompletedFetchDaily: result(DailySpendResponse),
	CompletedFetchInvoices: result(Schema.Array(BillingInvoice)),
	CompletedFetchProfile: { result: Schema.Result(BillingProfile, ProfileFailure) },
	CompletedFetchRuleStats: result(V2IngestRuleStats),
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
	CompletedFetchAccount: result(BillingAccount),
	CompletedFetchAccountUsage: result(BillingAccountUsageResponse),
	CompletedFetchOrgChoices: result(Schema.Array(OrgChoice)),
	ClickedRetryAccount: {},
	ClickedRetryAccountUsage: {},
	ChangedLinkOrg: { value: Schema.String },
	ClickedLink: {},
	GotLinkDialogMessage: { message: Dialog.Message },
	ClickedConfirmLink: {},
	CompletedLink: { orgName: Schema.String, result: Schema.Result(BillingAccount, LinkFailure) },
	ClickedUnlink: { orgId: OrgId },
	GotUnlinkDialogMessage: { message: Dialog.Message },
	ClickedConfirmUnlink: {},
	CompletedUnlink: { isSelf: Schema.Boolean, result: Schema.Result(BillingAccount, LinkFailure) },
})
export type Message = typeof Message.Type
