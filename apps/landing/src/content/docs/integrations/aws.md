---
title: "AWS"
description: "Connect an AWS account with a read-only IAM role, deployed as a CloudFormation stack from AWS CloudShell, in the console, or with Terraform. Maple assumes the role with short-lived OIDC tokens it signs for your connection, and stores no AWS secret."
group: "Integrations"
order: 11
---

The AWS integration connects one AWS account to Maple through an IAM role in that account. The setup registers Maple as an **OIDC identity provider** in the account (`https://api.maple.dev/oidc/aws`, or `https://api.eu.maple.dev/oidc/aws` on the EU instance), the same mechanism GitHub Actions uses to reach AWS. To assume the role, Maple signs a token valid for five minutes and exchanges it with AWS STS for a 15-minute session. The role trusts only tokens whose subject is your connection (`aws-connection:<id>`), so no other Maple organization or connection can assume it. Maple stores no access key, secret or session for your account, and holds no long-lived AWS credential of its own.

Maple checks each connection every hour, and whenever you select **Check connection**. The check assumes the role and reads the role's own tags and attached policies. CloudWatch metrics can be streamed to Maple as well (see below). A resource inventory, a security scan and cost each come as a **module**: a policy of its own on the same role, added by deploying the stack again.

## Before you start

You need to be an admin of the Maple organization, and in AWS, permission to create IAM roles and policies and CloudFormation stacks in the account you connect. The AWS managed `AdministratorAccess` policy covers it, and so do `IAMFullAccess` together with `AWSCloudFormationFullAccess`.

Find the 12-digit account ID in the account menu at the top right of the AWS console. Maple accepts it with or without the dashes the console shows.

## Connect

1. In Maple, open **Sources → New source** and choose **AWS**.
2. Enter the account ID and click **Connect AWS**. Maple creates the connection and shows its setup.
3. Open [AWS CloudShell](https://console.aws.amazon.com/cloudshell/home) signed in to that account, copy the script, paste it and press Enter.
4. The script checks that CloudShell is signed in to the right account, registers Maple's identity provider if the account doesn't have it yet, then deploys a stack named `maple-integration-<id>`. It takes about a minute.
5. Maple checks the connection every 10 seconds while the setup is open, and shows **Connected** once it can assume the role.

Running the script again is always safe: it updates the stack in place, and replaces a stack whose first deploy failed. The stack always lives in `us-east-1`, whatever region CloudShell opens in. IAM roles are global, so this changes nothing about what Maple can read.

### In the console

Choose **Console** in the setup and save the template. Then in CloudFormation, in the `us-east-1` region, choose **Create stack → With new resources**, upload the template, give the stack the name Maple shows, and acknowledge that it creates IAM resources. If the account already has Maple's identity provider (another Maple connection registered it), set the `CreateOidcProvider` parameter to `false`. The cleanup script looks for the stack in `us-east-1`.

### With Terraform

Choose **Terraform** in the setup and copy the file into your repository. It needs only the `aws` provider, configured for the account you connect. It declares Maple's identity provider too: if the account already has it, import it first with the `terraform import` command at the top of the file. Apply it, then select **Check connection**.

## What the stack creates

| Resource                                 | Purpose                                                                                                             |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| IAM OIDC provider for Maple's issuer     | Lets AWS verify Maple's tokens. One per account, shared by every Maple connection; the stack keeps it when deleted. |
| IAM role `MapleIntegration-<id>`         | Assumed by Maple. Its trust policy accepts only tokens for your connection's subject.                               |
| Inline policy `maple-self-read`          | Lets the role read its own tags and attached policies, and nothing else. This is how Maple checks it.               |
| Managed policy `MapleIntegration-<id>-…` | One per module you turn on. None until modules are available.                                                       |

The role is tagged with the setup version. When a later version of the setup changes the role, the connection shows **Update the stack**. Deploy it again from the setup to apply the change.

## CloudWatch metrics

A connection can stream CloudWatch metrics to Maple. Choose the regions and the services (CloudWatch namespaces) to send, then run the setup script again. In each region it deploys a stack named `maple-metrics-<id>` with:

| Resource                 | Purpose                                                                                                  |
| ------------------------ | -------------------------------------------------------------------------------------------------------- |
| CloudWatch metric stream | Sends the chosen namespaces every minute, in the OpenTelemetry 1.0 format.                               |
| Firehose delivery stream | Posts the metrics to Maple. It sends a secret only this connection holds, so Maple knows whose they are. |
| Two IAM roles            | Let the metric stream write to the Firehose, and the Firehose to its bucket.                             |
| S3 bucket                | Keeps batches Maple could not accept, and deletes them after 7 days.                                     |

Maple reads nothing back from your account for this: AWS pushes the metrics. The first ones arrive a few minutes after the stack finishes.

AWS bills the metric stream at $0.003 per 1,000 metric updates, and a metric updates once a minute, so 100 metrics cost about $13 a month. Firehose adds a few cents per gigabyte. Stream only the namespaces you need.

To stop streaming, turn the metric stream off in Maple and run the setup script again: it removes the stack from every region. The cleanup script removes it too.

## Troubleshooting

| What you see                                    | What to do                                                                                                      |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **Maple cannot assume the role yet**            | The stack isn't deployed, or it was deployed to another account. Run the script in the account the setup names. |
| **Maple can no longer assume the role**         | The stack was deleted or its trust policy was edited. Run the script again.                                     |
| **The role cannot read its own policies**       | The `maple-self-read` policy was removed or changed. Run the script again to repair it.                         |
| **AWS could not verify Maple's identity token** | A problem on Maple's side. Nothing in your account needs to change.                                             |

## Disconnect

Select **Disconnect** on the connection. Maple stops assuming the role and removes the source; data already collected stays. Maple has no write access to your account, so the role exists until you delete its stack. Maple shows a cleanup script for CloudShell that deletes it, and removes Maple's identity provider once no Maple role is left in the account. Or delete the stack in the CloudFormation console, and the identity provider under IAM → Identity providers.
