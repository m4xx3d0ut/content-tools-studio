{
  description = "Development environment for C&M Content Tools";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs =
    { nixpkgs, ... }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];

      forAllSystems =
        f:
        nixpkgs.lib.genAttrs systems (
          system:
          f (
            import nixpkgs {
              inherit system;
            }
          )
        );
    in
    {
      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = with pkgs; [
            nodejs_22
            ffmpeg
            pkg-config
            python3
            gcc
            gnumake
          ];

          shellHook = ''
            export HOST="127.0.0.1"
            export PORT="3033"
            export WORKSPACE_ROOT="$PWD/workspace"
            export FFMPEG_PATH="${pkgs.ffmpeg}/bin/ffmpeg"
            export FFPROBE_PATH="${pkgs.ffmpeg}/bin/ffprobe"
            export SHARP_IGNORE_GLOBAL_LIBVIPS="1"

            echo "content-tools-studio dev shell: Node $(node --version), npm $(npm --version)"
          '';
        };
      });
    };
}
