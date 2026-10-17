---
title: "Google Cloud manual setup"
description: "Connect Google Cloud to Maple by creating each resource yourself in the Google Cloud console, without running a script."
group: "Integrations"
order: 9
navLabel: "Google Cloud manual setup"
---

Manual setup creates the same resources as the [setup script](/docs/integrations/gcp), by hand in the Google Cloud console. It takes about 15 minutes.

In Maple, open **Integrations → Google Cloud**, click **Connect Google Cloud**, choose the scope and what to collect, then choose **Manual setup** in **Method**. The dialog lists every step with this connection's names and values to copy. This page covers what the dialog can't: the roles you need, what differs per scope, and the settings that are easy to get wrong.

## Roles you need

| You connect     | Roles you need                                                                                                                                      |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| A project       | Owner on the project.                                                                                                                               |
| A folder        | Owner on the host project. On the folder: Logs Configuration Writer for the log sink, and Folder IAM Admin for the read-only roles.                 |
| An organization | Owner on the host project. On the organization: Logs Configuration Writer for the log sink, and Organization Administrator for the read-only roles. |

## Folders and organizations

Everything goes in the host project except two steps, which you do on the folder or organization. Pick it in the console's resource picker first:

- **The Log Router sink.** Choose **Other resource** as the sink service and paste the full destination from the dialog, `pubsub.googleapis.com/projects/HOST_PROJECT/topics/…`: the picker lists only the current project's topics. Choose **Include logs ingested by this folder (organization) and all child resources**, not **Intercept logs**, which keeps those logs from the projects' own sinks and log buckets.
- **Monitoring Viewer and Cloud Asset Viewer** for the read-only account. **Service Usage Consumer** goes on the host project. Granted on the host project only, Maple reads only the host project.

## Pitfalls

- **Names.** Use the names the dialog shows, including the push service account's ID, `maple-push-…`: Maple refuses a push signed by any other account.
- **Add a default subscription** is ticked by default when you create the topic. Untick it: a default subscription keeps a copy of every log that nobody reads.
- **Enable payload unwrapping** must be on, with **Write metadata** off. Without it Pub/Sub wraps each entry in an envelope Maple can't read, and Maple drops it.
- **Expiration period** defaults to 31 days. Set **Never expire**, or an idle subscription is deleted.
- **The push service account's Token Creator grant** to `service-PROJECT_NUMBER@gcp-sa-pubsub.iam.gserviceaccount.com` is only needed where the Pub/Sub service agent was created before April 8, 2021. It does no harm elsewhere. `PROJECT_NUMBER` is on the host project's dashboard.
- **Pub/Sub Publisher** for the sink's writer identity goes on the topic, in its **Permissions** panel. On the IAM page it would cover every topic in the project. The sink needs no other role.
- **The filter** must be pasted unchanged. It leaves out Data Access audit logs, load balancer health checks, Kubernetes lease renewals, VM serial console output, and the application output of runtimes you didn't choose under **Log filter**.
- **The first minutes.** A new sink takes a few minutes to start forwarding, and entries written in that time are dropped, not delayed.
- **Maple's Token Creator grant** on the read-only account comes before its roles. If an organization policy restricts members to your domain, Google refuses it, and nothing is left behind: see [Domain restricted sharing](/docs/integrations/gcp#domain-restricted-sharing).
- **Billing.** Cloud Monitoring only answers for a host project with billing linked.

## Confirm the connection

A manual setup sends Maple no report. Maple confirms each part by its first data:

- **Log forwarding** by the first push Maple receives. The optional test message in the dialog confirms it in seconds, but it proves only the topic, subscription and push: the sink is proven by the first real log, usually within a few minutes.
- **Read-only access** by the first metrics read, within 5 minutes. If it fails, the connection says what is missing.

## Removing

When you switch **Log forwarding** or **Metrics and resources** off, the dialog lists what to delete, in this order:

1. The log sink. Then wait two minutes: Google keeps routing to the topic for over a minute, and a missing topic gets your project a sink error.
2. The subscription, the topic, and the push service account if there is one: a setup by script has none.
3. The read-only account's roles, then the account.

Leave **Logs Writer** for the sink's writer identity on the host project: every sink there writes as that identity. Then click **I've removed them** in the dialog: Maple can't see a removal and takes your word for it.

To disconnect for good, delete everything above, then disconnect the connection in Maple.
