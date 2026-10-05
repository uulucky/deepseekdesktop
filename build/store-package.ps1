param(
  [Parameter(Mandatory=$true)][string]$PortableZip,
  [Parameter(Mandatory=$true)][string]$OutputDirectory,
  [Parameter(Mandatory=$true)][string]$SourceCommit
)
$ErrorActionPreference = 'Stop'
$Repo = Split-Path $PSScriptRoot -Parent
$Product = Get-Content (Join-Path $PSScriptRoot 'store-product.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$PortableZip = (Resolve-Path $PortableZip).Path
if ((Get-FileHash $PortableZip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Product.basePortableSha256) { throw 'Portable ZIP SHA-256 does not match the approved release' }
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path $OutputDirectory) { throw 'Output directory exists; choose a fresh build directory' }
New-Item -ItemType Directory $OutputDirectory | Out-Null
$InputDir = Join-Path $OutputDirectory 'input'
Expand-Archive -LiteralPath $PortableZip -DestinationPath $InputDir
$AppInput = Join-Path $InputDir ('DeepSeekDesktop-' + $Product.baseVersion + '-portable')
$StageDir = Join-Path $OutputDirectory 'stage'
& node (Join-Path $PSScriptRoot 'store-stage.js') $AppInput $StageDir $SourceCommit
if ($LASTEXITCODE -ne 0) { throw 'Store staging failed' }
Add-Type -AssemblyName System.Drawing
$Assets = Join-Path $StageDir 'Assets'
New-Item -ItemType Directory $Assets | Out-Null
$Icon = [Drawing.Image]::FromFile((Join-Path $PSScriptRoot 'icon.png'))
try {
  foreach ($Entry in @(@('Square44x44Logo.png',44),@('Square150x150Logo.png',150),@('StoreLogo.png',50))) {
    $Bitmap = New-Object Drawing.Bitmap ([int]$Entry[1]),([int]$Entry[1])
    $Graphics = [Drawing.Graphics]::FromImage($Bitmap)
    try {
      $Graphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $Graphics.DrawImage($Icon,0,0,[int]$Entry[1],[int]$Entry[1])
      $Bitmap.Save((Join-Path $Assets $Entry[0]),[Drawing.Imaging.ImageFormat]::Png)
    } finally { $Graphics.Dispose(); $Bitmap.Dispose() }
  }
} finally { $Icon.Dispose() }
$SdkRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
$MakeAppx = Get-ChildItem $SdkRoot -Filter makeappx.exe -Recurse | Where-Object FullName -Match '\\x64\\makeappx.exe$' | Sort-Object FullName -Descending | Select-Object -First 1
if (!$MakeAppx) { throw 'Install the official Windows SDK (MakeAppx x64)' }
$Package = Join-Path $OutputDirectory ('DeepSeekDesktop-' + $Product.baseVersion + '-store-x64.msix')
& $MakeAppx.FullName pack /d $StageDir /p $Package /o
if ($LASTEXITCODE -ne 0) { throw 'MakeAppx validation/packaging failed' }
$Evidence = @{ product=$Product; sourceCommit=$SourceCommit; sha256=(Get-FileHash $Package -Algorithm SHA256).Hash.ToLowerInvariant(); bytes=(Get-Item $Package).Length; makeAppx=$MakeAppx.FullName; builtAt=[DateTime]::UtcNow.ToString('o'); signature='unsigned-for-Partner-Center' }
$Evidence | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $OutputDirectory 'store-build-info.json') -Encoding UTF8
Write-Host ('Ready for Partner Center: ' + $Package)
