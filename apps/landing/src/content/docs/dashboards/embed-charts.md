---
title: "Embed dashboard charts in your own product"
description: "Put a live Maple chart in your admin panel, internal tool or customer-facing page with a plain iframe. Make the dashboard public, copy the chart's embed snippet, and set theme, time range, refresh and variables in the URL."
group: "Dashboards"
order: 1
navLabel: "Embed charts"
---

Any chart on a public Maple dashboard can go into another page as a plain `<iframe>`. The chart queries Maple every time it loads, so the page shows the same numbers as the dashboard, with no export job and no second copy of the data.

The example on this page is Fieldnote, a made-up B2B app. Its admin panel has a Growth page, and the three funnels on it come straight from a Maple dashboard.

<figure class="shot">
  <img src="/screenshots/docs/embed-charts-06-customer-product.webp" alt="A light-themed admin panel for an app called Fieldnote. Its Growth page shows three KPI cards and, below them, three funnel charts embedded from Maple: pricing page to paid plan, signup to activation, and invite to paid." loading="lazy" />
  <figcaption>Fieldnote's admin panel. The KPI cards are Fieldnote's own markup; the three funnels are Maple charts in iframes, using <code>theme=light</code>.</figcaption>
</figure>

## The example dashboard: a trial-to-paid funnel

The data behind the example is synthetic: about 4,200 visitors to `fieldnote.app/pricing` over 30 days, with [product events](/docs/product-events/overview) for each step they took after that. The dashboard, **Customer funnel**, has three funnel charts built on those events:

| Chart                    | Steps                                                                                                |
| ------------------------ | ---------------------------------------------------------------------------------------------------- |
| Pricing page → paid plan | page view of `/pricing`, `signup_completed`, `workspace_created`, `teammate_invited`, `plan_started` |
| Signup → activation      | `signup_completed`, `workspace_created`, `teammate_invited`                                          |
| Invite → paid            | `teammate_invited`, `plan_started`                                                                   |

`plan_started` is sent from Fieldnote's billing service with `POST /v1/events`. The other events come from the browser.

<figure class="shot">
  <img src="/screenshots/docs/embed-charts-01-dashboard.webp" alt="The Customer funnel dashboard in Maple: a wide funnel from the pricing page to a paid plan, with 4.1K visitors narrowing to 282 paid, and two smaller funnels below it for signup to activation and invite to paid." loading="lazy" />
  <figcaption>The dashboard in Maple. Of 4.1K visitors to the pricing page, 282 started a paid plan within the 14-day funnel window.</figcaption>
</figure>

Other chart types embed the same way. See [Which charts can be embedded](#which-charts-can-be-embedded).

## Embed a chart in three steps

### Step 1: make the dashboard public

A chart can only be embedded while its dashboard is shared with **Anyone with the link**. Open the **⋮** menu in the dashboard header, choose **Share…**, and pick that option.

<figure class="shot">
  <img src="/screenshots/docs/embed-charts-05-share-dialog.webp" alt="The Share dashboard dialog with three options: Not shared, Anyone in this organization, and Anyone with the link, which is selected. Below it is the dashboard's link with Copy and Replace buttons." loading="lazy" />
  <figcaption>The Share dialog. Embeds need <strong>Anyone with the link</strong>.</figcaption>
</figure>

This makes the whole dashboard viewable, without signing in, by anyone who has the dashboard's own link. If some charts on a dashboard should stay private, move the charts you want to embed to a dashboard of their own.

### Step 2: open Embed chart

Hover the chart, open its **⋮** menu and choose **Embed chart**.

<figure class="shot">
  <img src="/screenshots/docs/embed-charts-02-menu.webp" alt="A chart's menu on the dashboard, opened from the three-dot button in its top-right corner, showing an Embed chart item." loading="lazy" />
</figure>

If the dashboard isn't public yet, the dialog says so and offers to make it public for you. That button does exactly what Step 1 does.

<figure class="shot">
  <img src="/screenshots/docs/embed-charts-03-not-public.webp" alt="The Embed chart dialog on a dashboard that is not shared. It explains that embeds only work on public dashboards, lists the steps to share it, and has a Make dashboard public button." loading="lazy" />
  <figcaption>On a dashboard that isn't public, the dialog explains how to share it instead of showing a link.</figcaption>
</figure>

On a public dashboard, the dialog creates the chart's own link the first time you open it and shows it with a ready-to-paste snippet.

<figure class="shot">
  <img src="/screenshots/docs/embed-charts-04-embed-dialog.webp" alt="The Embed chart dialog on a public dashboard: the chart's link with Copy and Replace buttons, an iframe snippet with HTML and React tabs, and a list of URL options for theme, time range, refresh and dashboard variables." loading="lazy" />
  <figcaption>The chart's link, the iframe snippet and the URL options it accepts.</figcaption>
</figure>

### Step 3: paste the snippet into your page

Copy the snippet from the **HTML** tab for plain HTML, Vue, Svelte, Angular or a server-rendered template:

```html
<iframe
	src="https://app.maple.dev/share/<token>?embed=true"
	width="100%"
	height="400"
	style="border: 0"
	loading="lazy"
></iframe>
```

Use the **React** tab in JSX. React only accepts `style` as an object, so the HTML version fails to compile there:

```jsx
<iframe
	src="https://app.maple.dev/share/<token>?embed=true"
	width="100%"
	height={400}
	style={{ border: 0 }}
	loading="lazy"
/>
```

Keep the closing `</iframe>` in HTML. A self-closing `<iframe />` only works in JSX; an HTML parser ignores the slash and treats everything after it as the frame's content.

The chart fills the frame, so `height` sets the chart's height. `?embed=true` removes Maple's page header, and the embed has no background of its own: the chart's card sits directly on your page, as in the Fieldnote screenshot. The card has 8px of space around it inside the frame, so pull the iframe out by 8px if its edges need to line up with your own cards.

## Set theme, time range, refresh and variables in the URL

Append any of these to the link in `src`:

| Parameter    | Values                                                                                                                     | Example                                            |
| ------------ | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `theme`      | `light` or `dark`. Defaults to dark.                                                                                       | `&theme=light`                                     |
| `from`, `to` | UTC, `YYYY-MM-DD HH:MM:SS`. Set both. Defaults to the dashboard's own time range.                                          | `&from=2026-09-01 00:00:00&to=2026-09-15 00:00:00` |
| `refresh`    | Seconds between reloads: `5`, `10`, `30`, `60`, `300` or `900`. `0` turns it off. Defaults to the dashboard's own setting. | `&refresh=300`                                     |
| `var-<name>` | A value for one of the dashboard's variables                                                                               | `&var-service=checkout`                            |

The dialog lists the dashboard's own variables with an example value for each. A space in `from` and `to` works as typed inside an HTML attribute; encode it as `%20` if you build the URL in code.

For example, a light chart that reloads every five minutes:

```html
<iframe
	src="https://app.maple.dev/share/<token>?embed=true&theme=light&refresh=300"
	width="100%"
	height="330"
	style="border: 0"
	loading="lazy"
></iframe>
```

A relative time range such as the dashboard's "Last 30 days" is worked out again every time the chart loads or refreshes, so the embed moves forward with the clock. `from` and `to` pin a fixed window.

## What a viewer of the embed can see

- **This chart and nothing else.** The chart's link only returns data for that one chart. It can't open the rest of the dashboard, and the chart's query definition isn't sent to the browser.
- **Live data.** Every load and every `refresh` runs the chart's query against your Maple data at that moment.
- **The chart as it is now.** Edit the chart on the dashboard and the embed shows the change on its next load. Delete the chart and the embed shows "This link isn't available".
- **No sign-in.** Anyone who has the link can load it, the same as the dashboard's own public link. Requests are rate-limited per link and per viewer IP.

## Which charts can be embedded

| Embeddable                                                     | Not embeddable (the menu item is greyed out)                                         |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Query builder charts, raw SQL charts, markdown, funnels, paths | Trace lists, trace facets and trace duration stats                                   |
| Errors summary and errors by type                              | Error facets, error rate by service, error detail traces                             |
| Service overview and service usage                             | Service time series, Apdex time series, service facets                               |
| Log lists                                                      | Log counts and log facets, metric lists and metric summaries, older v2 custom charts |

Hover a greyed-out **Embed chart** item to see why that chart can't be embedded.

## FAQ

### How do I stop embedding a chart?

Pick the option that matches how permanent you want it to be:

- **Turn off every embed on the dashboard, reversibly.** Set the dashboard back to **Not shared** in its Share dialog. Every chart link on it stops working. Set it to **Anyone with the link** again and the same links, and the embeds using them, work again.
- **Kill one chart's link for good.** Open **Embed chart** on that chart and click **Replace**. The old link never works again, and the dialog shows a new one. Anyone still embedding the chart needs the new link.
- **Remove one chart's link without replacing it.** There's no button for this yet. Call the API with a key that has `dashboards:write`:

```bash
curl -X DELETE \
  -H "Authorization: Bearer $MAPLE_API_KEY" \
  https://api.maple.dev/v2/dashboards/<dashboard_id>/widgets/<widget_id>/share
```

Opening **Embed chart** on that chart later creates a new link.

### Does replacing the dashboard's share link break my embeds?

No. **Replace** in the Share dialog only replaces the dashboard's own link. Chart embeds keep working as long as the dashboard stays public.

### Why does my embed say "This link isn't available"?

One of these happened: the dashboard is no longer shared, the chart's link was replaced or removed, or the chart was deleted from the dashboard.

### Can I embed a whole dashboard?

No. Only a single chart's link can be shown inside another site. The dashboard's own link shows "This link can't be embedded" in an iframe; open it directly or link to it instead.

### What if my dashboard is shared with "Anyone in this organization"?

Embeds don't work, even for people who are signed in to Maple. A chart link is never more open than its dashboard, and embedding needs the dashboard to be public.

### Do I need to change my Content Security Policy?

Only if your page sets `frame-src` (or `child-src`) in its `Content-Security-Policy`. Add `https://app.maple.dev`, or your own Maple web address if you self-host.

The chart is a JavaScript app, so it won't render inside an iframe whose `sandbox` attribute leaves out `allow-scripts`. Some page builders add that restriction to embedded HTML.

### Does the embed work when my app uses a light theme?

Add `&theme=light` to the link. The embed has no background, so the chart's card sits on your page in either theme.
