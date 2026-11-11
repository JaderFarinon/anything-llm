# AnythingLLM no Windows

Abra o Docker Desktop com containers Linux e execute `iniciar-anythingllm.cmd`
com dois cliques. A primeira execucao compila o projeto e precisa de internet;
Pode levar varios minutos. Depois de concluir, acesse http://localhost:3301
e configure seu provedor de IA na interface.

No PowerShell, na pasta do projeto:

```powershell
.\iniciar-anythingllm.cmd
.\iniciar-anythingllm.cmd status
.\iniciar-anythingllm.cmd logs
.\iniciar-anythingllm.cmd parar
```

O servico permanece em segundo plano quando a janela fecha. Para sair da
visualizacao de logs, pressione Ctrl+C; isso nao para o servico.
O container reinicia junto com o Docker, a menos que voce use `parar`.
Para iniciar junto com o login do Windows, habilite a inicializacao automatica
do Docker Desktop nas configuracoes dele.

O script cria `docker/.env` a partir do exemplo apenas quando ele nao existe.
Os dados permanecem em `server/storage`, `collector/hotdir` e
`collector/outputs`, conforme o Compose original. Cada inicio solicita a
compilacao da copia local, aproveitando o cache do Docker.

A porta 3301 no host encaminha para a porta 3001 do container, pois o Windows
neste ambiente reserva a porta 3001. O servico pode ficar acessivel pela rede
local conforme o firewall.
