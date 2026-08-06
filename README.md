# Painel Expedicao La Qualite

Primeira versao do painel de expedicao com recebimento de webhook.

## O que esta versao faz

- Lista pedidos por ordem de chegada, com os mais antigos no topo.
- Mostra numero do pedido, nome do cliente, bairro e tempo na loja.
- Tem abas `Todos`, `Atrasados` e `Tempo`.
- Permite mudar o tempo limite de saida da loja.
- Recebe pedidos por webhook em `/api/webhook/cardapio-web`.
- Remove pedidos da tela quando o webhook indicar despacho, entrega, conclusao ou cancelamento.

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
