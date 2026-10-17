---
title: "Google Cloud with Terraform or Alchemy"
description: "Connect Google Cloud to Maple from your own infrastructure code: a generated Terraform or Alchemy file with every resource inline and no secret."
group: "Integrations"
order: 10
navLabel: "Google Cloud with Terraform"
---

Maple generates the Google Cloud connection as a file for your own repository: `maple.tf` for Terraform's `google` provider, or `maple.ts` for [Alchemy](https://alchemy.run)'s `alchemy/GCP` resources. It creates the same resources as the [setup script](/docs/integrations/gcp) under the same names, so you can review every one before it exists.

The file holds no secret, so you can commit it. Pub/Sub signs each push as a push service account that holds no role, and Maple accepts a push only when it is signed as that account. IAM grants are additive (`*_iam_member`): your other grants are left alone.

## Get the file

1. In Maple, open **Integrations → Google Cloud**, click **Connect Google Cloud**, choose the scope and what to collect, and click **Continue**.
2. In **Method**, choose **Infrastructure as code**, then **Terraform** or **Alchemy**, and click **Continue**.
3. Click **Copy**, or **Copy prompt for coding agent** (see [below](#with-a-coding-agent)).

Alchemy can't grant roles on a folder or organization. A folder or organization connection with **Metrics and resources** uses Terraform.

## Terraform

Put `maple.tf` in a directory or module of its own. The resource names are fixed per connection, so a second connection goes into another module. If your configuration already declares the `google` and `time` providers, delete the file's `terraform` block.

Run `terraform plan`, review it, then `terraform apply` with an account that has Owner on the host project. For a folder or organization it also needs Logs Configuration Writer on the scope, and Folder IAM Admin or Organization Administrator for the read-only roles.

`terraform destroy` removes what the file created. The APIs it switched on stay on.

## Alchemy

`maple.ts` is a self-contained stack. Its header names the `alchemy` version it was written for:

1. Install `alchemy` at that version and `effect` 4.
2. With log forwarding, fill in `PROJECT_NUMBER` at the top: `gcloud projects describe HOST_PROJECT --format='value(projectNumber)'`.
3. Switch the APIs on first with the `gcloud services enable` command in the header. Alchemy doesn't wait for an API to be switched on.
4. Deploy as an account allowed to create the resources. Alchemy creates the topic, the subscription and a project's sink in the project it signs in to, which must be the host project:

```bash
GOOGLE_ACCESS_TOKEN="$(gcloud auth print-access-token)" GOOGLE_PROJECT_ID=HOST_PROJECT \
  bunx alchemy deploy maple.ts --stage maple
```

`bunx alchemy destroy maple.ts --stage maple` removes it again. It needs the state Alchemy keeps in `.alchemy/`.

## With a coding agent

**Copy prompt for coding agent** copies the file with instructions for an agent working in your repository: where to put the file, to show you the plan and apply only after you approve it, the `gcloud` commands that check the result, and to hand back to Maple's dialog at the end. Paste it into the agent from the repository that holds your infrastructure code.

## Confirm the connection

Nothing in Terraform or Alchemy reports to Maple:

- **Log forwarding** is confirmed by the first push Maple receives. A new sink can take about 10 minutes to start forwarding.
- **Read-only access** is confirmed by **Check access** in the dialog. Maple signs in as the read-only account and lists the scope's projects, and says what is missing if it can't.

## Change or remove

To change what a connection collects, change it in Maple, copy the regenerated file over the old one and apply it. A capability you switched off is no longer in the file, so the apply removes it. Then click **Check access** in the dialog: it confirms that the read-only account is gone, and records the log sink as removed.

To disconnect, run `terraform destroy` (or remove the file and apply), then disconnect in Maple.
