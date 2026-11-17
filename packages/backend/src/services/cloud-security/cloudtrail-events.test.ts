import { describe, expect, it } from "vitest"
import { Option, Schema, String as Str } from "effect"
import { cloudTrailAuditEvent } from "./cloudtrail-events"

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const at = new Date("2026-11-10T00:00:00Z")

const mapped = (record: Record<string, unknown>) =>
	Option.getOrUndefined(
		cloudTrailAuditEvent("111111111111", {
			EventId: "e-1",
			EventTime: at,
			CloudTrailEvent: encodeJson(record),
		}),
	)

describe("cloudTrailAuditEvent", () => {
	it("reads an Identity Center session as the person behind it", () => {
		const event = mapped({
			eventSource: "iam.amazonaws.com",
			eventName: "AttachRolePolicy",
			sourceIPAddress: "203.0.113.7",
			userIdentity: {
				type: "AssumedRole",
				arn: "arn:aws:sts::111111111111:assumed-role/AWSReservedSSO_Admin_abc/alice@example.com",
				sessionContext: { sessionIssuer: { userName: "AWSReservedSSO_Admin_abc" } },
			},
			resources: [{ ARN: "arn:aws:iam::111111111111:role/app", type: "AWS::IAM::Role" }],
		})
		expect(event?.actor).toMatchObject({ type: "user", name: "alice@example.com" })
		expect(event?.category).toBe("permission")
		expect(event?.target).toMatchObject({
			type: "AWS::IAM::Role",
			id: "arn:aws:iam::111111111111:role/app",
		})
		expect(event?.originIp).toBe("203.0.113.7")
		expect(event?.occurredAtMs).toBe(at.getTime())
	})

	it("reads a failed console sign-in as a failure, and a refused call as denied", () => {
		const login = mapped({
			eventSource: "signin.amazonaws.com",
			eventName: "ConsoleLogin",
			userIdentity: { type: "Root", arn: "arn:aws:iam::111111111111:root" },
			responseElements: { ConsoleLogin: "Failure" },
			errorMessage: "Failed authentication",
		})
		expect(login).toMatchObject({
			category: "authentication",
			outcome: "failure",
			actor: { name: "root" },
		})
		const refused = mapped({
			eventSource: "ec2.amazonaws.com",
			eventName: "RunInstances",
			userIdentity: { type: "IAMUser", userName: "bob" },
			errorCode: "Client.UnauthorizedOperation",
		})
		expect(refused).toMatchObject({
			category: "resource",
			outcome: "denied",
			outcomeReason: "Client.UnauthorizedOperation",
		})
	})

	it("tells Identity Center users apart by their identity store user id", () => {
		const event = mapped({
			eventSource: "s3.amazonaws.com",
			eventName: "DeleteBucket",
			userIdentity: {
				type: "IdentityCenterUser",
				onBehalfOf: {
					userId: "u-123",
					identityStoreArn: "arn:aws:identitystore::111111111111:identitystore/d-1",
				},
			},
		})
		expect(event?.actor).toEqual({
			type: "user",
			id: "arn:aws:identitystore::111111111111:identitystore/d-1/u-123",
			name: "u-123",
		})
	})

	it("keeps an AWS service address out of the origin IP", () => {
		const event = mapped({
			eventSource: "kms.amazonaws.com",
			eventName: "ScheduleKeyDeletion",
			sourceIPAddress: "cloudformation.amazonaws.com",
			userIdentity: { type: "IAMUser", userName: "bob" },
		})
		expect(event).toMatchObject({ category: "credential", action: "kms:ScheduleKeyDeletion" })
		expect(event?.originIp).toBeUndefined()
	})

	it("leaves out AWS acting on its own and role-session plumbing", () => {
		expect(
			mapped({
				eventSource: "s3.amazonaws.com",
				eventName: "PutObject",
				userIdentity: { type: "AWSService" },
			}),
		).toBeUndefined()
		expect(
			mapped({
				eventSource: "sts.amazonaws.com",
				eventName: "AssumeRole",
				userIdentity: { type: "IAMUser" },
			}),
		).toBeUndefined()
	})

	it("keeps a large record's identity but drops its request and response past 32 KB", () => {
		const event = mapped({
			eventSource: "lambda.amazonaws.com",
			eventName: "UpdateFunctionCode",
			userIdentity: { type: "IAMUser", userName: "bob" },
			requestParameters: { zipFile: Str.repeat(40 * 1024)("x") },
			responseElements: { ok: true },
		})
		expect(event?.raw).toMatchObject({
			eventName: "UpdateFunctionCode",
			userIdentity: { userName: "bob" },
		})
		expect(event?.raw?.["requestParameters"]).toBeUndefined()
	})
})
