import type { DatasetSummary } from "../contract.ts"

/**
 * Browser-side stand-in for clerk-js, installed via `page.addInitScript` before the app boots.
 * `@clerk/clerk-react` 5 (`IsomorphicClerk.loadClerkJS`) finds `window.Clerk`, skips the clerk-js
 * script, and hydrates from it once `loaded` is true, so auth is deterministic and offline.
 *
 * Serialized into the page with `Function.prototype.toString`, so it must be
 * self-contained (no imports, no closures over module scope).
 */
export interface ClerkStubIdentity {
	readonly clerkUserId: string
	readonly email: string
	readonly firstName: string
	readonly lastName: string
	readonly imageUrl: string
	readonly clerkOrgId: string | null
	readonly orgName: string
	readonly orgSlug: string
	readonly role: "org:admin" | "org:member"
}

/** The stub identity for a dataset, `null` when it is signed out. */
export const clerkIdentityFor = (dataset: DatasetSummary): ClerkStubIdentity | null => {
	const identity = dataset.identity
	if (identity === null) return null
	const [firstName = identity.name, ...rest] = identity.name.split(" ")
	return {
		clerkUserId: identity.userId,
		email: identity.email,
		firstName,
		lastName: rest.join(" "),
		imageUrl: "",
		// An empty slug marks a signed-in user with no active organization (`/org-required`).
		clerkOrgId: identity.orgSlug === "" ? null : identity.orgId,
		orgName: identity.orgName,
		orgSlug: identity.orgSlug,
		role: identity.role === "admin" ? "org:admin" : "org:member",
	}
}

/** `null` installs a signed-out Clerk: no client session, no user, no organization. */
export const installClerkStub = (identity: ClerkStubIdentity | null) => {
	const noop = () => {}
	const asyncNoop = async () => {}
	const signedIn = (id: ClerkStubIdentity) => {
		// Fixed timestamps: the org switcher reads `organization.createdAt.getTime()`.
		const createdAt = new Date(Date.UTC(2026, 0, 1))
		const organization = id.clerkOrgId
			? {
					id: id.clerkOrgId,
					name: id.orgName,
					slug: id.orgSlug,
					imageUrl: "",
					hasImage: false,
					publicMetadata: {},
					createdAt,
					updatedAt: createdAt,
					membersCount: 1,
					// `useOrganization({ memberships, invitations })` pages through these: the signed-in user only.
					getMemberships: async () => ({
						data: [
							{
								id: "orgmem_parity",
								role: id.role,
								createdAt,
								publicUserData: {
									userId: id.clerkUserId,
									firstName: id.firstName,
									lastName: id.lastName,
									identifier: id.email,
									imageUrl: id.imageUrl,
									hasImage: false,
								},
							},
						],
						total_count: 1,
					}),
					getInvitations: async () => ({ data: [], total_count: 0 }),
				}
			: null
		const memberships = organization
			? [{ id: "orgmem_parity", organization, role: id.role, permissions: [], publicMetadata: {}, createdAt }]
			: []
		// `useOrganizationList({ userMemberships })` pages through `user.getOrganizationMemberships`.
		const membershipPage = async () => ({ data: memberships, total_count: memberships.length })
		const primaryEmail = { id: "idn_parity_primary", emailAddress: id.email, verification: { status: "verified" } }
		const user = {
			id: id.clerkUserId,
			firstName: id.firstName,
			lastName: id.lastName,
			fullName: `${id.firstName} ${id.lastName}`,
			imageUrl: id.imageUrl,
			hasImage: false,
			primaryEmailAddress: primaryEmail,
			primaryEmailAddressId: primaryEmail.id,
			emailAddresses: [primaryEmail],
			externalAccounts: [],
			// What the /account tabs read: one passkey, a password, no TOTP, this one session.
			passkeys: [{ id: "pk_parity", name: "MacBook Touch ID", createdAt, lastUsedAt: createdAt }],
			passwordEnabled: true,
			totpEnabled: false,
			backupCodeEnabled: false,
			twoFactorEnabled: false,
			deleteSelfEnabled: true,
			getSessions: async () => [
				{
					id: "sess_parity",
					status: "active",
					lastActiveAt: createdAt,
					latestActivity: {
						browserName: "Chrome",
						browserVersion: "141.0.0.0",
						deviceType: "Macintosh",
						isMobile: false,
						city: "London",
						country: "GB",
						ipAddress: "203.0.113.24",
					},
					revoke: asyncNoop,
				},
			],
			organizationMemberships: memberships,
			getOrganizationMemberships: membershipPage,
			getOrganizationInvitations: async () => ({ data: [], total_count: 0 }),
			getOrganizationSuggestions: async () => ({ data: [], total_count: 0 }),
			publicMetadata: {},
			unsafeMetadata: {},
			reload: asyncNoop,
			update: asyncNoop,
		}
		const session = {
			id: "sess_parity",
			status: "active",
			user,
			lastActiveOrganizationId: id.clerkOrgId,
			factorVerificationAge: null,
			lastActiveToken: {
				getRawString: () => "parity-token",
				jwt: {
					claims: {
						sub: id.clerkUserId,
						sid: "sess_parity",
						org_id: id.clerkOrgId ?? undefined,
						org_role: id.role,
					},
				},
			},
			getToken: async () => "parity-token",
			checkAuthorization: () => true,
			touch: asyncNoop,
		}
		const client = {
			sessions: [session],
			signedInSessions: [session],
			activeSessions: [session],
			lastActiveSessionId: session.id,
		}
		return { client, session, user, organization }
	}
	const signedOut = {
		client: { sessions: [], signedInSessions: [], activeSessions: [], lastActiveSessionId: null },
		session: null,
		user: null,
		organization: null,
	}
	const resources = identity ? signedIn(identity) : signedOut
	const { client, session, user, organization } = resources
	const listeners = new Set<(r: typeof resources) => void>()

	const base: Record<string, unknown> = {
		loaded: true,
		status: "ready",
		version: "parity-stub",
		sdkMetadata: { name: "parity-stub", version: "0" },
		instanceType: "development",
		frontendApi: "parity.clerk.invalid",
		publishableKey: "pk_test_cGFyaXR5LmNsZXJrLmludmFsaWQk",
		isSatellite: false,
		isSignedIn: identity !== null,
		client,
		session,
		user,
		organization,
		telemetry: { record: noop },
		load: asyncNoop,
		__internal_lastEmittedResources: resources,
		addListener: (listener: (r: typeof resources) => void, options?: { skipInitialEmit?: boolean }) => {
			listeners.add(listener)
			if (!options?.skipInitialEmit) listener(resources)
			return () => listeners.delete(listener)
		},
		// clerk-react re-registers its status listeners here with `notify`; without a "ready" reply
		// `useAuth().isLoaded` never turns true and the app stays on its boot splash.
		on: (event: string, listener: (status: string) => void, options?: { notify?: boolean }) => {
			if (event === "status" && options?.notify) listener("ready")
		},
		off: noop,
		__internal_updateProps: noop,
		__internal_setStatus: noop,
		setActive: asyncNoop,
		signOut: asyncNoop,
		redirectToSignIn: asyncNoop,
		buildUrlWithAuth: (url: string) => url,
		buildSignInUrl: () => "/sign-in",
		buildSignUpUrl: () => "/sign-up",
		buildAfterSignOutUrl: () => "/",
		getOrganizationMemberships: async () => ({ data: [], total_count: 0 }),
		// Mount helpers for prebuilt components render nothing in parity runs.
		mountSignIn: noop,
		unmountSignIn: noop,
		mountSignUp: noop,
		unmountSignUp: noop,
		mountCreateOrganization: noop,
		unmountCreateOrganization: noop,
	}

	// Clerk's React layer calls a long tail of internal/UI methods (`__internal_*`,
	// `mountUserButton`, `openSignIn`, ...). None of them affect rendering, so they no-op.
	const isNoopMethod = (prop: string) =>
		/^(__internal_|mount|unmount|open|close|navigate|handle)/.test(prop)

	const unknownAccesses = new Set<string>()
	Reflect.set(window, "__parityClerkUnknown", unknownAccesses)
	const clerk = new Proxy(base, {
		get(target, prop, receiver) {
			if (typeof prop === "string" && prop !== "then" && !(prop in target)) {
				if (isNoopMethod(prop)) return asyncNoop
				unknownAccesses.add(prop)
			}
			return Reflect.get(target, prop, receiver)
		},
	})
	Reflect.set(window, "Clerk", clerk)
}
