# services.maple: self-hosted Maple Local as a systemd service, the NixOS
# counterpart of the container image (apps/cli/docker/entrypoint.sh).
{ defaultPackage }:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.maple;
  loopback = lib.elem cfg.host [
    "127.0.0.1"
    "::1"
    "localhost"
  ];
  # The image's rule: `--in-memory` has no store to recover and refuses the policy flag.
  inMemory = lib.elem "--in-memory" cfg.extraArgs;
  start = pkgs.writeShellScript "maple-start" ''
    set -eu
    # A configured secret must be non-empty: maple treats an empty one as unset,
    # which would serve without auth. 78 tells systemd not to retry.
    load_secret() {
      value="$(cat "$CREDENTIALS_DIRECTORY/$1")"
      if [ -z "$(printf '%s' "$value" | tr -d '[:space:]')" ]; then
        echo "maple: the $1 file is empty" >&2
        exit 78
      fi
      export "$2=$value"
    }
    ${lib.optionalString (cfg.ingestKeyFile != null) "load_secret ingest-key MAPLE_LOCAL_INGEST_KEY"}
    ${lib.optionalString (
      cfg.accessTokenFile != null
    ) "load_secret access-token MAPLE_LOCAL_ACCESS_TOKEN"}
    # After an unclean stop the store restores its last checkpoint. Before the
    # first one exists there is nothing to recover, so it starts fresh instead
    # of refusing (the image's policy).
    on_dirty_store=${if cfg.onDirtyStore == null then "wipe" else cfg.onDirtyStore}
    ${lib.optionalString (cfg.onDirtyStore == null) ''
      if [ -f "$HOME/.maple/data/backups/state.json" ]; then
        on_dirty_store=restore-checkpoint
      fi
    ''}
    exec ${lib.getExe cfg.package} start \
      --host ${lib.escapeShellArg cfg.host} \
      --port ${toString cfg.port} \
      --offline \
      ${lib.optionalString (!inMemory) "--on-dirty-store \"$on_dirty_store\""} \
      ${
        lib.optionalString (
          cfg.advertiseHost != null
        ) "--advertise-host ${lib.escapeShellArg cfg.advertiseHost}"
      } \
      ${
        lib.optionalString (
          cfg.checkpointInterval != null
        ) "--checkpoint-interval ${lib.escapeShellArg cfg.checkpointInterval}"
      } \
      ${lib.escapeShellArgs cfg.extraArgs}
  '';
in
{
  options.services.maple = {
    enable = lib.mkEnableOption "Maple, self-hosted OpenTelemetry ingest and dashboard (Maple Local)";

    package = lib.mkOption {
      type = lib.types.package;
      default = defaultPackage pkgs;
      defaultText = lib.literalExpression "maple.packages.\${system}.maple";
      description = "The maple package to run.";
    };

    host = lib.mkOption {
      type = lib.types.str;
      default = "127.0.0.1";
      example = "0.0.0.0";
      description = ''
        Address to listen on. Off loopback, both `ingestKeyFile` and
        `accessTokenFile` are required.
      '';
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 4318;
      description = "Port for OTLP/HTTP ingest, the dashboard and the query API.";
    };

    advertiseHost = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "maple.example.com";
      description = "Hostname browsers and exporters use to reach the server, when it differs from `host`.";
    };

    openFirewall = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Open `port` in the firewall.";
    };

    ingestKeyFile = lib.mkOption {
      # A string, not a path: a path literal would copy the secret into the store.
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "/run/secrets/maple-ingest-key";
      description = ''
        File holding `MAPLE_LOCAL_INGEST_KEY` (at least 16 characters), which
        guards OTLP ingest. Read through systemd credentials, so it never
        enters the Nix store.
      '';
    };

    accessTokenFile = lib.mkOption {
      # A string, not a path: a path literal would copy the secret into the store.
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "/run/secrets/maple-access-token";
      description = ''
        File holding `MAPLE_LOCAL_ACCESS_TOKEN` (at least 16 characters), which
        guards the dashboard and the query API.
      '';
    };

    checkpointInterval = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "15m";
      description = "How often to refresh the store checkpoint (`off` disables it). Null keeps maple's default (30m).";
    };

    onDirtyStore = lib.mkOption {
      type = lib.types.nullOr (
        lib.types.enum [
          "fail"
          "restore-checkpoint"
          "wipe"
        ]
      );
      default = null;
      description = ''
        Recovery after an unclean stop. Null restores the last checkpoint once
        one exists and starts fresh before that, as the container image does.
      '';
    };

    extraArgs = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      example = [
        "--minimum-raw-telemetry-retention-days"
        "14"
      ];
      description = ''
        Extra arguments for `maple start`. The store lives in
        `/var/lib/maple/.maple/data`; do not pass `--data-dir`.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = loopback || (cfg.ingestKeyFile != null && cfg.accessTokenFile != null);
        message = "services.maple: listening on ${cfg.host} needs both ingestKeyFile and accessTokenFile.";
      }
      {
        assertion = lib.all (f: f == null || !lib.hasPrefix builtins.storeDir f) [
          cfg.ingestKeyFile
          cfg.accessTokenFile
        ];
        message = "services.maple: secret files must live outside the Nix store, which is world-readable.";
      }
      {
        assertion = !lib.any (arg: arg == "--data-dir" || lib.hasPrefix "--data-dir=" arg) cfg.extraArgs;
        message = "services.maple: the store lives under /var/lib/maple; remove --data-dir from extraArgs.";
      }
    ];

    # A static user, so store-changing commands can run as it:
    # `sudo -u maple HOME=/var/lib/maple maple checkpoint`.
    users.users.maple = {
      isSystemUser = true;
      group = "maple";
      home = "/var/lib/maple";
    };
    users.groups.maple = { };

    environment.systemPackages = [ cfg.package ];
    networking.firewall.allowedTCPPorts = lib.mkIf cfg.openFirewall [ cfg.port ];

    systemd.services.maple = {
      description = "Maple (self-hosted OpenTelemetry ingest and dashboard)";
      wantedBy = [ "multi-user.target" ];
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];
      # The store, its sidecars and maple's config live under HOME.
      environment.HOME = "/var/lib/maple";
      serviceConfig = {
        ExecStart = start;
        User = "maple";
        Group = "maple";
        StateDirectory = "maple";
        StateDirectoryMode = "0700";
        WorkingDirectory = "/var/lib/maple";
        LoadCredential =
          lib.optional (cfg.ingestKeyFile != null) "ingest-key:${cfg.ingestKeyFile}"
          ++ lib.optional (cfg.accessTokenFile != null) "access-token:${cfg.accessTokenFile}";
        Restart = "on-failure";
        RestartSec = 5;
        # Exit 78 is a refusal retrying cannot fix (dirty or incompatible store).
        RestartPreventExitStatus = 78;
        # A clean stop waits for an in-flight checkpoint, then closes chDB; a kill
        # leaves a dirty store. Matches `maple stop`'s checkpoint budget.
        TimeoutStopSec = "15min";
        LimitNOFILE = 65536;

        NoNewPrivileges = true;
        PrivateTmp = true;
        PrivateDevices = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectKernelLogs = true;
        ProtectControlGroups = true;
        ProtectClock = true;
        ProtectHostname = true;
        RestrictNamespaces = true;
        RestrictRealtime = true;
        RestrictSUIDSGID = true;
        LockPersonality = true;
        RestrictAddressFamilies = [
          "AF_INET"
          "AF_INET6"
          "AF_UNIX"
          # getifaddrs(), which the startup banner uses to list addresses.
          "AF_NETLINK"
        ];
        CapabilityBoundingSet = if cfg.port < 1024 then [ "CAP_NET_BIND_SERVICE" ] else "";
        AmbientCapabilities = lib.optionals (cfg.port < 1024) [ "CAP_NET_BIND_SERVICE" ];
        SystemCallArchitectures = "native";
        UMask = "0077";
      };
    };
  };
}
