$dir = 'C:\Program Files\OpenTelemetry Collector'
New-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Services\otelcol-contrib' `
  -Name Environment -PropertyType MultiString -Value 'MAPLE_INGEST_KEY=YOUR_INGEST_KEY' -Force

& "$dir\otelcol-contrib.exe" validate --config "$dir\config.yaml"
Restart-Service otelcol-contrib
