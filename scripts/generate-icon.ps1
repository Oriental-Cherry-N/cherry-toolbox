$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing

$projectRoot = Split-Path -Parent $PSScriptRoot
$sourcePath = Join-Path $projectRoot 'static\assets\cherry-toolbox.png'
$outputPath = Join-Path $projectRoot 'static\assets\cherry-toolbox.ico'
$sizes = @(16, 20, 24, 32, 40, 48, 64, 128, 256)

if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
  throw "Icon source was not found: $sourcePath"
}

$source = $null
$buffers = New-Object System.Collections.ArrayList

try {
  $source = [System.Drawing.Image]::FromFile($sourcePath)

  foreach ($size in $sizes) {
    $bitmap = $null
    $graphics = $null
    $stream = $null

    try {
      $bitmap = New-Object System.Drawing.Bitmap(
        $size,
        $size,
        [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
      )
      $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
      $graphics.Clear([System.Drawing.Color]::Transparent)
      $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
      $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
      $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality

      $destination = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
      $graphics.DrawImage(
        $source,
        $destination,
        0,
        0,
        $source.Width,
        $source.Height,
        [System.Drawing.GraphicsUnit]::Pixel
      )

      $stream = New-Object System.IO.MemoryStream
      $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
      $null = $buffers.Add($stream.ToArray())
    }
    finally {
      if ($null -ne $stream) { $stream.Dispose() }
      if ($null -ne $graphics) { $graphics.Dispose() }
      if ($null -ne $bitmap) { $bitmap.Dispose() }
    }
  }
}
finally {
  if ($null -ne $source) { $source.Dispose() }
}

$fileStream = $null
$writer = $null

try {
  $fileStream = New-Object System.IO.FileStream(
    $outputPath,
    [System.IO.FileMode]::Create,
    [System.IO.FileAccess]::Write,
    [System.IO.FileShare]::None
  )
  $writer = New-Object System.IO.BinaryWriter($fileStream)

  $writer.Write([UInt16]0)
  $writer.Write([UInt16]1)
  $writer.Write([UInt16]$sizes.Count)

  $offset = 6 + (16 * $sizes.Count)
  for ($index = 0; $index -lt $sizes.Count; $index += 1) {
    $size = $sizes[$index]
    $buffer = $buffers[$index]
    $dimension = if ($size -eq 256) { [byte]0 } else { [byte]$size }

    $writer.Write($dimension)
    $writer.Write($dimension)
    $writer.Write([byte]0)
    $writer.Write([byte]0)
    $writer.Write([UInt16]1)
    $writer.Write([UInt16]32)
    $writer.Write([UInt32]$buffer.Length)
    $writer.Write([UInt32]$offset)
    $offset += $buffer.Length
  }

  foreach ($buffer in $buffers) {
    $writer.Write([byte[]]$buffer)
  }
}
finally {
  if ($null -ne $writer) {
    $writer.Dispose()
  }
  elseif ($null -ne $fileStream) {
    $fileStream.Dispose()
  }
}

Write-Host "Generated $outputPath ($($sizes -join ', ') px)"
