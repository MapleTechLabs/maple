---
title: "Connect AWS and stream CloudWatch metrics"
description: "Connect an AWS account with a read-only role and no stored secret, stream CloudWatch metrics, and see every resource under Infrastructure → AWS."
date: 2026-10-23
category: integrations
authors: [makisuo]
---

You can now connect an **AWS account** to Maple. The setup creates a read-only IAM role in your
account, deployed as a CloudFormation stack from CloudShell, in the console, or with Terraform.
Maple assumes it with short-lived tokens it signs for your connection, so there is no access key
to create, store or rotate.

A connection can also **stream CloudWatch metrics** to Maple. Pick the regions and the services
(ECS, Container Insights, ALB, NLB, RDS, Lambda, SQS, EC2, DynamoDB, API Gateway) and AWS pushes
the metrics as they are published. Maple reads nothing back from the account.

Once metrics arrive, **Infrastructure → AWS** lists each resource by kind: ECS services, EC2
instances, load balancers, RDS, Lambda and SQS. A health band calls out what is hot, erroring,
throttled, backed up, or idle and still billed, and filters the table to it. Each resource has a
page with its metrics, a link to the AWS console and, for ECS services and Lambda functions, the
traced service it runs as with its calls, errors and p95.

Get started with the [AWS guide](/docs/integrations/aws).
