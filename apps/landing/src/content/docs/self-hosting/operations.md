---
title: "Operations"
description: "Back up, upgrade and recover a self-hosted Maple, rotate its secrets, and know what it connects to."
group: "Self-hosting"
order: 4
---

## Data and backups

Everything lives on the `/data` volume: the store, its [restore points](/docs/local-mode/checkpoints-and-archives), and the CLI's config. Back up the volume to back up Maple.

- Give the container time to stop cleanly: `--stop-timeout 30`, or `stop_grace_period` in Compose.
- Run commands that change the store as the server's user: `docker exec -u 10001 maple maple checkpoint` (with Compose, `docker compose exec -u 10001 maple maple checkpoint`). Read-only commands such as `maple services` can run as any user.
- The server runs as an unprivileged user (uid 10001). A volume mounted as root is handed to that user on start.

## Upgrades

Pull the new image and recreate the container on the same volume. `latest` follows each stable release; pin a release tag (`ghcr.io/mapletechlabs/maple:<version>`) if you want to choose when you upgrade.

## If the container is killed

When the container is killed before it can stop cleanly (out of memory, a host crash), it starts again from its last restore point. It moves the damaged store aside as `/data/.maple/data.quarantine-*`, which you can delete once Maple is running again.

Restore points are taken on each start of a store that has data, and every 30 minutes while new data arrives. So a kill loses at most the data since the last one. A store killed before its first restore point starts empty, since there is nothing to restore.

One case needs you: a container killed and then upgraded to an image with a different storage engine cannot read the old restore point, and stops with an explanation. Run the previous image once to recover, or start fresh with:

```bash
docker run --rm -v maple-data:/data \
  ghcr.io/mapletechlabs/maple:latest reset --yes
```

With Docker Compose, which names the volume after the project, run this from the directory with `compose.yaml`:

```bash
docker compose down
docker compose run --rm maple reset --yes
docker compose up -d
```

## Rotating secrets

Change the variable and recreate the container. A new access token signs every browser out and needs updating in scripts and CLI setups. A new ingest key needs updating in every exporter.

## What connects to the internet

The server sends its own traces and metrics (service `maple-cli`) to Maple by default, as described in [What connects to the internet](/docs/local-mode#what-connects-to-the-internet). Set `MAPLE_TELEMETRY=off` to turn that off. Your telemetry never leaves the server. The image does not check for updates.
