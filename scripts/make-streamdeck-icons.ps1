# Draws the Stream Deck plugin's key images and icons.
#   powershell -ExecutionPolicy Bypass -File scripts\make-streamdeck-icons.ps1
Add-Type -AssemblyName System.Drawing
$root = Split-Path $PSScriptRoot -Parent
$out = Join-Path $root "streamdeck\com.rewind.clipper.sdPlugin\imgs"
New-Item -ItemType Directory -Force $out | Out-Null
$logo = [Drawing.Image]::FromFile((Join-Path $root "src-tauri\icons\icon.png"))

$bg = [Drawing.Color]::FromArgb(14, 16, 20)
$lime = [Drawing.Color]::FromArgb(198, 244, 50)
$red = [Drawing.Color]::FromArgb(255, 59, 48)
$grey = [Drawing.Color]::FromArgb(120, 128, 140)

function New-Canvas($size, $fill) {
    $b = New-Object Drawing.Bitmap $size, $size
    $g = [Drawing.Graphics]::FromImage($b)
    $g.SmoothingMode = 'AntiAlias'; $g.InterpolationMode = 'HighQualityBicubic'; $g.TextRenderingHint = 'AntiAliasGridFit'
    if ($fill) { $g.Clear($fill) } else { $g.Clear([Drawing.Color]::Transparent) }
    return @($b, $g)
}
function Save($bmp, $name, $size) {
    $bmp.Save((Join-Path $out "$name.png"), [Drawing.Imaging.ImageFormat]::Png)
    $half = New-Object Drawing.Bitmap $bmp, ([int]($size / 2)), ([int]($size / 2))
    # Stream Deck picks name.png for standard keys and name@2x.png for high-DPI.
    Move-Item -Force (Join-Path $out "$name.png") (Join-Path $out "$name@2x.png")
    $half.Save((Join-Path $out "$name.png"), [Drawing.Imaging.ImageFormat]::Png)
}
# Draw a key at 144 px (saved as @2x, plus a 72 px copy).
function Key($name, [scriptblock]$draw) {
    $b, $g = New-Canvas 144 $bg
    & $draw $g
    $g.Dispose(); Save $b $name 144
}
function Logo($g, $x, $y, $s, $alpha = 1.0) {
    $ia = New-Object Drawing.Imaging.ImageAttributes
    $cm = New-Object Drawing.Imaging.ColorMatrix; $cm.Matrix33 = $alpha
    $ia.SetColorMatrix($cm)
    $g.DrawImage($logo, (New-Object Drawing.Rectangle $x, $y, $s, $s), 0, 0, $logo.Width, $logo.Height, 'Pixel', $ia)
}

Key "key-save" { param($g) Logo $g 26 14 92 }
Key "key-record" { param($g)
    $g.DrawEllipse((New-Object Drawing.Pen $grey, 7), 38, 22, 68, 68)
    $g.FillEllipse((New-Object Drawing.SolidBrush ([Drawing.Color]::FromArgb(150, 40, 36))), 54, 38, 36, 36) }
Key "key-record-on" { param($g)
    $g.Clear([Drawing.Color]::FromArgb(70, 12, 12))
    $g.DrawEllipse((New-Object Drawing.Pen $red, 7), 38, 22, 68, 68)
    $g.FillEllipse((New-Object Drawing.SolidBrush $red), 50, 34, 44, 44) }
Key "key-buffer-on" { param($g)
    Logo $g 30 12 84
    $g.FillEllipse((New-Object Drawing.SolidBrush $red), 98, 10, 26, 26)
    $g.DrawEllipse((New-Object Drawing.Pen $bg, 4), 98, 10, 26, 26) }
Key "key-buffer-off" { param($g)
    Logo $g 30 12 84 0.35
    $br = New-Object Drawing.SolidBrush ([Drawing.Color]::FromArgb(232, 235, 240))
    $g.FillRectangle($br, 58, 40, 10, 32); $g.FillRectangle($br, 76, 40, 10, 32) }
Key "key-quality" { param($g)
    $pen = New-Object Drawing.Pen $lime, 6
    $g.DrawRectangle($pen, 30, 24, 84, 56)
    $g.FillRectangle((New-Object Drawing.SolidBrush $lime), 62, 84, 20, 8)
    $f = New-Object Drawing.Font "Segoe UI", 22, ([Drawing.FontStyle]::Bold), ([Drawing.GraphicsUnit]::Pixel)
    $sf = New-Object Drawing.StringFormat; $sf.Alignment = 'Center'; $sf.LineAlignment = 'Center'
    $g.DrawString("HD", $f, (New-Object Drawing.SolidBrush $lime), (New-Object Drawing.RectangleF 30, 24, 84, 56), $sf) }

# Action-list icons: white line art on transparent (40 px, plus 20 px).
function Icon($name, [scriptblock]$draw) {
    $b, $g = New-Canvas 40 $null
    & $draw $g ([Drawing.Color]::White)
    $g.Dispose(); Save $b $name 40
}
Icon "action-save" { param($g, $c) $p = New-Object Drawing.Pen $c, 3.5; $g.DrawArc($p, 6, 6, 28, 28, -60, 300)
    $g.FillPolygon((New-Object Drawing.SolidBrush $c), [Drawing.PointF[]]@((New-Object Drawing.PointF 34, 8), (New-Object Drawing.PointF 36, 20), (New-Object Drawing.PointF 26, 15))) }
Icon "action-record" { param($g, $c) $g.DrawEllipse((New-Object Drawing.Pen $c, 3.5), 5, 5, 30, 30); $g.FillEllipse((New-Object Drawing.SolidBrush $c), 13, 13, 14, 14) }
Icon "action-buffer" { param($g, $c) $p = New-Object Drawing.Pen $c, 3.5; $g.DrawArc($p, 5, 5, 30, 30, -60, 300); $g.FillRectangle((New-Object Drawing.SolidBrush $c), 15, 14, 3.5, 12); $g.FillRectangle((New-Object Drawing.SolidBrush $c), 22, 14, 3.5, 12) }
Icon "action-quality" { param($g, $c) $g.DrawRectangle((New-Object Drawing.Pen $c, 3), 4, 7, 32, 22); $g.FillRectangle((New-Object Drawing.SolidBrush $c), 16, 31, 8, 3) }
Icon "category" { param($g, $c) $p = New-Object Drawing.Pen $c, 3.5; $g.DrawArc($p, 6, 6, 28, 28, -60, 300); $g.FillPolygon((New-Object Drawing.SolidBrush $c), [Drawing.PointF[]]@((New-Object Drawing.PointF 34, 8), (New-Object Drawing.PointF 36, 20), (New-Object Drawing.PointF 26, 15))) }

# Plugin icon (store / plugin list): the app logo.
$b, $g = New-Canvas 288 $null; $g.DrawImage($logo, 0, 0, 288, 288); $g.Dispose(); Save $b "plugin" 288
$logo.Dispose()
Get-ChildItem $out | Select-Object Name, Length
