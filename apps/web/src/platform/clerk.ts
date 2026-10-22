import { OrgId, UserId } from "@maple/domain"
import { organizationFeatureFlagsFrom } from "@maple/domain/organization-feature-flags"
import {
	MapleRegion,
	organizationHomeRegion,
	organizationRegionOpen,
	organizationServedIn,
} from "@maple/domain/organization-regions"
import { clerkAppearance, clerkLocalization } from "../lib/clerk-appearance"
import { currentRegion } from "../lib/region"
import { purgeForeignClerkCookies } from "../lib/services/common/clerk-cookie-guard"
import { clerkJsUrl } from "./clerk-js-url"
import { Clock, Duration, Effect, Option, Predicate, Queue, Schema, Stream } from "effect"

/** The slice of clerk-js this app reads (`window.Clerk`). */
interface ClerkResources {
	readonly user?: ClerkUserResource | null
	readonly session?: {
		readonly id: string
		readonly getToken: (options?: { readonly skipCache?: boolean }) => Promise<string | null>
	} | null
	readonly organization?: ClerkOrganizationResource | null
}

// The resources `/settings` (organization, members) and `/account` read and write.

type Write<P = void, A = unknown> = (params: P) => Promise<A>
type Verification = { readonly status: string | null } | null

export interface ClerkEmailAddressResource {
	readonly id: string
	readonly emailAddress: string
	readonly verification: Verification
	readonly destroy: Write
	readonly prepareVerification: Write<{ strategy: "email_code" }>
	readonly attemptVerification: Write<{ code: string }>
}
export interface ClerkPasskeyResource {
	readonly id: string
	readonly name: string | null
	readonly createdAt: Date
	readonly lastUsedAt: Date | null
	readonly update: Write<{ name: string }>
	readonly delete: Write
}
export interface ClerkExternalAccountResource {
	readonly id: string
	readonly provider: string
	readonly emailAddress: string
	readonly username: string | null
	readonly verification: (Verification & { readonly externalVerificationRedirectURL?: URL | null }) | null
	readonly destroy: Write
	readonly reauthorize: Write<{ redirectUrl: string }, ClerkExternalAccountResource>
}
export interface ClerkSessionActivityResource {
	readonly id: string
	readonly lastActiveAt: Date
	readonly latestActivity: {
		readonly browserName?: string
		readonly browserVersion?: string
		readonly deviceType?: string
		readonly isMobile?: boolean
		readonly city?: string
		readonly country?: string
		readonly ipAddress?: string
	}
	readonly revoke: Write
}
export interface ClerkUserResource {
	readonly id: string
	readonly firstName: string | null
	readonly lastName: string | null
	readonly fullName: string | null
	readonly imageUrl: string
	readonly hasImage: boolean
	readonly primaryEmailAddress: ClerkEmailAddressResource | null
	readonly primaryEmailAddressId: string | null
	readonly emailAddresses: ReadonlyArray<ClerkEmailAddressResource>
	readonly passkeys: ReadonlyArray<ClerkPasskeyResource>
	readonly externalAccounts: ReadonlyArray<ClerkExternalAccountResource>
	readonly passwordEnabled: boolean
	readonly totpEnabled: boolean
	readonly backupCodeEnabled: boolean
	readonly deleteSelfEnabled: boolean
	readonly getSessions: () => Promise<ReadonlyArray<ClerkSessionActivityResource>>
	readonly update: Write<{ firstName?: string; lastName?: string; primaryEmailAddressId?: string }>
	readonly setProfileImage: Write<{ file: Blob | null }>
	readonly delete: Write
	readonly updatePassword: Write<{
		newPassword: string
		currentPassword?: string
		signOutOfOtherSessions: boolean
	}>
	readonly createEmailAddress: Write<{ email: string }, ClerkEmailAddressResource>
	readonly createPasskey: Write
	readonly createTOTP: Write<void, { readonly uri?: string; readonly secret?: string }>
	readonly verifyTOTP: Write<{ code: string }, { readonly backupCodes?: ReadonlyArray<string> }>
	readonly disableTOTP: Write
	readonly createBackupCode: Write<void, { readonly codes: ReadonlyArray<string> }>
	readonly createExternalAccount: Write<
		{ strategy: "oauth_google" | "oauth_github"; redirectUrl: string },
		ClerkExternalAccountResource
	>
	readonly leaveOrganization: Write<string>
	readonly organizationMemberships?: ReadonlyArray<{
		readonly organization: ClerkOrganizationResource
		readonly role?: string
	}>
	readonly getOrganizationMemberships: () => Promise<
		ClerkPage<{ readonly organization: { readonly id: string } }>
	>
}
export interface ClerkPublicUserData {
	readonly userId?: string
	readonly firstName: string | null
	readonly lastName: string | null
	readonly identifier: string
	readonly imageUrl: string
}
export interface ClerkMembershipResource {
	readonly id: string
	readonly role: string
	readonly createdAt: Date
	readonly publicUserData?: ClerkPublicUserData | null
	readonly update: Write<{ role: string }>
	readonly destroy: Write
}
export interface ClerkInvitationResource {
	readonly id: string
	readonly emailAddress: string
	readonly role: string
	readonly createdAt: Date
	readonly revoke: Write
}
interface ClerkPage<A> {
	readonly data: ReadonlyArray<A>
	readonly total_count: number
}
export interface ClerkOrganizationResource {
	readonly id: string
	readonly name: string
	readonly imageUrl: string
	readonly hasImage: boolean
	readonly publicMetadata: unknown
	readonly createdAt?: Date
	readonly getMemberships: (params: {
		initialPage?: number
		pageSize?: number
		role?: ReadonlyArray<string>
	}) => Promise<ClerkPage<ClerkMembershipResource>>
	readonly getInvitations: (params: {
		initialPage?: number
		pageSize?: number
		status?: ReadonlyArray<string>
	}) => Promise<ClerkPage<ClerkInvitationResource>>
	readonly update: Write<{ name: string }>
	readonly setLogo: Write<{ file: Blob | null }>
	readonly inviteMember: Write<{ emailAddress: string; role: string }>
	/** Re-reads the org, so its new public metadata reaches the listeners. */
	readonly reload: () => Promise<ClerkOrganizationResource>
}
interface ClerkGlobal extends ClerkResources {
	readonly load: (options: Readonly<Record<string, unknown>>) => Promise<void>
	readonly addListener: (listener: (resources: ClerkResources) => void) => () => void
	readonly mountSignIn: (element: HTMLDivElement, props: Readonly<Record<string, unknown>>) => void
	readonly unmountSignIn: (element: HTMLDivElement) => void
	readonly mountSignUp: (element: HTMLDivElement, props: Readonly<Record<string, unknown>>) => void
	readonly unmountSignUp: (element: HTMLDivElement) => void
	readonly setActive: (params: { readonly organization: string | null }) => Promise<void>
	readonly signOut: () => Promise<void>
	/** Clerk's re-verification modal, what `useReverification` opens (absent on a stub). */
	readonly __internal_openReverification?: (props: {
		readonly afterVerification: () => void
		readonly afterVerificationCancelled: () => void
	}) => void
}
declare global {
	interface Window {
		Clerk?: ClerkGlobal
	}
}

export class ClerkLoadError extends Schema.TaggedError<ClerkLoadError>()(
	"@maple/web/ClerkLoadError",
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
	isRegionOpen: organizationRegionOpen(
		organization.publicMetadata,
		organization.createdAt?.getTime(),
		nowMs,
	),
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

const injectClerkJs = Effect.callback<void, ClerkLoadError>((resume) => {
	const script = document.createElement("script")
	// The exact URL index.html preloads (vite.config.ts), so this runs the bytes already fetched.
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
	// Interrupted (the load deadline): a later attempt injects its own tag.
	return Effect.sync(() => script.remove())
})

const currentClerk = Effect.suspend(() =>
	Option.match(Option.fromNullishOr(window.Clerk), {
		onNone: () =>
			Effect.fail(new ClerkLoadError({ message: "window.Clerk is missing", cause: undefined })),
		onSome: Effect.succeed,
	}),
)

const CLERK_LOAD_TIMEOUT = Duration.seconds(20)

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
				// `<ClerkProvider appearance localization>`: every Clerk surface inherits these.
				appearance: clerkAppearance,
				localization: clerkLocalization,
			}),
		catch: (cause) => new ClerkLoadError({ message: "Clerk failed to load", cause }),
	})
	return yield* toSnapshot(clerk)
}).pipe(
	// Without a deadline a stalled script or `clerk.load` keeps the boot splash up forever.
	Effect.timeoutOrElse({
		duration: CLERK_LOAD_TIMEOUT,
		orElse: () =>
			Effect.fail(new ClerkLoadError({ message: "Clerk did not load in time", cause: undefined })),
	}),
)

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
	readonly update: (input: { name: string }) => Promise<void>
	readonly inviteMember: (input: { emailAddress: string; role: "org:member" }) => Promise<void>
	readonly pendingInvitations: () => Promise<ReadonlyArray<string>>
}

export const clerkTeamOrganization: Effect.Effect<Option.Option<ClerkTeamOrganization>> = Effect.sync(() =>
	Option.flatMap(Option.fromNullishOr(window.Clerk?.organization), (organization) => {
		const { update, inviteMember, getInvitations } = organization
		const missing = () => Promise.reject(new TypeError("Clerk organization method is missing"))
		const membership = window.Clerk?.user?.organizationMemberships?.find(
			(candidate) => candidate.organization.id === organization.id,
		)
		return Option.some<ClerkTeamOrganization>({
			name: organization.name,
			isAdmin: membership?.role === "org:admin",
			update: (input) =>
				update === undefined ? missing() : update.call(organization, input).then(() => undefined),
			inviteMember: (input) =>
				inviteMember === undefined
					? missing()
					: inviteMember.call(organization, input).then(() => undefined),
			pendingInvitations: () =>
				getInvitations === undefined
					? Promise.resolve([])
					: getInvitations
							.call(organization, { status: ["pending"] })
							.then((page) => page.data.map((invitation) => invitation.emailAddress)),
		})
	}),
)

const SESSION_TOKEN_TIMEOUT = Duration.seconds(10)

const sessionToken = (skipCache: boolean): Effect.Effect<Option.Option<string>> =>
	Effect.tryPromise(() => window.Clerk?.session?.getToken({ skipCache }) ?? Promise.resolve(null)).pipe(
		Effect.map(Option.fromNullishOr),
		// Runs before the request deadline starts, so a stalled token refresh must not hang every request.
		Effect.timeoutOrElse({ duration: SESSION_TOKEN_TIMEOUT, orElse: () => Effect.succeedNone }),
		Effect.orElseSucceed(Option.none),
	)

/** The session JWT for API calls (`session.getToken()`). */
export const clerkSessionToken = sessionToken(false)

/** A session JWT minted now, bypassing clerk-js's token cache. */
export const freshClerkSessionToken = sessionToken(true)

// clerk-js resources for the Clerk-only settings tabs and `/account`: ported markup over the
// vanilla resource API.

export class ClerkActionError extends Schema.TaggedError<ClerkActionError>()(
	"@maple/web/ClerkActionError",
	{
		message: Schema.String,
		cause: Schema.Defect(),
	},
) {}

const stringField = (value: unknown, key: string): string | undefined =>
	Predicate.hasProperty(value, key) && typeof value[key] === "string" ? value[key] : undefined

/** `accountErrorMessage`: Clerk's own `longMessage`/`message`, else the error's, else `fallback`. */
export const clerkErrorMessage = (cause: unknown, fallback: string): string => {
	if (Predicate.hasProperty(cause, "errors") && Array.isArray(cause.errors)) {
		const first: unknown = cause.errors[0]
		return stringField(first, "longMessage") ?? stringField(first, "message") ?? fallback
	}
	return cause instanceof Error ? cause.message : fallback
}

const missing = (what: string) =>
	new ClerkActionError({ message: `No ${what} is signed in`, cause: undefined })

/** The signed-in Clerk user (`useUser().user`). */
export const currentClerkUser: Effect.Effect<ClerkUserResource, ClerkActionError> = Effect.suspend(() =>
	Option.match(Option.fromNullishOr(window.Clerk?.user), {
		onNone: () => Effect.fail(missing("user")),
		onSome: Effect.succeed,
	}),
)

/** The active organization (`useOrganization().organization`). */
export const currentClerkOrganization: Effect.Effect<ClerkOrganizationResource, ClerkActionError> =
	Effect.suspend(() =>
		Option.match(Option.fromNullishOr(window.Clerk?.organization), {
			onNone: () => Effect.fail(missing("organization")),
			onSome: Effect.succeed,
		}),
	)

/** The current session's id (`useSession().session?.id`). */
export const currentClerkSessionId: Effect.Effect<string | null> = Effect.sync(
	() => window.Clerk?.session?.id ?? null,
)

/** A Clerk call, failing with Clerk's message or `fallback` (what `settleClerk` toasts). */
export const clerkTry = <A>(fallback: string, run: () => Promise<A>): Effect.Effect<A, ClerkActionError> =>
	Effect.tryPromise({
		try: run,
		catch: (cause) => new ClerkActionError({ message: clerkErrorMessage(cause, fallback), cause }),
	})

/** `isReverificationCancelledError`: a dismissed challenge, which the tabs settle without a toast. */
export const REVERIFICATION_CANCELLED = "User cancelled attempted verification"

/** `session_reverification_required`: the session is past the window for this write. */
const isReverificationRequired = (error: ClerkActionError): boolean =>
	Predicate.hasProperty(error.cause, "errors") &&
	Array.isArray(error.cause.errors) &&
	error.cause.errors.some(
		(entry: unknown) => stringField(entry, "code") === "session_reverification_required",
	)

/** Opens Clerk's challenge, themed by `clerk.load`; without a modal to open, the refusal stands. */
const reverify = (refusal: ClerkActionError): Effect.Effect<void, ClerkActionError> =>
	Effect.callback<void, ClerkActionError>((resume) => {
		const open = window.Clerk?.__internal_openReverification
		if (open === undefined) return resume(Effect.fail(refusal))
		open.call(window.Clerk, {
			afterVerification: () => resume(Effect.void),
			afterVerificationCancelled: () =>
				resume(
					Effect.fail(
						new ClerkActionError({ message: REVERIFICATION_CANCELLED, cause: undefined }),
					),
				),
		})
	})

/** `useReverification(fetcher)`: a refused write opens the challenge, then runs once more. */
export const clerkTryReverified = <A>(
	fallback: string,
	run: () => Promise<A>,
): Effect.Effect<A, ClerkActionError> => {
	const attempt = clerkTry(fallback, run)
	return attempt.pipe(
		Effect.catchIf(isReverificationRequired, (refusal) => Effect.andThen(reverify(refusal), attempt)),
	)
}

/** `setActive({ organization })` then home: after leaving or deleting the active organization. */
export const switchAwayFrom = (orgId: string): Effect.Effect<void> =>
	Effect.gen(function* () {
		const clerk = window.Clerk
		if (clerk === undefined) return
		const user = clerk.user
		const memberships =
			user === null || user === undefined
				? []
				: yield* Effect.tryPromise(() => user.getOrganizationMemberships()).pipe(
						Effect.map((page) => page.data),
						Effect.orElseSucceed(() => []),
					)
		const next =
			memberships.find((membership) => membership.organization.id !== orgId)?.organization.id ?? null
		// A failed switch falls through to navigation; Clerk's session refreshes on next load.
		yield* Effect.tryPromise(() => clerk.setActive({ organization: next })).pipe(Effect.ignore)
	})
