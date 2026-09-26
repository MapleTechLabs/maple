# `maple-preview-deploy`: the AWS role PR previews deploy with

`deploy-pr-preview.yml` assumes this role over GitHub OIDC to build the AWS half of a
preview stack (the ingest VPC, load balancer and ECS fleet from `apps/ingest/alchemy.run.ts`).
It exists because the production role, `maple-prod-deploy`, only trusts the subject
`repo:MapleTechLabs/maple:environment:production`, and the decision (2026-09-21) was to give
previews a role of their own rather than widen that one. `deploy-prd.yml` and `aws-probe.yml`
stay on the prod role.

Nothing here is applied automatically. A human runs the commands below with credentials that
can manage IAM in account `465760687006`.

## Files

- `trust-policy.json`: who may assume the role. One subject, the `pr-preview` GitHub
  environment, audience `sts.amazonaws.com`, through the account's
  `token.actions.githubusercontent.com` OIDC provider (it already exists, the prod role uses it).
- `policy-compute.json`: ECS, ECR, CloudWatch Logs, the read-only list, the ECS AMI SSM
  parameter, and the Cloud Map + Route 53 statements a `preview:collector` label needs.
- `policy-network.json`: EC2 (VPC, subnets, route tables, gateways, endpoints, security
  groups, launch templates), Auto Scaling, and Elastic Load Balancing v2.
- `policy-iam-storage.json`: IAM roles, policies, instance profiles, `iam:PassRole`, the S3 WAL
  bucket, and Secrets Manager.

Three documents because IAM caps a managed policy at 6,144 non-whitespace characters and a
role's inline policies at 10,240 in total; the union is about 14,000. Keep each file under the
cap when editing (`jq -c . file | tr -d ' \n\t' | wc -c`).

## How the scoping works

Every statement that can touch a resource is fenced by one of two guards, both derived from
how a preview names and tags what it creates:

1. **Name in the ARN.** `resolveAwsResourceName` (`packages/infra/src/aws/stage.ts`) names a
   preview resource `maple-<base>[-<region>]-pr-<n>`; production names carry no suffix and dev
   stages carry `-dev-<name>`. Resources alchemy names itself get
   `maple-<id>-pr-<n>-<random>` (`createPhysicalName` in `node_modules/alchemy/src/PhysicalName.ts`).
   Wherever the name reaches the ARN (ECS, ECR, Logs, S3, Secrets Manager, IAM, Auto Scaling)
   the resource is `…/maple-*-pr-*`. The production stage is `prd`, so `-prd-` never matches `-pr-`.
2. **The `alchemy::stage` tag.** alchemy stamps `alchemy::stack`, `alchemy::stage` and
   `alchemy::id` on everything it creates, with the stage as `pr-<n>` (`createInternalTags` in
   `node_modules/alchemy/src/Tags.ts`). Where the ARN carries an id instead of a name (VPC pieces,
   load balancers, target groups, listeners, Cloud Map) the statements require
   `aws:RequestTag/alchemy::stage` like `pr-*` on creation and `aws:ResourceTag/alchemy::stage`
   like `pr-*` on every later mutation or delete. The load balancer name is the reason the tag
   guard exists at all: alchemy truncates it to 32 characters, which drops the `pr-` part.

`iam:PassRole` is limited to `role/maple-*-pr-*` passed to ECS or EC2, and `iam:AttachRolePolicy`
to policies named `maple-*-pr-*` plus the three AWS-managed ECS and SSM policies, so a preview
cannot mint a role with broader rights than its own. The unscoped statement is the explicit
Describe, List and Get list plus `ecr:GetAuthorizationToken` and `sts:GetCallerIdentity`;
everything else names a resource or a tag.

Regional ARNs are pinned to `us-east-1`. An `eu` preview would need the same statements for
`eu-central-1`.

## Create the role

Run from this directory.

```bash
aws iam create-role \
  --role-name maple-preview-deploy \
  --description "GitHub Actions deploy role for PR previews (pr-preview environment only)" \
  --assume-role-policy-document file://trust-policy.json
```

```bash
for p in compute network iam-storage; do
  aws iam create-policy \
    --policy-name "maple-preview-deploy-$p" \
    --policy-document "file://policy-$p.json" \
    --query Policy.Arn --output text
  aws iam attach-role-policy \
    --role-name maple-preview-deploy \
    --policy-arn "arn:aws:iam::465760687006:policy/maple-preview-deploy-$p"
done
```

Then point the workflow at it:

```bash
gh variable set AWS_PREVIEW_ROLE_ARN --body arn:aws:iam::465760687006:role/maple-preview-deploy
```

## Update a policy

A managed policy keeps up to five versions. Set the new one as default and prune the oldest
so the next update does not fail on the version cap.

```bash
p=network
arn="arn:aws:iam::465760687006:policy/maple-preview-deploy-$p"
aws iam list-policy-versions --policy-arn "$arn" \
  --query 'Versions[?!IsDefaultVersion].VersionId' --output text \
  | tr '\t' '\n' | tail -n +4 | xargs -r -n1 aws iam delete-policy-version --policy-arn "$arn" --version-id
aws iam create-policy-version --policy-arn "$arn" \
  --policy-document "file://policy-$p.json" --set-as-default
```

The trust policy updates in place:

```bash
aws iam update-assume-role-policy --role-name maple-preview-deploy \
  --policy-document file://trust-policy.json
```

## Residual risk: a preview can widen its own task role

The stack needs `iam:CreatePolicy`, `iam:PutRolePolicy` and `iam:AttachRolePolicy` on
`maple-*-pr-*` (the WAL bucket and task-protection policies, the secrets inline policy). IAM
cannot condition on a policy's contents, so code running in the preview job could write a
broad policy under a preview name, attach it to a preview task role, and run a task with it.
The proper fix is a permissions boundary: require `iam:PermissionsBoundary` on
`iam:CreateRole`, ship the boundary document here, and drop `iam:DeleteRolePermissionsBoundary`.
That is not in place because alchemy's `ECS.Service` creates the task and execution roles
itself (`createTaskRoleIfNotExists` in `node_modules/alchemy/src/AWS/ECS/Service.ts`) with no
boundary input, so the condition would deny every preview deploy. Until alchemy accepts a
boundary or explicit roles, the control is the one the workflow already documents: the
`pr-preview` GitHub environment must require a reviewer before PR-controlled code gets these
credentials. The role also holds no `sts:AssumeRole`, `iam:CreateUser`, `iam:CreateAccessKey`
and no `iam:UpdateAssumeRolePolicy`, `iam:PutRolePermissionsBoundary` or
`iam:DeleteRolePermissionsBoundary` at all (the ingest stack never calls them; a preview role's
trust policy is fixed at `iam:CreateRole`), so the escalation stays inside resources named
`maple-*-pr-*` unless a task is launched with the widened role.

## Expect a few AccessDenied rounds

The action lists were taken from the alchemy modules a preview exercises
(`node_modules/alchemy/src/AWS/{EC2,ECS,ECR,ELBv2,IAM,Logs,S3,SecretsManager,CloudMap,AutoScaling}`)
and from `scripts/ingest-preview-verify.sh`, not from a recorded deploy. Plan on two or three
deploy → AccessDenied → add-action loops, on both the deploy and the teardown path (the first
teardown is the first time the Delete actions run). Each loop:

1. Read the denied call from the job log. The message names the action and the resource; if it
   ends in an encoded authorization message, decode it with
   `aws sts decode-authorization-message --encoded-message <blob>`.
2. Check whether the action is missing, or present but its guard did not match. A tag guard
   fails when alchemy did not send `alchemy::stage` on that call (add the action to the
   statement's untagged sibling, or drop the tag condition for that one action); a name guard
   fails when the resource name does not contain `-pr-` (check the ARN in the message against
   the patterns above before widening anything).
3. Add the action to the statement it belongs with, keep the file under the size cap, and push
   a new policy version as above. Re-run the job.

CloudTrail lists every denied call in one query once the events land (a few minutes):

```bash
aws cloudtrail lookup-events --region us-east-1 \
  --lookup-attributes AttributeKey=Username,AttributeValue=GitHubActions \
  --start-time "$(date -u -v-2H +%FT%TZ)" \
  --query 'Events[?contains(CloudTrailEvent, `AccessDenied`)].[EventTime,EventName]' --output table
```

Known soft spots, in the order they are likely to bite:

- `ecs:RegisterTaskDefinition`, `ecs:CreateCluster` and `ecs:CreateCapacityProvider` are
  allowed on `*` only with the `alchemy::stage` request tag. If alchemy registers a task
  definition without tags on some path, that call is the first to fail.
- Listeners: alchemy tags them at creation, but `aws:ResourceTag` support on listener
  mutations has been uneven; if `ModifyListener` or `DeleteListener` is denied with the tag
  present, move those two into a statement scoped by region only.
- The EC2 fleet statements (launch templates, Auto Scaling, `ec2:RunInstances`,
  `ec2:CreateTags` with `ec2:CreateAction: RunInstances`) are written for the EC2 NVMe ingest
  fleet (#937) ahead of it landing; the current Fargate stack never exercises them.
- Cloud Map and Route 53 only run for a PR carrying `preview:collector`. Cloud Map creates
  the namespace's private hosted zone on the caller's permissions, so the role gets
  `route53:CreateHostedZone` (it accepts no resource ARN). `route53:DeleteHostedZone` is
  deliberately NOT granted: the zone's id does not exist until the preview does, so the only
  grant possible up front is on every zone in the account. A collector preview's teardown
  therefore fails at `DeleteNamespace`. Read the zone id with
  `aws servicediscovery get-namespace --id <ns-id> --query Namespace.Properties.DnsProperties.HostedZoneId`,
  delete the namespace by hand with the prod credentials, and rerun the teardown. Nothing that
  writes records is granted: instance registration goes through the ECS and Cloud Map
  service-linked roles.
- `ec2:RunInstances` on the instance resource requires a Graviton instance type
  (`c7gd.*`, `c7g.*`, `t4g.*`). Auto Scaling validates the caller's launch permission when the
  group is created; the launch itself runs under the Auto Scaling service-linked role. Widen the
  list only alongside a fleet change that needs it. There is no `aws:RequestTag` condition on
  the instance: alchemy's launch template tags only the template, and the group's tags do not
  propagate at launch, so the condition would fail that validation. A direct launch is still
  fenced, because `RunInstances` also evaluates the subnet, security group and launch template,
  and those are allowed only under `alchemy::stage=pr-*`.
- Previews have no ingest domain, so nothing in ACM is granted. A preview that does get a
  domain (`resolveMapleDomains`) will need `acm:RequestCertificate` and friends.
- The orphan sweep (`cleanup-preview-orphans.yml`) never touches AWS, so a preview whose
  teardown run never happened leaks its VPC, load balancer and ECS service until someone runs
  `alchemy destroy --stage pr-<n>` by hand. The sweep does not need this role; its only AWS
  gap is that it does not exist yet.
