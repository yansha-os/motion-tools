[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$source = Join-Path $projectRoot '.local\RobloxMotion.plugin.lua'
if (-not (Test-Path -LiteralPath $source)) { throw 'Run npm.cmd run setup first.' }
$pluginDirectory = Join-Path $env:LOCALAPPDATA 'Roblox\Plugins'
$target = Join-Path $pluginDirectory 'RobloxMotion.plugin.lua'
if (Test-Path -LiteralPath $target) {
    $backup = Join-Path $projectRoot ('.local\RobloxMotion.backup-' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss-ffff') + '.lua')
    Copy-Item -LiteralPath $target -Destination $backup
    Write-Output "Backed up previous plugin: $backup"
}
New-Item -ItemType Directory -Path $pluginDirectory -Force | Out-Null
Copy-Item -LiteralPath $source -Destination $target
Write-Output "Installed: $target"
Write-Output 'Restart Roblox Studio and open Motion Tools from Plugins. The paired plugin connects automatically and retries while the local MCP server starts.'
