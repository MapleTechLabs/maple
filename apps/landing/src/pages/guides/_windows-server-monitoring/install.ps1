$v = '0.164.0'
$msi = "$env:TEMP\otelcol-contrib.msi"
Invoke-WebRequest -OutFile $msi -Uri "https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/v$v/otelcol-contrib_${v}_windows_x64.msi"
Start-Process msiexec.exe -ArgumentList "/i `"$msi`" /qn" -Wait
Get-Service otelcol-contrib
