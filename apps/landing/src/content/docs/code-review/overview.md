---
title: "Code review"
description: "Turn on pull request reviews for a GitHub repository, read what Maple posts on each push, talk to the reviewer with @maple, tune the rules per organization and repository, and track what reviews catch."
group: "Code Review"
order: 1
---

Maple reviews pull requests on GitHub. Each review reads the diff next to the production telemetry behind the changed code: the traffic of the operations it touches, open errors in those files, and the alerts and dashboards that read its spans and metrics. Findings come back on the pull request before you merge, and Maple checks production again after the change ships.

Reviews run through the [GitHub integration](/docs/integrations/github). Connect GitHub first.

## Turn reviews on

1. Open **Code Review → Settings**. Every repository the Maple GitHub App can see is listed.
2. Switch **Review status** to **Reviewed** on each repository you want reviewed. Reviews are off for every repository until you turn them on.
3. Push to an open pull request in that repository. The review starts on the push.

To review a repository that is not listed, click **Manage GitHub access** and grant the app access to it.

## What lands on the pull request

Every push to a reviewed pull request gets a review of its head commit:

- **A summary comment** with a confidence score and its reason, every finding, the deploy steps found in the diff, and the production traffic of the changed code.
- **An inline review** with a comment on the line of each finding. A finding with an exact fix carries a GitHub suggestion you apply in one click.
- **A check run** on the head commit.

Each finding has a severity (`critical`, `warn` or `info`) and a lens: correctness, security, performance, observability, convention, tests or maintainability. A finding keeps its handle (`F3`) across pushes. When a later push fixes it, the review marks it resolved.

### Before merge

The review lists the steps a change needs outside the code as a checklist: secrets, environment variables, migrations, warehouse schema changes, infrastructure and manual steps. Tick them on the comment as you do them. If you merge with a step unticked, Maple reminds you on the pull request.

### Telemetry contracts

The review flags a change that removes a span, attribute or metric name that an alert or dashboard reads. By default this is a finding. Turn on **Fail the check on broken telemetry** to fail the check run when the review cannot show the name is still emitted.

### After merge

When a reviewed pull request merges, Maple waits for the deploy that carries it, then compares an hour of traffic on each side of the deploy. It comments on the pull request with the deploy, the operations its files touch, new errors, and whether the errors the review linked to its files stopped. The first look is 15 minutes after the merge. Maple keeps looking for a deploy for 48 hours. Turn this off with **Check production after merge**.

## Talk to the reviewer

Mention the reviewer in a comment on the pull request. It reacts with 👀 and replies in the thread.

| Comment             | What happens                                                                                                                                        |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@maple review`     | Reviews the current head now, even when the push limit was reached.                                                                                 |
| `@maple fix`        | Commits the fix it proposes to the pull request's branch. Needs write access to the repository. It never pushes to a fork or to the default branch. |
| `@maple <question>` | Answers in the thread. Replying on a finding's thread asks about that finding.                                                                      |

To dismiss a finding, resolve its thread or reply "won't fix". The reviewer does not raise a dismissed finding again on later pushes.

## Which pull requests are reviewed

A push starts a review unless one of these applies:

- The pull request is a draft. Turn on **Draft pull requests** to review drafts too.
- The author is a bot.
- The author is not an owner, member or collaborator of the repository. The review runs once a maintainer approves the pull request's CI.
- The repository reached its **Daily limit** for the UTC day.
- The pull request reached its **Reviews per pull request** limit. Later pushes wait for `@maple review`.

A new push while a review runs supersedes it, and the newer head is reviewed.

## Review rules

**Code Review → Settings** holds the **Default review rules** every repository starts from. Each repository can override any of them under **Repository overrides → Configure**. Only organization admins can change rules.

| Rule                                   | Default              | What it does                                                                                                                                                                |
| -------------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Instructions**                       | None                 | Extra rules in plain language, such as "Flag any new endpoint without an auth check." Up to 4,000 characters.                                                               |
| **Ignored paths**                      | None                 | One path prefix or `*.ext` suffix per line. The review never reads matching files.                                                                                          |
| **Lenses**                             | All                  | Findings are only filed under checked lenses.                                                                                                                               |
| **Inline comments**                    | Warning and critical | The lowest severity posted inline: every issue, warning and critical, or critical only. The summary comment lists every finding either way.                                 |
| **Draft pull requests**                | Skip drafts          | Whether drafts are reviewed.                                                                                                                                                |
| **Daily limit per repository**         | No limit             | Reviews a repository may start per UTC day, 1 to 500.                                                                                                                       |
| **Reviews per pull request**           | No limit             | Reviews one pull request may get from pushes, 1 to 50.                                                                                                                      |
| **Learn from feedback**                | Whole organization   | Skips findings like ones your team downvoted or dismissed, learned across the organization, this repository only, or off. Security and critical findings are always posted. |
| **Fail the check on broken telemetry** | Off                  | See [telemetry contracts](#telemetry-contracts).                                                                                                                            |
| **Check production after merge**       | On                   | See [after merge](#after-merge).                                                                                                                                            |

Instructions and ignored paths add up: a repository's own are read after the organization's, so a repository can narrow the defaults but not drop them. The reviewer also reads `CLAUDE.md`, `AGENTS.md` and `.maple/review.md` from the repository.

### Model

Admins pick the **Review model** in Code Review settings. Reviews use the organization's model provider from **Settings → AI**: Maple managed models billed on your plan, or your own OpenRouter key.

## Code Review in the dashboard

- **Analytics:** pull requests reviewed, issues caught per day, issues by category, critical issues, the fixed rate (issues a later push resolved), average review time from push to posted review, average time to merge, and the repositories with the most issues.
- **Pull requests:** every reviewed pull request with its outcome, confidence and quality.
- **Issues:** every finding the reviewer posted, filterable by repository, severity, category and state (open, resolved, dismissed).
- **CI:** your GitHub Actions runs as traces. See [CI traces](/docs/integrations/github#ci-traces).

## When a review fails

A review that ends without a report says why on the pull request in one sentence, for example that it ran out of time or that the model provider was unavailable. Ask again with `@maple review`. If the reason is the organization's OpenRouter key (rejected or out of credits), an admin fixes it under **Settings → AI** first.
