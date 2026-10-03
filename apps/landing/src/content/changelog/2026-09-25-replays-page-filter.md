---
title: "Filter replays by any page visited"
description: "Find the sessions, and the users, that reached a page at any point, not only the page they landed on."
date: 2026-09-25
category: replays
authors: [jeremyfunk]
---

The **Replays** filter sidebar has a new **Page visited** section. Pick a page and the list shows
every session that reached it at any point, not only sessions that started there. Use it to find
the identified users who reached your pricing or checkout page, then watch what they did.

The section lists your most visited pages by session count, and you can search it. Selecting a
page narrows every other filter to match, so the browser, device and country counts you see
come from those sessions only.

The filter matches the exact path, without the query string or fragment. It is saved in the URL
as `?page=`, for example `?page=/pricing/`, so you can bookmark or share a filtered view.

Learn more in the [Replays docs](/docs/session-replay/replays).
