---
title: "AWS"
description: "Connect an AWS account with a read-only IAM role, deployed as a CloudFormation stack from AWS CloudShell, in the console, or with Terraform. Maple assumes the role with an external ID only your organization holds, and stores no AWS secret."
group: "Integrations"
order: 11
---

The AWS integration connects one AWS account to Maple through an IAM role in that account. Maple assumes the role from its own AWS identity, and the role trusts that identity only with an **external ID** Maple minted for your connection, so another Maple organization can't assume it. Maple stores no access key, secret or session for your account.

Maple checks each connection every hour, and whenever you select **Check connection**. The check assumes the role and reads the role's own tags and attached policies. Nothing else is read yet. Metrics, a resource inventory, a security scan and cost each come as a **module**: a policy of its own on the same role, added by deploying the stack again.

## Before you start

You need to be an admin of the Maple organization, and in AWS, permission to create IAM roles and policies and CloudFormation stacks in the account you connect. The AWS managed `AdministratorAccess` policy covers it, and so do `IAMFullAccess` together with `AWSCloudFormationFullAccess`.

Find the 12-digit account ID in the account menu at the top right of the AWS console. Maple accepts it with or without the dashes the console shows.

## Connect

1. In Maple, open **Sources → New source** and choose **AWS**.
2. Enter the account ID and click **Connect AWS**. Maple creates the connection and shows its setup.
3. Open [AWS CloudShell](https://console.aws.amazon.com/cloudshell/home) signed in to that account, copy the script, paste it and press Enter.
4. The script checks that CloudShell is signed in to the right account, then deploys a stack named `maple-integration-<id>`. It takes about a minute.
5. Maple checks the connection every 10 seconds while the setup is open, and shows **Connected** once it can assume the role.

Running the script again is always safe: it updates the stack in place, and replaces a stack whose first deploy failed. The stack always lives in `us-east-1`, whatever region CloudShell opens in. IAM roles are global, so this changes nothing about what Maple can read.

### In the console

Choose **Console** in the setup and save the template. Then in CloudFormation, in the `us-east-1` region, choose **Create stack → With new resources**, upload the template, give the stack the name Maple shows, and acknowledge that it creates IAM resources. The cleanup script looks for the stack in `us-east-1`.

### With Terraform

Choose **Terraform** in the setup and copy the file into your repository. It needs only the `aws` provider, configured for the account you connect. Apply it, then select **Check connection**.

## What the stack creates

| Resource                                 | Purpose                                                                                               |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| IAM role `MapleIntegration-<id>`         | Assumed by Maple. Its trust policy names Maple's identity and requires your external ID.              |
| Inline policy `maple-self-read`          | Lets the role read its own tags and attached policies, and nothing else. This is how Maple checks it. |
| Managed policy `MapleIntegration-<id>-…` | One per module you turn on. None until modules are available.                                         |

The role is tagged with the setup version. When a later version of the setup changes the role, the connection shows **Update the stack**. Deploy it again from the setup to apply the change.

## Troubleshooting

| What you see                              | What to do                                                                                                      |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **Maple cannot assume the role yet**      | The stack isn't deployed, or it was deployed to another account. Run the script in the account the setup names. |
| **Maple can no longer assume the role**   | The stack was deleted or its trust policy was edited. Run the script again.                                     |
| **The role cannot read its own policies** | The `maple-self-read` policy was removed or changed. Run the script again to repair it.                         |
| **AWS rejected Maple's own credentials**  | A problem on Maple's side. Nothing in your account needs to change.                                             |

## Disconnect

Select **Disconnect** on the connection. Maple stops assuming the role and removes the source; data already collected stays. Maple has no write access to your account, so the role exists until you delete its stack. Maple shows a cleanup script for CloudShell that deletes it, or delete the stack in the CloudFormation console.
