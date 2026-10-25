import type { OrgId } from "@maple/domain"
import type { Option } from "effect"
import type { ClerkOrganization, ClerkUser, PendingSessionTask } from "../../platform/clerk"
import type { CustomerSlot } from "./plan-gate"

/** What the root knows about the session, read by every onboarding screen. */
export interface Inputs {
	readonly session: "SignedOut" | "SignedIn"
	readonly maybeOrgId: Option.Option<OrgId>
	/** The time zone pages read (`useTimezonePreference`), for the connect drawer's flow. */
	readonly timeZone: string
	/** Clerk mode: the active org, the user's orgs and the user (`None` / empty self-hosted). */
	readonly maybeOrganization: Option.Option<ClerkOrganization>
	readonly memberships: ReadonlyArray<ClerkOrganization>
	readonly maybeUser: Option.Option<ClerkUser>
	readonly customer: CustomerSlot
	/** A pending session's task: `/sign-in` shows Clerk's card for it. */
	readonly maybePendingTask: Option.Option<PendingSessionTask>
}
