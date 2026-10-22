/**
 * A small AWS for tests: STS AssumeRoleWithWebIdentity and the two IAM reads the connection check
 * makes, answered from roles "deployed" by interpreting a rendered CloudFormation template. Trust
 * is enforced the way AWS does it (the token's signature, the account's OIDC provider for its
 * issuer, the role's `aud` and `sub` conditions), so a test proves that the template Maple renders
 * is the one its check accepts.
 */
import { generateKeyPairSync } from "node:crypto"
import { Effect, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"

/** Maple's signing key in tests: the private half goes in the env, the fake verifies with the public. */
const generateKey = () =>
	generateKeyPairSync("rsa", {
		modulusLength: 2048,
		privateKeyEncoding: { type: "pkcs8", format: "pem" },
		publicKeyEncoding: { type: "spki", format: "pem" },
	})
export const MAPLE_TEST_OIDC_KEY = generateKey()
/** A key that is not Maple's: tokens signed with it must never verify. */
export const OTHER_TEST_OIDC_KEY = generateKey()

interface FakeRole {
	readonly accountId: string
	readonly roleName: string
	readonly trustedProviderArn: string
	/** The `<issuer>:aud` and `<issuer>:sub` values the trust policy requires. */
	readonly conditions: Readonly<Record<string, string>>
	readonly tags: ReadonlyArray<{ readonly Key: string; readonly Value: string }>
	readonly attachedPolicyNames: ReadonlyArray<string>
	/** Whether the role may read itself (the template's self-read policy). */
	readonly canReadSelf: boolean
}

interface FakeProvider {
	readonly url: string
	readonly clientIds: ReadonlyArray<string>
}

const Template = Schema.Struct({
	Resources: Schema.Record(
		Schema.String,
		Schema.Struct({ Type: Schema.String, Properties: Schema.Record(Schema.String, Schema.Unknown) }),
	),
})

// A literal ARN, or the template's `Fn::If` between the provider it creates and an existing one.
const FederatedPrincipal = Schema.Union([
	Schema.String,
	Schema.Struct({ "Fn::If": Schema.Tuple([Schema.String, Schema.Unknown, Schema.String]) }),
])

const TrustDocument = Schema.Struct({
	Statement: Schema.Array(
		Schema.Struct({
			Principal: Schema.Struct({ Federated: FederatedPrincipal }),
			Action: Schema.String,
			Condition: Schema.Struct({ StringEquals: Schema.Record(Schema.String, Schema.String) }),
		}),
	),
})

const RoleProperties = Schema.Struct({
	RoleName: Schema.String,
	AssumeRolePolicyDocument: TrustDocument,
	ManagedPolicyArns: Schema.Array(Schema.Union([Schema.String, Schema.Struct({ Ref: Schema.String })])),
	Policies: Schema.Array(Schema.Struct({ PolicyName: Schema.String })),
	Tags: Schema.Array(Schema.Struct({ Key: Schema.String, Value: Schema.String })),
})

const PolicyProperties = Schema.Struct({ ManagedPolicyName: Schema.String })
const ProviderProperties = Schema.Struct({ Url: Schema.String, ClientIdList: Schema.Array(Schema.String) })

const providerArnOf = (accountId: string, issuer: string) =>
	`arn:aws:iam::${accountId}:oidc-provider/${issuer.replace(/^https:\/\//u, "")}`

/** The role a template creates, and the OIDC provider it registers, as a deploy would in `accountId`. */
export const deployTemplate = (
	accountId: string,
	templateJson: string,
	createsProvider = true,
): { readonly role: FakeRole; readonly provider: FakeProvider | undefined } => {
	const template = Schema.decodeUnknownSync(Template)(JSON.parse(templateJson))
	const resources = template.Resources
	const role = Object.values(resources).find((resource) => resource.Type === "AWS::IAM::Role")
	if (role === undefined) throw new Error("template has no role")
	const properties = Schema.decodeUnknownSync(RoleProperties)(role.Properties)
	const [statement] = properties.AssumeRolePolicyDocument.Statement
	if (statement === undefined) throw new Error("role has no trust statement")
	if (statement.Action !== "sts:AssumeRoleWithWebIdentity") throw new Error("role is not federated")
	const attachedPolicyNames = properties.ManagedPolicyArns.map((arn) => {
		if (typeof arn === "string") return arn.split("/").at(-1) ?? arn
		const policy = resources[arn.Ref]
		if (policy === undefined) throw new Error(`no resource ${arn.Ref}`)
		return Schema.decodeUnknownSync(PolicyProperties)(policy.Properties).ManagedPolicyName
	})
	const federated = statement.Principal.Federated
	const providerResource = Object.values(resources).find(
		(resource) => resource.Type === "AWS::IAM::OIDCProvider",
	)
	const provider =
		providerResource === undefined
			? undefined
			: Schema.decodeUnknownSync(ProviderProperties)(providerResource.Properties)
	return {
		role: {
			accountId,
			roleName: properties.RoleName,
			// The `Fn::If` resolves to the `Ref` of the provider the stack creates, else the literal ARN.
			trustedProviderArn:
				typeof federated === "string"
					? federated
					: createsProvider && provider !== undefined
						? providerArnOf(accountId, provider.Url)
						: federated["Fn::If"][2],
			conditions: statement.Condition.StringEquals,
			tags: properties.Tags,
			attachedPolicyNames,
			canReadSelf: properties.Policies.some((policy) => policy.PolicyName === "maple-self-read"),
		},
		provider:
			provider === undefined ? undefined : { url: provider.Url, clientIds: provider.ClientIdList },
	}
}

const xml = (status: number, body: string) =>
	new Response(body, { status, headers: { "content-type": "text/xml" } })

// Maple asks STS for JSON.
const json = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const stsError = (status: number, code: string, message: string) =>
	json(status, { Error: { Type: "Sender", Code: code, Message: message }, RequestId: "req" })

const iamError = (status: number, code: string, message: string) =>
	xml(
		status,
		`<ErrorResponse xmlns="https://iam.amazonaws.com/doc/2010-05-08/"><Error><Type>Sender</Type><Code>${code}</Code><Message>${message}</Message></Error><RequestId>req</RequestId></ErrorResponse>`,
	)

const decoder = new TextDecoder()

const fromBase64url = (part: string) => new Uint8Array(Buffer.from(part, "base64url"))

const TokenClaims = Schema.Struct({ iss: Schema.String, aud: Schema.String, sub: Schema.String })

/** The claims of `token` when its RS256 signature verifies with `key`. */
const verifiedClaims = async (key: CryptoKey, token: string) => {
	const [header, body, signature] = token.split(".")
	if (header === undefined || body === undefined || signature === undefined) return undefined
	const valid = await crypto.subtle.verify(
		"RSASSA-PKCS1-v1_5",
		key,
		fromBase64url(signature),
		new TextEncoder().encode(`${header}.${body}`),
	)
	return valid
		? Schema.decodeUnknownSync(TokenClaims)(JSON.parse(Buffer.from(body, "base64url").toString("utf8")))
		: undefined
}

/** The signing key id of a SigV4 request: `Credential=<key>/<date>/...`. */
const signingKey = (authorization: string | undefined) =>
	/Credential=([^/]+)\//u.exec(authorization ?? "")?.[1]

export interface FakeAws {
	readonly client: HttpClient.HttpClient
	/** Every call, as `<Action>`. */
	readonly calls: Array<string>
	/** The role ARN of every AssumeRoleWithWebIdentity, in order. */
	readonly assumed: Array<string>
	/** Deploys a template. Without `createsProvider` it leaves the OIDC provider out, as `CreateOidcProvider=false` does. */
	readonly deploy: (
		accountId: string,
		templateJson: string,
		options?: { readonly createsProvider?: boolean; readonly providerAudience?: string },
	) => void
	/** Deletes every role of an account, as deleting its stack would. Providers are retained. */
	readonly deleteStacks: (accountId: string) => void
	/** Runs before every call: a test makes AWS slow with a `TestClock` adjustment. */
	beforeEachCall: Effect.Effect<void>
	/** Answers every call with this error instead, as AWS does when it throttles or fails. */
	failWith: { readonly status: number; readonly code: string } | undefined
}

/** AWS fetches the issuer's JWKS; here it is `issuerPublicKeyPem`, whatever the issuer. */
export const makeFakeAws = (issuerPublicKeyPem: string = MAPLE_TEST_OIDC_KEY.publicKey): FakeAws => {
	const roles = new Map<string, FakeRole>()
	// Provider ARN → provider. Retained across stack deletes, as the template's DeletionPolicy says.
	const providers = new Map<string, FakeProvider>()
	// Session key id → the role it is a session of.
	const sessions = new Map<string, FakeRole>()
	const calls: Array<string> = []
	const assumed: Array<string> = []
	const pem = issuerPublicKeyPem.replace(/-----(BEGIN|END) PUBLIC KEY-----/gu, "").replace(/\s+/gu, "")
	const issuerKey = crypto.subtle.importKey(
		"spki",
		Buffer.from(pem, "base64"),
		{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
		false,
		["verify"],
	)

	const assumeRoleWithWebIdentity = async (form: URLSearchParams) => {
		const roleArn = form.get("RoleArn") ?? ""
		assumed.push(roleArn)
		const accountId = /^arn:aws:iam::([0-9]{12}):role\//u.exec(roleArn)?.[1] ?? ""
		const claims = await verifiedClaims(await issuerKey, form.get("WebIdentityToken") ?? "")
		if (claims === undefined)
			return stsError(400, "InvalidIdentityToken", "The token signature is invalid.")
		const providerArn = providerArnOf(accountId, claims.iss)
		const provider = providers.get(providerArn)
		if (provider === undefined) {
			return stsError(
				400,
				"InvalidIdentityToken",
				`No OpenIDConnect provider found in your account for ${claims.iss}`,
			)
		}
		if (!provider.clientIds.includes(claims.aud)) {
			return stsError(400, "InvalidIdentityToken", "Incorrect token audience")
		}
		const role = roles.get(roleArn)
		const issuer = claims.iss.replace(/^https:\/\//u, "")
		if (
			role === undefined ||
			role.trustedProviderArn !== providerArn ||
			role.conditions[`${issuer}:aud`] !== claims.aud ||
			role.conditions[`${issuer}:sub`] !== claims.sub
		) {
			return stsError(403, "AccessDenied", "Not authorized to perform sts:AssumeRoleWithWebIdentity")
		}
		const sessionKey = `ASIA${String(sessions.size).padStart(16, "0")}`
		sessions.set(sessionKey, role)
		const session = form.get("RoleSessionName") ?? ""
		return json(200, {
			AssumeRoleWithWebIdentityResponse: {
				AssumeRoleWithWebIdentityResult: {
					Credentials: {
						AccessKeyId: sessionKey,
						SecretAccessKey: "secret",
						SessionToken: "token",
						Expiration: 1893456000,
					},
					AssumedRoleUser: {
						AssumedRoleId: `AROAFAKE:${session}`,
						Arn: `arn:aws:sts::${role.accountId}:assumed-role/${role.roleName}/${session}`,
					},
					SubjectFromWebIdentityToken: claims.sub,
				},
				ResponseMetadata: { RequestId: "req" },
			},
		})
	}

	const state: FakeAws = {
		calls,
		assumed,
		beforeEachCall: Effect.void,
		failWith: undefined,
		deploy: (accountId, templateJson, options) => {
			const createsProvider = options?.createsProvider !== false
			const { role, provider } = deployTemplate(accountId, templateJson, createsProvider)
			roles.set(`arn:aws:iam::${accountId}:role/${role.roleName}`, role)
			if (provider !== undefined && createsProvider) {
				const clientIds =
					options?.providerAudience === undefined ? provider.clientIds : [options.providerAudience]
				providers.set(providerArnOf(accountId, provider.url), { url: provider.url, clientIds })
			}
		},
		deleteStacks: (accountId) => {
			for (const [arn, role] of roles) if (role.accountId === accountId) roles.delete(arn)
		},
		client: HttpClient.make((request) =>
			Effect.suspend(() => state.beforeEachCall).pipe(
				Effect.andThen(
					Effect.promise(async () => {
						const body =
							request.body._tag === "Uint8Array" ? decoder.decode(request.body.body) : ""
						const form = new URLSearchParams(body)
						const action = form.get("Action") ?? ""
						calls.push(action)
						const respond = (response: Response) => HttpClientResponse.fromWeb(request, response)
						if (state.failWith !== undefined) {
							return respond(
								action === "AssumeRoleWithWebIdentity"
									? stsError(state.failWith.status, state.failWith.code, "fake failure")
									: iamError(state.failWith.status, state.failWith.code, "fake failure"),
							)
						}
						if (action === "AssumeRoleWithWebIdentity") {
							// Unsigned: a web identity call carries no AWS credentials.
							if (request.headers["authorization"] !== undefined) {
								return respond(
									stsError(
										400,
										"InvalidRequest",
										"AssumeRoleWithWebIdentity is not signed",
									),
								)
							}
							return respond(await assumeRoleWithWebIdentity(form))
						}
						const key = signingKey(request.headers["authorization"])
						const role = key === undefined ? undefined : sessions.get(key)
						const stillDeployed =
							role !== undefined &&
							roles.has(`arn:aws:iam::${role.accountId}:role/${role.roleName}`)
						if (
							role === undefined ||
							!stillDeployed ||
							request.headers["x-amz-security-token"] !== "token"
						) {
							return respond(
								iamError(403, "InvalidClientTokenId", "The security token is invalid."),
							)
						}
						if (!role.canReadSelf || form.get("RoleName") !== role.roleName) {
							return respond(
								iamError(403, "AccessDenied", `not authorized to perform: iam:${action}`),
							)
						}
						if (action === "GetRole") {
							const tags = role.tags
								.map(
									(tag) =>
										`<member><Key>${tag.Key}</Key><Value>${tag.Value}</Value></member>`,
								)
								.join("")
							return respond(
								xml(
									200,
									`<GetRoleResponse xmlns="https://iam.amazonaws.com/doc/2010-05-08/"><GetRoleResult><Role><Path>/</Path><RoleName>${role.roleName}</RoleName><RoleId>AROAFAKE</RoleId><Arn>arn:aws:iam::${role.accountId}:role/${role.roleName}</Arn><CreateDate>2026-10-21T12:00:00Z</CreateDate><Tags>${tags}</Tags></Role></GetRoleResult><ResponseMetadata><RequestId>req</RequestId></ResponseMetadata></GetRoleResponse>`,
								),
							)
						}
						if (action === "ListAttachedRolePolicies") {
							const policies = role.attachedPolicyNames
								.map(
									(name) =>
										`<member><PolicyName>${name}</PolicyName><PolicyArn>arn:aws:iam::${role.accountId}:policy/${name}</PolicyArn></member>`,
								)
								.join("")
							return respond(
								xml(
									200,
									`<ListAttachedRolePoliciesResponse xmlns="https://iam.amazonaws.com/doc/2010-05-08/"><ListAttachedRolePoliciesResult><AttachedPolicies>${policies}</AttachedPolicies><IsTruncated>false</IsTruncated></ListAttachedRolePoliciesResult><ResponseMetadata><RequestId>req</RequestId></ResponseMetadata></ListAttachedRolePoliciesResponse>`,
								),
							)
						}
						return respond(iamError(400, "InvalidAction", `unknown action ${action}`))
					}),
				),
			),
		),
	}
	return state
}
