# End-to-end NixOS VM test: the service starts, refuses unauthenticated reads,
# accepts an OTLP span with the ingest key, serves it back to the access token,
# and survives a restart.
{ pkgs, module }:
let
  ingestKey = "nixos-test-ingest-key-0123456789";
  accessToken = "nixos-test-access-token-0123456789";
  span = pkgs.writeText "span.json" (
    builtins.toJSON {
      resourceSpans = [
        {
          resource.attributes = [
            {
              key = "service.name";
              value.stringValue = "nixos-test";
            }
          ];
          scopeSpans = [
            {
              spans = [
                {
                  traceId = "5b8efff798038103d269b633813fc60c";
                  spanId = "eee19b7ec3c1b174";
                  name = "nixos-test-span";
                  kind = 2;
                  startTimeUnixNano = "@START@";
                  endTimeUnixNano = "@END@";
                }
              ];
            }
          ];
        }
      ];
    }
  );
in
pkgs.testers.runNixOSTest {
  name = "maple";
  nodes.machine = {
    imports = [ module ];
    virtualisation.memorySize = 4096;
    virtualisation.diskSize = 4096;
    environment.etc."maple/ingest-key".text = ingestKey;
    environment.etc."maple/access-token".text = accessToken;
    environment.systemPackages = [ pkgs.curl ];
    services.maple = {
      enable = true;
      host = "0.0.0.0";
      ingestKeyFile = "/etc/maple/ingest-key";
      accessTokenFile = "/etc/maple/access-token";
    };
  };

  testScript = ''
    machine.wait_for_unit("maple.service")
    machine.wait_until_succeeds("curl -fsS http://127.0.0.1:4318/health", timeout=180)

    # Off loopback without a token, reads are refused.
    machine.succeed("test \"$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4318/local/status)\" = 401")

    machine.succeed(
        "now=$(date +%s%N); "
        "sed -e \"s/@START@/$now/\" -e \"s/@END@/$((now + 1000000))/\" ${span} > /tmp/span.json"
    )
    # The ingest key writes, and only with it.
    machine.succeed("test \"$(curl -s -o /dev/null -w '%{http_code}' -H 'content-type: application/json' --data @/tmp/span.json http://127.0.0.1:4318/v1/traces)\" = 401")
    machine.succeed("curl -fsS -H 'authorization: Bearer ${ingestKey}' -H 'content-type: application/json' --data @/tmp/span.json http://127.0.0.1:4318/v1/traces")

    # The CLI reads the span back over HTTP with the access token.
    query = "env HOME=/tmp/cli MAPLE_LOCAL_URL=http://127.0.0.1:4318 MAPLE_LOCAL_ACCESS_TOKEN=${accessToken} maple services"
    machine.wait_until_succeeds(query + " | grep -q nixos-test", timeout=60)

    # Store-changing commands run as the service user, as the docs say.
    machine.succeed("runuser -u maple -- env HOME=/var/lib/maple maple checkpoint")

    machine.systemctl("restart maple.service")
    machine.wait_until_succeeds("curl -fsS http://127.0.0.1:4318/health", timeout=180)
    machine.wait_until_succeeds(query + " | grep -q nixos-test", timeout=60)

    # An empty secret file must not serve without auth: the unit exits 78 and stays down.
    machine.succeed(
        "touch /run/empty-token",
        "mkdir -p /run/systemd/system/maple.service.d",
        "printf '[Service]\\nLoadCredential=\\nLoadCredential=ingest-key:/etc/maple/ingest-key\\nLoadCredential=access-token:/run/empty-token\\n' > /run/systemd/system/maple.service.d/empty.conf",
        "systemctl daemon-reload",
    )
    machine.systemctl("restart maple.service")
    machine.wait_until_succeeds("test \"$(systemctl show -P ExecMainStatus maple.service)\" = 78", timeout=60)
    machine.sleep(10)
    machine.succeed("test \"$(systemctl show -P ActiveState maple.service)\" = failed")
    machine.fail("curl -fsS http://127.0.0.1:4318/health")
  '';
}
