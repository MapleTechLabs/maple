import { AWS_TEMPLATE_VERSION, type AwsMetricStream, type AwsSetupPlan } from "@maple/domain/aws"
import type { AwsAccountId, AwsConnectionId } from "@maple/domain/primitives"
import { Effect } from "effect"
import { forPaste } from "../paste-script"

const DOCS_URL = "https://maple.dev/docs/integrations/aws"
/**
 * Stacks live in a region while IAM does not: one fixed region lets the cleanup find the stack
 * whatever region CloudShell opened in, and a re-run update it instead of colliding on the role.
 */
export const AWS_STACK_REGION = "us-east-1"

/** CloudFormation logical id of a module's policy: `ObservabilityPolicy`. */
const policyLogicalId = (module: string) => `${module[0]?.toUpperCase() ?? ""}${module.slice(1)}Policy`

/** The stack as a CloudFormation template (JSON, which CloudFormation reads as it reads YAML). */
export const renderAwsCloudFormation = (connectionId: AwsConnectionId, plan: AwsSetupPlan) => {
	const policies = Object.fromEntries(
		plan.modules.map((module) => [
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
		Resources: {
			...policies,
			MapleRole: {
				Type: "AWS::IAM::Role",
				Properties: {
					RoleName: plan.roleName,
					Description: "Assumed by Maple to read this account",
					AssumeRolePolicyDocument: plan.trustPolicy,
					MaxSessionDuration: 3600,
					ManagedPolicyArns: [
						...new Set(plan.modules.flatMap((module) => module.managedPolicies)),
						...plan.modules.map((module) => ({ Ref: policyLogicalId(module.module) })),
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
	return `${JSON.stringify(template, null, 2)}\n`
}

/** A connection's metric stream as its setup renders it. */
export interface AwsStreamTarget extends AwsMetricStream {
	/** The ingest URL the Firehose posts to, and the secret it sends as its access key. */
	readonly endpoint: string
	readonly accessKey: string
}

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
					Description: "Lets the Maple Firehose keep batches Maple could not accept",
					AssumeRolePolicyDocument: {
						Version: "2012-10-17",
						Statement: [
							{
								Effect: "Allow",
								Principal: { Service: "firehose.amazonaws.com" },
								Action: "sts:AssumeRole",
								Condition: { StringEquals: { "aws:SourceAccount": { Ref: "AWS::AccountId" } } },
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
						EndpointConfiguration: { Name: "Maple", Url: stream.endpoint, AccessKey: { Ref: "AccessKey" } },
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
								Condition: { StringEquals: { "aws:SourceAccount": { Ref: "AWS::AccountId" } } },
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
					IncludeFilters: stream.namespaces.map((namespace) => ({ Namespace: namespace })),
				},
			},
		},
	}
	return `${JSON.stringify(template, null, 2)}\n`
}

export interface AwsScriptTarget {
	readonly accountId: AwsAccountId
	readonly stackName: string
	readonly metricsStackName: string
}

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
 * Deletes the metric stream stack from every enabled region not in `keep`. A stream turned off, or
 * a region dropped, leaves a stack only a later setup or the cleanup knows to remove.
 */
/**
 * Deletes one region's metric stream stack. CloudFormation cannot delete a bucket with objects in
 * it, and failed batches land in it, so the bucket is emptied first; once more if Firehose wrote
 * into it while the stack was being deleted.
 */
const deleteMetricsStackFunction = (stackName: string) => `delete_metrics_stack() {
  for attempt in 1 2; do
    bucket="$(aws cloudformation describe-stack-resource --region "$1" --stack-name ${stackName} --logical-resource-id FailedDeliveries --query 'StackResourceDetail.PhysicalResourceId' --output text 2>/dev/null || true)"
    if [ -n "$bucket" ] && [ "$bucket" != "None" ]; then
      aws s3 rm "s3://$bucket" --recursive --region "$1" >/dev/null 2>&1 || true
    fi
    aws cloudformation delete-stack --region "$1" --stack-name ${stackName}
    if aws cloudformation wait stack-delete-complete --region "$1" --stack-name ${stackName}; then
      return 0
    fi
    echo "Deleting the metric stream stack in $1 failed (attempt $attempt)." >&2
  done
  return 1
}
`

const removeMetricsStacks = (stackName: string, keep: ReadonlyArray<string>) => `keep=" ${keep.join(" ")} "
for region in $(aws ec2 describe-regions --region ${AWS_STACK_REGION} --query 'Regions[].RegionName' --output text); do
  case "$keep" in *" $region "*) continue ;; esac
  if aws cloudformation describe-stacks --region "$region" --stack-name ${stackName} >/dev/null 2>&1; then
    echo "Removing the metric stream from $region..."
    delete_metrics_stack "$region"
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
for region in ${stream.regions.join(" ")}; do
  status="$(aws cloudformation describe-stacks --region "$region" --stack-name ${stackName} --query 'Stacks[0].StackStatus' --output text 2>/dev/null || true)"
  if [ "$status" = "ROLLBACK_COMPLETE" ]; then
    delete_metrics_stack "$region"
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

/**
 * The script an administrator pastes into AWS CloudShell. It deploys the stack, which converges: a
 * re-run after a module change updates the role and its policies in place. With a metric stream it
 * then deploys the stream's stack to each of its regions.
 */
export const renderAwsSetupScript = (
	target: AwsScriptTarget,
	template: string,
	metrics: { readonly stream: AwsStreamTarget; readonly template: string } | null,
) =>
	forPaste(
		"AWS",
		"MAPLE_SETUP_SCRIPT",
		`set -euo pipefail
${accountGuard(target.accountId)}template="$(mktemp)"
cat > "$template" <<'MAPLE_TEMPLATE'
${template}MAPLE_TEMPLATE
# A first deploy that failed leaves a stack that can only be deleted, not updated.
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
  --no-fail-on-empty-changeset
rm -f "$template"
${deleteMetricsStackFunction(target.metricsStackName)}${metrics === null ? "" : deployMetricsStacks(target.metricsStackName, metrics.stream, metrics.template)}${removeMetricsStacks(target.metricsStackName, metrics?.stream.regions ?? [])}echo "Done. Go back to Maple and select Check connection. Details: ${DOCS_URL}"
`,
	)

export const renderAwsCleanupScript = (target: AwsScriptTarget) =>
	forPaste(
		"AWS",
		"MAPLE_CLEANUP_SCRIPT",
		`set -euo pipefail
${accountGuard(target.accountId)}${deleteMetricsStackFunction(target.metricsStackName)}${removeMetricsStacks(target.metricsStackName, [])}echo "Deleting ${target.stackName} from account ${target.accountId}..."
aws cloudformation delete-stack --region ${AWS_STACK_REGION} --stack-name ${target.stackName}
aws cloudformation wait stack-delete-complete --region ${AWS_STACK_REGION} --stack-name ${target.stackName}
echo "Done. The role Maple used is gone."
`,
	)

const hcl = (value: unknown) => JSON.stringify(value)

/** The same setup as a self-contained Terraform file for the `aws` provider. */
export const renderAwsTerraform = (connectionId: AwsConnectionId, plan: AwsSetupPlan) => {
	const modulePolicies = plan.modules
		.map(
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
		)
		.join("")
	const managed = [...new Set(plan.modules.flatMap((module) => module.managedPolicies))]
		.map(
			(arn, index) => `
resource "aws_iam_role_policy_attachment" "maple_managed_${index}" {
  role       = aws_iam_role.maple.name
  policy_arn = ${hcl(arn)}
}
`,
		)
		.join("")
	return `# Maple integration ${connectionId} (setup v${AWS_TEMPLATE_VERSION}): a read-only role Maple assumes.
# Apply it with credentials for the account in the role ARN below.
# Details: ${DOCS_URL}

resource "aws_iam_role" "maple" {
  name                 = ${hcl(plan.roleName)}
  description          = "Assumed by Maple to read this account"
  max_session_duration = 3600
  assume_role_policy   = jsonencode(${hcl(plan.trustPolicy)})
  tags                 = ${hcl(Object.fromEntries(plan.tags.map((tag) => [tag.Key, tag.Value])))}
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

/** Every rendering of one connection's setup. */
export const renderAwsSetup = Effect.fn("renderAwsSetup")(function* (
	connectionId: AwsConnectionId,
	accountId: AwsAccountId,
	plan: AwsSetupPlan,
	stream: AwsStreamTarget | null,
) {
	const target = { accountId, stackName: plan.stackName, metricsStackName: plan.metricsStackName }
	const template = renderAwsCloudFormation(connectionId, plan)
	const metrics =
		stream === null
			? null
			: { stream, template: renderAwsMetricsCloudFormation(connectionId, plan.metricStreamName, stream) }
	return {
		stackName: plan.stackName,
		stackRegion: AWS_STACK_REGION,
		setupScript: yield* renderAwsSetupScript(target, template, metrics),
		cleanupScript: yield* renderAwsCleanupScript(target),
		cloudformationTemplate: template,
		terraform: renderAwsTerraform(connectionId, plan),
		metricsStackName: metrics === null ? null : plan.metricsStackName,
		metricsCloudformationTemplate: metrics?.template ?? null,
	}
})
