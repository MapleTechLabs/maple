import { OrgId, UserId } from "@maple/domain"
import { organizationFeatureFlagsFrom } from "@maple/domain/organization-feature-flags"
import {
	MapleRegion,
	organizationHomeRegion,
	organizationRegionOpen,
	organizationServedIn,
} from "@maple/domain/organization-regions"
import { currentRegion } from "@maple/web/lib/region"
import { purgeForeignClerkCookies } from "@maple/web/lib/services/common/clerk-cookie-guard"
import { Clock, Effect, Option, Queue, Schema, Stream } from "effect"

/** The slice of clerk-js this app reads. `window.Clerk` is what the parity harness stubs. */
interface ClerkOrganizationResource {
	readonly id: string
	readonly name: string
	readonly imageUrl?: string
	readonly publicMetadata?: unknown
	readonly createdAt?: Date
	readonly update?: (input: { name: string }) => Promise<object>
	readonly inviteMember?: (input: { emailAddress: string; role: "org:member" }) => Promise<object>
	readonly getInvitations?: (params: {
		readonly status: ReadonlyArray<string>
	}) => Promise<{ readonly data: ReadonlyArray<{ readonly emailAddress: string }> }>
}
interface ClerkResources {
	readonly user?: {
		readonly id: string
		readonly fullName?: string | null
		readonly imageUrl?: string
		readonly primaryEmailAddress?: { readonly emailAddress: string } | null
		readonly organizationMemberships?: ReadonlyArray<{
			readonly organization: ClerkOrganizationResource
			readonly role?: string
		}>
	} | null
	readonly session?: { readonly getToken: () => Promise<string | null> } | null
	readonly organization?: ClerkOrganizationResource | null
}
interface ClerkGlobal extends ClerkResources {
	readonly load: (options: Readonly<Record<string, unknown>>) => Promise<void>
	readonly addListener: (listener: (resources: ClerkResources) => void) => () => void
	readonly mountSignIn: (element: HTMLDivElement, props: Readonly<Record<string, unknown>>) => void
	readonly unmountSignIn: (element: HTMLDivElement) => void
	readonly mountSignUp: (element: HTMLDivElement, props: Readonly<Record<string, unknown>>) => void
	readonly unmountSignUp: (element: HTMLDivElement) => void
	readonly setActive: (params: { readonly organization: string }) => Promise<void>
	readonly signOut: () => Promise<void>
}
declare global {
	interface Window {
		Clerk?: ClerkGlobal
	}
}

export class ClerkLoadError extends Schema.TaggedError<ClerkLoadError>()(
	"@maple/web-foldkit/ClerkLoadError",
	{
		message: Schema.String,
		cause: Schema.Defect(),
	},
) {}

/**
 * An organization as the app reads it (`useOrganization`, `useOrganizationList`): its public
 * metadata decoded into the region (`useOrganizationRegion`) and rollout flags it decides.
 */
export const ClerkOrganization = Schema.Struct({
	id: OrgId,
	name: Schema.String,
	imageUrl: Schema.String,
	homeRegion: MapleRegion,
	isServedHere: Schema.Boolean,
	/** `organizationRegionOpen` at the time of the emit: onboarding may still ask for the region. */
	isRegionOpen: Schema.Boolean,
	flags: Schema.Struct({ aiAutoTriage: Schema.Boolean, releases: Schema.Boolean }),
})
export type ClerkOrganization = typeof ClerkOrganization.Type

/** `useUser()`: what the user menu shows. */
export const ClerkUser = Schema.Struct({
	fullName: Schema.NullOr(Schema.String),
	email: Schema.NullOr(Schema.String),
	imageUrl: Schema.String,
})
export type ClerkUser = typeof ClerkUser.Type

/** What the app reads from a Clerk session (`useAuth()`, `useUser()`, `useOrganization()`). */
export const ClerkSnapshot = Schema.Struct({
	maybeUserId: Schema.Option(UserId),
	maybeOrgId: Schema.Option(OrgId),
	maybeUser: Schema.Option(ClerkUser),
	maybeOrganization: Schema.Option(ClerkOrganization),
	/** `useOrganizationList({ userMemberships })`, the first page. */
	memberships: Schema.Array(ClerkOrganization),
})
export type ClerkSnapshot = typeof ClerkSnapshot.Type

const toOrganization = (organization: ClerkOrganizationResource, nowMs: number): ClerkOrganization => ({
	id: OrgId.make(organization.id),
	name: organization.name,
	imageUrl: organization.imageUrl ?? "",
	homeRegion: organizationHomeRegion(organization.publicMetadata),
	isServedHere: organizationServedIn(organization.publicMetadata, currentRegion),
	isRegionOpen: organizationRegionOpen(organization.publicMetadata, organization.createdAt?.getTime(), nowMs),
	flags: organizationFeatureFlagsFrom(organization.publicMetadata),
})

const toSnapshot = (resources: ClerkResources): Effect.Effect<ClerkSnapshot> =>
	Effect.map(Clock.currentTimeMillis, (nowMs) => ({
		maybeUserId: Option.map(Option.fromNullishOr(resources.user?.id), UserId.make),
		maybeOrgId: Option.map(Option.fromNullishOr(resources.organization?.id), OrgId.make),
		maybeUser: Option.map(Option.fromNullishOr(resources.user), (user) => ({
			fullName: user.fullName ?? null,
			email: user.primaryEmailAddress?.emailAddress ?? null,
			imageUrl: user.imageUrl ?? "",
		})),
		maybeOrganization: Option.map(Option.fromNullishOr(resources.organization), (organization) =>
			toOrganization(organization, nowMs),
		),
		memberships: (resources.user?.organizationMemberships ?? []).map((membership) =>
			toOrganization(membership.organization, nowMs),
		),
	}))

const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY?.trim() ?? ""
const signInUrl = import.meta.env.VITE_CLERK_SIGN_IN_URL?.trim() || "/sign-in"
const signUpUrl = import.meta.env.VITE_CLERK_SIGN_UP_URL?.trim() || "/sign-up"

/** `pk_test_<base64(frontendApi$)>`: where @clerk/clerk-react loads clerk-js from. */
const clerkJsUrl = (key: string) =>
	`https://${atob(key.split("_").slice(2).join("_")).replace(/\$$/, "")}/npm/@clerk/clerk-js@5/dist/clerk.browser.js`

const injectClerkJs = Effect.callback<void, ClerkLoadError>((resume) => {
	const script = document.createElement("script")
	script.src = clerkJsUrl(publishableKey)
	script.async = true
	script.crossOrigin = "anonymous"
	script.setAttribute("data-clerk-js-script", "true")
	script.setAttribute("data-clerk-publishable-key", publishableKey)
	script.addEventListener("load", () => resume(Effect.void))
	script.addEventListener("error", (cause) =>
		resume(Effect.fail(new ClerkLoadError({ message: "Failed to load Clerk", cause }))),
	)
	document.head.appendChild(script)
})

const currentClerk = Effect.suspend(() =>
	Option.match(Option.fromNullishOr(window.Clerk), {
		onNone: () =>
			Effect.fail(new ClerkLoadError({ message: "window.Clerk is missing", cause: undefined })),
		onSome: Effect.succeed,
	}),
)

/** Loads clerk-js the way `<ClerkProvider>` does (unless a stub already sits on `window`). */
export const loadClerk: Effect.Effect<ClerkSnapshot, ClerkLoadError> = Effect.gen(function* () {
	yield* Effect.promise(() => purgeForeignClerkCookies(publishableKey))
	if (window.Clerk === undefined) {
		yield* injectClerkJs
	}
	const clerk = yield* currentClerk
	yield* Effect.tryPromise({
		try: () =>
			clerk.load({
				signInUrl,
				signUpUrl,
				signUpFallbackRedirectUrl: "/quick-start",
				afterSignOutUrl: signInUrl,
			}),
		catch: (cause) => new ClerkLoadError({ message: "Clerk failed to load", cause }),
	})
	return yield* toSnapshot(clerk)
})

/** Every Clerk emit (session touch, org switch, sign-out), as snapshots. */
export const clerkSnapshots: Stream.Stream<ClerkSnapshot> = Stream.callback<ClerkResources>((queue) =>
	Option.match(Option.fromNullishOr(window.Clerk), {
		onNone: () => Effect.void,
		onSome: (clerk) =>
			Effect.acquireRelease(
				Effect.sync(() => clerk.addListener((resources) => Queue.offerUnsafe(queue, resources))),
				(unsubscribe) => Effect.sync(unsubscribe),
			),
	}),
).pipe(Stream.mapEffect(toSnapshot))

/** `setActive({ organization })` then reload, as `ClerkOrgSwitcherMenu`'s `switchOrganization`. */
export const setActiveOrganization = (orgId: string): Effect.Effect<void> =>
	Effect.promise(() => window.Clerk?.setActive({ organization: orgId }) ?? Promise.resolve()).pipe(
		Effect.catchDefect(() => Effect.void),
	)

/** `useClerk().signOut()`: Clerk then routes to `afterSignOutUrl`. */
export const signOutOfClerk: Effect.Effect<void> = Effect.promise(
	() => window.Clerk?.signOut() ?? Promise.resolve(),
).pipe(Effect.catchDefect(() => Effect.void))

/** The active org's handle for its own rename and invitations (`useOrganization().organization`). */
export interface ClerkTeamOrganization {
	readonly name: string
	/** `useAuth().orgRole === "org:admin"`: the role of the user's membership in it. */
	readonly isAdmin: boolean
	readonly update: (input: { name: string }) => Promise<object>
	readonly inviteMember: (input: { emailAddress: string; role: "org:member" }) => Promise<object>
	readonly pendingInvitations: () => Promise<ReadonlyArray<string>>
}

export const clerkTeamOrganization: Effect.Effect<Option.Option<ClerkTeamOrganization>> = Effect.sync(() =>
	Option.flatMap(Option.fromNullishOr(window.Clerk?.organization), (organization) => {
		const { update, inviteMember, getInvitations } = organization
		const missing = () => Promise.reject(new TypeError("Clerk organization method is missing"))
		const membership = window.Clerk?.user?.organizationMemberships?.find(
			(candidate) => candidate.organization.id === organization.id,
		)
		return Option.some({
			name: organization.name,
			isAdmin: membership?.role === "org:admin",
			update: (input) => (update === undefined ? missing() : update.call(organization, input)),
			inviteMember: (input) => (inviteMember === undefined ? missing() : inviteMember.call(organization, input)),
			pendingInvitations: () =>
				getInvitations === undefined
					? Promise.resolve([])
					: getInvitations
							.call(organization, { status: ["pending"] })
							.then((page) => page.data.map((invitation) => invitation.emailAddress)),
		})
	}),
)

/** The session JWT for API calls (`getToken()` in apps/web's ClerkAuthBridge). */
export const clerkSessionToken: Effect.Effect<Option.Option<string>> = Effect.tryPromise(
	() => window.Clerk?.session?.getToken() ?? Promise.resolve(null),
).pipe(Effect.map(Option.fromNullishOr), Effect.orElseSucceed(Option.none))
