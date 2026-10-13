---
title: "Pick the fix PR from a list, without leaving Maple"
description: "Attach a pull request to an error issue from your connected repositories, and fix verification now starts even if it already merged."
date: 2026-08-26
category: errors
authors: [makisuo]
---

Attaching a pull request to an error issue used to mean leaving Maple, finding the PR on GitHub and pasting its URL. Now **Attach** opens a picker of recent pull requests from your connected repositories. Maple preselects the likely repository, for example the one whose name matches the issue's service, and leaves the choice to you when it isn't sure.

Pasting still works: a full URL, `#123`, or a bare number. It is also the way to attach a pull request from a repository you haven't connected.

This also fixes a gap in fix verification. A pull request that had already merged when you attached it never started verification, so the issue stayed **In review** indefinitely. Maple now looks up the pull request when you attach it and starts the verification window right away if it has merged.

The picker needs the [GitHub integration](/docs/integrations/github). See [Fix verification](/docs/errors/overview#fix-verification) for how the window works.
