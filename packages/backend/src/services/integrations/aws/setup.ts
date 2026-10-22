import { AWS_TEMPLATE_VERSION, type AwsSetupPlan } from "@maple/domain/aws"
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

export interface AwsScriptTarget {
	readonly accountId: AwsAccountId
	readonly stackName: string
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
 * The script an administrator pastes into AWS CloudShell. It deploys the stack, which converges: a
 * re-run after a module change updates the role and its policies in place.
 */
export const renderAwsSetupScript = (target: AwsScriptTarget, template: string) =>
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
echo "Done. Go back to Maple and select Check connection. Details: ${DOCS_URL}"
`,
	)

export const renderAwsCleanupScript = (target: AwsScriptTarget) =>
	forPaste(
		"AWS",
		"MAPLE_CLEANUP_SCRIPT",
		`set -euo pipefail
${accountGuard(target.accountId)}echo "Deleting ${target.stackName} from account ${target.accountId}..."
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
) {
	const target = { accountId, stackName: plan.stackName }
	const template = renderAwsCloudFormation(connectionId, plan)
	return {
		stackName: plan.stackName,
		stackRegion: AWS_STACK_REGION,
		setupScript: yield* renderAwsSetupScript(target, template),
		cleanupScript: yield* renderAwsCleanupScript(target),
		cloudformationTemplate: template,
		terraform: renderAwsTerraform(connectionId, plan),
	}
})
