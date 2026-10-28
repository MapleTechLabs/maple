import { Schema } from "effect"
import { OrgId } from "../primitives"
import { HttpTaggedError } from "./error-policy"

/**
 * A sub-org's billing can roll up to a billing org: the sub-org keeps its own data, while its
 * usage, plan and invoice are the billing org's. `standalone` is every org that is neither.
 */
export const BillingAccountRole = Schema.Literals(["standalone", "billing_org", "member"])
export type BillingAccountRole = typeof BillingAccountRole.Type

export class BillingAccountOrg extends Schema.Class<BillingAccountOrg>("BillingAccountOrg")({
	orgId: OrgId,
	name: Schema.NullOr(Schema.String),
	imageUrl: Schema.NullOr(Schema.String),
	/** When the org joined the billing org; absent on the billing org itself. */
	linkedAt: Schema.optionalKey(Schema.Number),
}) {}

export class BillingAccount extends Schema.Class<BillingAccount>("BillingAccount")({
	/** The org this account was read for: what a member sends to stop billing through its payer. */
	orgId: OrgId,
	role: BillingAccountRole,
	/** The org that pays: this org itself unless it is a member. */
	billingOrg: BillingAccountOrg,
	/** The orgs billed through this one. Empty unless `role` is `billing_org`. */
	members: Schema.Array(BillingAccountOrg),
}) {}

export class LinkBillingOrgRequest extends Schema.Class<LinkBillingOrgRequest>("LinkBillingOrgRequest")({
	billingOrgId: OrgId,
}) {}

/** One org's billed volume this cycle, from the warehouse. */
export class BillingAccountOrgUsage extends Schema.Class<BillingAccountOrgUsage>("BillingAccountOrgUsage")({
	orgId: OrgId,
	logsGB: Schema.Number,
	tracesGB: Schema.Number,
	metricsGB: Schema.Number,
	browserSessions: Schema.Number,
	productEvents: Schema.Number,
}) {}

export class BillingAccountUsageResponse extends Schema.Class<BillingAccountUsageResponse>(
	"BillingAccountUsageResponse",
)({
	cycleStartMs: Schema.Number,
	cycleEndMs: Schema.Number,
	orgs: Schema.Array(BillingAccountOrgUsage),
}) {}

/** A billing write from a member org: its plan, payment and invoices belong to the billing org. */
export class BillingManagedByBillingOrgError extends HttpTaggedError<BillingManagedByBillingOrgError>()(
	"@maple/http/errors/BillingManagedByBillingOrgError",
	{ message: Schema.String, billingOrgId: OrgId },
	{
		status: 409,
		code: "billing_managed_by_billing_org",
		title: "Billed through another organization",
		message: "This organization is billed through another organization. Manage billing there.",
		retry: "never",
		recovery: "none",
		exposure: "redacted",
	},
) {}

export const BillingLinkRejection = Schema.Literals([
	"same_org",
	"already_linked",
	"billing_org_is_member",
	"org_is_billing_org",
	"not_admin_of_billing_org",
	"region_mismatch",
	"not_enabled",
	"not_a_member",
])
export type BillingLinkRejection = typeof BillingLinkRejection.Type

/** A link or unlink the rules refuse; `message` is written for the person who asked. */
export class BillingLinkRejectedError extends HttpTaggedError<BillingLinkRejectedError>()(
	"@maple/http/errors/BillingLinkRejectedError",
	{ message: Schema.String, reason: BillingLinkRejection },
	{
		status: 409,
		code: "billing_link_rejected",
		title: "Billing link not possible",
		retry: "never",
		recovery: "fix_request",
		exposure: "public_message",
	},
) {}

export class BillingAccountPersistenceError extends HttpTaggedError<BillingAccountPersistenceError>()(
	"@maple/http/errors/BillingAccountPersistenceError",
	{ message: Schema.String },
	{
		status: 503,
		code: "billing_account_persistence_unavailable",
		title: "Billing settings are temporarily unavailable",
		message: "Billing settings are temporarily unavailable. Retry in a few seconds.",
		retry: "backoff",
		recovery: "retry",
		exposure: "redacted",
	},
) {}

/**
 * An Autumn customer id: the org that pays. A member org's calls go to its billing org's customer,
 * so a bare org id never reaches Autumn; `BillingOrgService` is what turns one into this.
 */
export const BillingCustomerId = Schema.String.pipe(Schema.brand("@maple/BillingCustomerId"))
export type BillingCustomerId = typeof BillingCustomerId.Type
