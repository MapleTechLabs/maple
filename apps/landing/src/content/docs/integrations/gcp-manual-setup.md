---
title: "Google Cloud manual setup"
description: "Connect Google Cloud to Maple by creating each resource yourself in the Google Cloud console, without running a script."
group: "Integrations"
order: 9
navLabel: "Google Cloud manual setup"
---

Manual setup creates the same resources as the [setup script](/docs/integrations/gcp), by hand in the Google Cloud console. It takes about 20 minutes.

In Maple, open **Sources**, click **Connect source** and pick **Google Cloud**. Enter the scope, choose what to collect and click **Create connection**, then choose **Console steps** under **How do you want to apply the setup?**. Maple lists the steps below with this connection's names and values: copy them from there. Each step has an **Open in console** link to the right page.

## Prerequisites

| You connect     | Roles you need                                                                                                                                      |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| A project       | Owner on the project.                                                                                                                               |
| A folder        | Owner on the host project. On the folder: Logs Configuration Writer for the log sink, and Folder IAM Admin for the read-only roles.                 |
| An organization | Owner on the host project. On the organization: Logs Configuration Writer for the log sink, and Organization Administrator for the read-only roles. |

## Step by step

The screenshots show a project connection. Steps 2 to 7 are for **Log forwarding**, the rest for **Metrics and resources**: the dialog leaves out what you didn't choose. A folder or organization has one more step, Service Usage Consumer on the host project.

### 1. Enable the APIs

In **APIs & Services → Library**, search for each API the dialog lists, open it and click **Enable**. An API that shows **Manage** and **API Enabled** is on already. `pubsub.googleapis.com` is the **Cloud Pub/Sub API**, not Pub/Sub Lite.

<figure class="shot">
  <img src="/screenshots/docs/gcp-manual-01-api-enabled.webp" alt="The Cloud Asset API page in the API Library, with a Manage button and a green API Enabled label." loading="lazy" />
  <figcaption>An API that is already on: <strong>Manage</strong> and <strong>API Enabled</strong>.</figcaption>
</figure>

### 2. Create the Pub/Sub topic

In **Pub/Sub → Topics**, click **Create topic**. Paste the **Topic ID**, untick **Add a default subscription**, and click **Create**. The new topic warns that messages will be lost: the subscription in step 4 takes care of that.

<figure class="shot">
  <img src="/screenshots/docs/gcp-manual-02-topic.webp" alt="The Create topic form with the Topic ID filled in and Add a default subscription unticked." loading="lazy" />
  <figcaption>Untick <strong>Add a default subscription</strong>: it would keep a copy of every log that nobody reads.</figcaption>
</figure>

### 3. Create the push account

Pub/Sub signs each push to Maple as this account.

1. In **IAM & Admin → Service accounts**, click **Create service account**.
2. Paste the **Service account name**, then the **Service account ID**: the console fills the ID from the name, so replace it. Paste the description and click **Create and close**, without roles.
3. Open the new account, go to its **Principals with access** tab, not **Permissions**, and click **Grant access**.
4. In **New principals**, type `gcp-sa-pubsub` and pick **Cloud Pub/Sub Service Account for Project …**. The role picker starts on **Service Account Admin**: replace it with **Service Account Token Creator**, and click **Save**.

Step 4 is only needed where the Pub/Sub service agent was created before April 8, 2021, and harmless elsewhere. The grant is listed only with **Include Google-provided role grants** ticked.

<figure class="shot">
  <img src="/screenshots/docs/gcp-manual-03-push-account.webp" alt="The Create service account form with the name Maple log push identity, the ID maple-push-… and the description filled in, and the Create and close button." loading="lazy" />
  <figcaption>Replace the ID the console suggests with the one from the dialog, then <strong>Create and close</strong>.</figcaption>
</figure>

<figure class="shot">
  <img src="/screenshots/docs/gcp-manual-03-principals-tab.webp" alt="The service account's tabs Details, Permissions, Keys, Metrics, Logs and Principals with access, with a note pointing to Principals with access." loading="lazy" />
  <figcaption>Grants on the account itself live under <strong>Principals with access</strong>.</figcaption>
</figure>

<figure class="shot">
  <img src="/screenshots/docs/gcp-manual-03-token-creator.webp" alt="The Grant access panel with the Pub/Sub service agent as new principal and the role Service Account Token Creator." loading="lazy" />
  <figcaption>The Pub/Sub service agent gets <strong>Service Account Token Creator</strong>.</figcaption>
</figure>

### 4. Create the push subscription

In **Pub/Sub → Subscriptions**, click **Create subscription** and set:

- **Subscription ID**, and the topic from step 2 under **Select a Cloud Pub/Sub topic**.
- **Delivery type: Push**, with the **Endpoint URL** from the dialog.
- Tick **Enable authentication**, pick the push service account from step 3, and paste the endpoint again as **Audience**. The console marks Audience optional; Maple needs it.
- Tick **Enable payload unwrapping** and leave **Write metadata** unticked. Without unwrapping Maple can't read what Pub/Sub sends and drops it.
- Under **Failure handling → Retry policy**: **Retry after exponential backoff delay**, 10 to 600 seconds (the defaults).
- **Acknowledgement deadline**: 30 seconds.
- **Message retention duration**: 1 day, 0 hours, 0 minutes.
- **Expiry period**: **Never expire**. The default, 31 days, deletes an idle subscription.

Click **Create**.

<figure class="shot">
  <img src="/screenshots/docs/gcp-manual-04-subscription-push.webp" alt="The Create subscription form: subscription ID, topic, Delivery type Push, Endpoint URL, Enable authentication ticked with the push service account, Audience, and Enable payload unwrapping ticked with Write metadata unticked." loading="lazy" />
  <figcaption>Push delivery, signed by the push account, with payload unwrapping on.</figcaption>
</figure>

<figure class="shot">
  <img src="/screenshots/docs/gcp-manual-04-subscription-retry.webp" alt="Failure handling with Retry after exponential backoff delay selected, 10 and 600 seconds, and an acknowledgement deadline of 30 seconds." loading="lazy" />
  <figcaption>Retry policy and acknowledgement deadline.</figcaption>
</figure>

<figure class="shot">
  <img src="/screenshots/docs/gcp-manual-04-subscription-lifetime.webp" alt="Message retention duration 1 day, 0 hours, 0 minutes, and Expiry period set to Never expire, above the Create button." loading="lazy" />
  <figcaption>One day of retention and <strong>Never expire</strong>.</figcaption>
</figure>

### 5. Create the Log Router sink

In **Logging → Log router**, click **Create sink**:

1. **Sink details**: paste the **Sink name**, click **Next**.
2. **Sink destination**: **Select sink service** → **Cloud Pub/Sub topic**, pick the topic from step 2, click **Next**.
3. **Choose logs to include in sink**: paste the filter from the dialog into **Build inclusion filter**, unchanged, and click **Next**.
4. Skip **Choose logs to filter out of sink** and click **Create sink**.

A new sink takes a few minutes to start forwarding. Entries written in that time are dropped, not delayed.

<figure class="shot">
  <img src="/screenshots/docs/gcp-manual-05-sink-filter.webp" alt="The Create logs routing sink page with sink details and destination done, and the filter pasted into Build inclusion filter." loading="lazy" />
  <figcaption>Paste the filter as the dialog shows it.</figcaption>
</figure>

<figure class="shot">
  <img src="/screenshots/docs/gcp-manual-05-sink-review.webp" alt="The sink's four sections filled in: destination Cloud Pub/Sub topic, the inclusion filter, no exclusions, and the Create sink button." loading="lazy" />
  <figcaption>Ready to create: Cloud Pub/Sub topic, the filter, no exclusions.</figcaption>
</figure>

### 6. Let the sink publish

1. In **Log router**, open the sink's **⋮** menu → **View sink details** and copy its **Writer identity**.
2. In **Pub/Sub → Topics**, tick the topic. In the info panel on the right (**Show info panel** if it is hidden), open **Permissions** → **Add principal**.
3. Paste the writer identity **without its leading `serviceAccount:`**: with it, the console refuses the principal. Pick the role **Pub/Sub Publisher** and click **Save**.

Grant it on the topic, not on the IAM page, where it would cover every topic in the project.

<figure class="shot">
  <img src="/screenshots/docs/gcp-manual-06-writer-identity.webp" alt="The Sink details modal showing the destination and the writer identity serviceAccount:service-…@gcp-sa-logging.iam.gserviceaccount.com with a copy button." loading="lazy" />
  <figcaption>The writer identity, in <strong>View sink details</strong>.</figcaption>
</figure>

<figure class="shot">
  <img src="/screenshots/docs/gcp-manual-06-topic-permissions.webp" alt="The Topics list with the Maple topic ticked and the info panel open on Permissions, with an Add principal button." loading="lazy" />
  <figcaption>The topic's own <strong>Permissions</strong>, in the info panel.</figcaption>
</figure>

<figure class="shot">
  <img src="/screenshots/docs/gcp-manual-06-publisher-grant.webp" alt="The Grant access panel for the topic with the logging service agent as new principal and the role Pub/Sub Publisher." loading="lazy" />
  <figcaption>The identity without <code>serviceAccount:</code>, with <strong>Pub/Sub Publisher</strong>.</figcaption>
</figure>

### 7. Send a test message

This step is optional. On the topic's **Messages** tab, click **Publish message**, paste the dialog's message body as **Message**, and click **Publish**. Maple confirms log forwarding within seconds. The message proves the topic, subscription and push; the sink is proven by the first real log.

<figure class="shot">
  <img src="/screenshots/docs/gcp-manual-07-test-message.webp" alt="The Publish message panel with the test message body pasted into Message and the Publish button." loading="lazy" />
  <figcaption>The test message from the dialog.</figcaption>
</figure>

### 8. Create the read-only account

Maple reads metrics and resources as this account, with short-lived tokens and no key. In **IAM & Admin → Service accounts**, click **Create service account**, paste the name, replace the ID the console fills in, and click **Create and close**.

<figure class="shot">
  <img src="/screenshots/docs/gcp-manual-08-reader-account.webp" alt="The Create service account form with the name Maple metrics and resource reader and the ID maple-… filled in." loading="lazy" />
  <figcaption>The read-only account, created without roles.</figcaption>
</figure>

### 9. Let Maple use the account

Open the read-only account → **Principals with access** → **Grant access**. Paste Maple's service account from the dialog as **New principals**, replace the preselected **Service Account Admin** with **Service Account Token Creator**, and click **Save**.

If an organization policy restricts members to your domain, Google refuses this grant and nothing is left behind: see [Domain restricted sharing](/docs/integrations/gcp#domain-restricted-sharing).

<figure class="shot">
  <img src="/screenshots/docs/gcp-manual-09-maple-token-creator.webp" alt="The Grant access panel on the read-only account with Maple's service account as new principal and the role Service Account Token Creator." loading="lazy" />
  <figcaption>Maple's account gets <strong>Service Account Token Creator</strong> on the read-only account.</figcaption>
</figure>

### 10. Grant read-only roles

In **IAM & Admin → IAM**, click **Grant access**, paste the read-only account as **New principals**, and add **Monitoring Viewer**, **Cloud Asset Viewer** and **Service Usage Consumer**, each after the first with **Add another role**. Click **Save**. Cloud Monitoring only answers for a host project with billing linked.

<figure class="shot">
  <img src="/screenshots/docs/gcp-manual-10-reader-roles.webp" alt="The Grant access panel on the project with the read-only account and three roles: Monitoring Viewer, Cloud Asset Viewer and Service Usage Consumer." loading="lazy" />
  <figcaption>The three read-only roles.</figcaption>
</figure>

## Folders and organizations

Everything goes in the host project except these, which you do on the folder or organization (the dialog's links open them there):

- **The Log Router sink.** Choose **Other resource** as the sink service and paste the full destination from the dialog, `pubsub.googleapis.com/projects/HOST_PROJECT/topics/…`: the picker lists only the current project's topics. Choose **Include logs ingested by this folder (organization) and all child resources**, not **Intercept logs**, which keeps those logs from the projects' own sinks and log buckets. The writer identity in step 6 is the folder's or organization's own.
- **Monitoring Viewer and Cloud Asset Viewer** on the folder or organization. **Service Usage Consumer** goes on the host project, as its own step in the dialog.

## Verify

A manual setup sends Maple no report. Maple confirms each part by its first data:

- **Log forwarding** by the first push Maple receives: within seconds with the test message, or within a few minutes of the sink.
- **Metrics and resources** by the first metrics read, a few minutes after step 10. Until then the connection may say Maple can't sign in as the read-only account yet.

## Removing

When you switch **Log forwarding** off, the dialog lists what to delete, in this order, each with an **Open in console** link:

1. The log sink: **⋮ → Delete sink**. Then wait two minutes: Google keeps routing to the topic for over a minute, and a missing topic gets your project a sink error.
2. The subscription.
3. The topic. The console asks you to type `delete`.
4. The push service account.

Then click **I've removed them** in the dialog: Maple can't see a removal and takes your word for it.

<figure class="shot">
  <img src="/screenshots/docs/gcp-manual-11-delete-sink.webp" alt="The Confirm sink deletion modal naming the Maple sink." loading="lazy" />
  <figcaption>The sink goes first.</figcaption>
</figure>

<figure class="shot">
  <img src="/screenshots/docs/gcp-manual-12-delete-topic.webp" alt="The Delete topic modal, with delete typed into the confirmation box." loading="lazy" />
  <figcaption>Deleting the topic asks you to type <code>delete</code>.</figcaption>
</figure>

A connection collects at least one of the two. To stop collecting altogether, open the connection's menu → **Disconnect**: under **Delete them in the console instead** it lists everything still set up. For the read-only account, remove its roles in **IAM & Admin → IAM** (tick it → **Remove access**), then delete the account.

<figure class="shot">
  <img src="/screenshots/docs/gcp-manual-13-remove-access.webp" alt="The confirmation to remove the read-only service account's access, listing that it loses all non-inherited roles on the resource." loading="lazy" />
  <figcaption>Removing the read-only account's roles before deleting it.</figcaption>
</figure>

Leave **Logs Writer** for a sink's writer identity on the host project: every sink there writes as that identity.
