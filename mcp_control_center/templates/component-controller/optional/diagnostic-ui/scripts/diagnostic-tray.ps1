Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$displayName = '__DISPLAY_NAME_PS_SINGLE__'
$menu = New-Object Windows.Forms.ContextMenu
$status = New-Object Windows.Forms.MenuItem "Integration status: lifecycle implementation pending"
$status.Enabled = $false
$exit = New-Object Windows.Forms.MenuItem "Exit diagnostic UI only"
$menu.MenuItems.Add($status) | Out-Null
$menu.MenuItems.Add("-") | Out-Null
$menu.MenuItems.Add($exit) | Out-Null
$icon = New-Object Windows.Forms.NotifyIcon
$icon.ContextMenu = $menu
$icon.Icon = [Drawing.SystemIcons]::Information
$icon.Text = "$displayName diagnostics"
$icon.Visible = $true
$exit.add_Click({
    $icon.Visible = $false
    [Windows.Forms.Application]::Exit()
})
try { [Windows.Forms.Application]::Run() }
finally {
    $icon.Visible = $false
    $icon.Dispose()
}
