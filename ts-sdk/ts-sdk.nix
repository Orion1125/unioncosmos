_: {
  perSystem =
    {
      jsPkgs,
      lib,
      self',
      ...
    }:
    let
      packageJson = lib.importJSON ./package.json;
    in
    {
      packages = {
        ts-sdk = jsPkgs.buildNpmPackage {
          pname = packageJson.name;
          inherit (packageJson) version;
          src = ./.;
          npmDepsHash = "sha256-LMNhQFd1LSgpIxpkKehhXjuaAZDPftBgfEf2/dOfmv4=";
          doCheck = true;
          checkPhase = ''
            npm run test
          '';
        };

      };
      apps.publish-ts-sdk = {
        type = "app";
        program = jsPkgs.writeShellApplication {
          name = "publish-ts-sdk";
          text = ''
            cd ${self'.packages.ts-sdk}/lib/node_modules/@unionlabs/sdk
            ${jsPkgs.nodejs}/bin/npm publish --access='public' --no-git-tagsh
          '';
        };

      };
    };
}
