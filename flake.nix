{
  description = "Maple: self-hosted OpenTelemetry ingest, storage and dashboard (Maple Local)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      lib = nixpkgs.lib;
      release = lib.importJSON ./nix/release.json;
      # Platforms the pinned release has a bundle for, among those nixpkgs still
      # supports (unstable dropped x86_64-darwin in 26.11).
      systems = lib.intersectLists [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
      ] (builtins.attrNames release.assets);
      linuxSystems = lib.filter (lib.hasSuffix "-linux") systems;
      forAll = list: f: lib.genAttrs list (system: f system);
      # Maple is FSL-1.1-ALv2, which nixpkgs counts as unfree; building it from
      # this flake should not require a global allowUnfree.
      mapleFor = pkgs: pkgs.callPackage ./nix/package.nix { };
      pkgsFor =
        system:
        import nixpkgs {
          inherit system;
          config.allowUnfreePredicate = pkg: lib.getName pkg == "maple";
        };
    in
    {
      packages = forAll systems (
        system:
        let
          maple = mapleFor (pkgsFor system);
        in
        {
          inherit maple;
          default = maple;
        }
      );

      overlays.default = final: _prev: { maple = mapleFor final; };

      nixosModules.maple = import ./nix/module.nix {
        defaultPackage = pkgs: self.packages.${pkgs.stdenv.hostPlatform.system}.maple;
      };
      nixosModules.default = self.nixosModules.maple;

      checks = forAll linuxSystems (system: {
        package = self.packages.${system}.maple;
        nixos = import ./nix/test.nix {
          pkgs = pkgsFor system;
          module = self.nixosModules.maple;
        };
      });

      formatter = forAll systems (system: (pkgsFor system).nixfmt);
    };
}
