import { BillingCustomerId, type OrgId } from "@maple/domain/http"

/**
 * The org's OWN Autumn customer, whatever it is linked to. Only for questions about the org
 * itself (its plan history, its own subscriptions); everything it is billed for goes through
 * `BillingOrgService.customerFor`.
 */
export const ownBillingCustomer = (orgId: OrgId): BillingCustomerId => BillingCustomerId.make(orgId)
