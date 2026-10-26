# Local CurrentUser DPAPI reader. No InstalledRelease module, token creation or output.
function Assert-CbDailyBearerFile([string]$Path,[string]$OperatorSid) {
    $canonical='C:\GPT_MCPtool\codex_bridge\.local\runtime\.bridge-http-bearer.dpapi'
    $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
    if($Path -cne $canonical -or $identity.User.Value -cne $OperatorSid -or
        ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {throw 'DAILY_BEARER_SCOPE_REJECTED'}
    $trusted=@($OperatorSid,'S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
    $write=[Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Delete -bor
        [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
    $cursor=$Path;$first=$true
    while($cursor) {
        $item=Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
        if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'DAILY_BEARER_REPARSE_REJECTED'}
        $acl=Get-Acl -LiteralPath $cursor -ErrorAction Stop
        $owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
        if($owner -notin $trusted -or ($first -and $owner -cne $OperatorSid)){throw 'DAILY_BEARER_OWNER_REJECTED'}
        $raw=New-Object Security.AccessControl.RawSecurityDescriptor($acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::All))
        if($null -eq $raw.DiscretionaryAcl){throw 'DAILY_BEARER_ACL_REJECTED'}
        if($first -and ($item.PSIsContainer -or $item.Length -lt 1 -or $item.Length -gt 65536)){throw 'DAILY_BEARER_FILE_REJECTED'}
        foreach($ace in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
            if(-not $first -and ($ace.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly)){continue}
            $mask=if($cursor -eq [IO.Path]::GetPathRoot($cursor)){$write -band (-bnot 6)}else{$write}
            if($ace.AccessControlType -eq 'Allow' -and $ace.IdentityReference.Value -notin $trusted -and ($first -or ($ace.FileSystemRights -band $mask))){throw 'DAILY_BEARER_ACL_REJECTED'}
        }
        $first=$false;$cursor=Split-Path -Parent $cursor
    }
}

function Set-CbDailyContextBearer($Context,$Settings) {
    if($Settings.dataDir -cne 'C:\GPT_MCPtool\codex_bridge\.local\runtime'){throw 'DAILY_BEARER_SCOPE_REJECTED'}
    $path=Join-Path $Settings.dataDir '.bridge-http-bearer.dpapi'
    $stream=$null;$reader=$null;$secure=$null;$bstr=[IntPtr]::Zero;$value=$null
    try {
        Assert-CbDailyBearerFile $path $Settings.operatorSid
        $stream=[IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
        Assert-CbDailyBearerFile $path $Settings.operatorSid
        $reader=New-Object IO.StreamReader($stream,[Text.Encoding]::ASCII)
        $secure=ConvertTo-SecureString ($reader.ReadToEnd()) -ErrorAction Stop
        $bstr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        $value=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
        if($value -cnotmatch '^[A-Za-z0-9_-]{43}$'){throw 'DAILY_BEARER_INVALID'}
        $Context.token=$value
    } catch {throw 'DAILY_BEARER_UNAVAILABLE'}
    finally {
        if($bstr -ne [IntPtr]::Zero){[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)}
        if($secure){$secure.Dispose()};if($reader){$reader.Dispose()}elseif($stream){$stream.Dispose()}
        $value=$null
    }
}

function Assert-CbDailyMcpAuthentication($Context) {
    if([string]::IsNullOrWhiteSpace($Context.token)){throw 'DAILY_BEARER_REQUIRED'}
    $client=$null;$handler=$null;$response=$null
    try {
        Add-Type -AssemblyName System.Net.Http
        $handler=New-Object Net.Http.HttpClientHandler;$handler.UseProxy=$false;$handler.AllowAutoRedirect=$false
        $client=New-Object Net.Http.HttpClient($handler);$client.Timeout=[TimeSpan]::FromSeconds(10)
        $url='http://127.0.0.1:18828/mcp'
        $response=$client.GetAsync($url).GetAwaiter().GetResult()
        if([int]$response.StatusCode -ne 401){throw 'DAILY_ANONYMOUS_MCP_NOT_REJECTED'}
        $response.Dispose();$response=$null
        $client.DefaultRequestHeaders.Authorization=New-Object Net.Http.Headers.AuthenticationHeaderValue('Bearer',$Context.token)
        $client.DefaultRequestHeaders.TryAddWithoutValidation('Accept','application/json, text/event-stream')|Out-Null
        $body='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"daily-acceptance","version":"1"}}}'
        $content=New-Object Net.Http.StringContent($body,[Text.Encoding]::UTF8,'application/json')
        try {$response=$client.PostAsync($url,$content).GetAwaiter().GetResult()}finally{$content.Dispose()}
        if([int]$response.StatusCode -ne 200){throw 'DAILY_AUTHENTICATED_MCP_FAILED'}
        $text=$response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        if($text.Length -gt 65536){throw 'DAILY_MCP_RESPONSE_LIMIT'}
        if($text -match '(?m)^data: (.+)$'){$text=$Matches[1]}
        $reply=$text|ConvertFrom-Json
        if($reply.id -ne 1 -or -not $reply.result.serverInfo.name){throw 'DAILY_MCP_INITIALIZE_FAILED'}
        if($response.Headers.Contains('mcp-session-id')) {
            $session=@($response.Headers.GetValues('mcp-session-id'))[0]
            $client.DefaultRequestHeaders.TryAddWithoutValidation('mcp-session-id',$session)|Out-Null
            $response.Dispose();$response=$null
            $response=$client.DeleteAsync($url).GetAwaiter().GetResult()
            if([int]$response.StatusCode -notin @(200,204)){throw 'DAILY_MCP_SESSION_CLOSE_FAILED'}
        }
    } catch {
        $code=[string]$_.Exception.Message
        if($code -cmatch '^DAILY_[A-Z_]+$'){throw $code};throw 'DAILY_MCP_CHECK_FAILED'
    } finally {if($response){$response.Dispose()};if($client){$client.Dispose()}elseif($handler){$handler.Dispose()}}
}
