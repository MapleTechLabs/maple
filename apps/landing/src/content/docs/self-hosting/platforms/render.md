---
title: "Render"
description: "Deploy Maple to Render in one click from the maple-render blueprint."
group: "Platforms"
order: 1
icon: "render"
---

<a class="deploy-button" href="https://render.com/deploy?repo=https://github.com/MapleTechLabs/maple-render">
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18.263.007c-3.121-.147-5.744 2.109-6.192 5.082-.018.138-.045.272-.067.405-.696 3.703-3.936 6.507-7.827 6.507-1.388 0-2.691-.356-3.825-.979a.2024.2024 0 0 0-.302.178V24H12v-8.999c0-1.656 1.338-3 2.987-3h2.988c3.382 0 6.103-2.817 5.97-6.244-.12-3.084-2.61-5.603-5.682-5.75" /></svg>
  <span>Deploy to Render</span>
  <svg class="deploy-button__arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" aria-hidden="true"><path d="M7 17 17 7M9 7h8v8" /></svg>
</a>

The button deploys the [maple-render](https://github.com/MapleTechLabs/maple-render) blueprint, so the service starts out configured:

<dl class="spec-list">
  <div><dt>Instance</dt><dd>1<span>the store is a local database</span></dd></div>
  <div><dt>Disk</dt><dd>10 GB at <code>/data</code></dd></div>
  <div><dt>Plan</dt><dd><code>1c-2g</code><span>512 MB plans can run out of memory</span></dd></div>
  <div><dt>Health check</dt><dd><code>/health</code></dd></div>
  <div><dt>TLS</dt><dd>Handled by Render<span>no proxy to run</span></dd></div>
</dl>

## Set it up

First, generate an ingest key:

```bash
openssl rand -hex 32
```

- **Ingest key:** paste it into `MAPLE_LOCAL_INGEST_KEY` on the deploy page.
- **Access token:** Render generates it. Copy `MAPLE_LOCAL_ACCESS_TOKEN` from the service's **Environment** tab once the deploy finishes.
- **Sign in:** open the service's `onrender.com` URL and paste the token.

Next, [connect your apps](/docs/self-hosting/connect) to send telemetry.
