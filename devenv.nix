{ pkgs, ... }:
{
  packages = [ pkgs.git pkgs.nodejs_24 ];

  enterTest = ''
    npm ci --ignore-scripts
    npm run check
  '';
}
