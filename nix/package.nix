# The released `maple` bundle (the Bun-compiled binary plus libchdb), the same
# artifact the installer and the container image ship. nix/release.json pins the
# version and each platform's sha256; scripts/update-nix-release.sh rewrites it.
{
  lib,
  stdenv,
  fetchurl,
  autoPatchelfHook,
}:
let
  release = lib.importJSON ./release.json;
  asset =
    release.assets.${stdenv.hostPlatform.system}
      or (throw "maple: no release bundle for ${stdenv.hostPlatform.system}");
  name = "maple-v${release.version}-${asset.target}";
in
stdenv.mkDerivation {
  pname = "maple";
  inherit (release) version;

  src = fetchurl {
    url = "https://github.com/MapleTechLabs/maple/releases/download/v${release.version}/${name}.tar.gz";
    inherit (asset) sha256;
  };

  nativeBuildInputs = lib.optionals stdenv.hostPlatform.isLinux [ autoPatchelfHook ];
  buildInputs = lib.optionals stdenv.hostPlatform.isLinux [ stdenv.cc.cc.lib ];

  # Stripping drops the JS payload Bun appends to the executable.
  dontStrip = true;
  dontConfigure = true;
  dontBuild = true;

  installPhase = ''
    runHook preInstall
    install -Dm755 maple $out/libexec/maple/maple
    install -Dm755 libchdb.so $out/libexec/maple/libchdb.so
    mkdir -p $out/bin
    # Nix owns upgrades: no update notice, and `maple update` would write into the store.
    cat > $out/bin/maple <<EOF
    #!${stdenv.shell}
    if [ "\''${1:-}" = "update" ]; then
      echo "maple was installed by Nix; upgrade it through your flake or channel." >&2
      exit 1
    fi
    export MAPLE_NO_UPDATE_CHECK=1
    # maple finds the libchdb.so beside it.
    exec $out/libexec/maple/maple "\$@"
    EOF
    chmod 755 $out/bin/maple
    runHook postInstall
  '';

  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    HOME="$TMPDIR" $out/bin/maple --version | grep -F "${release.version}"
    refusal="$(HOME="$TMPDIR" $out/bin/maple update 2>&1 || true)"
    [[ "$refusal" == *"installed by Nix"* ]]
    runHook postInstallCheck
  '';

  meta = {
    description = "Maple Local: OpenTelemetry ingest, an embedded ClickHouse store, a query API and the dashboard in one binary";
    homepage = "https://maple.dev/docs/self-hosting";
    license = lib.licenses.unfree;
    sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
    platforms = builtins.attrNames release.assets;
    mainProgram = "maple";
  };
}
