# th-canada-checklist

Painel de mudança compartilhado (Hugo & Taís) — acompanhamento das demandas
pré-mudança para Toronto (imigração, trabalho, financeiro, pessoal, família, saúde).

Migrado do protótipo em artifact HTML do Claude.ai (ver `HANDOFF.md` original) para uma
aplicação própria mínima: mesmo front-end, storage trocado por SQLite via um backend
Express bem pequeno.

## Stack

- **Front-end:** `public/index.html` — single-file HTML/CSS/JS vanilla, reaproveitado
  quase integralmente do protótipo original.
- **Regras de negócio:** `public/domain.js` — o que dá sentido aos números (o que conta
  como "recebido", por que "a receber" não é `pedido − recebido`, quando um story do
  Instagram saiu do ar) mora num arquivo só, carregado pelo navegador via `<script src>`
  e pelo servidor via `require()`. Sem build step: é o mesmo arquivo nos dois lados,
  justamente para a tela e a API nunca contarem histórias diferentes.
- **Back-end:** `server.js` — Express servindo o front estático + uma API mínima
  (`GET/PUT /api/kv/:key`) que espelha o contrato antigo do `window.storage.get/set`,
  mais `POST/DELETE /api/upload` para as fotos do inventário e `GET /api/snapshot`.
  O upload recebe os bytes crus da imagem no corpo (o cliente já reduziu no canvas), o
  que dispensa multipart e qualquer dependência nova.
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

## Inventário

Segunda aba do painel, para a outra metade da mudança: decidir o destino de cada objeto
da casa e acompanhar quanto a venda já rendeu.

É uma **triagem completa**, não só uma lista de vendas. Todo item tem um **destino** —
*A decidir*, *Vender*, *Levar*, *Doar* ou *Descartar*. `A decidir` é o padrão de
propósito: uma triagem começa indecisa, e sem esse estado não dá para medir o que ainda
falta resolver. Só quem vai à venda ganha o ciclo comercial (preço pedido, piso, status
do anúncio, comprador, preço realizado); para os demais as colunas de dinheiro ficam
vazias, nunca em "R$ 0,00", que sugeriria "de graça".

**Trocar o destino nunca apaga nada.** Marcar um sofá como *Doar* por engano depois de
ter posto R$ 1.200 e voltar para *Vender* recupera tudo — quem decide se o dinheiro
conta é a exibição e a soma, ambas filtrando por destino. Pelo mesmo motivo "resolvido"
é derivado, nunca gravado: vendido para quem vende, um checkbox "já saiu de casa" para
quem doa/leva/descarta.

### Captura rápida

Uma casa inteira são umas 80 coisas. Passar cada uma por um formulário de 15 campos
garante que a aba não seja usada, então o campo no topo da tabela cadastra com um Enter
— nome, o cômodo que fica fixo entre um item e outro, e nada mais. Preço, foto e destino
vêm depois, só nos itens que merecem. Duplicata é permitida: "Cadeira" seis vezes é
resultado legítimo de varrer uma sala.

### Preço mínimo é privado

Cada item à venda guarda o preço pedido e um **piso de negociação** (🔒). O piso nunca
entra no texto do anúncio e não aparece na faixa do topo — que é a parte da tela que vai
num print mandado para alguém. Ele fica só no rodapé da tabela.

O botão 📋 gera o texto do anúncio pronto para colar no Marketplace/OLX, com estado,
valor, observações e o prazo. Fora de HTTPS (por exemplo, abrindo pelo IP na rede local)
o navegador não expõe a API de área de transferência; nesse caso o texto aparece já
selecionado para copiar à mão.

### Vendido não é a mesma coisa que recebido

Venda de mudança é parcelada com frequência ("te dou 500 agora e o resto quando
receber"), então o item guarda duas coisas diferentes: o **preço vendido**, que é o
combinado, e os **recebimentos**, que é o dinheiro que efetivamente caiu. Cada
recebimento tem valor e data, lançados livremente — três parcelas iguais e "500 agora,
1.350 depois" são o mesmo mecanismo.

Item vendido **sem nenhum lançamento conta como pago à vista**. É o caso mais comum (PIX
na hora, ninguém vai lançar nada) e também o que "Vendido" significava antes de existirem
recebimentos, então nada precisou ser migrado.

O sinal de um item apenas reservado também conta como dinheiro em mãos — o que entrou,
entrou. Mas ele não vira "a receber": enquanto a venda não fecha o negócio ainda pode
cair, e o preço do item segue contando como *a vender*.

Junto vem a **forma de pagamento** (PIX, dinheiro, transferência, cartão), que serve para
lembrar por onde o dinheiro vem quando a parcela atrasa.

### Anúncio em stories do Instagram

Story sai do ar 24h depois de postado, e um item "Anunciado" com o story vencido não está
sendo mostrado para ninguém — o status mente sem que nada na tela avise. Por isso, quando
o canal é um story, o item guarda o horário da postagem e a tabela mostra há quanto tempo:
`📸 19h` enquanto está no ar, `📸 venceu` depois disso. O contador de stories vencidos
aparece no rodapé e tem chip próprio para filtrar.

O badge é clicável: repostar acontece no Instagram, e um toque aqui zera o contador. Fica
separado de "Em risco", que é sobre prazo — são dois problemas diferentes.

### Os números

A faixa do topo mostra o quadro **global** — itens resolvidos, a receber, recebido e em
risco. O rodapé da tabela mostra o **filtro atual**: filtrando por `Cômodo = Sala`, ele
diz quanto a sala vale. Sem filtro os dois coincidem.

"A receber" é a soma do que **ainda está à venda**, não `pedido − recebido`: vender acima
do preço pedido faria a conta ingênua dizer que sobrou menos do que realmente sobra. E
`⚠ N sem preço` existe para avisar que o total está subestimado — sem isso ele mentiria
por omissão.

"Recebido" é dinheiro em mãos, nunca o valor combinado. O que foi vendido e ainda não foi
pago aparece como um número próprio no rodapé, e não no topo: somar parcela futura ao
"Recebido" seria contar dinheiro que ainda não existe.

Preços são guardados em centavos inteiros. O campo aceita `1200`, `1.200`, `1200,50` ou
`R$ 1.200,50`, e normaliza ao sair do campo: quem digita `1200` vê `1.200,00` antes de
salvar, que é a confirmação de que foi lido como mil e duzentos.

### Fotos

A foto é enviada do arquivo ou da câmera e reduzida no próprio navegador antes de subir
(1280px, JPEG) — uma foto de celular sai de vários MB para uns 200 KB, o que torna o
upload viável no 4G. O reencode ainda descarta o EXIF inteiro, inclusive a
geolocalização de dentro de casa, e normaliza HEIC de iPhone.

Os arquivos ficam em `/uploads`, **ao lado do banco** — dentro do volume do Railway, e
não em `public/`, que é reconstruído a cada deploy. Excluir o item ou trocar a foto apaga
o arquivo antigo, mas só depois de a mudança ter sido efetivamente gravada: se a gravação
falhar, o registro no banco continua apontando para aquela foto, então ela precisa
continuar existindo.

### Prazos

O prazo de cada item é lido contra a data da mudança que o painel já guarda, em três
níveis: `⚠` o prazo estourou, `⏳` o prazo cai **depois** do voo (não vai dar tempo) e
`·` faltam menos de 30 dias e o item nem prazo tem.

### Edição simultânea

Diferente das demandas, a triagem é os dois andando pela casa com dois celulares ao mesmo
tempo — e o dado perdido agora é dinheiro. Por isso o inventário lê o estado do servidor
antes de gravar e funde item a item, em vez de sobrescrever o bloco inteiro: a aba aberta
de manhã não apaga o que o outro cadastrou à tarde. Edição simultânea do *mesmo* item
continua sendo o último a salvar que vence.

Um id que existe aqui e não existe no servidor tem duas leituras opostas, e a última
leitura conhecida separa as duas: se o id não estava nela, é cadastro local que ainda não
subiu e precisa sobreviver à fusão; se estava, o outro lado excluiu — e ressuscitar
desfaria a exclusão para os dois, porque a gravação seguinte regravaria o item.

Voltar para a aba também recarrega (sem polling): no celular isso acontece a cada
desbloqueio, que é o ritmo da triagem. O que estava em digitação nos últimos instantes é
gravado antes da recarga, não depende de sorte.

## Snapshot para automação

`GET /api/snapshot` devolve todo o estado do painel em JSON, formatado para ser
consumido por um agente: ordenado por `id` (estável entre chamadas, então dá para
diferenciar duas coletas), datado, com `hoje` calculado em `America/Sao_Paulo`
(`SNAPSHOT_TZ`), e com os números **já calculados** — quem consome não deveria ter que
reimplementar o que "recebido" significa.

Dinheiro vem sempre como `{ "cents": 120000, "brl": "R$ 1.200,00" }`: o inteiro para
comparar, a string para escrever, e nenhuma divisão por 100 na mão. Os alertas já vêm
como listas de id (`semPreco`, `prazoEstourado`, `prazoDepoisDaMudanca`, `storyVencido`,
`vendasParceladas`).

`?since=<ISO>` acrescenta os ids editados depois daquele instante. É conveniência, não
verdade: baseia-se em `lastEditedAt`, então não enxerga exclusão. Para saber o que mudou
de fato, compare dois snapshots por `id`.

Se `SNAPSHOT_TOKEN` estiver definido, a rota passa a exigir `?token=` ou o header
`X-Snapshot-Token`. Sem a variável ela fica tão aberta quanto o resto do painel —
vale definir antes de entregar a URL a um agendador.

O uso pensado está em `HANDOFF-COWORK.md`: um schedule diário às 12h que compara com a
coleta anterior, resume o que foi feito, mostra o panorama e sugere o que fazer até o dia
seguinte.

## Ordem manual e drag and drop

Vale para a aba de demandas. A tabela do inventário usa ordenação por coluna: numa lista
de 80 objetos a pergunta é sempre "o que vale mais" ou "o que vence antes", e não em que
posição a linha 57 deveria estar.

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

Na toolbar há um botão que expande ou recolhe todos os checklists de uma vez. Ele
age sobre as **tarefas visíveis**: com um filtro de categoria ou de responsável
ativo, fala só sobre o que está na tela, e desabilita quando nenhuma demanda
visível tem checklist. O rótulo alterna conforme o estado atual. Esse estado é de
visualização, mora só em memória — não vai para o banco e volta recolhido a cada
recarga.

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
   no filesystem efêmero do container e os dados somem a cada deploy). O mesmo volume
   guarda as fotos do inventário, em `/data/uploads` — o diretório é derivado do
   `DATABASE_PATH`, então não há nada a configurar além dele.
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
- Aviso de comentário novo do outro lado (não há push nem polling — o inventário
  recarrega ao voltar para a aba, as demandas só ao recarregar a página)
- Qualquer autenticação real, caso o link privado deixe de ser suficiente
