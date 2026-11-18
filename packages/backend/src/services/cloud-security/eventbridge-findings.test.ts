import { describe, expect, it } from "vitest"
import { Array as Arr, Option } from "effect"
import { findingEvent, MAX_FINDINGS_PER_EVENT } from "./eventbridge-findings"

// Events as EventBridge delivers them, trimmed from the samples in each service's documentation.

const ACCOUNT = "111111111111"

const envelope = (source: string, detailType: string, detail: unknown, region = "us-east-1") => ({
	version: "0",
	id: "6f87d04b-9f74-4f04-a780-7acf4b0a9b38",
	"detail-type": detailType,
	source,
	account: ACCOUNT,
	time: "2026-11-16T12:00:00Z",
	region,
	resources: [],
	detail,
})

/** The tests' "now": every sample is dated before it unless a test says otherwise. */
const NOW = Date.parse("2026-11-17T00:00:00Z")

const read = (event: unknown) => Option.getOrUndefined(findingEvent(ACCOUNT, event, NOW))

describe("findingEvent", () => {
	it("reads a GuardDuty finding about an instance, with its count and first and last sighting", () => {
		const event = read(
			envelope("aws.guardduty", "GuardDuty Finding", {
				schemaVersion: "2.0",
				accountId: ACCOUNT,
				region: "us-east-1",
				id: "16afba5c5c43e07c9e3e5e2e544e95df",
				arn: "arn:aws:guardduty:us-east-1:111111111111:detector/d1/finding/16afba5c5c43e07c9e3e5e2e544e95df",
				type: "UnauthorizedAccess:EC2/SSHBruteForce",
				resource: {
					resourceType: "Instance",
					instanceDetails: { instanceId: "i-05746eb48123455e0" },
				},
				service: {
					archived: false,
					count: 18,
					eventFirstSeen: "2026-11-05T16:32:31Z",
					eventLastSeen: "2026-11-16T11:58:04Z",
				},
				severity: 8,
				createdAt: "2026-11-05T16:51:07.426Z",
				updatedAt: "2026-11-16T11:59:58.383Z",
				title: "SSH brute force attacks against i-05746eb48123455e0",
				description: "i-05746eb48123455e0 is performing SSH brute force attacks.",
			}),
		)
		expect(event).toMatchObject({ source: "guardduty", region: "us-east-1", skipped: 0 })
		expect(event?.findings[0]).toMatchObject({
			findingId: "16afba5c5c43e07c9e3e5e2e544e95df",
			severity: "high",
			status: "active",
			resourceType: "Instance",
			resourceId: "i-05746eb48123455e0",
			occurrences: 18,
			firstSeenAt: Date.parse("2026-11-05T16:32:31Z"),
			lastSeenAt: Date.parse("2026-11-16T11:58:04Z"),
			providerUpdatedAt: Date.parse("2026-11-16T11:59:58.383Z"),
		})
	})

	it("skips a GuardDuty administrator's event about a member account's finding", () => {
		const event = read(
			envelope("aws.guardduty", "GuardDuty Finding", {
				accountId: "222222222222",
				id: "member-finding",
				type: "Recon:EC2/PortProbeUnprotectedPort",
				updatedAt: "2026-11-16T11:59:58Z",
			}),
		)
		expect(event).toMatchObject({ findings: [], skipped: 1 })
	})

	it("keeps Security Hub's own findings in this region and closes a passed control", () => {
		const finding = (overrides: Record<string, unknown>) => ({
			SchemaVersion: "2018-10-08",
			Id: "arn:aws:securityhub:us-east-1:111111111111:subscription/aws-foundational/v/1.0.0/S3.1/finding/1",
			ProductName: "Security Hub",
			GeneratorId: "aws-foundational-security-best-practices/v/1.0.0/S3.1",
			AwsAccountId: ACCOUNT,
			Region: "us-east-1",
			Types: ["Software and Configuration Checks/Industry and Regulatory Standards"],
			CreatedAt: "2026-11-01T00:00:00.000Z",
			UpdatedAt: "2026-11-16T11:00:00.000Z",
			Severity: { Label: "MEDIUM" },
			Title: "S3 Block Public Access setting should be enabled",
			Resources: [{ Type: "AwsAccount", Id: "AWS::::Account:111111111111" }],
			Compliance: { Status: "FAILED" },
			Workflow: { Status: "NEW" },
			RecordState: "ACTIVE",
			...overrides,
		})
		const event = read(
			envelope("aws.securityhub", "Security Hub Findings - Imported", {
				findings: [
					finding({}),
					finding({ Id: "passed", Compliance: { Status: "PASSED" } }),
					// GuardDuty's copy is read from GuardDuty, and a linked region's from that region.
					finding({ Id: "copy", ProductName: "GuardDuty" }),
					finding({ Id: "linked", Region: "eu-west-1" }),
				],
			}),
		)
		expect(event?.source).toBe("securityhub")
		expect(Arr.map(event?.findings ?? [], (f) => [f.findingId, f.status, f.severity])).toEqual([
			[
				"arn:aws:securityhub:us-east-1:111111111111:subscription/aws-foundational/v/1.0.0/S3.1/finding/1",
				"active",
				"medium",
			],
			["passed", "resolved", "medium"],
		])
		expect(event?.skipped).toBe(2)
	})

	it("reads Inspector's event times, which are not ISO", () => {
		const event = read(
			envelope("aws.inspector2", "Inspector2 Finding", {
				awsAccountId: ACCOUNT,
				findingArn: "arn:aws:inspector2:us-east-1:111111111111:finding/0a1b2c",
				type: "PACKAGE_VULNERABILITY",
				title: "CVE-2026-0001 - openssl",
				severity: "CRITICAL",
				status: "CLOSED",
				firstObservedAt: "Mar 31, 2026, 10:51:08 PM",
				lastObservedAt: "Nov 16, 2026, 9:05:00 AM",
				updatedAt: "Nov 16, 2026, 12:30:00\u202fPM",
				packageVulnerabilityDetails: { vulnerabilityId: "CVE-2026-0001" },
				resources: [{ type: "AWS_EC2_INSTANCE", id: "i-0abc" }],
			}),
		)
		expect(event?.findings[0]).toMatchObject({
			findingId: "arn:aws:inspector2:us-east-1:111111111111:finding/0a1b2c",
			type: "CVE-2026-0001",
			severity: "critical",
			status: "resolved",
			resourceId: "i-0abc",
			firstSeenAt: Date.UTC(2026, 2, 31, 22, 51, 8),
			lastSeenAt: Date.UTC(2026, 10, 16, 9, 5, 0),
			providerUpdatedAt: Date.UTC(2026, 10, 16, 12, 30, 0),
		})
	})

	it("reads an external access finding and an unused access finding by their own id fields", () => {
		const external = read(
			envelope("aws.access-analyzer", "Access Analyzer Finding", {
				version: "1.0",
				id: "aa-external-1",
				status: "ACTIVE",
				resourceType: "AWS::S3::Bucket",
				resource: "arn:aws:s3:::my-bucket",
				createdAt: "2026-11-10T01:22:33.645Z",
				analyzedAt: "2026-11-16T01:22:33.645Z",
				updatedAt: "2026-11-16T01:22:33.645Z",
				accountId: ACCOUNT,
				isPublic: true,
			}),
		)
		expect(external?.findings[0]).toMatchObject({
			findingId: "aa-external-1",
			type: "ExternalAccess",
			severity: "high",
			status: "active",
			resourceId: "arn:aws:s3:::my-bucket",
		})
		// A deletion keeps its last status and sets `isDeleted`: the finding is gone.
		const deleted = read(
			envelope("aws.access-analyzer", "Access Analyzer Finding", {
				id: "aa-external-1",
				status: "ACTIVE",
				isDeleted: true,
				resourceType: "AWS::S3::Bucket",
				resource: "arn:aws:s3:::my-bucket",
				updatedAt: "2026-11-16T02:00:00.000Z",
				accountId: ACCOUNT,
			}),
		)
		expect(deleted?.findings[0]?.status).toBe("resolved")
		const unused = read(
			envelope("aws.access-analyzer", "Unused Access Finding for IAM entities", {
				version: "1.0",
				findingId: "aa-unused-1",
				findingType: "UnusedIAMRole",
				resource: "arn:aws:iam::111111111111:role/old",
				resourceType: "AWS::IAM::Role",
				resourceOwnerAccount: ACCOUNT,
				status: "RESOLVED",
				createdAt: "2026-10-01T00:00:00Z",
				updatedAt: "2026-11-16T00:00:00Z",
			}),
		)
		expect(unused?.findings[0]).toMatchObject({
			findingId: "aa-unused-1",
			title: "Unused IAM role",
			status: "resolved",
		})
	})

	it("holds a finding dated ahead of now to now", () => {
		const event = read(
			envelope("aws.guardduty", "GuardDuty Finding", {
				accountId: ACCOUNT,
				id: "ahead",
				type: "Recon:EC2/PortProbeUnprotectedPort",
				createdAt: "2999-01-01T00:00:00Z",
				updatedAt: "2999-01-02T00:00:00Z",
				service: { eventFirstSeen: "2999-01-01T00:00:00Z", eventLastSeen: "2999-01-02T00:00:00Z" },
			}),
		)
		expect(event?.findings[0]).toMatchObject({
			findingId: "ahead",
			firstSeenAt: NOW,
			lastSeenAt: NOW,
			providerUpdatedAt: NOW,
		})
	})

	it("takes a bounded number of findings from one Security Hub event", () => {
		const finding = (index: number) => ({
			Id: `sh-${index}`,
			ProductName: "Security Hub",
			AwsAccountId: ACCOUNT,
			Region: "us-east-1",
			UpdatedAt: "2026-11-16T11:00:00.000Z",
		})
		const extra = 25
		const event = read(
			envelope("aws.securityhub", "Security Hub Findings - Imported", {
				findings: Arr.makeBy(MAX_FINDINGS_PER_EVENT + extra, finding),
			}),
		)
		expect(event?.findings).toHaveLength(MAX_FINDINGS_PER_EVENT)
		expect(event?.findings.at(-1)?.findingId).toBe(`sh-${MAX_FINDINGS_PER_EVENT - 1}`)
		expect([event?.skipped, event?.overCap]).toEqual([0, extra])
	})

	it("takes a finding that names no account as the event's account, and skips one that names neither", () => {
		const detail = {
			id: "no-account",
			type: "Recon:EC2/PortProbeUnprotectedPort",
			updatedAt: "2026-11-16T11:59:58Z",
		}
		const own = read(envelope("aws.guardduty", "GuardDuty Finding", detail))
		expect(Arr.map(own?.findings ?? [], (f) => f.findingId)).toEqual(["no-account"])
		const { account: _account, ...anonymous } = envelope("aws.guardduty", "GuardDuty Finding", detail)
		expect(read(anonymous)).toMatchObject({ findings: [], skipped: 1 })
		const foreign = { ...envelope("aws.guardduty", "GuardDuty Finding", detail), account: "222222222222" }
		expect(read(foreign)).toMatchObject({ findings: [], skipped: 1 })
	})

	it("ignores events the setup does not forward", () => {
		expect(
			read(envelope("aws.ec2", "EC2 Instance State-change Notification", { state: "running" })),
		).toBe(undefined)
		expect(
			read(envelope("aws.securityhub", "Security Hub Findings - Custom Action", { findings: [] })),
		).toBe(undefined)
		expect(read({ source: "aws.guardduty" })).toBe(undefined)
	})
})
