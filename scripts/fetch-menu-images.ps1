# Downloads free-licensed (Wikimedia Commons) food photos for the menu UI.
# Each photo's source page is recorded in apps/web/public/menu/CREDITS.md.
$ErrorActionPreference = "Stop"
$outDir = Join-Path $PSScriptRoot "..\apps\web\public\menu"
New-Item -ItemType Directory -Force $outDir | Out-Null
$UA = @{ "User-Agent" = "MeatboxAI-menu-images/1.0 (contact: kevin@smartventuring.com.au)" }

$wanted = @(
  @{ slug = "meatbox";          q = "halal snack pack" },
  @{ slug = "kebab-wrap";       q = "doner kebab wrap durum" },
  @{ slug = "falafel-wrap";     q = "falafel wrap sandwich" },
  @{ slug = "charcoal-chicken"; q = "rotisserie roast chicken" },
  @{ slug = "grill-skewers";    q = "shish kebab skewers grill" },
  @{ slug = "lamb-shank";       q = "lamb shank dish" },
  @{ slug = "beef-ribs";        q = "beef ribs barbecue plate" },
  @{ slug = "burger";           q = "chicken burger" },
  @{ slug = "manakish";         q = "manakish zaatar" },
  @{ slug = "pide";             q = "pide turkish food" },
  @{ slug = "pizza";            q = "chicken pizza" },
  @{ slug = "gozleme";          q = "gozleme" },
  @{ slug = "fish-chips";       q = "fish and chips" },
  @{ slug = "chips";            q = "french fries chips" },
  @{ slug = "garlic-bread";     q = "garlic bread" },
  @{ slug = "rice";             q = "rice pilaf" },
  @{ slug = "tabouli";          q = "tabbouleh salad" },
  @{ slug = "falafel";          q = "falafel balls plate" },
  @{ slug = "garlic-dip";       q = "toum garlic dip" },
  @{ slug = "hummus";           q = "hummus bowl" },
  @{ slug = "chilli-dip";       q = "chili sauce bowl" },
  @{ slug = "tahini";           q = "tahini sauce" },
  @{ slug = "soft-drink";       q = "cola glass ice" },
  @{ slug = "water";            q = "bottled water" },
  @{ slug = "ayran";            q = "ayran drink" },
  @{ slug = "bubble-tea";       q = "bubble tea" }
)

$credits = @("# Menu photo credits", "", "Free-licensed images from Wikimedia Commons (see each source page for author/license).", "")
$results = @()
foreach ($w in $wanted) {
  $file = Join-Path $outDir "$($w.slug).jpg"
  try {
    $api = "https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search&gsrnamespace=6&gsrsearch=$([uri]::EscapeDataString($w.q))&gsrlimit=8&prop=imageinfo&iiprop=url%7Cmime%7Csize%7Cextmetadata&iiurlwidth=800"
    $res = Invoke-RestMethod -Uri $api -Headers $UA -TimeoutSec 30
    $pages = @($res.query.pages.PSObject.Properties | ForEach-Object { $_.Value }) | Sort-Object index
    $pick = $null
    foreach ($p in $pages) {
      $ii = $p.imageinfo[0]
      if ($ii -and ($ii.mime -eq "image/jpeg") -and ($ii.width -ge 500) -and ($ii.height -ge 350)) { $pick = $ii; $pickTitle = $p.title; break }
    }
    if (-not $pick) { $results += "MISS  $($w.slug) ($($w.q))"; continue }
    Invoke-WebRequest -Uri $pick.thumburl -Headers $UA -OutFile $file -TimeoutSec 60
    $size = (Get-Item $file).Length
    if ($size -lt 8kb) { Remove-Item $file; $results += "TINY  $($w.slug)"; continue }
    $credits += "- $($w.slug).jpg - $pickTitle - $($pick.descriptionurl)"
    $results += "OK    $($w.slug) ($([math]::Round($size/1kb))KB)"
  } catch {
    $results += "FAIL  $($w.slug): $($_.Exception.Message)"
  }
}
$credits | Set-Content (Join-Path $outDir "CREDITS.md") -Encoding utf8
$results
