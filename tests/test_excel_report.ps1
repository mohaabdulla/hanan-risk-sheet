param([Parameter(Mandatory = $true)][string]$WorkbookDirectory)
# Optional integration check using desktop Excel. All edits stay in memory.
$ErrorActionPreference = 'Stop'
$excel = $null
$book = $null
try {
    $excel = New-Object -ComObject Excel.Application
    $excel.Visible = $false
    $excel.DisplayAlerts = $false
    foreach ($name in @('us', 'charts-only', 'positions-only', 'bh', 'missing')) {
        $file = (Resolve-Path -LiteralPath (Join-Path $WorkbookDirectory "$name.xlsx")).Path
        $book = $excel.Workbooks.Open($file, 0, $true)
        $excel.CalculateFullRebuild()
        $count = 0
        foreach ($sheet in $book.Worksheets) {
            $count += $sheet.ChartObjects().Count
            $used = $sheet.UsedRange
            foreach ($cell in $used.Cells) {
                if ($cell.HasFormula -and $cell.Text -match '^#(REF!|VALUE!|DIV/0!|NAME\?|NUM!|N/A)') {
                    throw "$name has an Excel error at $($sheet.Name)!$($cell.Address()): $($cell.Text)"
                }
            }
        }
        $expected = @{ 'us' = 8; 'charts-only' = 8; 'positions-only' = 0; 'bh' = 5; 'missing' = 0 }[$name]
        if ($count -ne $expected) { throw "$name has $count charts; expected $expected" }
        if ($name -eq 'us') {
            $summary = $book.Worksheets.Item('Summary')
            if ([math]::Abs($summary.Range('B2').Value2 - 1650) -gt 0.001) { throw 'Initial total is incorrect' }
            $positions = $book.Worksheets.Item('Positions')
            $positions.Range('D2').Value2 = 20
            $positions.Range('G2').Value2 = 150
            $book.Worksheets.Item('Inputs').Range('B2').Value2 = 100
            $book.Worksheets.Item('Sectors').Range('E2').Value2 = 0.6
            $excel.CalculateFullRebuild()
            foreach ($check in @(
                @('Summary', 'B2', 3500), @('Summary', 'B5', 2440),
                @('Summary', 'B6', 960), @('Summary', 'B10', 68),
                @('Sectors', 'B2', 1), @('Sectors', 'F2', 2040),
                @('Chart - Profit loss', 'B5', 0.5), @('Chart - VaR', 'B5', 60)
            )) {
                $actual = $book.Worksheets.Item($check[0]).Range($check[1]).Value2
                if ([math]::Abs($actual - $check[2]) -gt 0.001) { throw "$($check[0])!$($check[1]): expected $($check[2]), got $actual" }
            }
        }
        if ($name -eq 'missing' -and $book.Worksheets.Item('Summary').Range('B5').Value2 -ne 0) {
            throw 'Unpriced positions must not contribute to portfolio cost'
        }
        $book.Close($false)
        $book = $null
        Write-Output "$name opened and recalculated in Excel: $count native charts, no formula errors."
    }
} finally {
    if ($book) { $book.Close($false) }
    if ($excel) { $excel.Quit(); [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($excel) }
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
}
