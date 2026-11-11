// Upgrading is documented as "re-run the install command" — `update` just
// runs it, rather than growing a second download/verify path to keep in
// step with install.sh and install.ps1.
const INSTALL_SH =
  'curl -fsSL https://raw.githubusercontent.com/iamakbarsha1/burn-watch/main/scripts/install.sh | sh'
const INSTALL_PS1 =
  'powershell -c "irm https://raw.githubusercontent.com/iamakbarsha1/burn-watch/main/scripts/install.ps1 | iex"'

export function updateInstallCommand(platform: NodeJS.Platform): string {
  return platform === 'win32' ? INSTALL_PS1 : INSTALL_SH
}
