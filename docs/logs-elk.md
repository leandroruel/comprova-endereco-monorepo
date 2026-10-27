# Logs centralizados (Elasticsearch + Kibana)

Stack opcional para consultar os logs do Comprova no Kibana. Usa apenas
componentes gratuitos do Elastic Stack, com versões fixas:

| Componente    | Imagem                                                 |
| ------------- | ------------------------------------------------------ |
| Elasticsearch | `docker.elastic.co/elasticsearch/elasticsearch:8.17.0` |
| Kibana        | `docker.elastic.co/kibana/kibana:8.17.0`               |
| Filebeat      | `docker.elastic.co/beats/filebeat:8.17.0`              |

O Elasticsearch roda em modo single-node, com segurança habilitada e a licença
`basic` auto-gerada. Os índices ficam no volume `esdata`; o registro do Filebeat
fica em `filebeatdata`.

## O que é coletado

- **Containers do Compose** com o label `comprova_logs=true`: `postgres`,
  `redis`, `temporal` e `objectstorage`. O Filebeat lê o `stdout`/`stderr`
  desses containers e adiciona `container.name`, `container.image.name` e
  `service.name` (derivado do label do Compose).
- **API e worker rodando no host**: opcionalmente, os arquivos
  `logs/api.log` e `logs/worker.log` (veja a seção
  [Logs da API e do worker](#logs-da-api-e-do-worker-host)).
- Elasticsearch, Kibana e o próprio Filebeat **não** têm o label, então não são
  coletados.

Novos serviços Docker só entram na coleta se receberem
`labels: { comprova_logs: 'true' }` no Compose.

## Configuração

Adicione ao `.env` (que é ignorado pelo Git) os três segredos e, se quiser,
ajuste os limites:

```bash
echo "ELASTIC_PASSWORD=$(openssl rand -hex 24)"
echo "KIBANA_PASSWORD=$(openssl rand -hex 24)"
echo "KIBANA_ENCRYPTION_KEY=$(openssl rand -hex 32)"
```

```dotenv
ELASTIC_PASSWORD=<valor gerado>
KIBANA_PASSWORD=<valor gerado>
KIBANA_ENCRYPTION_KEY=<valor gerado>
KIBANA_BIND_ADDRESS=127.0.0.1
KIBANA_PORT=5601
ELASTICSEARCH_HEAP=512m
ELASTICSEARCH_MEM_LIMIT=1536m
KIBANA_MEM_LIMIT=1g
FILEBEAT_MEM_LIMIT=256m
```

`KIBANA_PASSWORD` é a senha do usuário built-in `kibana_system`. O Kibana 8.17
recusa o superusuário `elastic`; um serviço one-shot (`kibana-setup`) define
essa senha no Elasticsearch antes do Kibana iniciar. O login na interface
continua sendo `elastic` + `ELASTIC_PASSWORD`.

O `.env.example` tem a lista completa. O `docker-compose.yml` base não usa
essas variáveis; só o `docker-compose.elk.yml` exige os três segredos.

## Subir

Na primeira vez (ou depois de mudar os labels), recrie os serviços existentes
para que o Filebeat consiga vê-los. Os volumes são preservados, mas os
containers são recriados (breve indisponibilidade):

```bash
pnpm compose:up
```

Se o ELK já estiver no ar, esse comando pode avisar que os containers do ELK
são "orphans", porque o arquivo base não os conhece. É esperado; **não** use
`--remove-orphans`, pois isso removeria o Elastic Stack.

Depois suba o Elastic Stack:

```bash
pnpm compose:logs:up
```

O comando equivale a:

```bash
docker compose -f docker-compose.yml -f docker-compose.elk.yml \
  --profile elk up -d elasticsearch kibana-setup kibana filebeat
```

O perfil `elk` mantém o `pnpm compose:up` padrão inalterado. O Elasticsearch não
publica a porta 9200 no host; o Kibana fica em `127.0.0.1:5601` por padrão.

## Verificar

```bash
# status dos containers e healthchecks
docker compose -f docker-compose.yml -f docker-compose.elk.yml \
  --profile elk ps -a

# logs do Filebeat (erros de configuração/coleta)
docker compose -f docker-compose.yml -f docker-compose.elk.yml \
  --profile elk logs --tail=100 filebeat

# saúde do Elasticsearch (usa a senha de dentro do container)
docker compose -f docker-compose.yml -f docker-compose.elk.yml \
  --profile elk exec elasticsearch sh -c \
  'curl -s -u "elastic:$ELASTIC_PASSWORD" "http://localhost:9200/_cluster/health?pretty"'

# índices criados pelo Filebeat
docker compose -f docker-compose.yml -f docker-compose.elk.yml \
  --profile elk exec elasticsearch sh -c \
  'curl -s -u "elastic:$ELASTIC_PASSWORD" "http://localhost:9200/_cat/indices/comprova-logs-*?v"'

# um documento de amostra
docker compose -f docker-compose.yml -f docker-compose.elk.yml \
  --profile elk exec elasticsearch sh -c \
  'curl -s -u "elastic:$ELASTIC_PASSWORD" "http://localhost:9200/comprova-logs-*/_search?size=1&pretty"'

# status do Kibana
curl -fsS http://127.0.0.1:5601/api/status | head
```

O `kibana-setup` aparece como `Exited (0)`; é um serviço one-shot que já
cumpriu sua função. Os índices têm o formato `comprova-logs-AAAA.MM.DD`.

## Abrir o Kibana e pesquisar

1. Abra <http://127.0.0.1:5601>.
2. Entre com o usuário `elastic` e a senha de `ELASTIC_PASSWORD`.
3. Em **Stack Management → Data Views**, crie um data view:
   - **Name**: `Comprova logs`
   - **Index pattern**: `comprova-logs-*`
   - **Time field**: `@timestamp`
4. Abra **Discover** e selecione o data view. Ajuste o intervalo de tempo
   (por exemplo, **Last 24 hours**) para incluir os logs que você quer ver.

Também é possível criar o data view pela API do Kibana:

```bash
ELASTIC_PASSWORD="$(grep '^ELASTIC_PASSWORD=' .env | cut -d= -f2-)"
curl -fsS -u "elastic:$ELASTIC_PASSWORD" \
  -X POST http://127.0.0.1:5601/api/data_views/data_view \
  -H 'kbn-xsrf: true' -H 'Content-Type: application/json' \
  -d '{"data_view":{"title":"comprova-logs-*","name":"Comprova logs","timeFieldName":"@timestamp","allowNoIndex":true}}'
```

Exemplos de KQL no Discover:

| Objetivo                               | KQL                                         |
| -------------------------------------- | ------------------------------------------- |
| Logs de um container                   | `service.name: postgres`                    |
| Erros da API (pino: 40=warn, 50=error) | `service.name: api and level >= 40`         |
| Erros do worker                        | `service.name: worker and message: *ERROR*` |
| Logs do Temporal                       | `container.name: *temporal*`                |
| Procurar uma validação/termo           | `message: *<termo>*`                        |

A API emite JSON (campos `level`, `time`, `msg`, `service` etc.); o worker emite
texto formatado. Logs de containers trazem `container.name` e `service.name`.

Para linhas JSON da API, o Filebeat decodifica o objeto em `api.*` (para não
colidir com `host`/`service` do próprio evento), copia `api.msg` para
`message`, `api.level` para `level` e `api.time` para `time`, e usa `time` como
`@timestamp`. A linha bruta fica em `event.original`. Assim, `message` e
`level` funcionam como nos exemplos acima; campos específicos da API (por
exemplo `api.port`, `api.signal`, `api.worker_loops`) ficam em `api.*`. Linhas
não-JSON (como a saída do `pnpm`) mantêm o texto original em `message`.

Para logs do host, `host.name` é o hostname do container do Filebeat, não o
host da API/worker; use `service.name` e `log.file.path` para identificar a
origem. O endereço de bind da API fica em `api.host`.

## Logs da API e do worker (host)

A API e o worker rodam via `pnpm dev` no host, não em containers. O Filebeat não
consegue ler o `stdout` de processos do host diretamente. Para indexá-los,
redirecione a saída para os arquivos que o Filebeat monta em `./logs`:

```bash
mkdir -p logs

# terminal 1
pnpm --filter @comprova/api dev 2>&1 | tee -a logs/api.log

# terminal 2
LOG_COLOR=false pnpm --filter @comprova/worker dev 2>&1 | tee -a logs/worker.log
```

O `LOG_COLOR=false` evita códigos ANSI no log do worker. O input da API faz
`decode_json_fields` para `api.*` e normaliza `message`/`level`/`time`; o do
worker mantém o texto como `message`.

O `pnpm dev` normal continua funcionando, mas os logs da API/worker ficam
apenas no terminal e **não** aparecem no Kibana. Use os comandos acima quando
precisar investigar uma execução no Kibana.

## Parar, reiniciar e remover

```bash
# para apenas o Elastic Stack, preservando os containers e volumes
pnpm compose:logs:down

# reinicia apenas o Elastic Stack
docker compose -f docker-compose.yml -f docker-compose.elk.yml \
  --profile elk restart elasticsearch kibana filebeat

# sobe novamente
pnpm compose:logs:up

# remove os containers do Elastic Stack (volumes preservados)
docker compose -f docker-compose.yml -f docker-compose.elk.yml \
  --profile elk rm -sf elasticsearch kibana-setup kibana filebeat
```

Evite `docker compose ... down` sem nomes de serviço: ele remove também os
containers da infraestrutura existente (os volumes continuam).

## Persistência e retenção

- `esdata`: índices do Elasticsearch. Remover o volume apaga os logs e também
  as senhas/usuários criados nele. Depois de remover, rode
  `pnpm compose:logs:up` novamente para o `kibana-setup` recriar a senha do
  `kibana_system`.
- `ELASTIC_PASSWORD` só é aplicada na primeira inicialização do volume
  `esdata`. Se você trocá-la depois, atualize a senha do usuário `elastic` pela
  API ou remova `esdata` (perdendo os logs); caso contrário, o healthcheck e o
  Filebeat continuam usando a senha antiga e falham.
- `KIBANA_ENCRYPTION_KEY` deve permanecer a mesma depois que o Kibana grava
  saved objects; trocá-la pode impedir a leitura de objetos criptografados.
- `filebeatdata`: registro de leitura do Filebeat. Remover faz o Filebeat
  reler os arquivos disponíveis.
- Não há ILM/retenção automática. Os índices são diários e crescem até serem
  removidos manualmente. Para remover os índices existentes, informe cada nome
  explicitamente (o Elasticsearch recusa wildcard em `DELETE` por padrão):

  ```bash
  docker compose -f docker-compose.yml -f docker-compose.elk.yml \
    --profile elk exec elasticsearch sh -c '
      curl -s -u "elastic:$ELASTIC_PASSWORD" \
        "http://localhost:9200/_cat/indices/comprova-logs-*?h=index" |
      while read -r idx; do
        curl -s -u "elastic:$ELASTIC_PASSWORD" -X DELETE "http://localhost:9200/$idx"
      done
    '
  ```

  Também é possível remover pelo Kibana em **Stack Management → Index
  Management**.

## Memória

Padrões pensados para o ambiente local:

| Serviço       | Heap / processo            | Limite do container |
| ------------- | -------------------------- | ------------------- |
| Elasticsearch | `-Xms512m -Xmx512m`        | 1.5 GiB             |
| Kibana        | `--max-old-space-size=512` | 1 GiB               |
| Filebeat      | —                          | 256 MiB             |

Ajuste no `.env`:

```dotenv
ELASTICSEARCH_HEAP=1g
ELASTICSEARCH_MEM_LIMIT=2g
KIBANA_MEM_LIMIT=1g
FILEBEAT_MEM_LIMIT=256m
```

Mantenha o heap do Elasticsearch em no máximo ~50% do limite do container.
Depois de mudar, recrie os serviços com `pnpm compose:logs:down` e
`pnpm compose:logs:up`. Use `docker stats` para acompanhar o consumo.

O compose usa `node.store.allow_mmap=false` para não exigir
`vm.max_map_count=262144` no host de desenvolvimento. Em produção, habilite mmap
e ajuste o sysctl.

## Segurança

- O Elasticsearch tem segurança habilitada (`xpack.security.enabled=true`) e
  exige usuário/senha. A porta 9200 **não** é publicada no host.
- TLS HTTP/transporte está desligado apenas porque o tráfego fica na rede
  privada do Compose. Se a porta do Elasticsearch for exposta ou o ambiente
  deixar de ser local, habilite TLS e use um proxy reverso.
- O Kibana escuta em `127.0.0.1` por padrão. Para acesso remoto, defina
  `KIBANA_BIND_ADDRESS=0.0.0.0` conscientemente e coloque firewall/TLS na
  frente.
- O Kibana usa o usuário built-in `kibana_system`, cuja senha é definida pelo
  serviço one-shot `kibana-setup`. O Filebeat usa `elastic` nesta configuração
  local. Para um ambiente compartilhado, crie usuários/roles dedicados com o
  menor privilégio.
- `ELASTIC_PASSWORD`, `KIBANA_PASSWORD` e `KIBANA_ENCRYPTION_KEY` ficam no
  `.env` ignorado. O `.env.example` não contém segredos.
- O Filebeat monta o socket do Docker em modo somente leitura para ler os logs
  dos containers. Acesso ao socket é privilegiado; o Filebeat não publica
  portas.

## Limitações conhecidas

- A API e o worker não são containerizados. Sem o redirecionamento para
  `logs/api.log`/`logs/worker.log`, os logs deles não são indexados.
- Nem toda linha de log tem um identificador de execução de validação. A
  correlação depende dos campos/ids já emitidos pela aplicação; nenhum evento é
  inventado ou simulado para preencher essa lacuna.
- Logs do worker são texto; a API é JSON. A busca textual funciona, mas nem
  todos os campos do worker são estruturados.
- A coleta de containers depende de `/var/lib/docker/containers` e do socket
  do Docker. Em Docker Desktop (macOS/Windows) esse caminho pode não existir;
  nesse caso use os inputs de arquivo do host ou outro driver de log.
- Na primeira execução (ou depois de remover `filebeatdata`), o Filebeat varre
  os arquivos de log já existentes do Docker e descarta os de containers sem o
  label; isso pode gerar uso temporário de CPU.
- Em um cluster single-node o status fica `yellow`: os índices têm uma réplica
  que não pode ser alocada. Isso é esperado e não impede buscas. Para `green`,
  use um template com `index.number_of_replicas: 0`.
- Não há dashboards, alertas ou retenção automática. A investigação é feita no
  Discover com os data views/KQL acima.
