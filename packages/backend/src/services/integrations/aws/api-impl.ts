/**
 * AWS access: Maple's OIDC token assumes a customer role through STS, unsigned, and the role reads
 * itself back through `@distilled.cloud/aws`. Every failure is folded into one {@link AwsApiError}
 * whose `kind` says what the connection check reports.
 */
import * as Credentials from "@distilled.cloud/aws/Credentials"
import { UnknownAwsError } from "@distilled.cloud/aws/Errors"
import * as IAM from "@distilled.cloud/aws/iam"
import { Duration, Effect, Redacted, Schema, Stream } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { AwsApiError } from "./errors"

const REQUEST_TIMEOUT = Duration.seconds(20)
// STS and IAM answer in us-east-1 for every commercial account.
const REGION = "us-east-1"
const STS_URL = "https://sts.amazonaws.com/"
// The shortest session AWS allows: a check needs seconds, and nothing keeps the credentials.
const SESSION_SECONDS = 900

export interface AwsRoleTarget {
	readonly roleArn: string
	readonly roleName: string
	readonly sessionName: string
}

export interface AwsRoleReport {
	/** The account of the session AWS handed out. */
	readonly accountId: string
	readonly tags: ReadonlyArray<{ readonly key: string; readonly value: string }>
	readonly attachedPolicyNames: ReadonlyArray<string>
}

// STS answers these when it cannot verify Maple's token: on Maple's side, not the customer's.
const MAPLE_TOKEN_CODES = new Set(["InvalidIdentityToken", "IDPCommunicationError", "ExpiredTokenException"])
// IAM answers these to a session it does not accept.
const SESSION_CODES = new Set([
	"InvalidClientTokenId",
	"SignatureDoesNotMatch",
	"UnrecognizedClientException",
])
const THROTTLE_CODES = new Set(["Throttling", "ThrottlingException", "RequestLimitExceeded"])

/** What STS answers `AssumeRoleWithWebIdentity` with, when asked for JSON. */
const StsAnswer = Schema.Union([
	Schema.Struct({
		AssumeRoleWithWebIdentityResponse: Schema.Struct({
			AssumeRoleWithWebIdentityResult: Schema.Struct({
				Credentials: Schema.Struct({
					AccessKeyId: Schema.String,
					SecretAccessKey: Schema.String,
					SessionToken: Schema.String,
				}),
				AssumedRoleUser: Schema.Struct({ Arn: Schema.String }),
			}),
		}),
	}),
	Schema.Struct({
		Error: Schema.Struct({ Code: Schema.String, Message: Schema.optionalKey(Schema.String) }),
	}),
])
const decodeStsAnswer = Schema.decodeUnknownEffect(StsAnswer)

/**
 * A rejected `AssumeRoleWithWebIdentity`. A missing OIDC provider or a refused claim is the
 * customer's setup not being done; a token STS cannot verify is Maple's.
 */
const stsError = (code: string, detail: string | undefined): AwsApiError => {
	const message = `AssumeRoleWithWebIdentity: ${detail === undefined || detail === "" ? code : detail.slice(0, 300)}`
	if (THROTTLE_CODES.has(code)) return new AwsApiError({ message, kind: "throttled", code })
	const noProvider = code === "InvalidIdentityToken" && /no openid ?connect provider/iu.test(detail ?? "")
	if (code === "AccessDenied" || code === "IDPRejectedClaim" || noProvider) {
		return new AwsApiError({ message, kind: "assume_denied", code })
	}
	if (MAPLE_TOKEN_CODES.has(code)) return new AwsApiError({ message, kind: "maple_identity", code })
	return new AwsApiError({ message, kind: "upstream", code })
}

const codeOf = (error: { readonly _tag: string }) =>
	error instanceof UnknownAwsError ? error.errorTag : error._tag

const messageOf = (error: unknown) =>
	typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
		? error.message
		: undefined

const toReadError =
	(what: string) =>
	(error: { readonly _tag: string }): AwsApiError => {
		const code = codeOf(error)
		const detail = messageOf(error)?.slice(0, 300)
		const message = detail === undefined || detail === "" ? `${what}: ${code}` : `${what}: ${detail}`
		if (THROTTLE_CODES.has(code)) return new AwsApiError({ message, kind: "throttled", code })
		if (SESSION_CODES.has(code)) return new AwsApiError({ message, kind: "upstream", code })
		if (code === "AccessDenied" || code === "AccessDeniedException" || code === "NoSuchEntityException") {
			return new AwsApiError({ message, kind: "read_denied", code })
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

const assumeWithToken = (
	httpClient: HttpClient.HttpClient,
	token: Redacted.Redacted<string>,
	target: AwsRoleTarget,
) =>
	HttpClientRequest.post(STS_URL).pipe(
		HttpClientRequest.acceptJson,
		HttpClientRequest.bodyUrlParams({
			Action: "AssumeRoleWithWebIdentity",
			Version: "2011-06-15",
			RoleArn: target.roleArn,
			RoleSessionName: target.sessionName,
			WebIdentityToken: Redacted.value(token),
			DurationSeconds: String(SESSION_SECONDS),
		}),
		httpClient.execute,
		Effect.flatMap((response) => response.json),
		Effect.flatMap(decodeStsAnswer),
		Effect.timeoutOrElse({
			duration: REQUEST_TIMEOUT,
			orElse: () => Effect.fail(timedOut("AssumeRoleWithWebIdentity")),
		}),
		Effect.mapError((error) =>
			error instanceof AwsApiError
				? error
				: new AwsApiError({
						message: `AssumeRoleWithWebIdentity: ${error.message}`,
						kind: "upstream",
					}),
		),
		Effect.flatMap((answer) =>
			"Error" in answer
				? Effect.fail(stsError(answer.Error.Code, answer.Error.Message))
				: Effect.succeed(answer.AssumeRoleWithWebIdentityResponse.AssumeRoleWithWebIdentityResult),
		),
	)

/**
 * Assumes `target` with Maple's token, then reads the role's tags and attached policies with the
 * session. Each read needs only the setup's self-read policy.
 */
export const checkRole = Effect.fn("AwsApi.checkRole")(function* (
	httpClient: HttpClient.HttpClient,
	token: Redacted.Redacted<string>,
	target: AwsRoleTarget,
) {
	yield* Effect.annotateCurrentSpan({ "maple.aws.role_arn": target.roleArn })
	const assumed = yield* assumeWithToken(httpClient, token, target)
	const credentials = assumed.Credentials
	const sessionArn = assumed.AssumedRoleUser.Arn
	const session = signWith({
		accessKeyId: Redacted.make(credentials.AccessKeyId),
		secretAccessKey: Redacted.make(credentials.SecretAccessKey),
		sessionToken: Redacted.make(credentials.SessionToken),
	})
	const asRole = <A, E extends { readonly _tag: string }>(
		what: string,
		effect: Effect.Effect<A, E, never>,
	) =>
		effect.pipe(
			Effect.timeoutOrElse({ duration: REQUEST_TIMEOUT, orElse: () => Effect.fail(timedOut(what)) }),
			Effect.mapError((error) => (error instanceof AwsApiError ? error : toReadError(what)(error))),
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
