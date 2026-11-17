import {
	AWS_AUDIT_DETAIL_TYPES,
	AWS_AUDIT_HOME_REGION,
	AWS_ROLE_NAME_PREFIX,
	AWS_TEMPLATE_VERSION,
	awsConnectionResourceNames,
	type AwsMetricStream,
	type AwsSetupPlan,
} from "@maple/domain/aws"
import type { AwsAccountId, AwsConnectionId } from "@maple/primitives"
import { Effect, Schema, Array as Arr, Record as Rec, String as Str } from "effect"
import { forPaste } from "../paste-script"

const DOCS_URL = "https://maple.dev/docs/integrations/aws"
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const encodePrettyJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown, { space: 2 }))
/**
 * Stacks live in a region while IAM does not: one fixed region lets the cleanup find the stack
 * whatever region CloudShell opened in, and a re-run update it instead of colliding on the role.
 */
export const AWS_STACK_REGION = "us-east-1"

/** CloudFormation logical id of a module's policy: `ObservabilityPolicy`. */
const policyLogicalId = (module: string) =>
	`${Str.toUpperCase(Str.slice(0, 1)(module))}${Str.slice(1)(module)}Policy`

/** The trust policy with its federated principal swapped for `principal`. */
const trustingPrincipal = (plan: AwsSetupPlan, principal: unknown) => ({
	...plan.trustPolicy,
	Statement: Arr.map(plan.trustPolicy.Statement, (statement) => ({
		...statement,
		Principal: { Federated: principal },
	})),
})

/**
 * The stack as a CloudFormation template (JSON, which CloudFormation reads as it reads YAML). An
 * account has one OIDC provider per issuer, shared by every connection to it: the stack creates it
 * only when told to (the console default), and keeps it when deleted, since another role may trust it.
 */
export const renderAwsCloudFormation = (connectionId: AwsConnectionId, plan: AwsSetupPlan) => {
	const policies = Rec.fromEntries(
		Arr.map(plan.modules, (module) => [
			policyLogicalId(module.module),
			{
				Type: "AWS::IAM::ManagedPolicy",
				Properties: {
					ManagedPolicyName: module.policyName,
					Description: `Maple ${module.module} access`,
					PolicyDocument: module.policy,
				},
			},
		]),
	)
	const template = {
		AWSTemplateFormatVersion: "2010-09-09",
		Description: `Maple integration ${connectionId} (setup v${AWS_TEMPLATE_VERSION}): a read-only role Maple assumes. ${DOCS_URL}`,
		Parameters: {
			CreateOidcProvider: {
				Type: "String",
				AllowedValues: ["true", "false"],
				Default: "true",
				Description: `Whether to register Maple's identity provider (${plan.oidcProvider.url}). Choose false if this account already has it.`,
			},
		},
		Conditions: { CreateOidcProvider: { "Fn::Equals": [{ Ref: "CreateOidcProvider" }, "true"] } },
		Resources: {
			MapleOidcProvider: {
				Type: "AWS::IAM::OIDCProvider",
				Condition: "CreateOidcProvider",
				DeletionPolicy: "Retain",
				UpdateReplacePolicy: "Retain",
				Properties: { Url: plan.oidcProvider.url, ClientIdList: [plan.oidcProvider.audience] },
			},
			...policies,
			MapleRole: {
				Type: "AWS::IAM::Role",
				Properties: {
					RoleName: plan.roleName,
					Description: "Assumed by Maple to read this account",
					// Through the provider the stack creates, when it does, so the role waits for it.
					AssumeRolePolicyDocument: trustingPrincipal(plan, {
						"Fn::If": ["CreateOidcProvider", { Ref: "MapleOidcProvider" }, plan.oidcProvider.arn],
					}),
					MaxSessionDuration: 3600,
					ManagedPolicyArns: [
						...new Set(Arr.flatMap(plan.modules, (module) => module.managedPolicies)),
						...Arr.map(plan.modules, (module) => ({ Ref: policyLogicalId(module.module) })),
					],
					Policies: [{ PolicyName: "maple-self-read", PolicyDocument: plan.selfReadPolicy }],
					Tags: plan.tags,
				},
			},
		},
		Outputs: {
			RoleArn: { Description: "The role Maple assumes", Value: { "Fn::GetAtt": ["MapleRole", "Arn"] } },
		},
	}
	return `${encodePrettyJson(template)}\n`
}

/** A connection's metric stream as its setup renders it. */
export interface AwsStreamTarget extends AwsMetricStream {
	/** The ingest URL the Firehose posts to, and the secret it sends as its access key. */
	readonly endpoint: string
	readonly accessKey: string
}

/**
 * A Firehose that posts to Maple with the stack's `AccessKey` parameter, and the bucket that keeps
 * the batches Maple did not accept for 7 days.
 */
const firehoseResources = (streamName: string, endpoint: string, roleDescription: string) => ({
	FailedDeliveries: {
		Type: "AWS::S3::Bucket",
		Properties: {
			BucketEncryption: {
				ServerSideEncryptionConfiguration: [
					{ ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } },
				],
			},
			PublicAccessBlockConfiguration: {
				BlockPublicAcls: true,
				BlockPublicPolicy: true,
				IgnorePublicAcls: true,
				RestrictPublicBuckets: true,
			},
			OwnershipControls: { Rules: [{ ObjectOwnership: "BucketOwnerEnforced" }] },
			LifecycleConfiguration: {
				Rules: [{ Id: "expire-failed-deliveries", Status: "Enabled", ExpirationInDays: 7 }],
			},
		},
	},
	FirehoseRole: {
		Type: "AWS::IAM::Role",
		Properties: {
			Description: roleDescription,
			AssumeRolePolicyDocument: {
				Version: "2012-10-17",
				Statement: [
					{
						Effect: "Allow",
						Principal: { Service: "firehose.amazonaws.com" },
						Action: "sts:AssumeRole",
						Condition: {
							StringEquals: { "aws:SourceAccount": { Ref: "AWS::AccountId" } },
						},
					},
				],
			},
			Policies: [
				{
					PolicyName: "failed-deliveries",
					PolicyDocument: {
						Version: "2012-10-17",
						Statement: [
							{
								Effect: "Allow",
								Action: [
									"s3:AbortMultipartUpload",
									"s3:GetBucketLocation",
									"s3:GetObject",
									"s3:ListBucket",
									"s3:ListBucketMultipartUploads",
									"s3:PutObject",
								],
								Resource: [
									{ "Fn::GetAtt": ["FailedDeliveries", "Arn"] },
									{ "Fn::Sub": "${FailedDeliveries.Arn}/*" },
								],
							},
						],
					},
				},
			],
		},
	},
	DeliveryStream: {
		Type: "AWS::KinesisFirehose::DeliveryStream",
		Properties: {
			DeliveryStreamName: streamName,
			DeliveryStreamType: "DirectPut",
			HttpEndpointDestinationConfiguration: {
				EndpointConfiguration: {
					Name: "Maple",
					Url: endpoint,
					AccessKey: { Ref: "AccessKey" },
				},
				RequestConfiguration: { ContentEncoding: "GZIP" },
				BufferingHints: { IntervalInSeconds: 60, SizeInMBs: 1 },
				RetryOptions: { DurationInSeconds: 3600 },
				RoleARN: { "Fn::GetAtt": ["FirehoseRole", "Arn"] },
				S3BackupMode: "FailedDataOnly",
				S3Configuration: {
					BucketARN: { "Fn::GetAtt": ["FailedDeliveries", "Arn"] },
					RoleARN: { "Fn::GetAtt": ["FirehoseRole", "Arn"] },
					CompressionFormat: "GZIP",
					Prefix: "failed/",
				},
			},
		},
	},
})

/**
 * One region's metric stream: CloudWatch streams that region's metrics to a Firehose, which posts
 * them to Maple. Failed batches land in a bucket that empties itself after 7 days.
 */
export const renderAwsMetricsCloudFormation = (
	connectionId: AwsConnectionId,
	streamName: string,
	stream: Pick<AwsStreamTarget, "endpoint" | "namespaces">,
) => {
	const template = {
		AWSTemplateFormatVersion: "2010-09-09",
		Description: `Maple integration ${connectionId}: streams CloudWatch metrics of this region to Maple. ${DOCS_URL}`,
		Parameters: {
			AccessKey: {
				Type: "String",
				NoEcho: true,
				MinLength: 1,
				Description: "Sent with every delivery so Maple knows which connection it is for",
			},
		},
		Resources: {
			...firehoseResources(
				streamName,
				stream.endpoint,
				"Lets the Maple Firehose keep batches Maple could not accept",
			),
			MetricStreamRole: {
				Type: "AWS::IAM::Role",
				Properties: {
					Description: "Lets the Maple metric stream write to its Firehose",
					AssumeRolePolicyDocument: {
						Version: "2012-10-17",
						Statement: [
							{
								Effect: "Allow",
								Principal: { Service: "streams.metrics.cloudwatch.amazonaws.com" },
								Action: "sts:AssumeRole",
								Condition: {
									StringEquals: { "aws:SourceAccount": { Ref: "AWS::AccountId" } },
								},
							},
						],
					},
					Policies: [
						{
							PolicyName: "put-to-firehose",
							PolicyDocument: {
								Version: "2012-10-17",
								Statement: [
									{
										Effect: "Allow",
										Action: ["firehose:PutRecord", "firehose:PutRecordBatch"],
										Resource: { "Fn::GetAtt": ["DeliveryStream", "Arn"] },
									},
								],
							},
						},
					],
				},
			},
			MetricStream: {
				Type: "AWS::CloudWatch::MetricStream",
				Properties: {
					Name: streamName,
					FirehoseArn: { "Fn::GetAtt": ["DeliveryStream", "Arn"] },
					RoleArn: { "Fn::GetAtt": ["MetricStreamRole", "Arn"] },
					OutputFormat: "opentelemetry1.0",
					IncludeFilters: Arr.map(stream.namespaces, (namespace) => ({ Namespace: namespace })),
				},
			},
		},
	}
	return `${encodePrettyJson(template)}\n`
}

/** A connection's CloudTrail feed as its setup renders it. */
export interface AwsAuditTarget {
	/** The ingest URL the Firehose posts to, and the secret it sends as its access key. */
	readonly endpoint: string
	readonly accessKey: string
}

/** Matches the CloudTrail events the feed sends. Reads are never matched by an `ENABLED` rule. */
const auditEventPattern = { "detail-type": AWS_AUDIT_DETAIL_TYPES }

/** A role EventBridge assumes to deliver a rule's events, allowed one action on one resource. */
const eventsRole = (description: string, action: string | ReadonlyArray<string>, resource: unknown) => ({
	Type: "AWS::IAM::Role",
	Properties: {
		Description: description,
		AssumeRolePolicyDocument: {
			Version: "2012-10-17",
			Statement: [
				{
					Effect: "Allow",
					Principal: { Service: "events.amazonaws.com" },
					Action: "sts:AssumeRole",
					Condition: { StringEquals: { "aws:SourceAccount": { Ref: "AWS::AccountId" } } },
				},
			],
		},
		Policies: [
			{
				PolicyName: "deliver",
				PolicyDocument: {
					Version: "2012-10-17",
					Statement: [{ Effect: "Allow", Action: action, Resource: resource }],
				},
			},
		],
	},
})

/**
 * The CloudTrail feed's home stack, in us-east-1 where IAM, STS and sign-in events land: a rule on
 * the default bus sends CloudTrail's changes and console activity, this region's and those the other
 * regions forward, to a Firehose that posts them to Maple. EventBridge sees CloudTrail events only
 * while a trail logs, so `CreateTrail` adds a multi-region one for an account without; its bucket
 * outlives the stack, since it holds the account's audit history.
 */
export const renderAwsAuditCloudFormation = (
	connectionId: AwsConnectionId,
	names: { readonly streamName: string; readonly trailName: string },
	endpoint: string,
) => {
	const trailArn = {
		"Fn::Sub": `arn:\${AWS::Partition}:cloudtrail:\${AWS::Region}:\${AWS::AccountId}:trail/${names.trailName}`,
	}
	const template = {
		AWSTemplateFormatVersion: "2010-09-09",
		Description: `Maple integration ${connectionId}: sends this account's CloudTrail changes and console sign-ins to Maple's audit log. ${DOCS_URL}`,
		Parameters: {
			AccessKey: {
				Type: "String",
				NoEcho: true,
				MinLength: 1,
				Description: "Sent with every delivery so Maple knows which connection it is for",
			},
			CreateTrail: {
				Type: "String",
				AllowedValues: ["true", "false"],
				Default: "false",
				Description:
					"Whether to create a multi-region trail. EventBridge only sees CloudTrail events while a trail logs; choose false if the account already has one.",
			},
		},
		Conditions: { CreateTrail: { "Fn::Equals": [{ Ref: "CreateTrail" }, "true"] } },
		Resources: {
			...firehoseResources(
				names.streamName,
				endpoint,
				"Lets the Maple audit Firehose keep batches Maple could not accept",
			),
			AuditRuleRole: eventsRole(
				"Lets the Maple audit rule write to its Firehose",
				["firehose:PutRecord", "firehose:PutRecordBatch"],
				{ "Fn::GetAtt": ["DeliveryStream", "Arn"] },
			),
			AuditRule: {
				Type: "AWS::Events::Rule",
				Properties: {
					Name: names.streamName,
					Description: "Sends CloudTrail changes and console sign-ins to Maple",
					EventPattern: auditEventPattern,
					State: "ENABLED",
					Targets: [
						{
							Id: "maple",
							Arn: { "Fn::GetAtt": ["DeliveryStream", "Arn"] },
							RoleArn: { "Fn::GetAtt": ["AuditRuleRole", "Arn"] },
						},
					],
				},
			},
			TrailBucket: {
				Type: "AWS::S3::Bucket",
				Condition: "CreateTrail",
				DeletionPolicy: "Retain",
				UpdateReplacePolicy: "Retain",
				Properties: {
					BucketEncryption: {
						ServerSideEncryptionConfiguration: [
							{ ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } },
						],
					},
					PublicAccessBlockConfiguration: {
						BlockPublicAcls: true,
						BlockPublicPolicy: true,
						IgnorePublicAcls: true,
						RestrictPublicBuckets: true,
					},
					OwnershipControls: { Rules: [{ ObjectOwnership: "BucketOwnerEnforced" }] },
					LifecycleConfiguration: {
						Rules: [{ Id: "expire-trail-logs", Status: "Enabled", ExpirationInDays: 365 }],
					},
				},
			},
			TrailBucketPolicy: {
				Type: "AWS::S3::BucketPolicy",
				Condition: "CreateTrail",
				Properties: {
					Bucket: { Ref: "TrailBucket" },
					PolicyDocument: {
						Version: "2012-10-17",
						Statement: [
							{
								Sid: "CloudTrailAclCheck",
								Effect: "Allow",
								Principal: { Service: "cloudtrail.amazonaws.com" },
								Action: "s3:GetBucketAcl",
								Resource: { "Fn::GetAtt": ["TrailBucket", "Arn"] },
								Condition: { StringEquals: { "aws:SourceArn": trailArn } },
							},
							{
								Sid: "CloudTrailWrite",
								Effect: "Allow",
								Principal: { Service: "cloudtrail.amazonaws.com" },
								Action: "s3:PutObject",
								Resource: { "Fn::Sub": "${TrailBucket.Arn}/AWSLogs/${AWS::AccountId}/*" },
								Condition: { StringEquals: { "aws:SourceArn": trailArn } },
							},
						],
					},
				},
			},
			Trail: {
				Type: "AWS::CloudTrail::Trail",
				Condition: "CreateTrail",
				DependsOn: "TrailBucketPolicy",
				Properties: {
					TrailName: names.trailName,
					S3BucketName: { Ref: "TrailBucket" },
					IsLogging: true,
					IsMultiRegionTrail: true,
					IncludeGlobalServiceEvents: true,
					EnableLogFileValidation: true,
				},
			},
		},
	}
	return `${encodePrettyJson(template)}\n`
}

/** One region's forwarder: a rule that sends its CloudTrail changes to the default bus in us-east-1. */
export const renderAwsAuditForwarderCloudFormation = (connectionId: AwsConnectionId, ruleName: string) => {
	const homeBus = {
		"Fn::Sub": `arn:\${AWS::Partition}:events:${AWS_AUDIT_HOME_REGION}:\${AWS::AccountId}:event-bus/default`,
	}
	const template = {
		AWSTemplateFormatVersion: "2010-09-09",
		Description: `Maple integration ${connectionId}: forwards this region's CloudTrail changes to ${AWS_AUDIT_HOME_REGION}, where Maple's audit feed sends them on. ${DOCS_URL}`,
		Resources: {
			ForwardRuleRole: eventsRole(
				`Lets the Maple audit rule forward events to ${AWS_AUDIT_HOME_REGION}`,
				"events:PutEvents",
				homeBus,
			),
			ForwardRule: {
				Type: "AWS::Events::Rule",
				Properties: {
					Name: ruleName,
					Description: `Forwards CloudTrail changes and console sign-ins to ${AWS_AUDIT_HOME_REGION} for Maple`,
					EventPattern: auditEventPattern,
					State: "ENABLED",
					Targets: [
						{
							Id: "maple-home-region",
							Arn: homeBus,
							RoleArn: { "Fn::GetAtt": ["ForwardRuleRole", "Arn"] },
						},
					],
				},
			},
		},
	}
	return `${encodePrettyJson(template)}\n`
}

export interface AwsScriptTarget {
	readonly accountId: AwsAccountId
	readonly stackName: string
	readonly metricsStackName: string
	readonly auditStackName: string
	readonly auditForwarderStackName: string
	readonly auditTrailName: string
	readonly oidcProvider: AwsSetupPlan["oidcProvider"]
}

/**
 * Registers Maple's identity provider unless the account has it: other connections may share it.
 * One made by hand may lack Maple's audience, and adding a client id it already lists is a no-op.
 */
const ensureOidcProvider = (
	provider: AwsScriptTarget["oidcProvider"],
) => `if aws iam get-open-id-connect-provider --open-id-connect-provider-arn ${provider.arn} >/dev/null 2>&1; then
  aws iam add-client-id-to-open-id-connect-provider --open-id-connect-provider-arn ${provider.arn} --client-id ${provider.audience}
else
  echo "Registering Maple's identity provider, ${provider.url}..."
  aws iam create-open-id-connect-provider --url ${provider.url} --client-id-list ${provider.audience} >/dev/null
fi
`

/** Deletes Maple's identity provider once no Maple role is left to trust it. */
const removeOidcProviderIfUnused = (
	provider: AwsScriptTarget["oidcProvider"],
) => `remaining="$(aws iam list-roles --query "Roles[?starts_with(RoleName, '${AWS_ROLE_NAME_PREFIX}')].RoleName" --output text)"
if [ -z "$remaining" ] || [ "$remaining" = "None" ]; then
  echo "Removing Maple's identity provider: no Maple role is left in the account..."
  aws iam delete-open-id-connect-provider --open-id-connect-provider-arn ${provider.arn} 2>/dev/null || true
fi
`

// Every value interpolated below is pattern-checked (account id) or derived from a UUID (stack
// name), and the template is JSON, so nothing needs shell quoting inside the quoted here-document.
const accountGuard = (
	accountId: AwsAccountId,
) => `account="$(aws sts get-caller-identity --query Account --output text)"
if [ "$account" != "${accountId}" ]; then
  echo "This shell is signed in to AWS account $account, not ${accountId}." >&2
  echo "Open CloudShell from the AWS console of account ${accountId} and paste this again." >&2
  exit 1
fi
`

/**
 * Deletes one region's stack (`$1` region, `$2` stack, `$3` what it is). CloudFormation cannot delete
 * a bucket with objects in it, and failed batches land in it, so the bucket is emptied first; once
 * more if Firehose wrote into it while the stack was being deleted.
 */
const DELETE_EMPTIED_STACK = `delete_emptied_stack() {
  for attempt in 1 2; do
    bucket="$(aws cloudformation describe-stack-resource --region "$1" --stack-name "$2" --logical-resource-id FailedDeliveries --query 'StackResourceDetail.PhysicalResourceId' --output text 2>/dev/null || true)"
    if [ -n "$bucket" ] && [ "$bucket" != "None" ]; then
      aws s3 rm "s3://$bucket" --recursive --region "$1" >/dev/null 2>&1 || true
    fi
    if aws cloudformation delete-stack --region "$1" --stack-name "$2" &&
      aws cloudformation wait stack-delete-complete --region "$1" --stack-name "$2"; then
      return 0
    fi
    echo "Deleting the $3 stack in $1 failed (attempt $attempt)." >&2
  done
  return 1
}
`

const ENABLED_REGIONS = `$(aws ec2 describe-regions --region ${AWS_STACK_REGION} --query 'Regions[].RegionName' --output text)`

/**
 * Deletes `stackName` from every enabled region not in `keep`. A feature turned off, or a region
 * dropped, leaves a stack only a later setup or the cleanup knows to remove.
 */
const removeStacks = (
	stackName: string,
	keep: ReadonlyArray<string>,
	what: string,
) => `keep=" ${Arr.join(keep, " ")} "
regions="${ENABLED_REGIONS}"
for region in $regions; do
  case "$keep" in *" $region "*) continue ;; esac
  if aws cloudformation describe-stacks --region "$region" --stack-name ${stackName} >/dev/null 2>&1; then
    echo "Removing the ${what} from $region..."
    delete_emptied_stack "$region" ${stackName} "${what}"
  fi
done
`

/** Deploys the metric stream stack to each of the stream's regions. */
const deployMetricsStacks = (
	stackName: string,
	stream: AwsStreamTarget,
	template: string,
) => `metrics_template="$(mktemp)"
cat > "$metrics_template" <<'MAPLE_METRICS_TEMPLATE'
${template}MAPLE_METRICS_TEMPLATE
for region in ${Arr.join(stream.regions, " ")}; do
  status="$(aws cloudformation describe-stacks --region "$region" --stack-name ${stackName} --query 'Stacks[0].StackStatus' --output text 2>/dev/null || true)"
  if [ "$status" = "ROLLBACK_COMPLETE" ]; then
    delete_emptied_stack "$region" ${stackName} "metric stream"
  fi
  echo "Deploying the metric stream to $region..."
  aws cloudformation deploy \\
    --region "$region" \\
    --stack-name ${stackName} \\
    --template-file "$metrics_template" \\
    --capabilities CAPABILITY_IAM \\
    --parameter-overrides "AccessKey=${stream.accessKey}" \\
    --no-fail-on-empty-changeset
done
rm -f "$metrics_template"
`

/** The CloudTrail feed's rendered stacks. */
export interface AwsAuditStacks {
	readonly target: AwsAuditTarget
	readonly template: string
	readonly forwarderTemplate: string
}

/** A trail a Maple feed created (`maple-` and 24 hex digits), in any connection to the account. */
const MAPLE_TRAIL_GLOB = `*/maple-${Str.repeat(24)("?")}`

/**
 * Whether the account needs Maple's trail: none of its other multi-region trails logs write
 * management events. A trail whose status or selectors cannot be read (an organization trail seen
 * from a member account) counts, so the feed never adds a second trail, which AWS bills, beside
 * one it cannot see into. Trails other Maple connections created never count: one of them may
 * be removed while this feed still needs a trail. The lists are read into variables first, so a
 * failed AWS call stops the script instead of reading as "no trails".
 */
const trailCheck = (
	trailName: string,
) => `trails="$(aws cloudtrail describe-trails --region ${AWS_AUDIT_HOME_REGION} --include-shadow-trails --query 'trailList[?IsMultiRegionTrail].TrailARN' --output text)"
create_trail=true
for trail in $trails; do
  case "$trail" in None | ${MAPLE_TRAIL_GLOB}) continue ;; esac
  logging="$(aws cloudtrail get-trail-status --region ${AWS_AUDIT_HOME_REGION} --name "$trail" --query IsLogging --output text 2>/dev/null || echo unknown)"
  [ "$logging" = "False" ] && continue
  selectors="$(aws cloudtrail get-event-selectors --region ${AWS_AUDIT_HOME_REGION} --trail-name "$trail" --query '[length(EventSelectors[?IncludeManagementEvents && ReadWriteType != \`ReadOnly\`] || \`[]\`), length(AdvancedEventSelectors || \`[]\`)]' --output text 2>/dev/null || echo unknown)"
  # Advanced selectors are trusted to include management events: reading them is not worth a guess.
  set -- $selectors
  [ "\${1:-}" = "0" ] && [ "\${2:-}" = "0" ] && continue
  create_trail=false
  break
done
if [ "$create_trail" = "true" ]; then
  echo "No other multi-region trail records changes in this account: the CloudTrail feed creates ${trailName}."
fi
`

/**
 * Deploys the CloudTrail feed: its home stack in us-east-1, then a forwarder in every other enabled
 * region, side by side so a first run does not take a region at a time. Any region that fails is
 * named, with its output, and fails the script.
 */
const deployAuditStacks = (target: AwsScriptTarget, audit: AwsAuditStacks) => `audit_template="$(mktemp)"
cat > "$audit_template" <<'MAPLE_AUDIT_TEMPLATE'
${audit.template}MAPLE_AUDIT_TEMPLATE
forwarder_template="$(mktemp)"
cat > "$forwarder_template" <<'MAPLE_AUDIT_FORWARDER_TEMPLATE'
${audit.forwarderTemplate}MAPLE_AUDIT_FORWARDER_TEMPLATE
${trailCheck(target.auditTrailName)}status="$(aws cloudformation describe-stacks --region ${AWS_AUDIT_HOME_REGION} --stack-name ${target.auditStackName} --query 'Stacks[0].StackStatus' --output text 2>/dev/null || true)"
if [ "$status" = "ROLLBACK_COMPLETE" ]; then
  delete_emptied_stack ${AWS_AUDIT_HOME_REGION} ${target.auditStackName} "CloudTrail feed"
fi
echo "Deploying the CloudTrail feed to ${AWS_AUDIT_HOME_REGION}..."
aws cloudformation deploy \\
  --region ${AWS_AUDIT_HOME_REGION} \\
  --stack-name ${target.auditStackName} \\
  --template-file "$audit_template" \\
  --capabilities CAPABILITY_IAM \\
  --parameter-overrides "AccessKey=${audit.target.accessKey}" "CreateTrail=$create_trail" \\
  --no-fail-on-empty-changeset
forwarder_logs="$(mktemp -d)"
jobs_started=""
regions="${ENABLED_REGIONS}"
for region in $regions; do
  [ "$region" = "${AWS_AUDIT_HOME_REGION}" ] && continue
  (
    status="$(aws cloudformation describe-stacks --region "$region" --stack-name ${target.auditForwarderStackName} --query 'Stacks[0].StackStatus' --output text 2>/dev/null || true)"
    if [ "$status" = "ROLLBACK_COMPLETE" ]; then
      aws cloudformation delete-stack --region "$region" --stack-name ${target.auditForwarderStackName}
      aws cloudformation wait stack-delete-complete --region "$region" --stack-name ${target.auditForwarderStackName}
    fi
    aws cloudformation deploy \\
      --region "$region" \\
      --stack-name ${target.auditForwarderStackName} \\
      --template-file "$forwarder_template" \\
      --capabilities CAPABILITY_IAM \\
      --no-fail-on-empty-changeset
  ) >"$forwarder_logs/$region.log" 2>&1 &
  jobs_started="$jobs_started $!:$region"
done
echo "Forwarding CloudTrail events from every other enabled region..."
failed=""
blocked=""
for job in $jobs_started; do
  region="\${job#*:}"
  if ! wait "\${job%%:*}"; then
    # A region an organization policy denies is not this account's to use: skip it.
    if grep -qE "AccessDenied|explicit deny|not authorized" "$forwarder_logs/$region.log"; then
      blocked="$blocked $region"
    else
      failed="$failed $region"
    fi
  fi
done
rm -f "$audit_template" "$forwarder_template"
if [ -n "$blocked" ]; then
  echo "Skipped regions this account may not deploy to (an organization policy denies them):$blocked"
fi
if [ -n "$failed" ]; then
  for region in $failed; do
    echo "Deploying the CloudTrail forwarder to $region failed:" >&2
    cat "$forwarder_logs/$region.log" >&2
  done
  rm -rf "$forwarder_logs"
  exit 1
fi
rm -rf "$forwarder_logs"
`

/**
 * The script an administrator pastes into AWS CloudShell. It deploys the stack, which converges: a
 * re-run after a module change updates the role and its policies in place. With a metric stream it
 * then deploys the stream's stack to each of its regions.
 */
export const renderAwsSetupScript = (
	target: AwsScriptTarget,
	template: string,
	metrics: { readonly stream: AwsStreamTarget; readonly template: string } | null,
	audit: AwsAuditStacks | null,
) =>
	forPaste(
		"AWS",
		"MAPLE_SETUP_SCRIPT",
		`set -euo pipefail
${accountGuard(target.accountId)}template="$(mktemp)"
cat > "$template" <<'MAPLE_TEMPLATE'
${template}MAPLE_TEMPLATE
${ensureOidcProvider(target.oidcProvider)}# A first deploy that failed leaves a stack that can only be deleted, not updated.
status="$(aws cloudformation describe-stacks --region ${AWS_STACK_REGION} --stack-name ${target.stackName} --query 'Stacks[0].StackStatus' --output text 2>/dev/null || true)"
if [ "$status" = "ROLLBACK_COMPLETE" ]; then
  echo "Removing the stack a failed deploy left behind..."
  aws cloudformation delete-stack --region ${AWS_STACK_REGION} --stack-name ${target.stackName}
  aws cloudformation wait stack-delete-complete --region ${AWS_STACK_REGION} --stack-name ${target.stackName}
fi
echo "Deploying ${target.stackName} to account ${target.accountId}..."
aws cloudformation deploy \\
  --region ${AWS_STACK_REGION} \\
  --stack-name ${target.stackName} \\
  --template-file "$template" \\
  --capabilities CAPABILITY_NAMED_IAM \\
  --parameter-overrides CreateOidcProvider=false \\
  --no-fail-on-empty-changeset
rm -f "$template"
${DELETE_EMPTIED_STACK}${metrics === null ? "" : deployMetricsStacks(target.metricsStackName, metrics.stream, metrics.template)}${removeStacks(target.metricsStackName, metrics?.stream.regions ?? [], "metric stream")}${audit === null ? `${removeStacks(target.auditForwarderStackName, [], "CloudTrail forwarder")}${removeStacks(target.auditStackName, [], "CloudTrail feed")}` : deployAuditStacks(target, audit)}echo "Done. Go back to Maple and select Check connection. Details: ${DOCS_URL}"
`,
	)

export const renderAwsCleanupScript = (target: AwsScriptTarget) =>
	forPaste(
		"AWS",
		"MAPLE_CLEANUP_SCRIPT",
		`set -euo pipefail
${accountGuard(target.accountId)}${DELETE_EMPTIED_STACK}${removeStacks(target.metricsStackName, [], "metric stream")}${removeStacks(target.auditForwarderStackName, [], "CloudTrail forwarder")}${removeStacks(target.auditStackName, [], "CloudTrail feed")}echo "Deleting ${target.stackName} from account ${target.accountId}..."
aws cloudformation delete-stack --region ${AWS_STACK_REGION} --stack-name ${target.stackName}
aws cloudformation wait stack-delete-complete --region ${AWS_STACK_REGION} --stack-name ${target.stackName}
${removeOidcProviderIfUnused(target.oidcProvider)}echo "Done. The role Maple used is gone."
`,
	)

const hcl = (value: unknown) => encodeJson(value)

/** The same setup as a self-contained Terraform file for the `aws` provider. */
export const renderAwsTerraform = (connectionId: AwsConnectionId, plan: AwsSetupPlan) => {
	const modulePolicies = Arr.join(
		Arr.map(
			plan.modules,
			(module) => `
resource "aws_iam_policy" "maple_${module.module}" {
  name   = ${hcl(module.policyName)}
  policy = jsonencode(${hcl(module.policy)})
}

resource "aws_iam_role_policy_attachment" "maple_${module.module}" {
  role       = aws_iam_role.maple.name
  policy_arn = aws_iam_policy.maple_${module.module}.arn
}
`,
		),
		"",
	)
	const managed = Arr.join(
		Arr.map(
			[...new Set(Arr.flatMap(plan.modules, (module) => module.managedPolicies))],
			(arn, index) => `
resource "aws_iam_role_policy_attachment" "maple_managed_${index}" {
  role       = aws_iam_role.maple.name
  policy_arn = ${hcl(arn)}
}
`,
		),
		"",
	)
	const trust = Str.replace(
		'"__PROVIDER__"',
		"data.aws_iam_openid_connect_provider.maple.arn",
	)(hcl(trustingPrincipal(plan, "__PROVIDER__")))
	return `# Maple integration ${connectionId} (setup v${AWS_TEMPLATE_VERSION}): a read-only role Maple assumes.
# Apply it with credentials for the account in the role ARN below.
# Details: ${DOCS_URL}

# Maple's identity provider. An account has one per issuer, shared by every Maple connection, so
# this file only looks it up: a destroy here must not take it from the others. Register it once:
#   aws iam create-open-id-connect-provider --url ${plan.oidcProvider.url} --client-id-list ${plan.oidcProvider.audience}
data "aws_iam_openid_connect_provider" "maple" {
  url = ${hcl(plan.oidcProvider.url)}
}

resource "aws_iam_role" "maple" {
  name                 = ${hcl(plan.roleName)}
  description          = "Assumed by Maple to read this account"
  max_session_duration = 3600
  assume_role_policy   = jsonencode(${trust})
  tags                 = ${hcl(Rec.fromEntries(Arr.map(plan.tags, (tag) => [tag.Key, tag.Value])))}
}

resource "aws_iam_role_policy" "maple_self_read" {
  name   = "maple-self-read"
  role   = aws_iam_role.maple.id
  policy = jsonencode(${hcl(plan.selfReadPolicy)})
}
${modulePolicies}${managed}
output "maple_role_arn" {
  value = aws_iam_role.maple.arn
}
`
}

/** What the setup and cleanup scripts of a connection name in the account. */
export const awsScriptTarget = (
	connectionId: AwsConnectionId,
	accountId: AwsAccountId,
	oidcProvider: AwsSetupPlan["oidcProvider"],
): AwsScriptTarget => {
	const names = awsConnectionResourceNames(connectionId)
	return {
		accountId,
		stackName: names.stackName,
		metricsStackName: names.metricsStackName,
		auditStackName: names.auditStackName,
		auditForwarderStackName: names.auditForwarderStackName,
		auditTrailName: names.auditTrailName,
		oidcProvider,
	}
}

/** Every rendering of one connection's setup. */
export const renderAwsSetup = Effect.fn("renderAwsSetup")(function* (
	connectionId: AwsConnectionId,
	accountId: AwsAccountId,
	plan: AwsSetupPlan,
	stream: AwsStreamTarget | null,
	audit: AwsAuditTarget | null,
) {
	const target = awsScriptTarget(connectionId, accountId, plan.oidcProvider)
	const names = awsConnectionResourceNames(connectionId)
	const template = renderAwsCloudFormation(connectionId, plan)
	const metrics =
		stream === null
			? null
			: {
					stream,
					template: renderAwsMetricsCloudFormation(connectionId, plan.metricStreamName, stream),
				}
	const auditStacks =
		audit === null
			? null
			: {
					target: audit,
					template: renderAwsAuditCloudFormation(
						connectionId,
						{ streamName: names.auditStreamName, trailName: names.auditTrailName },
						audit.endpoint,
					),
					forwarderTemplate: renderAwsAuditForwarderCloudFormation(
						connectionId,
						names.auditStreamName,
					),
				}
	return {
		stackName: plan.stackName,
		stackRegion: AWS_STACK_REGION,
		setupScript: yield* renderAwsSetupScript(target, template, metrics, auditStacks),
		cleanupScript: yield* renderAwsCleanupScript(target),
		cloudformationTemplate: template,
		terraform: renderAwsTerraform(connectionId, plan),
		metricsStackName: metrics === null ? null : plan.metricsStackName,
		metricsCloudformationTemplate: metrics?.template ?? null,
	}
})
