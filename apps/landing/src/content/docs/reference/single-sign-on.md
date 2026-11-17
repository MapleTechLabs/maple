---
title: "Single sign-on and SCIM provisioning"
description: "Sign in to Maple through your identity provider with SAML 2.0 or OIDC, verify your email domains, enforce SSO, and provision members, roles and deprovisioning with SCIM 2.0. Self-serve add-ons on every plan."
group: "Reference"
order: 11
---

Single sign-on (SSO) lets members sign in to Maple through your identity provider (IdP). SCIM provisioning lets the IdP create, update and remove Maple members, and set their roles from IdP groups.

Both are self-serve add-ons on every plan, added by an organization admin under **Settings → SSO & SCIM** in the dashboard:

| Add-on            | Price      | Includes                                                      |
| ----------------- | ---------- | ------------------------------------------------------------- |
| Single sign-on    | $100/month | One SAML or OIDC connection, domain verification, break-glass |
| SCIM provisioning | $100/month | Provisioning, deprovisioning and group to role mapping        |

SCIM provisioning needs single sign-on connected first. If an add-on ends, everything you set up keeps working as it is, and admins can still turn SSO off, pause or remove SCIM, and remove the connection.

Only organization admins can configure SSO and SCIM. Every change is recorded in the organization's audit log, under **Security → Audit log**.

SSO and SCIM work the same for organizations in the US and EU [regions](/docs/reference/regions).

## Supported identity providers

| Protocol | Identity providers                                                  |
| -------- | ------------------------------------------------------------------- |
| SAML 2.0 | Okta, Microsoft Entra ID, Google Workspace, any custom SAML 2.0 IdP |
| OIDC     | GitHub Enterprise, GitLab, any OpenID Connect provider              |

## Set up single sign-on

Setup has four steps. Until the last one, members keep signing in the way they do today.

### 1. Verify a domain

SSO applies to email addresses on domains you have verified.

1. Under **Settings → SSO & SCIM**, add your domain, for example `example.com`.
2. Maple shows a value of the form `maple-domain-verification=...`. Publish it as a DNS TXT record named `_maple-challenge.example.com`.
3. Click **Verify**.

DNS changes can take a few minutes to be visible. If verification fails, wait and try again. Add every domain your members sign in with. Subdomains are not included: `jo@eu.example.com` needs `eu.example.com` verified too.

### 2. Connect your identity provider

Choose SAML or OIDC and enter your IdP's details.

**SAML 2.0**

1. In your IdP, create a SAML 2.0 application with the values Maple shows: the **ACS URL** (some IdPs call it the single sign-on URL) and the **SP entity ID** (the audience URI), or the **SP metadata URL**.
2. Configure the attribute statements. The SAML response must send the user's email as `mail`. `firstName` and `lastName` are optional.
3. Assign the users or groups who should sign in.
4. In Maple, give the IdP metadata URL. If your IdP has no metadata URL, give its SSO URL, entity ID and signing certificate instead.

**OIDC**

1. In your IdP, create an OIDC application and add the **redirect URI** Maple shows to its allowed redirect URLs.
2. Request the `openid`, `email` and `profile` scopes. The IdP must return the `email` and `email_verified` claims.
3. In Maple, give the discovery URL, client ID and client secret.

The name you give the connection is shown on the sign-in page. If another organization already uses that name, Maple adds your domain to it, for example `Okta (example.com)`.

A new connection starts **off**: nobody signs in through it yet, and everyone keeps signing in as before. It only takes effect when you require SSO in step 4.

### 3. Add a break-glass admin

Add at least one admin to the bypass list before you require SSO. A member on this list can sign in with a one-time code sent to their email when the IdP is down or misconfigured, and then fix or turn off the connection.

- Only members with a verified email on one of the connection's domains can be added.
- A person whose email is also on a domain another organization's SSO covers can't be added or removed here.
- Bypass sign-ins still require any multi-factor authentication your account has set up.
- Keep the list short. Every entry is a way in that skips your IdP.

### 4. Require SSO

Turn on **Require SSO**. From then on, everyone who signs in with an email address on the connection's domains must go through the IdP. The only exception is the bypass list.

If the connection's settings have an error, members on those domains can't sign in until it's fixed, so turn it on at a quiet time and try signing in yourself right after. A break-glass admin can turn it off again.

Existing members don't need to do anything in advance. On their next sign-in they go through the IdP, and their Maple account is linked to their IdP identity because the email addresses match.

## Set up SCIM provisioning

SCIM needs a connected IdP and the SCIM provisioning add-on. Once the connection from step 2 is in place, add the add-on if you haven't, then click **Set up SCIM**. Maple shows:

- a SCIM 2.0 base URL
- a bearer token

The token is shown once. Copy it before you close the dialog.

Paste both into your IdP's provisioning settings:

| IdP                | Where                                                             | What to enter                                                                                                                                                                                                                                                                                                                                   |
| ------------------ | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Okta               | The app's **Provisioning** tab, **Configure API Integration**     | The base URL as **SCIM connector base URL** and the token as **API Token**. Set **Unique identifier field for users** to `userName`. Under **To App**, enable **Create Users**, **Update User Attributes** and **Deactivate Users**. Check that `email` is mapped, even if `userName` is an email. To use role mapping, enable **Push Groups**. |
| Microsoft Entra ID | The enterprise application's **Provisioning**, mode **Automatic** | The base URL as **Tenant URL** and the token as **Secret Token**. Check that `userName`, `name.givenName`, `name.familyName`, `email` and `active` are mapped, then set **Provisioning Status** to **On**.                                                                                                                                      |
| Other IdPs         | The SCIM or provisioning settings                                 | The base URL and the token as a bearer token.                                                                                                                                                                                                                                                                                                   |

Every provisioned user needs an email address in the SCIM `emails` attribute, on one of the connection's domains. Maple doesn't fall back to `userName`. Users without one fail to provision.

### Manage the SCIM connection

- **Rotate token** issues a new token. The old token keeps working for a short grace period, so you can update the IdP without interrupting provisioning.
- **Pause** stops provisioning. Members already provisioned stay in the organization, and provisioning picks up where it left off when you resume.
- **Remove** stops provisioning and removes the memberships that only SCIM granted. Members who joined another way are not affected, and no user account is deleted. To lock someone out, deactivate them in the IdP before you remove SCIM.

## Map groups to roles

Groups your IdP pushes appear in Maple under **Settings → SSO & SCIM**. Map each group to a Maple role: **Admin**, **Engineer**, **Member** or **Analyst**.

- The order of the mappings sets precedence. A user in several mapped groups gets the role of the highest mapping in the list.
- A user in no mapped group gets the default **Member** role.
- A new or changed mapping applies the next time your IdP pushes the group. In Okta, open **Push Groups** and choose **Push now**. Entra ID applies it on its next provisioning cycle.
- A role assigned by a mapping follows the IdP. When the user's groups change in the IdP, their Maple role changes with them, and it can't be changed by hand in Maple.
- A group deleted in the IdP disappears from Maple when the IdP sends the deletion, usually on its next provisioning cycle.

Nested groups are not followed. Add users directly to the group you mapped.

## Deprovisioning

When you deactivate or remove a user in the IdP, Maple:

- signs them out of every session
- removes the membership that SCIM granted
- revokes their Maple API keys, CLI credentials and device credentials

The IdP sends the change on its own schedule, which can take a few minutes. A user provisioned by more than one organization's directory stays active until every one of them deprovisions the user.

## Remove single sign-on

Removing the connection doesn't delete any user. Members on its domains go back to signing in with their email and their other sign-in methods, and the connection's bypass list is cleared.

## Troubleshooting

| Problem                                              | What to do                                                                                                                                                      |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain verification says the TXT record is not found | Wait a few minutes for DNS to update, then click **Verify** again. Check that the record is named `_maple-challenge.<domain>`, not the bare domain.             |
| "Verify the domain before using it for SSO"          | The domain is added but not verified yet. Finish [step 1](#1-verify-a-domain) first.                                                                            |
| Members can't sign in after you require SSO          | A break-glass admin signs in with an email code and turns off **Require SSO**, then checks the IdP details and, for SAML, that the `mail` attribute is sent.    |
| OIDC sign-in fails with a redirect error             | The redirect URI Maple shows is missing from the IdP application's allowed redirect URLs.                                                                       |
| A user fails to provision                            | The user has no email in the SCIM `emails` attribute, or it isn't on one of the connection's domains. Fix the email mapping in the IdP.                         |
| A user gets the Member role instead of a mapped role | Push the group again from your IdP after saving the mapping. If they are only in a group nested inside the mapped group, add them to the mapped group directly. |

## Next steps

- [Authentication](/docs/reference/authentication): the API keys and other credentials deprovisioning revokes
- [Regions](/docs/reference/regions): US and EU hosts
- [Audit log detections](/docs/alerting/alert-rules#audit-log-detections): alert on SSO and membership changes
