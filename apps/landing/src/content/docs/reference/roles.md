---
title: "Roles and permissions"
description: "What each built-in role in Maple can do, how to create custom roles from the permission catalog, how to assign a role to a member, and what happens to a member's keys and devices when their role changes."
group: "Reference"
order: 12
---

A role is a named set of permissions, and a permission allows one kind of action, such as managing alerts or reading the audit log. Each member of an organization holds exactly one role.

This page covers the four built-in roles, how to make your own custom roles, how to give a role to a member, and what happens to a member's credentials when their role changes.

## Built-in roles

Every organization starts with these four roles:

| Role     | Who it's for                                                 | What it can do                                                                                                                                                                     |
| -------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Analyst  | People who look at data but don't respond to incidents       | Read telemetry, run raw SQL, build and share dashboards, ask Maple AI, connect the CLI, mobile app and MCP clients                                                                 |
| Member   | Most of the team. New invitations default to this role       | Everything Analyst can do, plus triage errors, respond to incidents, run investigations, post status page updates and approve Maple AI actions                                     |
| Engineer | People who set up and maintain how your telemetry is handled | Everything Member can do, plus manage integrations, data sources, alerts, on-call, SLOs, uptime monitors, status pages, sources, ingest rules, ingest keys and restricted API keys |
| Admin    | Owners of the organization                                   | Everything, including billing, members, roles, single sign-on, full-access API keys and the audit log                                                                              |

Built-in roles can't be edited. To change one, duplicate it and edit the copy (see [Custom roles](#custom-roles)).

An organization always needs at least one Admin, and nobody can change their own role.

## Permissions

The role editor lists permissions in groups. This table shows what each group contains:

| Group                  | Permissions                                                                                                                                                                       |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read access            | Read telemetry, run raw SQL, build dashboards, share dashboards publicly, ask Maple AI, connect devices and clients                                                               |
| Everyday work          | Approve Maple AI actions, edit the shared service map, create MCP keys, join the support channel                                                                                  |
| Incident response      | Triage error issues, respond to incidents, run investigations, post status page updates, triage recommendations                                                                   |
| Alerting and detection | Manage alerts, on-call schedules, SLOs and budgets, uptime monitors and error notifications; configure anomaly detection and AI triage                                            |
| Status pages           | Edit status pages, control who can view them, manage break-glass tokens                                                                                                           |
| Ingestion and data     | View public ingest key, view and roll ingest keys, manage sources, ingest rules, attribute mappings and scrape targets, connect and query data sources, manage the data warehouse |
| Integrations and code  | Manage integrations, configure code review, turn on automatic PR approval, open the Security Center, run code security audits                                                     |
| Keys and AI providers  | Create restricted API keys, manage all API keys, manage model provider keys, see every MCP connection                                                                             |
| Organization           | Manage the organization, members, roles, billing and single sign-on; read the audit log                                                                                           |

The editor marks some permissions **Sensitive**: they cover billing, keys and other credentials, public sharing and organization-wide settings. Give them only to roles that need them.

### Read telemetry comes with most permissions

Most of Maple works on telemetry: alerts route it, investigations read it, integrations send it. So almost every permission includes **Read telemetry**. When you tick one of them, Read telemetry ticks itself and shows which permission requires it.

These permissions don't include Read telemetry:

- Connect devices and clients
- Create MCP keys
- Create restricted API keys
- Join the support channel
- Post status page updates
- View public ingest key
- Manage billing

A role that holds only these can't see traces, logs, metrics or errors. That fits a role for billing or for posting status updates, and nothing else.

One other permission works the same way: **Roll ingest keys** includes **View ingest keys**.

## Custom roles

Make a custom role when none of the built-in roles fits: for example, an Analyst who also needs to manage alerts, or someone who only handles billing. An organization can have up to 20 custom roles.

### Create a role

1. Go to **Settings → Roles** and click **Create role**.
2. Enter a name (up to 40 characters, unique in your organization) and an optional description (up to 160 characters). The description is shown in the role picker on the Members page.
3. Under **Start from**, pick a role to copy its permissions from (any built-in or custom role), or **No role** to start with none.
4. Click **Create and choose permissions**, then tick the permissions you want and click **Save role**.

Nobody holds a new role until you assign it on the Members page.

**Duplicate** in a role's row menu, or **Duplicate to customize** on a built-in role's page, opens the same dialog with that role picked.

### Edit a role

Open the role from **Settings → Roles**. While you edit:

- Use **Compare with** to show another role's permissions next to each row, so you can see what you're adding or removing.
- Filter the list by text, or show only **Granted** or **Sensitive** permissions.
- Saving applies the change to everyone who holds the role on their next request. It can take up to five minutes to reach every session.

### Delete a role

Choose **Delete** from the role's row menu. If members hold it, pick the role they move to. You can pick any role except Admin. To make someone an Admin, change their role on the Members page instead.

### Permissions only Admin can have

These permissions can't be given to a custom role. Only members with the Admin role have them:

| Permission                | Why it stays with Admin                                    |
| ------------------------- | ---------------------------------------------------------- |
| Manage members            | Inviting people and changing roles can make anyone Admin   |
| Manage roles              | A role that edits roles could give itself every permission |
| Manage the organization   | Rename, move or delete the organization                    |
| Manage all API keys       | A full-access API key can do everything an Admin can       |
| Manage single sign-on     | SCIM group mappings can assign the Admin role              |
| Manage the data warehouse | It decides where all your telemetry is stored and read     |

Duplicating the Admin role gives you every other permission. Some permissions that no built-in role below Admin holds can go in a custom role, such as **Manage billing**, **Read the audit log** and **Manage model provider keys**.

## Assign a role to a member

Only Admins can create, edit and delete roles, and change members' roles. Everyone else can open **Settings → Roles** to see what each role allows.

To change a member's role, go to **Settings → Members** and pick a role from the menu on their row. The menu lists the built-in roles first, then your custom roles. Making someone an Admin asks you to confirm.

When you invite someone, you choose one of the built-in roles. Give them a custom role after they join.

If your identity provider manages roles through [SCIM group mappings](/docs/reference/single-sign-on#map-groups-to-roles), groups map to the built-in roles only. A role set by a mapping can't be changed by hand in Maple.

## When a member's role changes

CLI logins, MCP keys and clients, and mobile app sign-ins keep the permissions their owner had when they were created. When a member's role changes to one with fewer permissions, Maple updates what they created:

| What the member created                      | What happens                                                                                            |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| CLI logins, MCP keys and MCP client sign-ins | Revoked if they carry a permission the new role doesn't have                                            |
| Mobile app and device sign-ins               | Revoked if they carry a permission the new role doesn't have                                            |
| Restricted API keys                          | Narrowed to the new role if the member could still create a key with the same scopes, otherwise revoked |
| Public dashboard share links                 | Revoked if the new role can't share dashboards publicly                                                 |
| Email digests and mobile push notifications  | Turned off if the new role can't read telemetry                                                         |
| Alert destinations                           | Keep working                                                                                            |
| Full-access API keys                         | Keep working                                                                                            |

A role change leaves full-access API keys alone, so automation an Admin set up for the organization keeps running. If someone who made a full-access key should no longer have that access, revoke the key under **Settings → Keys**.

A change to a role with more permissions revokes nothing. Editing a custom role works the same way for everyone who holds it.

Removing someone from the organization revokes every key and credential they created, full-access API keys included. See [Authentication](/docs/reference/authentication) for the kinds of credential Maple issues.

## Next steps

- [Authentication](/docs/reference/authentication): API keys, MCP keys and how they are scoped
- [Single sign-on and SCIM provisioning](/docs/reference/single-sign-on): map identity provider groups to roles
