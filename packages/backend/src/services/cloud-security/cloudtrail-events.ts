import type {
	AuditTrailActorType,
	AuditTrailCategory,
	AuditTrailEvent,
	AuditTrailOutcome,
} from "@maple/domain/audit-trail"
import { Array as Arr, Option, Predicate, Record as Rec, Schema, String as Str } from "effect"

// A CloudTrail management event as an audit trail event. Only writes are read; AWS acting on its
// own and the role-session plumbing every workload runs stay out.

type Json = Readonly<Record<string, unknown>>

const decodeRecord = Schema.decodeUnknownOption(
	Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
)

const objectAt = (value: Json | undefined, key: string): Json | undefined => {
	const found = value?.[key]
	return Predicate.isObject(found) && !Arr.isArray(found) ? found : undefined
}
const textAt = (value: Json | undefined, key: string): string | undefined => {
	const found = value?.[key]
	return typeof found === "string" && found !== "" ? found : undefined
}

/** Calls made thousands of times a day by every workload and Maple itself: not audit events. */
const NOISE = new Set([
	"sts:AssumeRole",
	"sts:AssumeRoleWithWebIdentity",
	"sts:AssumeRoleWithSAML",
	"sts:GetSessionToken",
	"logs:CreateLogStream",
	"logs:CreateLogGroup",
])

const IAM_PERMISSION = /Policy|Role|Permission|Boundary/u
const IAM_CREDENTIAL =
	/AccessKey|LoginProfile|Password|MFA|SSHPublicKey|ServiceSpecificCredential|SigningCertificate/u
const IAM_MEMBERSHIP = /^(Create|Delete)User$|UserToGroup|UserFromGroup|^(Create|Delete)Group$/u
const CONFIGURATION_SERVICES = new Set([
	"cloudtrail",
	"config",
	"guardduty",
	"securityhub",
	"access-analyzer",
	"inspector2",
	"organizations",
	"account",
])

/** Who may reach what over the network, and what of it is recorded: how the account is set up. */
const EC2_NETWORK_CONFIGURATION =
	/SecurityGroup|NetworkAcl|FlowLogs|VpcEndpoint|VpcPeering|TransitGateway|InternetGateway|Route(Table)?$/u

/** `iam:CreateAccessKey` from `iam.amazonaws.com` and `CreateAccessKey`. */
const actionOf = (eventSource: string, eventName: string) =>
	`${Str.replace(".amazonaws.com", "")(eventSource)}:${eventName}`

const categoryOf = (service: string, eventName: string): AuditTrailCategory => {
	if (service === "signin") return "authentication"
	if (service === "iam") {
		if (IAM_CREDENTIAL.test(eventName)) return "credential"
		if (IAM_MEMBERSHIP.test(eventName)) return "membership"
		if (IAM_PERMISSION.test(eventName)) return "permission"
		return "resource"
	}
	if (service === "kms" || service === "secretsmanager") return "credential"
	if (service === "billing" || service === "ce" || service === "budgets" || service === "payments")
		return "billing"
	if (CONFIGURATION_SERVICES.has(service)) return "configuration"
	if (service === "ec2" && EC2_NETWORK_CONFIGURATION.test(eventName)) return "configuration"
	if (/Policy$|Permission|Acl$/u.test(eventName)) return "permission"
	return "resource"
}

const actorOf = (identity: Json | undefined): AuditTrailEvent["actor"] => {
	const kind = textAt(identity, "type")
	const arn = textAt(identity, "arn")
	const issuer = objectAt(objectAt(identity, "sessionContext"), "sessionIssuer")
	const sessionName =
		arn === undefined ? undefined : Arr.last(Str.split(arn, "/")).pipe(Option.getOrUndefined)
	const user = (type: AuditTrailActorType, name: string | undefined) => ({ type, id: arn, name })
	switch (kind) {
		case "Root":
			return user("user", "root")
		case "IAMUser":
			return user("user", textAt(identity, "userName"))
		case "IdentityCenterUser": {
			// Often no ARN or user name: the identity store and its user id are what tell people apart.
			const onBehalfOf = objectAt(identity, "onBehalfOf")
			const userId = textAt(onBehalfOf, "userId")
			const store = textAt(onBehalfOf, "identityStoreArn")
			const id =
				arn ??
				(userId === undefined ? undefined : store === undefined ? userId : `${store}/${userId}`)
			return { type: "user", id, name: textAt(identity, "userName") ?? userId }
		}
		case "FederatedUser":
			return user("user", sessionName)
		case "AssumedRole":
			// Identity Center sign-ins are roles named AWSReservedSSO_*, with the person as the session;
			// other federated sign-ins (SAML, OIDC) name the session after the person's email.
			return Str.startsWith("AWSReservedSSO_")(textAt(issuer, "userName") ?? "") ||
				Str.includes("@")(sessionName ?? "")
				? user("user", sessionName)
				: user("service", sessionName)
		case "AWSAccount":
			return user("service", textAt(identity, "accountId"))
		default:
			return user("unknown", textAt(identity, "userName"))
	}
}

const outcomeOf = (
	record: Json,
): { readonly outcome: AuditTrailOutcome; readonly reason: string | undefined } => {
	const code = textAt(record, "errorCode")
	const reason = textAt(record, "errorMessage") ?? code
	// A sign-in step reports itself under its own name, with no error code: `{"CheckMfa": "Failure"}`.
	const eventName = textAt(record, "eventName")
	if (eventName !== undefined && textAt(objectAt(record, "responseElements"), eventName) === "Failure") {
		return { outcome: "failure", reason: reason ?? "Failed authentication" }
	}
	if (code === undefined) return { outcome: "success", reason: undefined }
	return { outcome: /AccessDenied|Unauthorized/u.test(code) ? "denied" : "failure", reason }
}

const IP = /^[0-9a-f:.]+$/iu

/** The most of a record the audit trail keeps; a larger one loses its request and response first. */
const RAW_LIMIT_BYTES = 32 * 1024
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const sizeOf = (value: Json) => new TextEncoder().encode(encodeJson(value)).length

const rawOf = (record: Json): Json | undefined => {
	if (sizeOf(record) <= RAW_LIMIT_BYTES) return record
	const trimmed = Rec.remove(Rec.remove(record, "requestParameters"), "responseElements")
	return sizeOf(trimmed) <= RAW_LIMIT_BYTES ? trimmed : undefined
}

/** An event `LookupEvents` returned, as the audit trail stores it. None for noise and AWS's own calls. */
export const cloudTrailAuditEvent = (
	accountId: string,
	event: {
		readonly EventId?: string | undefined
		readonly EventTime?: Date | undefined
		readonly CloudTrailEvent?: string | undefined
	},
): Option.Option<AuditTrailEvent> => {
	if (event.EventId === undefined || event.EventTime === undefined || event.CloudTrailEvent === undefined) {
		return Option.none()
	}
	const eventId = event.EventId
	const occurredAtMs = event.EventTime.getTime()
	return Option.flatMap(decodeRecord(event.CloudTrailEvent), (record): Option.Option<AuditTrailEvent> => {
		const eventSource = textAt(record, "eventSource")
		const eventName = textAt(record, "eventName")
		const identity = objectAt(record, "userIdentity")
		if (eventSource === undefined || eventName === undefined) return Option.none()
		const action = actionOf(eventSource, eventName)
		if (NOISE.has(action) || textAt(identity, "type") === "AWSService") return Option.none()
		const service = Str.replace(".amazonaws.com", "")(eventSource)
		const { outcome, reason } = outcomeOf(record)
		const resource = Arr.head(Arr.isArray(record["resources"]) ? record["resources"] : []).pipe(
			Option.filter((value): value is Json => Predicate.isObject(value)),
			Option.getOrUndefined,
		)
		const sourceIp = textAt(record, "sourceIPAddress")
		const userAgent = textAt(record, "userAgent")
		const targetName = textAt(resource, "ARN") ?? textAt(resource, "resourceName")
		return Option.some({
			provider: "aws",
			providerEventId: eventId,
			account: accountId,
			occurredAtMs,
			actor: actorOf(identity),
			action,
			category: categoryOf(service, eventName),
			outcome,
			outcomeReason: reason,
			target:
				resource === undefined
					? undefined
					: { type: textAt(resource, "type"), id: targetName, name: targetName },
			originIp: sourceIp !== undefined && IP.test(sourceIp) ? sourceIp : undefined,
			userAgent,
			raw: rawOf(record),
		})
	})
}
