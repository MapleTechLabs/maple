---
title: "Status pages"
description: "Publish a hosted status page for your customers in Maple: components that follow your uptime monitors, incidents and maintenance notices, themes, password and internal pages, custom domains, break-glass posting, feeds, the API and limits."
group: "Alerting"
order: 5.7
---

A status page tells your customers whether your product works. It lists components, such as API and Dashboard, with their current status and up to 90 days of daily uptime bars, and shows open incidents, planned maintenance and incidents resolved in the last 14 days. Components can follow your [uptime checks](/docs/alerting/uptime-checks), so the page shows an outage when the checks fail. Maple serves the page separately from the dashboard, so it keeps showing its last published state when the rest of Maple is unreachable.

Status page incidents are public posts for customers. They are separate from the internal [incidents](/docs/alerting/incidents) that alert rules open.

## Create a page

You need the engineer or admin role in the organization.

1. Open **Status pages** in the sidebar (under **Triage**) and click **New status page**.
2. Under **Page**, enter a **Name**, such as `Acme Status`. **Address** follows the name until you type your own slug.
3. Under **What's on it**, pick the uptime monitors to show. Each picked monitor becomes a component; rename or group it the way visitors should read it. To add more:
    - **Monitor a URL**: paste a URL and click **Monitor it**. Maple creates an uptime check that runs every minute and adds it as a component.
    - **Add a component without a monitor**: a component you update by hand.
4. Under **Look**, pick a preset and a **Mode** (**Auto**, **Light** or **Dark**). The preview on the right shows the page as visitors get it, with your monitors' real uptime.
5. Click **Publish page**, or **Save as draft** to keep it private.

Nothing is public until you publish. A draft page shows the banner "This page is a draft" in the editor until you click **Publish page**. After that, saved changes go out within a minute. **Open page** in the page header opens the public page.

If **Status pages** is missing from the sidebar, the feature is not enabled for your organization yet.

The editor has four tabs: **Page** (the page itself, where you edit components and incidents), **Appearance**, **Settings** and **JSON** (the whole page as one config document).

## Components

Click a component on the **Page** tab to edit it:

- **Shown as**: the name visitors see.
- **Group**: components with the same group are listed under one heading.
- **Description**: a line under the name.
- **Driven by**: the uptime monitor behind the component, or **No monitor**.
- **Override status**: **Automatic**, or a fixed status: **Operational**, **Degraded**, **Partial outage** or **Major outage** or **Maintenance**.
- **Show uptime bars**: the daily bars and uptime percentage. Uptime bars need a monitor.

A component's status is the worst of three inputs:

| Input                                   | Status it sets                                                                                                                 |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Its monitor is down                     | Major outage                                                                                                                   |
| **Override status**                     | The status you picked                                                                                                          |
| An active incident or maintenance on it | Impact None: Operational. Minor: Degraded. Major: Partial outage. Critical: Major outage. Maintenance in progress: Maintenance |

The banner at the top of the page shows the worst component status.

Each uptime bar is one UTC day of the monitor's checks. A day with checks taken while the monitor was down shows as down. A day with failed checks that never added up to the monitor's **Down after** count shows as degraded. A day without checks shows as empty. The uptime percentage is the share of checks taken while the monitor was up.

When no publish has reached the page for 5 minutes, or a page with monitored components has had no new check result for 5 minutes, it shows "Live checks are delayed" with the time of the last known state, rather than looking green.

**Remove from page** takes a component off the page. Its monitor keeps running.

## Incidents and maintenance notices

Org members can post to a status page; analysts cannot.

1. On the **Page** tab, click **Post incident**.
2. Pick the **Kind**: **Incident** or **Maintenance**.
3. Enter a **Title**, such as `Elevated API errors`, and pick the **Affected components**.
4. For an incident, set the **Status** and **Impact** (**None**, **Minor**, **Major** or **Critical**). For maintenance, set **Starts** and **Ends**.
5. Write the **Message**. It supports **bold**, _italic_, `code`, lists and links.
6. Click **Review**. The review step shows the post as it will appear and what changes on the page.
7. Click **Publish** (**Schedule** for maintenance), or **Save as draft**.

A draft is not on the public page. It is listed under **Incidents** in the editor's **On this page** list, where **Publish** puts it on the page.

To follow up, open the incident and click **Post update**. Each update has a status and a message and also goes through **Review**. Use **Resolve** (**Complete** for maintenance) to close it, and **Edit details** to change the title, impact, times or components without posting an update.

The statuses are:

- Incidents: `investigating`, `identified`, `monitoring`, `resolved`.
- Maintenance: `scheduled`, `in_progress`, `completed`.

Maintenance follows its window on its own. At the start it moves to `in_progress` with the update "The scheduled maintenance has started.", and at the end to `completed` with "The scheduled maintenance is complete.".

A resolved incident or completed maintenance stays listed, with its updates, for 14 days. The page's incident history covers the last 365 days.

### Automatic incidents from monitors

Under **Settings → Behaviour**, **When a linked monitor goes down** sets what happens when a monitor behind a component goes down:

- **Off** (the default): nothing is posted.
- **Open a draft for me to publish**: a draft incident waits under **Incidents** in the editor.
- **Open and publish an incident**: the incident shows on the page at once.

The incident is titled "<component> is down", with impact Major, status `investigating` and the update "Automated checks for <component> are failing. We are investigating.". When the monitor's alert incident resolves, Maple resolves the page incident with "Automated checks are passing again. This incident has been resolved.". A component's status follows its monitor whether or not this setting is on.

## Appearance

The **Appearance** tab holds:

- **Branding**: **Logo URL** (also the image when the page is shared), **Dark mode logo URL** and **Favicon URL**.
- **Preset**: **Default**, **Maple**, **Mono**, **Cosmic Night** or **Vintage Paper**. Picking a preset also resets the font and corners to the ones it is designed around.
- **Mode**: **Auto** follows each visitor's light or dark setting. **Light** or **Dark** forces one, and only then can you set your own **Background**, **Text**, **Card** and **Border** colors. **Accent** colors links and highlights in every mode.
- **Corners**: **Square**, **Small**, **Medium** or **Large**.
- **Font**: **Sans serif**, **Serif** or **Monospace** (system fonts).

Colors are `#rrggbb` hex values. Maple refuses a theme whose text would be hard to read: text on the background and on cards, and the status colors on both, need a WCAG contrast ratio of at least 4.5:1. The editor shows "Text is hard to read" with the ratio it found, and the API answers with the same message. An accent below 4.5:1 on the background is still used as a fill, but links keep the preset's link color.

The page name, **Address**, description, **Website URL**, **Privacy policy URL**, **Terms of service URL**, **Support URL** (shown as Contact support in the header) and **Show powered by Maple** are on the **Settings** tab. Links must be `https`.

## Private pages

**Settings → Who can view** has three options. Changing it needs the admin role.

| Option                 | Who can read it                                                                                                                        |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **Public**             | Anyone with the address. Feeds, JSON and the badge are open.                                                                           |
| **Password-protected** | Visitors who enter the page password. No subscribe link, feeds need the password, and search engines leave it out.                     |
| **Internal**           | Members of your organization, signed in to Maple. The page's address and custom domain answer not found; members read it inside Maple. |

Set the password first, under **New password** and **Save password**: 8 to 256 characters. Visitors enter it once per browser and stay signed in for 30 days. Saving a new password signs every visitor out. An internal page cannot have a custom domain, so remove the domain before switching to internal. It has no public address, so the editor offers no break-glass token for it either.

## Custom domain

A page can answer on a subdomain you control, such as `status.acme.com`, with a certificate Maple issues and renews. You need the engineer or admin role.

1. Open **Settings → Custom domain**, enter the **Hostname** and click **Add domain**.
2. Add both records from the **DNS records to add** table at your DNS provider:
    - A `CNAME` from your hostname to the target Maple shows. It points the domain at Maple and is always needed.
    - A `TXT` record named `_maple-challenge.<your hostname>`. It proves you own the domain, and Maple sets the domain up only after it finds this record. You can remove it once the domain is active.
3. Wait for the badge to change from **Waiting for DNS** to **Issuing certificate** and then **Active**. Maple checks every minute for the first hour, then every ten minutes. **Check now** checks at once and retries a failed certificate. While the certificate is issued the table may list more `TXT` records: one marked optional, and records for the certificate, which you add only when they are listed.

The `TXT` value is specific to your organization and this page, so the record works for no one else, and a `CNAME` that points at Maple is not enough for anyone to serve a page on your domain. If Maple says a hostname is held by another status page that has not proved it owns the domain, the message gives the `TXT` record to add: publish it, then add the domain again, and it becomes yours. Domains that were added before this record was required keep working and need no change.

Once the domain is active, the page, its feeds and its JSON answer there, and feed links, the Slack command and the dashboard's links use it. **Needs attention** means the domain stopped; the panel says what went wrong. **Remove** stops serving the page on the domain within a minute; the page stays up at its Maple address.

The hostname must be a subdomain: an apex domain such as `acme.com` cannot point at Maple. IP addresses, names under `maple.dev` and reserved names such as `localhost` are refused. A page has one custom domain, and a hostname can belong to only one page. A domain that is not active within 7 days of being added is removed, so add the DNS records soon after.

## Post while Maple is down (break-glass)

The page keeps serving its last published state even when the rest of Maple is unreachable. A break-glass token lets you post incident updates straight to the hosted page when Maple itself is down. It needs the admin role.

1. Open **Settings → Break-glass token** and click **Issue token**.
2. Copy the token, which starts with `mstat_`, into your password manager. It is not shown again. The panel then shows only its last 6 characters.

During an outage, open `/_manage` on the page's address, for example `https://status.acme.com/_manage`. On a password-protected page, enter the page password first. The form takes the **Break-glass token**, the **Incident** (an open one or **New incident**), a **Title** for a new incident, a **Status** and **Impact** (left at **No change**, a new incident starts as Investigating with impact Major), the **Message** and the affected components. Click **Post update** and the page shows it at once. When Maple is back, it imports these updates into the page's incidents.

**Replace token** stops the old token at once. **Revoke** refuses every later post until you issue a new one.

## Subscribers and feeds

A public page has a **Subscribe to updates** link in its header. It lists the feed links and the Slack command `/feed subscribe <feed URL>`, which posts each update to a channel. Maple does not send email or SMS to subscribers. Every public page also serves:

| Path                  | What it returns                                                                                            |
| --------------------- | ---------------------------------------------------------------------------------------------------------- |
| `/feed.rss`           | RSS 2.0, one item per incident update, newest first                                                        |
| `/feed.atom`          | Atom, the same items                                                                                       |
| `/api/v1/status.json` | Overall status, components, open incidents and planned maintenance, in the statuspage.io summary format    |
| `/api/v1/uptime.json` | Daily uptime per component. `?days=` takes 1 to 365 (default 90); `?component=` limits it to one component |
| `/badge.svg`          | A badge with the current status                                                                            |

A password-protected page serves these only to a visitor who entered the password, and an internal page serves none.

## From an AI assistant or the API

On the [MCP server](/docs/reference/mcp):

- `get_status_page` lists every page, or with `page` (slug, name or id) shows one as visitors see it, drafts included. `include_config=true` adds the page's config document.
- `post_status_page_update` opens an incident on `page` with `title` and `message`, or maintenance when you pass `starts_at` and `ends_at`. With `incident`, it posts the next update and moves it to `status`. `impact` and `components` are optional. New posts are drafts unless `publish=true`.
- `create_status_page` creates a page from a `name` (and optional `slug` and `description`). It starts as a draft with no components.
- `apply_status_page_config` replaces a page's settings, theme and components with an edited config document. It refuses the write if the config changed since you read it (`if_version`).
- `set_status_page_domain` serves a page on your own subdomain (`domain`) and returns the DNS records to add. Call it again with the same domain to check them now; `remove=true` removes it.
- `publish_status_page` makes a draft page public. It goes live within a minute.

In the [REST API](/docs/reference/api), pages live under `/v2/status_pages` (scopes `status_pages:read` and `status_pages:write`) and incidents under `/v2/status_page_incidents` (scopes `status_page_incidents:read` and `status_page_incidents:write`):

| Endpoint                                                   | What it does                                                                     |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `GET`, `POST /v2/status_pages`                             | List pages, or create one with its components (`publish: false` creates a draft) |
| `POST /v2/status_pages/preview`                            | Build the page a draft config would publish, without saving                      |
| `GET`, `PATCH`, `DELETE /v2/status_pages/{id}`             | Read, update or delete a page                                                    |
| `GET /v2/status_pages/{id}/view`                           | The page as visitors see it, whatever its visibility                             |
| `POST /v2/status_pages/{id}/publish`                       | Publish now instead of within the minute                                         |
| `GET`, `PUT /v2/status_pages/{id}/config`                  | The whole page as one document; `PUT` replaces it, with optional `?if_version=`  |
| `/v2/status_pages/{id}/components`                         | `GET` and `POST`, `PATCH` and `DELETE` on `/{component_id}`, `POST .../reorder`  |
| `PUT`, `DELETE /v2/status_pages/{id}/password`             | Set or remove the page password                                                  |
| `POST /v2/status_pages/{id}/rotate_break_glass`            | Issue a break-glass token; `DELETE .../break_glass` revokes it                   |
| `GET`, `PUT`, `DELETE /v2/status_pages/{id}/custom_domain` | Read, set or remove the custom domain; `POST .../check` checks it now            |
| `GET`, `POST /v2/status_page_incidents`                    | List incidents and maintenance, or open one with its first update                |
| `GET`, `PATCH`, `DELETE /v2/status_page_incidents/{id}`    | Read, edit or delete one                                                         |
| `POST /v2/status_page_incidents/{id}/updates`              | Post an update; `resolved` or `completed` closes it                              |

Writes to a page need the engineer role; the password and break-glass endpoints, and any change to `visibility`, need an admin. The custom domain is not part of the config document. There is no Terraform or Pulumi resource for status pages.

## Limits

- **Address** (slug): 3 to 48 lowercase letters, digits or inner hyphens, unique within your organization.
- Components: at most 200 per page.
- An incident update message: up to 20,000 characters. A break-glass message: up to 5,000 characters, with a title of up to 200.
- Page links: up to 2,048 characters, `https` only.
- Page password: 8 to 256 characters.
- Uptime bars: 90 days on the page, 365 days through `/api/v1/uptime.json`.
- Resolved incidents stay listed for 14 days. The page says live checks are delayed after 5 minutes without fresh data.
- Break-glass: at most 50 updates wait at the page until Maple imports them.

## Next steps

- [Uptime checks](/docs/alerting/uptime-checks): the monitors that drive components.
- [Heartbeat monitors](/docs/alerting/heartbeat-monitors): monitors for cron jobs and scheduled workers.
- [Incidents](/docs/alerting/incidents): the internal incidents a down monitor opens.
