param([string]$VerifiedPackageFile,[string]$ExpectedSha256,[string]$ExpectedReleaseId)
Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
$source=Join-Path $PSScriptRoot '..\scripts\installed-release-operator.ps1'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($source,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'OPERATOR_SYNTAX_INVALID'}
$branches=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.IfStatementAst] -and
    $n.Clauses[0].Item1.Extent.Text -ceq "`$Action -eq 'Install'"},$true))
if($branches.Count -ne 1){throw 'INSTALL_BRANCH_NOT_UNIQUE'}
$block=$branches[0].Clauses[0].Item2
$tries=@($block.Statements | Where-Object {$_ -is [Management.Automation.Language.TryStatementAst]})
if($tries.Count -ne 1){throw 'INSTALL_READER_NOT_UNIQUE'}
$reader=$tries[0]
$parents=@($reader.Body.Statements | Where-Object {$_ -is [Management.Automation.Language.AssignmentStatementAst] -and
    $_.Left -is [Management.Automation.Language.VariableExpressionAst] -and $_.Left.VariablePath.UserPath -ceq 'parent'})
if($parents.Count -ne 1 -or $null -eq $reader.Finally){throw 'INSTALL_READER_BOUNDARY_CHANGED'}
# Execute the actual Install prefix through digest and manifest validation, then
# its original finally. Stop before the protected destination is even assigned.
# Do not import the operator, invoke lineage checks, extract files or touch ACLs.
$text=$ast.Extent.Text
$prefix=$text.Substring($block.Extent.StartOffset+1,$reader.Extent.StartOffset-$block.Extent.StartOffset-1)
$body=$text.Substring($reader.Body.Extent.StartOffset+1,$parents[0].Extent.StartOffset-$reader.Body.Extent.StartOffset-1)
$readArchive=[scriptblock]::Create($prefix+"`ntry {`n"+$body+"`n`$doc`n} finally "+$reader.Finally.Extent.Text)
$base=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\.tmp'))
$fixture=Join-Path $base ('archive-reader-'+[guid]::NewGuid().ToString('N'))
$passed=0
try {
    [void][IO.Directory]::CreateDirectory($fixture)
    $PackageFile=Join-Path $fixture 'fixture.zip'
    # A stored ZIP containing only a synthetic v3 manifest. Fixed bytes keep the
    # test from preloading Compression while constructing its own input.
    $bytes=[Convert]::FromBase64String('UEsDBBQAAAAAAAAAAAD/j4bQKQAAACkAAAAwAAAAbWNwX2NvbnRyb2xfY2VudGVyL2NvbmZpZy9pbnN0YWxsZWQtcmVsZWFzZS5qc29ueyJzY2hlbWFWZXJzaW9uIjozLCJyZWxlYXNlSWQiOiJmaXh0dXJlIn1QSwECFAAUAAAAAAAAAAAA/4+G0CkAAAApAAAAMAAAAAAAAAAAAAAAAAAAAAAAbWNwX2NvbnRyb2xfY2VudGVyL2NvbmZpZy9pbnN0YWxsZWQtcmVsZWFzZS5qc29uUEsFBgAAAAABAAEAXgAAAHcAAAAAAA==')
    [IO.File]::WriteAllBytes($PackageFile,$bytes)
    $PackageSha256=(Get-FileHash -LiteralPath $PackageFile).Hash.ToLowerInvariant()
    $manifest=& $readArchive
    if($manifest.schemaVersion -cne 3 -or $manifest.releaseId -cne 'fixture'){throw 'ARCHIVE_MANIFEST_NOT_READ'};$passed++
    $PackageSha256='0'*64
    $failure=$null;try{& $readArchive | Out-Null}catch{$failure=$_.Exception.Message}
    if($failure -cne 'PACKAGE_DIGEST_MISMATCH'){throw 'ARCHIVE_DIGEST_REJECTION_LOST'};$passed++
    [IO.File]::WriteAllBytes($PackageFile,[Convert]::FromBase64String('UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA=='))
    $PackageSha256=(Get-FileHash -LiteralPath $PackageFile).Hash.ToLowerInvariant()
    $failure=$null;try{& $readArchive | Out-Null}catch{$failure=$_.Exception.Message}
    if($failure -cne 'PACKAGE_MANIFEST_INVALID'){throw 'ARCHIVE_MANIFEST_REJECTION_LOST'};$passed++
    $probe=[IO.File]::Open($PackageFile,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    $probe.Dispose();$passed++
    # Exercise the real Prepare ZIP creation expression, so the Windows .NET
    # Framework separator behavior cannot be hidden by the portable fixture.
    $creates=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.InvokeMemberExpressionAst] -and
        $n.Extent.Text.StartsWith('[IO.Compression.ZipFile]::CreateFromDirectory(')},$true))
    if($creates.Count -ne 1){throw 'PREPARE_ARCHIVE_CREATOR_NOT_UNIQUE'}
    $PackageRoot=Join-Path $fixture 'payload'
    $config=Join-Path $PackageRoot 'mcp_control_center\config'
    [void][IO.Directory]::CreateDirectory($config)
    [IO.File]::WriteAllText((Join-Path $config 'installed-release.json'),'{"schemaVersion":3,"releaseId":"fixture"}')
    $archive=Join-Path $fixture 'native.zip'
    & ([scriptblock]::Create($creates[0].Extent.Text))
    $PackageFile=$archive;$PackageSha256=(Get-FileHash -LiteralPath $PackageFile).Hash.ToLowerInvariant()
    $manifest=& $readArchive
    if($manifest.releaseId -cne 'fixture'){throw 'PREPARE_ARCHIVE_NOT_READ'};$passed++
    # Introduce a second entry with the other separator. Neither alias may win.
    $editable=[IO.Compression.ZipFile]::Open($archive,[IO.Compression.ZipArchiveMode]::Update)
    try {
        $entryName=$editable.Entries[0].FullName
        $nativeSeparator=if($entryName.Contains('\')){'BACKSLASH'}else{'SLASH'}
        $alias=if($entryName.Contains('\')){$entryName.Replace('\','/')}else{$entryName.Replace('/','\')}
        [void]$editable.CreateEntry($alias)
    } finally {$editable.Dispose()}
    $PackageSha256=(Get-FileHash -LiteralPath $PackageFile).Hash.ToLowerInvariant()
    $failure=$null;try{& $readArchive | Out-Null}catch{$failure=$_.Exception.Message}
    if($failure -cne 'PACKAGE_MANIFEST_INVALID'){throw 'AMBIGUOUS_MANIFEST_ACCEPTED'};$passed++
    $PackageFile=Join-Path $fixture 'oversized.zip'
    $editable=[IO.Compression.ZipFile]::Open($PackageFile,[IO.Compression.ZipArchiveMode]::Create)
    try {
        $entry=$editable.CreateEntry('mcp_control_center/config/installed-release.json')
        $writer=$entry.Open()
        try {$oversized=New-Object byte[] 16385;$writer.Write($oversized,0,$oversized.Length)}finally{$writer.Dispose()}
    } finally {$editable.Dispose()}
    $PackageSha256=(Get-FileHash -LiteralPath $PackageFile).Hash.ToLowerInvariant()
    $failure=$null;try{& $readArchive | Out-Null}catch{$failure=$_.Exception.Message}
    if($failure -cne 'PACKAGE_MANIFEST_INVALID'){throw 'OVERSIZED_MANIFEST_ACCEPTED'};$passed++
    $verifiedArchive=$null
    if($VerifiedPackageFile){
        if($ExpectedSha256 -cnotmatch '^[0-9a-f]{64}$' -or $ExpectedReleaseId -cnotmatch '^[a-z0-9][a-z0-9._-]{0,63}$'){throw 'EXPLICIT_ARCHIVE_IDENTITY_REQUIRED'}
        $PackageFile=$VerifiedPackageFile;$PackageSha256=$ExpectedSha256
        $manifest=& $readArchive
        if($manifest.releaseId -cne $ExpectedReleaseId){throw 'VERIFIED_ARCHIVE_RELEASE_MISMATCH'}
        $verifiedArchive=$manifest.releaseId;$passed++
    }
    [pscustomobject]@{ok=$true;checks=$passed;archiveReader='ACTUAL_INSTALL_PREFIX';
        prepareArchiveSeparator=$nativeSeparator;verifiedArchive=$verifiedArchive;
        archiveExtraction=$false;productionTouched=$false}|ConvertTo-Json
} finally {
    $resolved=[IO.Path]::GetFullPath($fixture)
    if((Split-Path -Parent $resolved) -ine $base -or (Split-Path -Leaf $resolved) -cnotmatch '^archive-reader-[0-9a-f]{32}$'){throw 'UNSAFE_FIXTURE_CLEANUP'}
    if(Test-Path -LiteralPath $resolved){Remove-Item -LiteralPath $resolved -Recurse -Force}
}
