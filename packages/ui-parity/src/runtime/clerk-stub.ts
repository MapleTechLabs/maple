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
	readonly orgPublicMetadata: Readonly<Record<string, unknown>>
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
		orgPublicMetadata: identity.orgPublicMetadata ?? {},
	}
}

/** `null` installs a signed-out Clerk: no client session, no user, no organization. */
declare global {
	interface Window {
		/** Clerk members the app read that the stub lacks; `capture.ts` reports them. */
		__parityClerkUnknown?: Set<string>
		/** Clerk writes the app made (`organization.inviteMember`, `user.update`, ...); `capture.ts` logs them. */
		__parityClerkCalls?: Array<{ tag: string; payload: unknown }>
	}
}

export const installClerkStub = (identity: ClerkStubIdentity | null) => {
	const noop = () => {}
	const asyncNoop = async () => {}
	// Writes resolve and are logged as `clerk:<resource>.<method>` calls, so the behavior diff checks them.
	const calls: Array<{ tag: string; payload: unknown }> = []
	window.__parityClerkCalls = calls
	const write =
		(tag: string, result: unknown = {}) =>
		async (payload?: unknown) => {
			calls.push({ tag: `clerk:${tag}`, payload: payload === undefined ? null : payload })
			return result
		}
	// `File` payloads are not JSON: log the file's name and type.
	const fileWrite = (tag: string) => async (payload: { file: File | null }) => {
		const file = payload.file
		calls.push({
			tag: `clerk:${tag}`,
			payload: { file: file === null ? null : { name: file.name, type: file.type } },
		})
		return {}
	}
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
					publicMetadata: id.orgPublicMetadata,
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
								update: write("membership.update"),
								destroy: write("membership.destroy"),
							},
						],
						total_count: 1,
					}),
					getInvitations: async () => ({ data: [], total_count: 0 }),
					update: write("organization.update"),
					setLogo: fileWrite("organization.setLogo"),
					inviteMember: write("organization.inviteMember"),
				}
			: null
		const memberships = organization
			? [
					{
						id: "orgmem_parity",
						organization,
						role: id.role,
						permissions: [],
						publicMetadata: {},
						createdAt,
					},
				]
			: []
		// `useOrganizationList({ userMemberships })` pages through `user.getOrganizationMemberships`.
		const membershipPage = async () => ({ data: memberships, total_count: memberships.length })
		const primaryEmail = {
			id: "idn_parity_primary",
			emailAddress: id.email,
			verification: { status: "verified" },
			destroy: write("emailAddress.destroy"),
			prepareVerification: write("emailAddress.prepareVerification"),
			attemptVerification: write("emailAddress.attemptVerification"),
		}
		const totp = {
			uri: "otpauth://totp/Maple:parity?secret=JBSWY3DPEHPK3PXP&issuer=Maple",
			secret: "JBSWY3DPEHPK3PXP",
		}
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
			passkeys: [
				{
					id: "pk_parity",
					name: "MacBook Touch ID",
					createdAt,
					lastUsedAt: createdAt,
					update: write("passkey.update"),
					delete: write("passkey.delete"),
				},
			],
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
			update: write("user.update"),
			setProfileImage: fileWrite("user.setProfileImage"),
			delete: write("user.delete"),
			updatePassword: write("user.updatePassword"),
			createEmailAddress: write("user.createEmailAddress", primaryEmail),
			createPasskey: write("user.createPasskey"),
			createTOTP: write("user.createTOTP", totp),
			verifyTOTP: write("user.verifyTOTP", { backupCodes: [] }),
			disableTOTP: write("user.disableTOTP"),
			createBackupCode: write("user.createBackupCode", { codes: [] }),
			createExternalAccount: write("user.createExternalAccount"),
			leaveOrganization: write("user.leaveOrganization"),
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

	const base = {
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
	window.__parityClerkUnknown = unknownAccesses
	const clerk = new Proxy(base, {
		get(target, prop, receiver) {
			if (typeof prop === "string" && prop !== "then" && !(prop in target)) {
				if (isNoopMethod(prop)) return asyncNoop
				unknownAccesses.add(prop)
			}
			// The standard Proxy forwarding idiom: the trap's `prop` is any key the app reads.
			// oxlint-disable-next-line anti-slop/no-reflect-get
			return Reflect.get(target, prop, receiver)
		},
	})
	Reflect.set(window, "Clerk", clerk)
}
