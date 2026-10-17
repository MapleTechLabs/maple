---
title: "Google Cloud manual setup"
description: "Connect Google Cloud to Maple by creating each resource yourself in the Google Cloud console, without running a script."
group: "Integrations"
order: 9
navLabel: "Google Cloud manual setup"
---

Manual setup creates the same resources as the [setup script](/docs/integrations/gcp), by hand in the Google Cloud console. It takes about 15 minutes. Use it when you want to see and approve every resource before it exists.

The connect dialog lists every step for your connection, with the names and values to paste. This page explains the same steps and the console settings that are easy to get wrong.

## Before you start

1. In Maple, open **Integrations → Google Cloud**, click **Connect Google Cloud**, choose the scope and what to collect, and click **Continue**.
2. In **Method**, choose **Manual setup** and click **Continue**. The dialog lists the steps with this connection's names.
3. Sign in to the console with the roles for what you connect:

| You connect     | Roles you need                                                                                                                                      |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| A project       | Owner on the project.                                                                                                                               |
| A folder        | Owner on the host project. On the folder: Logs Configuration Writer for the log sink, and Folder IAM Admin for the read-only roles.                 |
| An organization | Owner on the host project. On the organization: Logs Configuration Writer for the log sink, and Organization Administrator for the read-only roles. |

Names in the steps below, such as `maple-018f2b3c…`, stand for the ones the dialog shows. Maple checks them: a push signed by a differently named account is refused.

## Log forwarding

Do these steps in order. The sink's permissions have to be in place right after the sink is created: entries routed before that are lost.

### 1. Enable the APIs

In **APIs & Services → [Library](https://console.cloud.google.com/apis/library)**, enable each API the dialog lists in the host project: Pub/Sub, Cloud Logging, IAM and Cloud Resource Manager.

### 2. Create the Pub/Sub topic

In **Pub/Sub → Topics**, click **Create topic** and enter the **Topic ID** from the dialog. Untick **Add a default subscription**: it is on by default, and a default subscription keeps a copy of every log that nobody reads. Leave the other options as they are.

### 3. Create the push service account

In **IAM & Admin → Service accounts**, click **Create service account**:

- **Service account name**: `Maple log push identity`
- **Service account ID**: the ID from the dialog, `maple-push-…`. Edit the generated ID: it can't be changed later.
- **Description**: `Signs Pub/Sub push requests to Maple. Holds no roles.`

Click **Done** without granting a role. Then open the account, go to **Permissions → Grant access**, and grant `service-PROJECT_NUMBER@gcp-sa-pubsub.iam.gserviceaccount.com` the role **Service Account Token Creator**. `PROJECT_NUMBER` is on the host project's dashboard, or run `gcloud projects describe HOST_PROJECT --format='value(projectNumber)'`. Projects created after April 2021 don't need this grant, but it does no harm.

### 4. Create the push subscription

In **Pub/Sub → Subscriptions**, click **Create subscription**:

| Field                          | Value                                                                   |
| ------------------------------ | ----------------------------------------------------------------------- |
| **Subscription ID**            | From the dialog                                                         |
| **Pub/Sub topic**              | The topic from step 2                                                   |
| **Delivery type**              | **Push**                                                                |
| **Endpoint URL**               | From the dialog. It carries no secret.                                  |
| **Enable authentication**      | On, with the push service account from step 3                           |
| **Audience**                   | The endpoint URL again                                                  |
| **Enable payload unwrapping**  | On, with **Write metadata** off                                         |
| **Retry policy**               | **Retry after exponential backoff**, minimum 10 and maximum 600 seconds |
| **Acknowledgement deadline**   | 30 seconds                                                              |
| **Message retention duration** | 1 day                                                                   |
| **Expiration period**          | **Never expire**                                                        |

Leave dead lettering, exactly-once delivery, message ordering and the filter off.

- Without **payload unwrapping**, Pub/Sub sends each entry wrapped in an envelope that Maple can't read. Maple drops it, and no logs arrive.
- The expiration period defaults to 31 days. An idle subscription would then be deleted.

### 5. Create the Log Router sink

In **Logging → Log Router**, click **Create sink**. For a folder or organization, first pick it in the console's resource picker.

| Field                              | Project                                  | Folder or organization                                                                                           |
| ---------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **Sink name**                      | From the dialog                          | From the dialog                                                                                                  |
| **Select sink service**            | **Pub/Sub topic**, the topic from step 2 | **Other resource**, with the destination from the dialog: `pubsub.googleapis.com/projects/HOST_PROJECT/topics/…` |
| **Choose logs to include in sink** |                                          | **Include logs ingested by this folder (organization) and all child resources**                                  |
| **Build inclusion filter**         | The filter from the dialog               | The filter from the dialog                                                                                       |

Paste the filter unchanged, as one line. It leaves out Data Access audit logs, load balancer health checks, Kubernetes lease renewals and VM serial console output, and the application output of runtimes you didn't choose under **Log filter**.

For a folder or organization, don't choose **Intercept logs**: that keeps those logs from the projects' own sinks and log buckets.

### 6. Let the sink publish to the topic

In **Log Router**, open the sink's **⋮** menu, click **View sink details** and copy its **Writer identity**. Grant it two roles:

- **Pub/Sub Publisher** on the topic: in **Pub/Sub → Topics**, tick the topic, open **Show info panel → Permissions** and add the writer identity. Don't grant it on the IAM page, which would cover every topic in the project.
- **Logs Writer** on the host project, in **IAM & Admin → IAM**.

The console may have granted these already when it created the sink. Add whichever is missing.

### 7. Send a test message (optional)

In **Pub/Sub → Topics**, open the topic's **Messages** tab, click **Publish message** and paste the message body from the dialog. Maple confirms log forwarding as soon as it arrives, instead of at the first log. A new sink can take about 10 minutes to start forwarding.

## Metrics and resources

### 1. Enable the APIs

Enable Cloud Monitoring, Cloud Asset, IAM, IAM Credentials and Cloud Resource Manager in the host project. Cloud Monitoring needs [billing](https://console.cloud.google.com/billing/linkedaccount) on the host project.

### 2. Create the read-only service account

In **IAM & Admin → Service accounts**, create an account named `Maple metrics and resource reader` with the ID from the dialog. Click **Done**. It gets no key.

### 3. Grant the read-only roles

In **IAM & Admin → IAM**, click **Grant access**, enter the read-only account's email and add the roles:

| Scope           | Roles                                                                                                                 |
| --------------- | --------------------------------------------------------------------------------------------------------------------- |
| A project       | **Monitoring Viewer**, **Cloud Asset Viewer** and **Service Usage Consumer** on the project.                          |
| A folder        | **Monitoring Viewer** and **Cloud Asset Viewer** on the folder. **Service Usage Consumer** on the host project.       |
| An organization | **Monitoring Viewer** and **Cloud Asset Viewer** on the organization. **Service Usage Consumer** on the host project. |

Granted on the host project instead of the folder or organization, Maple reads only the host project.

### 4. Let Maple use the read-only account

Open the read-only account, go to **Permissions → Grant access**, and grant Maple's service account from the dialog **Service Account Token Creator**. If an organization policy restricts members to your domain, Google refuses this grant: see [Domain restricted sharing](/docs/integrations/gcp#domain-restricted-sharing).

## Confirm the connection

Nothing in a manual setup reports to Maple, so the dialog confirms each part another way:

- **Log forwarding** is confirmed by the first push Maple receives: the test message, or the first log.
- **Read-only access** is confirmed by **Check access**. Maple signs in as the read-only account and lists the scope's projects. If that fails, the dialog says what is missing and opens the step to fix.

Check access doesn't test **Monitoring Viewer** or billing. If metrics don't arrive within about 15 minutes, the connection's row says why.

## Removing

When you switch **Log forwarding** or **Metrics and resources** off, the dialog lists what to delete. Delete the log sink first, and wait a minute before you delete the topic: Google keeps routing to it for a moment, and a missing topic gets your project a sink error. Then delete the subscription, the topic and the push service account.

For metrics, remove the read-only account's roles, then delete the account.

Click **Check access** when you are done. Maple confirms that it can no longer sign in as the read-only account. For the log sink, Maple can't tell a deleted sink from a quiet one, so the check records it as removed on your word.

To disconnect for good, delete everything above, then disconnect the connection in Maple.
