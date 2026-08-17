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

## Filas laterais

Além do fluxo A fazer → Em andamento → Concluído, há duas filas fora do fluxo:
**🚫 Bloqueado** e **⏳ Aguardando terceiros**, exibidas abaixo do board principal.

Não são etapas — são um desvio. Cada card tem um botão de ícone que o manda para uma
delas, e um botão "↩ Retomar" que o traz de volta. O `status` original fica preservado
no campo (o card parkeado mostra um badge com ele), então retomar devolve a demanda
exatamente para a coluna de onde ela saiu.

Tarefas parkeadas somem das colunas principais mas continuam contando no total de
"Concluídas" e no contador de "Atrasadas" — uma demanda travada com prazo vencido
continua sendo um problema que vale enxergar.

## Comentários por card

Cada card tem um painel de comentários, aberto pelo badge 💬 no card (mostra a
contagem quando há algum). Serve de thread curta entre os dois — "liguei no
consulado, pediram o original" — sem precisar editar a demanda.

Cada comentário guarda autor (vem da identidade do navegador, o mesmo "Quem está
usando?"), data/hora e texto, com quebras de linha preservadas. ⌘/Ctrl + Enter
envia; Enter sozinho quebra linha.

Comentário não enviado fica guardado em memória enquanto a aba estiver aberta,
então qualquer outra ação no painel (que redesenha os cards) não apaga o que
estava sendo escrito. Rascunho não vai para o banco — só o comentário enviado.

## Ordem manual e drag and drop

Cards e itens de checklist são reordenáveis arrastando pela alça ⠿. Cards podem
mudar de coluna e ir para as filas laterais no arraste; itens de checklist podem
ser reordenados tanto no card quanto no modal de edição.

O arraste começa pela alça, não pelo card inteiro, por causa do celular: tornar
o card todo arrastável exigiria `touch-action:none` nele, o que mataria o scroll
da página. Pela alça, os botões e checkboxes do card continuam clicáveis normalmente.

Cada tarefa guarda um campo `order` e as colunas deixaram de ordenar por prazo —
ordem manual e ordenação automática não convivem. Na primeira carga o `order` é
semeado a partir da ordenação por prazo anterior, então nada muda de lugar
sozinho. O aviso de atraso (⚠) continua igual.

## Densidade do board

O board ocupa a largura inteira da janela (não há mais o limite de 1100px) e os
cards dentro de cada coluna fluem em **sub-colunas**, em ordem de leitura, via
`grid-template-columns: repeat(auto-fill, minmax(265px, 1fr))`. Numa tela larga
uma coluna de 800px mostrava 1 card por linha e desperdiçava o resto; agora
empacota quantos couberem. `auto-fill` e não `auto-fit` de propósito: com
`auto-fit`, um card sozinho esticaria até os 800px.

Medido com 18 demandas, contando cards inteiros visíveis sem rolar:

| Tela | Antes | Depois |
|---|---|---|
| MacBook 1512×945 | 6 | 12 |
| Full HD 1920×1080 | 9 | 18 |
| Ultrawide 2560×1440 | 13 | 18 |

Abaixo de ~1700px a coluna ainda é estreita demais para duas sub-colunas, então
o ganho ali vem só da densidade (cabeçalho em uma linha, paddings e fontes
menores no card). O piso de 265px é o ponto em que a linha de ações do card
("← Voltar / Avançar → / Editar / Excluir" mais os ícones de fila) ainda cabe em
uma linha — abaixo disso ela quebra em duas e o card volta a crescer.

Como uma coluna virou grade, o hit-test do drag deixou de ser só por Y: quando
detecta mais de uma sub-coluna, passa a decidir a posição por ordem de leitura
(linha, depois metade esquerda/direita do card).

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
- Filtro por "atrasadas" / "prazo esta semana"
- Edição de comentário já enviado (hoje só dá para excluir e escrever outro)
- Aviso de comentário novo do outro lado (não há push nem polling — só aparece
  ao recarregar a página)
- Qualquer autenticação real, caso o link privado deixe de ser suficiente
