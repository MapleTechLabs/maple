---
title: "Single sign-on and SCIM provisioning"
description: "Sign in to Maple through your identity provider with SAML 2.0 or OIDC, verify your email domains, enforce SSO, and provision members, roles and deprovisioning with SCIM 2.0."
group: "Reference"
order: 11
---

Single sign-on (SSO) lets members sign in to Maple through your identity provider (IdP). SCIM provisioning lets the IdP create, update and remove Maple members, and set their roles from IdP groups.

Both are available on the Enterprise plan. Only organization admins can configure them, under **Settings → SSO & SCIM** in the dashboard. Every change is recorded in the organization's audit log, under **Security → Audit log**.

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

DNS changes can take a few minutes to be visible. If verification fails, wait and try again. Add every domain your members sign in with.

### 2. Connect your identity provider

Choose SAML or OIDC and enter your IdP's details.

**SAML 2.0**

- In Maple, give the IdP metadata URL. If your IdP has no metadata URL, give its SSO URL, entity ID and signing certificate instead.
- In your IdP, create a SAML application and paste the values Maple shows: the ACS URL, and the SP entity ID or SP metadata URL.

**OIDC**

- In your IdP, create an OIDC application.
- In Maple, give the discovery URL, client ID and client secret.

A new connection starts **not enforced**. Members who use the IdP can sign in through it, and everyone else can still sign in as before. Use this to test the connection with your own account.

### 3. Add a break-glass admin

Add at least one admin to the bypass list. Only members with a verified email on one of the connection's domains can be added. A member on this list can still sign in with an email code when the IdP is down or misconfigured, so you cannot lock the whole organization out.

### 4. Enforce SSO

Turn on enforcement. From then on, everyone who signs in with an email address on a verified domain must go through the IdP. The only exception is the bypass list.

Existing members do not need to do anything in advance. On their next sign-in they go through the IdP, and their Maple account is linked to their IdP identity.

## Set up SCIM provisioning

SCIM needs a connected IdP. Once the connection from step 2 is in place, click **Set up SCIM**. Maple shows:

- a SCIM 2.0 base URL
- a bearer token

The token is shown once. Copy it before you close the dialog.

Paste both into your IdP's provisioning settings:

| IdP                | Where                                | What to enter                                                                                                                   |
| ------------------ | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Okta               | **Provisioning → API integration**   | The base URL and the token. Then enable **Create Users**, **Update User Attributes**, **Deactivate Users** and **Push Groups**. |
| Microsoft Entra ID | **Provisioning**, mode **Automatic** | The base URL as **Tenant URL** and the token as **Secret token**.                                                               |
| Other IdPs         | The SCIM or provisioning settings    | The base URL and the token as a bearer token.                                                                                   |

Every provisioned user needs an email address on a verified domain. Users without one fail to provision.

### Manage the SCIM connection

- **Rotate token** issues a new token. The old token keeps working for a short grace period, so you can update the IdP without interrupting provisioning.
- **Pause** stops provisioning. Members already provisioned stay in the organization.
- **Remove** stops provisioning and removes the memberships that SCIM granted. Members who joined another way are not affected.

## Map groups to roles

Groups your IdP pushes appear in Maple under **Settings → SSO & SCIM**. Map each group to a Maple role: **Admin**, **Engineer**, **Member** or **Analyst**.

- The order of the mappings sets precedence. A user in several mapped groups gets the role of the highest mapping in the list.
- A user in no mapped group gets the default **Member** role.
- A new or changed mapping applies the next time your IdP pushes the group. In Okta, open **Push Groups** and choose **Push now**; Entra ID applies it on its next provisioning cycle.
- A role assigned by a mapping follows the IdP. When the user's groups change in the IdP, their Maple role changes with them.

Nested groups are not followed. Add users directly to the group you mapped.

## Deprovisioning

When you deactivate or remove a user in the IdP, Maple:

- signs them out of every session
- removes the membership that SCIM granted
- revokes their Maple API keys, CLI credentials and device credentials

## Troubleshooting

| Problem                                              | What to do                                                                                                                                                      |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain verification says the TXT record is not found | Wait a few minutes for DNS to update, then click **Verify** again. Check that the record is named `_maple-challenge.<domain>`, not the bare domain.             |
| "Verify the domain before using it for SSO"          | The domain is added but not verified yet. Finish [step 1](#1-verify-a-domain) first.                                                                            |
| A user fails to provision                            | The user has no email address, or it is not on a verified domain. Set an email on a verified domain in the IdP, or verify that domain in Maple.                 |
| A user gets the Member role instead of a mapped role | Push the group again from your IdP after saving the mapping. If they are only in a group nested inside the mapped group, add them to the mapped group directly. |

## Next steps

- [Authentication](/docs/reference/authentication): the API keys and other credentials deprovisioning revokes
- [Regions](/docs/reference/regions): US and EU hosts
- [Audit log detections](/docs/alerting/alert-rules#audit-log-detections): alert on SSO and membership changes
