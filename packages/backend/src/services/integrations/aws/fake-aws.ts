/**
 * A small AWS for tests: STS AssumeRole and the two IAM reads the connection check makes, answered
 * from roles "deployed" by interpreting a rendered CloudFormation template. Trust is enforced the
 * way AWS does it (principal, external id, signing key), so a test proves that the template Maple
 * renders is the one its check accepts.
 */
import { Effect, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"

export const MAPLE_ACCESS_KEY_ID = "AKIAMAPLETEST0000001"
export const MAPLE_PRINCIPAL_ARN = "arn:aws:iam::999999999999:user/maple-integrations"

interface FakeRole {
	readonly accountId: string
	readonly roleName: string
	readonly trustedPrincipalArn: string
	readonly externalId: string
	readonly tags: ReadonlyArray<{ readonly Key: string; readonly Value: string }>
	readonly attachedPolicyNames: ReadonlyArray<string>
	/** Whether the role may read itself (the template's self-read policy). */
	readonly canReadSelf: boolean
}

const Template = Schema.Struct({
	Resources: Schema.Record(
		Schema.String,
		Schema.Struct({ Type: Schema.String, Properties: Schema.Record(Schema.String, Schema.Unknown) }),
	),
})

const TrustDocument = Schema.Struct({
	Statement: Schema.Array(
		Schema.Struct({
			Condition: Schema.Struct({
				StringEquals: Schema.Struct({ "sts:ExternalId": Schema.String }),
				ArnEquals: Schema.Struct({ "aws:PrincipalArn": Schema.String }),
			}),
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

/** The role a template creates, as `aws cloudformation deploy` would in `accountId`. */
export const deployTemplate = (accountId: string, templateJson: string): FakeRole => {
	const template = Schema.decodeUnknownSync(Template)(JSON.parse(templateJson))
	const resources = template.Resources
	const role = Object.values(resources).find((resource) => resource.Type === "AWS::IAM::Role")
	if (role === undefined) throw new Error("template has no role")
	const properties = Schema.decodeUnknownSync(RoleProperties)(role.Properties)
	const [statement] = properties.AssumeRolePolicyDocument.Statement
	if (statement === undefined) throw new Error("role has no trust statement")
	const attachedPolicyNames = properties.ManagedPolicyArns.map((arn) => {
		if (typeof arn === "string") return arn.split("/").at(-1) ?? arn
		const policy = resources[arn.Ref]
		if (policy === undefined) throw new Error(`no resource ${arn.Ref}`)
		return Schema.decodeUnknownSync(PolicyProperties)(policy.Properties).ManagedPolicyName
	})
	return {
		accountId,
		roleName: properties.RoleName,
		trustedPrincipalArn: statement.Condition.ArnEquals["aws:PrincipalArn"],
		externalId: statement.Condition.StringEquals["sts:ExternalId"],
		tags: properties.Tags,
		attachedPolicyNames,
		canReadSelf: properties.Policies.some((policy) => policy.PolicyName === "maple-self-read"),
	}
}

const xml = (status: number, body: string) =>
	new Response(body, { status, headers: { "content-type": "text/xml" } })

const stsError = (status: number, code: string, message: string) =>
	xml(
		status,
		`<ErrorResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><Error><Type>Sender</Type><Code>${code}</Code><Message>${message}</Message></Error><RequestId>req</RequestId></ErrorResponse>`,
	)

const iamError = (status: number, code: string, message: string) =>
	xml(
		status,
		`<ErrorResponse xmlns="https://iam.amazonaws.com/doc/2010-05-08/"><Error><Type>Sender</Type><Code>${code}</Code><Message>${message}</Message></Error><RequestId>req</RequestId></ErrorResponse>`,
	)

const decoder = new TextDecoder()

/** The signing key id of a SigV4 request: `Credential=<key>/<date>/...`. */
const signingKey = (authorization: string | undefined) =>
	/Credential=([^/]+)\//u.exec(authorization ?? "")?.[1]

export interface FakeAws {
	readonly client: HttpClient.HttpClient
	/** Every call, as `<Action>`. */
	readonly calls: Array<string>
	/** The role ARN of every AssumeRole, in order. */
	readonly assumed: Array<string>
	readonly deploy: (accountId: string, templateJson: string) => void
	/** Deletes every role of an account, as deleting its stack would. */
	readonly deleteStacks: (accountId: string) => void
	/** Runs before every call: a test makes AWS slow with a `TestClock` adjustment. */
	beforeEachCall: Effect.Effect<void>
	/** Answers every call with this error instead, as AWS does when it throttles or fails. */
	failWith: { readonly status: number; readonly code: string } | undefined
}

/** `mapleKeyId` signs as `maplePrincipalArn`: the only identity a deployed role may trust. */
export const makeFakeAws = (
	mapleKeyId: string = MAPLE_ACCESS_KEY_ID,
	maplePrincipalArn: string = MAPLE_PRINCIPAL_ARN,
): FakeAws => {
	const roles = new Map<string, FakeRole>()
	// Session key id → the role it is a session of.
	const sessions = new Map<string, FakeRole>()
	const calls: Array<string> = []
	const assumed: Array<string> = []
	const state: FakeAws = {
		calls,
		assumed,
		beforeEachCall: Effect.void,
		failWith: undefined,
		deploy: (accountId, templateJson) => {
			const role = deployTemplate(accountId, templateJson)
			roles.set(`arn:aws:iam::${accountId}:role/${role.roleName}`, role)
		},
		deleteStacks: (accountId) => {
			for (const [arn, role] of roles) if (role.accountId === accountId) roles.delete(arn)
		},
		client: HttpClient.make((request) =>
			Effect.suspend(() => state.beforeEachCall).pipe(
				Effect.andThen(
					Effect.sync(() => {
						const body =
							request.body._tag === "Uint8Array" ? decoder.decode(request.body.body) : ""
						const form = new URLSearchParams(body)
						const action = form.get("Action") ?? ""
						calls.push(action)
						const respond = (response: Response) => HttpClientResponse.fromWeb(request, response)
						if (state.failWith !== undefined) {
							return respond(
								stsError(state.failWith.status, state.failWith.code, "fake failure"),
							)
						}
						const key = signingKey(request.headers["authorization"])
						if (action === "AssumeRole") {
							if (key !== mapleKeyId) {
								return respond(
									stsError(403, "InvalidClientTokenId", "The security token is invalid."),
								)
							}
							const roleArn = form.get("RoleArn") ?? ""
							assumed.push(roleArn)
							const role = roles.get(roleArn)
							if (
								role === undefined ||
								role.trustedPrincipalArn !== maplePrincipalArn ||
								role.externalId !== form.get("ExternalId")
							) {
								return respond(
									stsError(
										403,
										"AccessDenied",
										`User is not authorized to perform: sts:AssumeRole on resource: ${roleArn}`,
									),
								)
							}
							const sessionKey = `ASIA${String(sessions.size).padStart(16, "0")}`
							sessions.set(sessionKey, role)
							const session = form.get("RoleSessionName") ?? ""
							return respond(
								xml(
									200,
									`<AssumeRoleResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><AssumeRoleResult><Credentials><AccessKeyId>${sessionKey}</AccessKeyId><SecretAccessKey>secret</SecretAccessKey><SessionToken>token</SessionToken><Expiration>2030-01-01T00:00:00Z</Expiration></Credentials><AssumedRoleUser><AssumedRoleId>AROAFAKE:${session}</AssumedRoleId><Arn>arn:aws:sts::${role.accountId}:assumed-role/${role.roleName}/${session}</Arn></AssumedRoleUser></AssumeRoleResult><ResponseMetadata><RequestId>req</RequestId></ResponseMetadata></AssumeRoleResponse>`,
								),
							)
						}
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
