# th-canada-checklist

Painel de mudança compartilhado (Hugo & Taís) — acompanhamento das demandas
pré-mudança para Toronto (imigração, trabalho, financeiro, pessoal, família, saúde).

Migrado do protótipo em artifact HTML do Claude.ai (ver `HANDOFF.md` original) para uma
aplicação própria mínima: mesmo front-end, storage trocado por SQLite via um backend
Express bem pequeno.

## Stack

- **Front-end:** `public/index.html` — single-file HTML/CSS/JS vanilla, reaproveitado
  quase integralmente do protótipo original.
- **Back-end:** `server.js` — Express servindo o front estático + uma API mínima
  (`GET/PUT /api/kv/:key`) que espelha o contrato antigo do `window.storage.get/set`.
- **Persistência:** SQLite (`better-sqlite3`), uma tabela `kv_store` (key/value), sem
  ORM nem schema relacional — troca 1:1 do storage anterior, sem refactor de modelo de
  dados.
- **Identidade:** sem login. No primeiro acesso em cada navegador, um modal pergunta
  "Quem está usando?" (Hugo / Taís / Ambos) e guarda a resposta em `localStorage`. Toda
  edição de tarefa carimba `lastEditedBy` + `lastEditedAt`, exibido no rodapé do card.

## Rodando localmente

```bash
npm install
npm start
```

Abre em `http://localhost:3000`. O banco SQLite é criado em `./data/app.db`
(ignorado pelo git).

## Deploy no Railway

1. Criar um novo projeto no Railway a partir deste repositório.
2. Adicionar um **Volume** ao serviço, montado em `/data`.
3. Definir a variável de ambiente `DATABASE_PATH=/data/app.db` (sem isso o SQLite fica
   no filesystem efêmero do container e os dados somem a cada deploy).
4. Deploy — o Railway detecta o `package.json` e roda `npm install && npm start`
   automaticamente.

O painel fica acessível pela URL pública do serviço. Não há autenticação — o link em si
é o controle de acesso (uso combinado de ser só entre Hugo e Taís, por tempo limitado).

## O que ficou de fora deste corte

Conforme o handoff original, esta etapa só migrou o storage (Claude.ai artifact → SQLite
+ Express) e adicionou o gate leve de identidade. Ficam para depois, se fizer sentido:

- Refactor de categoria por `id` estável (hoje ainda é por nome, como no protótipo)
- Campo de notas/observações por tarefa
- Filtro por "atrasadas" / "prazo esta semana"
- Qualquer autenticação real, caso o link privado deixe de ser suficiente
