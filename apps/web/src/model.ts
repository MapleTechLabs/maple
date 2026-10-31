import { OrgId } from "@maple/domain"
import { Schema } from "effect"
import { defineTaggedUnion } from "foldkit/schema"
import * as Onboarding from "./page/onboarding"
import { CustomerSlot } from "./page/onboarding/plan-gate"
import { ClerkSnapshot } from "./platform/clerk"
import * as Preload from "./page/preload"
import { RootToastAction } from "./page/contract"
import { PageMessage, PageSlot } from "./page/registry"
import * as SignIn from "./page/sign-in"
import * as Toast from "./ui/toast"
import { AppRoute } from "./route"
import { SessionTimeRange } from "./route/session-time-range"
import * as Shell from "./shell"

/** The session: unknown until resolved (boot splash), then settled. */
export const Session = defineTaggedUnion({
	Resolving: {},
	SignedOut: {},
	SignedIn: { maybeOrgId: Schema.Option(OrgId) },
})
export type Session = typeof Session.Type

/** clerk-js on `window.Clerk`, in Clerk mode only. */
export const ClerkPhase = defineTaggedUnion({
	Unused: {},
	Loading: {},
	Loaded: {},
	Failed: { message: Schema.String },
})
export type ClerkPhase = typeof ClerkPhase.Type

export const Model = Schema.Struct({
	route: AppRoute,
	session: Session,
	clerk: ClerkPhase,
	signIn: SignIn.Model,
	/** Sidebar, menus and boot data: survives navigation like the rest of the root Model. */
	shell: Shell.Model,
	/** The app-wide toasts. */
	toasts: Toast.Model,
	/** A page toast's action, by toast id: the page Message its button sends (`actionProps.onClick`). */
	toastActions: Schema.Record(Schema.String, PageMessage),
	/** A toast's root-level action, by toast id (Reconnect). */
	toastRootActions: Schema.Record(Schema.String, RootToastAction),
	/** The routed page (`page/registry.ts`): built on route entry, dropped on leave. */
	page: Schema.NullOr(PageSlot),
	/** Page instances built so far; the next build is stamped `pageInstances + 1`. */
	pageInstances: Schema.Number,
	/** Pages left recently, newest first: going back revives one with its last data (`parkPages`). */
	parkedPages: Schema.Array(PageSlot),
	/** The open onboarding or auth-handoff screen (`page/onboarding`): outside the shell and `PageContext`. */
	onboarding: Schema.NullOr(Onboarding.Model),
	/** The last Clerk emit (`useUser`, `useOrganization`, `useOrganizationList`), Clerk mode only. */
	clerkSnapshot: Schema.NullOr(ClerkSnapshot),
	/** The active org's Autumn customer (`billingCustomerAtom`), Clerk mode only. */
	customer: CustomerSlot,
	/** `maple.billing.selected-plan.<orgId>` per org, read at boot and written as plans settle. */
	knownToRenderApp: Schema.Record(Schema.String, Schema.Boolean),
	/** Link-intent preloads waiting for their page (`page/preload.ts`). */
	preload: Preload.Model,
	/** The window this tab remembers for the org (`route/session-time-range.ts`); `nowMs` is when read. */
	sessionTimeRange: Schema.NullOr(
		Schema.Struct({
			orgId: Schema.String,
			value: SessionTimeRange,
			nowMs: Schema.Number,
			isLoaded: Schema.Boolean,
		}),
	),
	/** `useTimezonePreference().effectiveTimezone`, read at boot. */
	timeZone: Schema.String,
})
export type Model = typeof Model.Type
