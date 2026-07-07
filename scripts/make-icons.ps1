# Generates the Blotty extension icons (ink-drop blob on transparent) at the
# sizes WXT picks up from public/icon/. Run once: powershell -File scripts/make-icons.ps1
Add-Type -AssemblyName System.Drawing

$outDir = Join-Path $PSScriptRoot '..\public\icon'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$ink = [System.Drawing.Color]::FromArgb(255, 32, 37, 60)     # brand ink navy
$paper = [System.Drawing.Color]::FromArgb(255, 253, 251, 245) # brand paper

function New-Icon([int]$size, [string]$path) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)

    $s = $size / 48.0
    $inkBrush = New-Object System.Drawing.SolidBrush($ink)

    # Blob body: circle centred low, plus a triangular drip tip meeting it.
    $bodyX = 9.5 * $s; $bodyY = 15.0 * $s; $bodyD = 29.0 * $s
    $gp = New-Object System.Drawing.Drawing2D.GraphicsPath
    $gp.AddEllipse($bodyX, $bodyY, $bodyD, $bodyD)
    $tip = @(
        (New-Object System.Drawing.PointF((24.0 * $s), (2.5 * $s))),
        (New-Object System.Drawing.PointF((13.5 * $s), (23.0 * $s))),
        (New-Object System.Drawing.PointF((34.5 * $s), (23.0 * $s)))
    )
    $gp.AddPolygon($tip)
    $g.FillPath($inkBrush, $gp)

    if ($size -ge 32) {
        # Happy face: two paper eyes and a smile.
        $paperBrush = New-Object System.Drawing.SolidBrush($paper)
        $eyeR = 3.1 * $s
        $g.FillEllipse($paperBrush, [single](18.5 * $s - $eyeR), [single](28.0 * $s - $eyeR), [single](2 * $eyeR), [single](2 * $eyeR))
        $g.FillEllipse($paperBrush, [single](29.5 * $s - $eyeR), [single](28.0 * $s - $eyeR), [single](2 * $eyeR), [single](2 * $eyeR))
        $pupilR = 1.5 * $s
        $g.FillEllipse($inkBrush, [single](19.3 * $s - $pupilR), [single](28.6 * $s - $pupilR), [single](2 * $pupilR), [single](2 * $pupilR))
        $g.FillEllipse($inkBrush, [single](30.3 * $s - $pupilR), [single](28.6 * $s - $pupilR), [single](2 * $pupilR), [single](2 * $pupilR))
        $pen = New-Object System.Drawing.Pen($paper, [single](2.0 * $s))
        $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
        $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
        $g.DrawArc($pen, [single](19.0 * $s), [single](29.5 * $s), [single](10.0 * $s), [single](8.0 * $s), 25, 130)
        $pen.Dispose()
        $paperBrush.Dispose()
    }

    $g.Dispose()
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    $inkBrush.Dispose()
    Write-Host "wrote $path"
}

foreach ($size in 16, 32, 48, 96, 128) {
    New-Icon $size (Join-Path $outDir "$size.png")
}
