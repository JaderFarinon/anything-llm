[CmdletBinding()]
param(
    [ValidateSet('iniciar', 'parar', 'status', 'logs')]
    [string]$Acao = 'iniciar'
)

$ErrorActionPreference = 'Stop'

function Invoke-Docker {
    param([string[]]$DockerArgs)
    & docker @DockerArgs
    if ($LASTEXITCODE -ne 0) {
        throw "Docker falhou (codigo $LASTEXITCODE). Verifique a mensagem acima."
    }
}

try {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        throw 'Instale o Docker Desktop e habilite os containers Linux antes de iniciar.'
    }

    & docker info --format '{{.OSType}}' 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw 'Abra o Docker Desktop, aguarde o mecanismo iniciar e execute este script novamente.'
    }
    $dockerOs = & docker info --format '{{.OSType}}'
    if ($dockerOs -ne 'linux') {
        throw 'Altere o Docker Desktop para containers Linux e tente novamente.'
    }
    Invoke-Docker -DockerArgs @('compose', 'version')

    $dockerDir = Join-Path $PSScriptRoot 'docker'
    $envFile = Join-Path $dockerDir '.env'
    if (-not (Test-Path -LiteralPath $envFile)) {
        if ($Acao -eq 'iniciar') {
            Copy-Item -LiteralPath (Join-Path $dockerDir '.env.example') -Destination $envFile
        } else {
            throw 'O servico ainda nao foi preparado. Execute primeiro sem parametros.'
        }
    }

    $composeArgs = @(
        'compose', '--project-directory', $dockerDir,
        '-f', (Join-Path $dockerDir 'docker-compose.yml'),
        '-f', (Join-Path $dockerDir 'docker-compose.local.yml')
    )

    switch ($Acao) {
        'iniciar' {
            Write-Host 'Iniciando AnythingLLM. A primeira compilacao pode levar varios minutos.'
            Invoke-Docker -DockerArgs ($composeArgs + @('up', '-d', '--build', '--wait', '--wait-timeout', '600'))
            Write-Host 'AnythingLLM iniciado. Acesse http://localhost:3301'
        }
        'parar' {
            Invoke-Docker -DockerArgs ($composeArgs + @('stop'))
            Write-Host 'AnythingLLM parado. Os dados foram preservados.'
        }
        'status' { Invoke-Docker -DockerArgs ($composeArgs + @('ps', '-a')) }
        'logs' { Invoke-Docker -DockerArgs ($composeArgs + @('logs', '--follow', '--tail', '100')) }
    }
} catch {
    Write-Host "Erro: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
