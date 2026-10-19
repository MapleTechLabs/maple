import { MapleRegion } from "@maple/domain/organization-regions"
import { Schema } from "effect"

// The Clerk screens without state of their own: `/org-required` (its switcher is the container's)
// and `/sign-up` (Clerk's card). Their views are in `view.ts`.

/** `OrgRequiredPageClerk`: a signed-in user with no active organization. */
export const OrgRequired = Schema.TaggedStruct("OrgRequired", {})
export type OrgRequired = typeof OrgRequired.Type

/** `SignUpPage`: Clerk's sign-up card, landing in onboarding unless a redirect is carried. */
export const SignUp = Schema.TaggedStruct("SignUp", { target: Schema.String })
export type SignUp = typeof SignUp.Type

/** `WrongRegionScreen`: the org lives in another region; `href` is the page to open there. */
export const WrongRegion = Schema.TaggedStruct("WrongRegion", { region: MapleRegion, href: Schema.String })
export type WrongRegion = typeof WrongRegion.Type
