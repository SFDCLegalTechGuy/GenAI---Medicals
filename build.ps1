function Show-Help {
    Write-Host "Available commands:"
    Write-Host "  .\build.ps1 build      - Compile TypeScript to JavaScript"
    Write-Host "  .\build.ps1 watch      - Watch for changes and compile"
    Write-Host "  .\build.ps1 test       - Run unit tests"
    Write-Host "  .\build.ps1 deploy     - Deploy the stack to your default AWS account/region"
    Write-Host "  .\build.ps1 diff       - Compare deployed stack with current state"
    Write-Host "  .\build.ps1 synth      - Emit the synthesized CloudFormation template"
    Write-Host "  .\build.ps1 bootstrap  - Bootstrap CDK resources in your AWS account"
    Write-Host "  .\build.ps1 clean      - Remove build artifacts"
    Write-Host "  .\build.ps1 help       - Display this help message"
}

function Build { poetry run npm run build }
function Watch { poetry run npm run watch }
function Test { poetry run npm run test }
function Deploy { poetry run cdk deploy }
function Diff { poetry run cdk diff }
function Synth { poetry run cdk synth }
function Bootstrap { poetry run cdk bootstrap }
function Clean { Remove-Item -Recurse -Force -ErrorAction SilentlyContinue cdk.out }

# Get the command-line argument
$command = $args[0]

# Execute the appropriate function based on the command
switch ($command) {
    "build" { Build }
    "watch" { Watch }
    "test" { Test }
    "deploy" { Deploy }
    "diff" { Diff }
    "synth" { Synth }
    "bootstrap" { Bootstrap }
    "clean" { Clean }
    "help" { Show-Help }
    default { Show-Help }
}
