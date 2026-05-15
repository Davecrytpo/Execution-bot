$processes = @(
  "npm.cmd run start:api",
  "npm.cmd run start:bot",
  "npm.cmd run start:worker",
  "npm.cmd run start:monitor",
  "npm.cmd run start:sniper"
)

foreach ($command in $processes) {
  Start-Process powershell -ArgumentList "-NoExit", "-Command", $command -WorkingDirectory $PSScriptRoot
}
