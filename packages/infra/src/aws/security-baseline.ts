/**
 * The AWS account security baseline: AWS Config and GuardDuty in the instance's region and, on
 * the US prd instance alone, the account's one multi-region CloudTrail trail. Every stage shares
 * the account, so `profile.deploys.awsSecurityBaseline` keeps it on the prd instances.
 */
import * as AWS from "alchemy/AWS"
import * as Output from "alchemy/Output"
import * as RemovalPolicy from "alchemy/RemovalPolicy"
import * as Effect from "effect/Effect"
import type { MapleStage } from "../cloudflare/stage.ts"
import { requiredPlain } from "../env.ts"
import type { AwsSecurityBaseline } from "../profile.ts"
import type { MapleRegion } from "../region.ts"
import { type AwsRegionName, resolveAwsRegion, resolveAwsResourceName } from "./stage.ts"

export interface AwsSecurityBaselineOptions {
	readonly stage: MapleStage
	readonly region: MapleRegion
	readonly baseline: Exclude<AwsSecurityBaseline, "none">
}

/** Audit log retention in the trail's CloudWatch Logs group. */
const TRAIL_LOG_RETENTION = "365 days"

const publicAccessBlock = {
	blockPublicAcls: true,
	blockPublicPolicy: true,
	ignorePublicAcls: true,
	restrictPublicBuckets: true,
}

/** Refuses plain-HTTP access to an audit bucket. */
const denyInsecureTransport = (bucketArn: string): AWS.IAM.PolicyStatement => ({
	Sid: "DenyInsecureTransport",
	Effect: "Deny",
	Principal: "*",
	Action: ["s3:*"],
	Resource: [bucketArn, `${bucketArn}/*`],
	Condition: { Bool: { "aws:SecureTransport": "false" } },
})

/**
 * A versioned, encrypted, private bucket for audit logs. Retained: a stack teardown must never
 * delete audit evidence. Named with the account id because bucket names are global.
 */
const auditBucket = (
	id: string,
	bucketName: string,
	policy: ReadonlyArray<AWS.IAM.PolicyStatement>,
	tags: Record<string, string>,
) =>
	AWS.S3.Bucket(id, {
		bucketName,
		versioning: "Enabled",
		encryption: { sseAlgorithm: "AES256" },
		publicAccessBlock,
		policy: [denyInsecureTransport(`arn:aws:s3:::${bucketName}`), ...policy],
		tags,
	}).pipe(RemovalPolicy.retain())

/**
 * The account's one trail: every region, management events read and write, digest-validated
 * files in S3 and a copy in CloudWatch Logs.
 */
const accountTrail = (
	name: (base: string) => string,
	accountId: string,
	awsRegion: AwsRegionName,
	tags: Record<string, string>,
) =>
	Effect.gen(function* () {
		const trailName = name("audit")
		const trailArn = `arn:aws:cloudtrail:${awsRegion}:${accountId}:trail/${trailName}`
		const bucketName = `${name("audit-cloudtrail")}-${accountId}`
		const bucketArn = `arn:aws:s3:::${bucketName}`
		// Confused-deputy guard: only this account's trail may write here.
		const fromTrail = { "aws:SourceArn": trailArn, "aws:SourceAccount": accountId }
		const bucket = yield* auditBucket(
			"audit-cloudtrail-bucket",
			bucketName,
			[
				{
					Sid: "AWSCloudTrailAclCheck",
					Effect: "Allow",
					Principal: { Service: "cloudtrail.amazonaws.com" },
					Action: ["s3:GetBucketAcl"],
					Resource: bucketArn,
					Condition: { StringEquals: fromTrail },
				},
				{
					Sid: "AWSCloudTrailWrite",
					Effect: "Allow",
					Principal: { Service: "cloudtrail.amazonaws.com" },
					Action: ["s3:PutObject"],
					Resource: `${bucketArn}/AWSLogs/${accountId}/*`,
					Condition: {
						StringEquals: { ...fromTrail, "s3:x-amz-acl": "bucket-owner-full-control" },
					},
				},
			],
			tags,
		)

		const logGroup = yield* AWS.Logs.LogGroup("audit-cloudtrail-logs", {
			logGroupName: `/aws/cloudtrail/${trailName}`,
			retention: TRAIL_LOG_RETENTION,
			deletionProtectionEnabled: true,
			tags,
		}).pipe(RemovalPolicy.retain())
		const logsRole = yield* AWS.IAM.Role("audit-cloudtrail-logs-role", {
			roleName: name("audit-cloudtrail-logs"),
			assumeRolePolicyDocument: {
				Version: "2012-10-17",
				Statement: [
					{
						Effect: "Allow",
						Principal: { Service: "cloudtrail.amazonaws.com" },
						Action: ["sts:AssumeRole"],
					},
				],
			},
			inlinePolicies: {
				"cloudtrail-to-cloudwatch-logs": {
					Version: "2012-10-17",
					Statement: [
						{
							Effect: "Allow",
							Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
							Resource: [Output.map(logGroup.logGroupArn, (arn) => `${arn}:log-stream:*`)],
						},
					],
				},
			},
			tags,
		})

		return yield* AWS.CloudTrail.Trail("audit-trail", {
			trailName,
			s3BucketName: bucket.bucketName,
			isMultiRegionTrail: true,
			includeGlobalServiceEvents: true,
			enableLogFileValidation: true,
			// CloudTrail takes the log group ARN in its `:*` form.
			cloudWatchLogsLogGroupArn: Output.map(logGroup.logGroupArn, (arn) => `${arn}:*`),
			cloudWatchLogsRoleArn: logsRole.roleArn,
			eventSelectors: [{ readWriteType: "All", includeManagementEvents: true }],
			isLogging: true,
			tags,
		})
	})

/**
 * AWS Config in this region, recording every supported type into its own bucket. The recorder
 * and channel are created side by side: each provider retries until the other exists.
 */
const regionalConfig = (
	name: (base: string) => string,
	accountId: string,
	awsRegion: AwsRegionName,
	tags: Record<string, string>,
) =>
	Effect.gen(function* () {
		const bucketName = `${name("audit-config")}-${accountId}`
		const bucketArn = `arn:aws:s3:::${bucketName}`
		const deliveryPrefix = `${bucketArn}/AWSLogs/${accountId}/Config/*`
		const fromAccount = { "aws:SourceAccount": accountId }
		const configService = { Service: "config.amazonaws.com" }
		const bucket = yield* auditBucket(
			"audit-config-bucket",
			bucketName,
			[
				{
					Sid: "AWSConfigBucketPermissionsCheck",
					Effect: "Allow",
					Principal: configService,
					Action: ["s3:GetBucketAcl"],
					Resource: bucketArn,
					Condition: { StringEquals: fromAccount },
				},
				{
					Sid: "AWSConfigBucketExistenceCheck",
					Effect: "Allow",
					Principal: configService,
					Action: ["s3:ListBucket"],
					Resource: bucketArn,
					Condition: { StringEquals: fromAccount },
				},
				{
					Sid: "AWSConfigBucketDelivery",
					Effect: "Allow",
					Principal: configService,
					Action: ["s3:PutObject"],
					Resource: deliveryPrefix,
					Condition: {
						StringEquals: { ...fromAccount, "s3:x-amz-acl": "bucket-owner-full-control" },
					},
				},
			],
			tags,
		)

		const role = yield* AWS.IAM.Role("audit-config-role", {
			roleName: name("audit-config"),
			assumeRolePolicyDocument: {
				Version: "2012-10-17",
				Statement: [
					{
						Effect: "Allow",
						Principal: configService,
						Action: ["sts:AssumeRole"],
						Condition: { StringEquals: fromAccount },
					},
				],
			},
			managedPolicyArns: ["arn:aws:iam::aws:policy/service-role/AWS_ConfigRole"],
			inlinePolicies: {
				"config-delivery": {
					Version: "2012-10-17",
					Statement: [
						{
							Effect: "Allow",
							Action: ["s3:PutObject"],
							Resource: [deliveryPrefix],
							Condition: { StringEquals: { "s3:x-amz-acl": "bucket-owner-full-control" } },
						},
						{ Effect: "Allow", Action: ["s3:GetBucketAcl"], Resource: [bucketArn] },
					],
				},
			},
			tags,
		})

		// One recorder and one channel per account-region. Global types (IAM) only in
		// us-east-1, so the EU recorder does not record them a second time.
		const recorder = yield* AWS.Config.ConfigurationRecorder("audit-config-recorder", {
			name: name("config"),
			roleArn: role.roleArn,
			recordingGroup: {
				allSupported: true,
				includeGlobalResourceTypes: awsRegion === "us-east-1",
			},
			recording: true,
			tags,
		})
		yield* AWS.Config.DeliveryChannel("audit-config-channel", {
			name: name("config"),
			s3BucketName: bucket.bucketName,
			snapshotDeliveryFrequency: "TwentyFour_Hours",
		})
		return recorder
	})

/** The baseline for one prd instance. Its trail, when it has one, covers every region. */
export const createAwsSecurityBaseline = ({ stage, region, baseline }: AwsSecurityBaselineOptions) =>
	Effect.gen(function* () {
		// Every deploy workflow sets it (docs/infra.md); bucket names and the trail ARN need it.
		const accountId = yield* requiredPlain("AWS_ACCOUNT_ID")
		const awsRegion = resolveAwsRegion(region)
		const name = (base: string) => resolveAwsResourceName(base, stage, region)
		const tags = { Service: "maple-security-baseline", Region: region }

		const trail =
			baseline === "account" ? yield* accountTrail(name, accountId, awsRegion, tags) : undefined
		const recorder = yield* regionalConfig(name, accountId, awsRegion, tags)
		const detector = yield* AWS.GuardDuty.Detector("audit-guardduty", {
			enable: true,
			findingPublishingFrequency: "FIFTEEN_MINUTES",
			tags,
		})
		return {
			trailArn: trail?.trailArn,
			configRecorder: recorder.recorderName,
			guardDutyDetectorId: detector.detectorId,
		}
	})
