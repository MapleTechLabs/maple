import { createHash, timingSafeEqual } from "node:crypto"
import { createClerkClient } from "@clerk/backend"
import {
	PreviewSignInDisabledError,
	PreviewSignInInvalidKeyError,
	PreviewSignInResponse,
	PreviewSignInStatusResponse,
	PreviewSignInUnavailableError,
} from "@maple/domain/http"
import { Context, Effect, Layer, Option, Redacted } from "effect"
import { Env, type EnvConfig } from "@maple/backend/platform/Env"
import { clerkRequest, type ClerkRequestError } from "@maple/backend/services/auth/clerk-request"

/**
 * One reviewer identity shared by every preview, kept apart from the developers' own dev users
 * so a leaked preview session reaches nothing but preview data.
 */
export const PREVIEW_REVIEWER_EMAIL = "preview-reviewer+clerk_test@maple.dev"
export const PREVIEW_REVIEWER_ORG_NAME = "Preview"

/** Clerk's page maximum; the reviewer only ever joins orgs this service creates. */
const MEMBERSHIP_PAGE_LIMIT = 500

/** Long enough to survive the redirect to `/sign-in`, short enough to be useless if copied. */
const TICKET_TTL_SECONDS = 120

/** The slice of the Clerk Backend API this service uses; tests supply a fake. */
export interface PreviewClerk {
	readonly findUserIdByEmail: (email: string) => Effect.Effect<Option.Option<string>, ClerkRequestError>
	readonly createUser: (email: string) => Effect.Effect<string, ClerkRequestError>
	/** Whether `userId` belongs to an organization called `name`; other memberships do not count. */
	readonly isMemberOf: (userId: string, name: string) => Effect.Effect<boolean, ClerkRequestError>
	readonly createOrganization: (userId: string, name: string) => Effect.Effect<void, ClerkRequestError>
	readonly createSignInToken: (
		userId: string,
		ttlSeconds: number,
	) => Effect.Effect<string, ClerkRequestError>
}

export interface PreviewSignInServiceApi {
	readonly status: () => Effect.Effect<PreviewSignInStatusResponse>
	readonly signIn: (
		key: string,
	) => Effect.Effect<
		PreviewSignInResponse,
		PreviewSignInDisabledError | PreviewSignInInvalidKeyError | PreviewSignInUnavailableError
	>
}

const digest = (value: string) => createHash("sha256").update(value).digest()

/** Hashing first makes the comparison constant-time regardless of the guess's length. */
const keyMatches = (provided: string, expected: string) => timingSafeEqual(digest(provided), digest(expected))

type PreviewEnv = Pick<
	EnvConfig,
	"MAPLE_AUTH_MODE" | "MAPLE_ENVIRONMENT" | "CLERK_SECRET_KEY" | "PREVIEW_SIGNIN_KEY"
>

/**
 * The key only means anything on a PR stage running a Clerk development instance: tickets
 * minted by a production instance would be real sessions for real people.
 */
export const previewKey = (env: PreviewEnv): Option.Option<string> =>
	env.MAPLE_AUTH_MODE.toLowerCase() === "clerk" &&
	/^pr-\d+$/.test(env.MAPLE_ENVIRONMENT) &&
	Option.exists(env.CLERK_SECRET_KEY, (secret) => Redacted.value(secret).startsWith("sk_test_"))
		? Option.map(
				Option.filter(env.PREVIEW_SIGNIN_KEY, (key) => Redacted.value(key).trim().length > 0),
				Redacted.value,
			)
		: Option.none()

/** `None` is the state of every non-preview deployment: status says disabled, sign-in 404s. */
export const makePreviewSignIn = (
	enabled: Option.Option<{ readonly key: string; readonly clerk: PreviewClerk }>,
): PreviewSignInServiceApi => {
	const unavailable = (error: ClerkRequestError) =>
		new PreviewSignInUnavailableError({ message: `Clerk: ${error.message}`, cause: error })

	const ensureReviewer = Effect.fnUntraced(function* (clerk: PreviewClerk) {
		const existing = yield* clerk.findUserIdByEmail(PREVIEW_REVIEWER_EMAIL)
		const userId = Option.isSome(existing)
			? existing.value
			: yield* clerk.createUser(PREVIEW_REVIEWER_EMAIL)
		// Without an org the app parks the reviewer on `/org-required`; the preview's empty
		// database provisions the org's rows on first request.
		if (!(yield* clerk.isMemberOf(userId, PREVIEW_REVIEWER_ORG_NAME))) {
			yield* clerk.createOrganization(userId, PREVIEW_REVIEWER_ORG_NAME)
		}
		return userId
	})

	const signIn = Effect.fn("PreviewSignInService.signIn")(function* (key: string) {
		if (Option.isNone(enabled)) {
			return yield* new PreviewSignInDisabledError({ message: "Preview sign-in is not enabled here" })
		}
		const { clerk } = enabled.value
		if (!keyMatches(key, enabled.value.key)) {
			return yield* new PreviewSignInInvalidKeyError({ message: "Invalid preview access key" })
		}
		const userId = yield* ensureReviewer(clerk).pipe(Effect.mapError(unavailable))
		const ticket = yield* clerk
			.createSignInToken(userId, TICKET_TTL_SECONDS)
			.pipe(Effect.mapError(unavailable))
		return new PreviewSignInResponse({ ticket })
	})

	return {
		status: () => Effect.succeed(new PreviewSignInStatusResponse({ enabled: Option.isSome(enabled) })),
		signIn,
	}
}

const clerkPort = (secretKey: string): PreviewClerk => {
	const clerk = createClerkClient({ secretKey })
	return {
		findUserIdByEmail: (email) =>
			clerkRequest("Clerk.users.getUserList", {}, () =>
				clerk.users.getUserList({ emailAddress: [email], limit: 1 }),
			).pipe(Effect.map((response) => Option.fromNullishOr(response.data[0]?.id))),
		createUser: (email) =>
			clerkRequest("Clerk.users.createUser", {}, () =>
				clerk.users.createUser({
					emailAddress: [email],
					firstName: "Preview",
					lastName: "Reviewer",
					skipPasswordRequirement: true,
				}),
			).pipe(Effect.map((user) => user.id)),
		isMemberOf: (userId, name) =>
			clerkRequest("Clerk.users.getOrganizationMembershipList", { "tenant.userId": userId }, () =>
				clerk.users.getOrganizationMembershipList({ userId, limit: MEMBERSHIP_PAGE_LIMIT }),
			).pipe(Effect.map((response) => response.data.some((m) => m.organization.name === name))),
		createOrganization: (userId, name) =>
			clerkRequest("Clerk.organizations.createOrganization", { "tenant.userId": userId }, () =>
				clerk.organizations.createOrganization({ name, createdBy: userId }),
			).pipe(Effect.asVoid),
		createSignInToken: (userId, ttlSeconds) =>
			clerkRequest("Clerk.signInTokens.createSignInToken", { "tenant.userId": userId }, () =>
				clerk.signInTokens.createSignInToken({ userId, expiresInSeconds: ttlSeconds }),
			).pipe(Effect.map((token) => token.token)),
	}
}

export class PreviewSignInService extends Context.Service<PreviewSignInService, PreviewSignInServiceApi>()(
	"@maple/backend/services/auth/PreviewSignInService",
	{
		make: Effect.gen(function* () {
			const env = yield* Env
			const clerk = Option.map(env.CLERK_SECRET_KEY, (secret) => clerkPort(Redacted.value(secret)))
			return makePreviewSignIn(Option.zipWith(previewKey(env), clerk, (key, clerk) => ({ key, clerk })))
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
