$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$env:GPT_REPO_CONFIG = "./config.local.json"
$env:REPO_READER_CONFIG = "./config.local.json"
$env:PORT = "8787"

npm run dev
