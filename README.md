# Painel de Expedicao

Primeira versao do painel de expedicao com recebimento de webhook.

> O KDS esta temporariamente desativado. O sistema opera somente com o Painel de Expedicao.

## O que esta versao faz

- Lista pedidos por ordem de chegada, com os mais antigos no topo.
- Mostra numero do pedido, nome do cliente, bairro e tempo na loja.
- Tem abas `Todos`, `Atrasados` e `Tempo`.
- Permite mudar o tempo limite de saida da loja.
- Recebe pedidos por webhook em `/api/webhook/cardapio-web`.
- Remove pedidos da tela quando o webhook indicar despacho, entrega, conclusao ou cancelamento.
- Permite selecionar entregas e motoboy para despachar dentro do proprio painel.
- Registra em Eventos os sucessos e todas as falhas ocorridas no despacho.
- Usa os endpoints oficiais da API Partner para preparar e despachar pedidos.
- Aceita OAuth Bearer por `CARDAPIO_ACCESS_TOKEN`, com compatibilidade temporaria por `CARDAPIO_API_KEY`.

## Cardapio Web

As acoes de status usam a API Partner de producao:

```text
POST /api/partner/v1/orders/{order_id}/prepared
POST /api/partner/v1/orders/{order_id}/dispatch
```

Para a futura operacao com multiplas lojas, cada instalacao devera armazenar seu proprio `access_token` e `refresh_token` obtidos via OAuth 2.0 com PKCE. Tokens e credenciais nunca devem ser gravados no repositorio.

## Como abrir localmente

Execute:

```bash
npm start
```

Depois abra:

```text
http://localhost:3000
```

## Webhook local

```text
http://localhost:3000/api/webhook/cardapio-web
```

Essa URL local ainda nao funciona dentro do Cardapio Web. Para cadastrar no Cardapio Web, sera necessario publicar o painel ou criar uma URL publica temporaria apontando para este servidor.
