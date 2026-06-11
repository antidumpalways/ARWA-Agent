$env:PORT = "4001"
$env:X402_DEMO_SERVER_ENABLED = "true"
$env:X402_CEP18_PACKAGE_HASH = "hash-a786a295384b6f39b6d62a97e12af776642253b37167f2a6c9b9410e8c93c775"
$env:X402_PAYEE_ADDRESS = "6a0459e25d4c5721dd4b0d2af0a5750d92f97766e2e2fcb5877401753800630e"
$env:CASPER_NETWORK = "casper-test"
$env:CSPR_CLOUD_API_KEY = "019ea14d-a7a5-744c-91b2-afaf3fafa600"
$env:X402_FACILITATOR_URL = "https://x402-facilitator.cspr.cloud"
Set-Location "C:\Users\Acer\Downloads\Casper hackathon\parkflow-agent\agent"
Start-Process node -ArgumentList "dist\scripts\x402Server.js" -RedirectStandardOutput "x402-server.log" -RedirectStandardError "x402-server.err" -NoNewWindow
Start-Sleep 2
Get-Content "x402-server.log" -Tail 6
