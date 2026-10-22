/**
 * AWS access through `@distilled.cloud/aws`: Maple's own key assumes a customer role, and the role
 * reads itself back. Every SDK failure is folded into one {@link AwsApiError} whose `kind` says what
 * the connection check reports.
 */
import * as Credentials from "@distilled.cloud/aws/Credentials"
import { UnknownAwsError } from "@distilled.cloud/aws/Errors"
import * as IAM from "@distilled.cloud/aws/iam"
import * as STS from "@distilled.cloud/aws/sts"
import { Duration, Effect, Redacted, Stream } from "effect"
import { HttpClient } from "effect/http"
import { AwsApiError } from "./errors"

const REQUEST_TIMEOUT = Duration.seconds(20)
// STS and IAM answer in us-east-1 for every commercial account.
const REGION = "us-east-1"
// The shortest session AWS allows: a check needs seconds, and nothing keeps the credentials.
const SESSION_SECONDS = 900

export interface AwsKey {
	readonly accessKeyId: string
	readonly secretAccessKey: Redacted.Redacted<string>
}

export interface AwsRoleTarget {
	readonly roleArn: string
	readonly roleName: string
	readonly externalId: string
	readonly sessionName: string
}

export interface AwsRoleReport {
	/** The account of the session AWS handed out. */
	readonly accountId: string
	readonly tags: ReadonlyArray<{ readonly key: string; readonly value: string }>
	readonly attachedPolicyNames: ReadonlyArray<string>
}

// Codes AWS answers a rejected caller key with, as opposed to a role that refuses it.
const MAPLE_KEY_CODES = new Set([
	"InvalidClientTokenId",
	"SignatureDoesNotMatch",
	"UnrecognizedClientException",
	"IncompleteSignature",
])
const THROTTLE_CODES = new Set(["Throttling", "ThrottlingException", "RequestLimitExceeded"])

const codeOf = (error: { readonly _tag: string }) =>
	error instanceof UnknownAwsError ? error.errorTag : error._tag

const messageOf = (error: unknown) =>
	typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
		? error.message
		: undefined

const toApiError =
	(denied: "assume_denied" | "read_denied", what: string) =>
	(error: { readonly _tag: string }): AwsApiError => {
		const code = codeOf(error)
		const detail = messageOf(error)?.slice(0, 300)
		const message = detail === undefined || detail === "" ? `${what}: ${code}` : `${what}: ${detail}`
		if (MAPLE_KEY_CODES.has(code)) return new AwsApiError({ message, kind: "maple_credentials", code })
		if (THROTTLE_CODES.has(code)) return new AwsApiError({ message, kind: "throttled", code })
		if (code === "AccessDenied" || code === "AccessDeniedException" || code === "NoSuchEntityException") {
			return new AwsApiError({ message, kind: denied, code })
		}
		return new AwsApiError({ message, kind: "upstream", code })
	}

/** What an operation signs with: fixed credentials, in the region STS and IAM answer in. */
const signWith = (credentials: {
	readonly accessKeyId: Redacted.Redacted<string>
	readonly secretAccessKey: Redacted.Redacted<string>
	readonly sessionToken?: Redacted.Redacted<string>
}): Credentials.Credentials["Service"] =>
	Effect.succeed({
		accessKeyId: credentials.accessKeyId,
		secretAccessKey: credentials.secretAccessKey,
		sessionToken: credentials.sessionToken,
		region: REGION,
	})

const timedOut = (what: string) =>
	new AwsApiError({ message: `${what}: AWS did not answer in time`, kind: "upstream" })

/**
 * Assumes `target` with Maple's key, then reads the role's tags and attached policies with the
 * session. Each read needs only the setup's self-read policy.
 */
export const checkRole = Effect.fn("AwsApi.checkRole")(function* (
	httpClient: HttpClient.HttpClient,
	key: AwsKey,
	target: AwsRoleTarget,
) {
	yield* Effect.annotateCurrentSpan({ "maple.aws.role_arn": target.roleArn })
	const assumed = yield* STS.assumeRole({
		RoleArn: target.roleArn,
		RoleSessionName: target.sessionName,
		ExternalId: target.externalId,
		DurationSeconds: SESSION_SECONDS,
	}).pipe(
		Effect.provideService(
			Credentials.Credentials,
			signWith({ accessKeyId: Redacted.make(key.accessKeyId), secretAccessKey: key.secretAccessKey }),
		),
		Effect.provideService(HttpClient.HttpClient, httpClient),
		Effect.timeoutOrElse({
			duration: REQUEST_TIMEOUT,
			orElse: () => Effect.fail(timedOut("AssumeRole")),
		}),
		Effect.mapError((error) =>
			error instanceof AwsApiError ? error : toApiError("assume_denied", "AssumeRole")(error),
		),
	)
	const credentials = assumed.Credentials
	const sessionArn = assumed.AssumedRoleUser?.Arn
	if (credentials === undefined || sessionArn === undefined) {
		return yield* new AwsApiError({ message: "AssumeRole returned no credentials", kind: "upstream" })
	}
	const session = signWith({
		accessKeyId: Redacted.make(credentials.AccessKeyId),
		secretAccessKey: Redacted.isRedacted(credentials.SecretAccessKey)
			? credentials.SecretAccessKey
			: Redacted.make(credentials.SecretAccessKey),
		sessionToken: Redacted.make(credentials.SessionToken),
	})
	const asRole = <A, E extends { readonly _tag: string }>(
		what: string,
		effect: Effect.Effect<A, E, never>,
	) =>
		effect.pipe(
			Effect.timeoutOrElse({ duration: REQUEST_TIMEOUT, orElse: () => Effect.fail(timedOut(what)) }),
			Effect.mapError((error) =>
				error instanceof AwsApiError ? error : toApiError("read_denied", what)(error),
			),
		)
	const [role, attached] = yield* Effect.all(
		[
			asRole(
				"GetRole",
				IAM.getRole({ RoleName: target.roleName }).pipe(
					Effect.provideService(Credentials.Credentials, session),
					Effect.provideService(HttpClient.HttpClient, httpClient),
				),
			),
			asRole(
				"ListAttachedRolePolicies",
				IAM.listAttachedRolePolicies
					.items({ RoleName: target.roleName })
					.pipe(
						Stream.runCollect,
						Effect.provideService(Credentials.Credentials, session),
						Effect.provideService(HttpClient.HttpClient, httpClient),
					),
			),
		],
		// One at a time: a sweep runs several checks, and each fetch holds one of the Worker's connections.
		{ concurrency: 1 },
	)
	return {
		accountId: /^arn:aws:sts::([0-9]{12}):/u.exec(sessionArn)?.[1] ?? "",
		tags: (role.Role.Tags ?? []).map((tag) => ({ key: tag.Key, value: tag.Value })),
		attachedPolicyNames: attached.flatMap((policy) =>
			policy.PolicyName === undefined ? [] : [policy.PolicyName],
		),
	} satisfies AwsRoleReport
})
