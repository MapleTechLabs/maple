---
title: "NixOS"
description: "Run self-hosted Maple as a NixOS service from the flake in the Maple repository, with its secrets read from files."
group: "Platforms"
order: 3
---

The Maple repository is a Nix flake. It packages the released `maple` binary and ships a NixOS module, `services.maple`, which runs the same server as the [container image](/docs/self-hosting) under systemd.

## Add the module

In your system flake:

```nix
{
  inputs.maple.url = "github:MapleTechLabs/maple";

  outputs = { nixpkgs, maple, ... }: {
    nixosConfigurations.my-host = nixpkgs.lib.nixosSystem {
      system = "x86_64-linux";
      modules = [
        maple.nixosModules.maple
        ./configuration.nix
      ];
    };
  };
}
```

Then in `configuration.nix`:

```nix
services.maple = {
  enable = true;
  host = "127.0.0.1";
  ingestKeyFile = "/run/secrets/maple-ingest-key";
  accessTokenFile = "/run/secrets/maple-access-token";
};

services.caddy = {
  enable = true;
  virtualHosts."maple.example.com".extraConfig = "reverse_proxy localhost:4318";
};
```

Each secret file holds one of the [two secrets](/docs/self-hosting#the-two-secrets), at least 16 characters. Create them with `openssl rand -hex 32`, or manage them with sops-nix or agenix. The service reads them through systemd credentials, so they never enter the Nix store. Listening on anything other than loopback requires both files.

## Options

| Option               | Default     | Meaning                                                                                                    |
| -------------------- | ----------- | ---------------------------------------------------------------------------------------------------------- |
| `host`               | `127.0.0.1` | Address to listen on. Use `0.0.0.0` without a proxy on a private network                                   |
| `port`               | `4318`      | OTLP ingest, the dashboard and the query API                                                               |
| `advertiseHost`      | none        | The hostname exporters and browsers use, when it differs from `host`                                       |
| `openFirewall`       | `false`     | Open `port` in the firewall                                                                                |
| `ingestKeyFile`      | none        | File holding the ingest key                                                                                |
| `accessTokenFile`    | none        | File holding the access token                                                                              |
| `checkpointInterval` | `30m`       | How often to refresh the [recovery checkpoint](/docs/self-hosting/operations), or `off`                    |
| `onDirtyStore`       | automatic   | After an unclean stop: restore the last checkpoint once one exists, start fresh before that (as the image) |
| `extraArgs`          | `[]`        | Extra arguments for `maple start`                                                                          |

Telemetry and checkpoints live in `/var/lib/maple`, owned by the `maple` system user. Back it up as described in [Operations](/docs/self-hosting/operations), and run commands that change the store as that user:

```bash
sudo -u maple HOME=/var/lib/maple maple checkpoint
```

Read-only commands such as `maple services` can run as any user with `MAPLE_LOCAL_URL=http://127.0.0.1:4318` and `MAPLE_LOCAL_ACCESS_TOKEN` set.

## Upgrades

The flake follows Maple releases. Run `nix flake update maple` and rebuild. `maple update` is disabled in a Nix install. Roll back with your previous generation like any other NixOS change, but note that a store opened by a newer version may refuse to start on an older one.

## Without NixOS

`nix run github:MapleTechLabs/maple -- start` runs Maple Local on any Linux machine with Nix, and on Apple Silicon macOS when the pinned release has a bundle for it. Maple's license is the [FSL](https://fsl.software), which nixpkgs counts as unfree: the flake's own package builds without any setting, but the `overlays.default` overlay needs `maple` allowed in your `allowUnfreePredicate`.
