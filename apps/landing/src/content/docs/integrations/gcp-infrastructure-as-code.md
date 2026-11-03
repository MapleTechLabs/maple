---
title: "Google Cloud with Terraform or Alchemy"
description: "Connect Google Cloud to Maple from your own infrastructure code: a generated Terraform or Alchemy file with every resource inline."
group: "Integrations"
order: 10
navLabel: "Google Cloud with Terraform"
---

Maple generates the Google Cloud connection as a file for your own repository: `maple.tf` for Terraform's `google` provider, or `maple.ts` for [Alchemy](https://alchemy.run)'s `alchemy/GCP` resources. It creates the same resources as the [setup script](/docs/integrations/gcp) under the same names, so you can review every one before it exists.

The file carries no secret, so you can commit it: Pub/Sub signs each push as a push service account that holds no role, and Maple checks the signature. IAM grants are additive (`*_iam_member`): your other grants are left alone.

## Get the file

1. In Maple, open **Sources**, click **Connect source** and pick **Google Cloud**. Enter the scope, choose what to collect and click **Create connection**.
2. Under **How do you want to apply the setup?**, choose **Terraform** or **Alchemy**.
3. Click **Copy**, or **Copy prompt for coding agent** (see [below](#with-a-coding-agent)).

Without a script there is no sink filter to keep: the file sets the recommended filter, or the one chosen under **Log filter**.

## Terraform

Put `maple.tf` in a root module of its own: its resource names are fixed per connection, and `import` blocks only work in a root module. If your configuration already declares the `google` and `time` providers, delete the file's `terraform` block. It needs Terraform 1.5 or later.

Run `terraform plan`, review it, then `terraform apply` with an account that has Owner on the host project. For a folder or organization it also needs Logs Configuration Writer on the scope, and Folder IAM Admin or Organization Administrator for the read-only roles.

If an earlier setup created the connection, the file has `import` blocks: Terraform takes over the topic, subscription, sink and read-only account instead of failing on duplicates. A commented `import` for the push service account (a setup in the console has one) and for a read-only account an earlier setup left in place are there to uncomment.

## Alchemy

`maple.ts` is a self-contained stack, named after the connection. Its header has the commands:

1. Install what its `bun add` line names: `alchemy` at the version the file was written for, `effect` 4 and `@effect/platform-bun` 4.
2. With log forwarding, fill in `PROJECT_NUMBER` at the top: `gcloud projects describe HOST_PROJECT --format='value(projectNumber)'`.
3. Switch the APIs on first with the `gcloud services enable` command. Alchemy doesn't wait for an API to be switched on.
4. Deploy with the header's command. Alchemy creates the topic, the subscription and a project's sink in the project it signs in to, which must be the host project. After a setup by script the command has `--adopt`, which takes over what the script created.

Alchemy's IAM resource grants roles on projects only. For a folder or organization with **Metrics and resources**, `maple.ts` defines its own small resource, `ScopeIamMember`, that grants the two read roles on the folder's or organization's IAM policy and removes them again on destroy. The account that deploys needs to be allowed to set that policy, as Folder IAM Admin or Organization Administrator, like Terraform.

`bunx alchemy destroy maple.ts --stage maple` removes it again, with the state Alchemy keeps in `.alchemy/`. It deletes the topic right after the sink; to avoid a sink error, delete the sink in the console two minutes earlier.

## With a coding agent

**Copy prompt for coding agent** copies the file with instructions for an agent working in your repository: where to put the file, to show you the plan and apply only after you approve it, the `gcloud` commands that check the result, and how Maple confirms it. Paste it into the agent from the repository that holds your infrastructure code.

## Verify

Nothing in Terraform or Alchemy reports to Maple. Maple confirms each part by its first data:

- **Log forwarding** by the first push Maple receives. A new sink takes a few minutes to start forwarding, and entries written in that time are dropped, not delayed.
- **Read-only access** by the first metrics read, within 5 minutes.

## Change or remove

To change what a connection collects, change it in Maple, copy the regenerated file over the old one and apply it. A capability you switched off is no longer in the file, so the apply removes what the file created. What the file didn't create (a setup by script or in the console) stays: delete it in the console, as the dialog lists. Then click **I've removed them** in the dialog: Maple can't see a removal and takes your word for it.

Without the script there is no sink filter to keep: if you customised `log_filter`, keep yours when you copy a regenerated file.

The file doesn't manage the **Logs Writer** role of the sink's writer identity on the host project: every sink there writes as that identity, so a destroy must not revoke it.

To disconnect, run `terraform destroy` (or the Alchemy destroy above), then disconnect in Maple.
