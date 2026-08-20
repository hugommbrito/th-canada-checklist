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

Cada item aceita até 8 fotos, e a primeira da lista é a capa: é ela que aparece na
tabela, com um contador quando há mais de uma. O ★ de uma foto a promove a capa — não
tem arrastar, que no celular competiria com o scroll da página. Clicar na miniatura abre
a galeria, que navega com as setas do teclado, com `‹ ›` e fecha no `Esc`. Item gravado
quando a foto era uma só continua sendo lido: o campo antigo entra como capa.

As fotos são enviadas do arquivo ou da câmera, uma requisição por foto e em fila (três
uploads simultâneos no 4G da casa deixam os três lentos), e reduzidas no próprio
navegador antes de subir (1280px, JPEG) — uma foto de celular sai de vários MB para uns
200 KB. O reencode ainda descarta o EXIF inteiro, inclusive a geolocalização de dentro
de casa, e normaliza HEIC de iPhone. Enquanto uma foto sobe, a miniatura já aparece
apagada e o botão Salvar fica desabilitado: salvar no meio do upload gravaria o item sem
ela.

Os arquivos ficam em `/uploads`, **ao lado do banco** — dentro do volume do Railway, e
não em `public/`, que é reconstruído a cada deploy. Excluir o item ou remover uma foto
apaga o arquivo, mas só depois de a mudança ter sido efetivamente gravada: se a gravação
falhar, o registro no banco continua apontando para aquela foto, então ela precisa
continuar existindo. Cancelar a edição também apaga o que subiu durante ela.

### Descrição pública é um campo separado

O item tem dois campos de texto livre, e a diferença entre eles é a fronteira de tudo o
que esta parte do projeto faz:

- **Observações (internas)** 🔒 — "não passa pela porta da cozinha", "aceito 850 se pagar
  hoje". Nunca sai do painel: não vai para lista compartilhada nem para o texto do anúncio.
- **Descrição pública** 👁 — "sofá retrátil 2,10m, tecido suede, sem rasgo". É o que aparece
  nas listas e no anúncio.

Até esta etapa o texto do anúncio publicava as *observações*, o que é o mesmo tipo de
vazamento que o preço mínimo teve o cuidado de evitar. Ele passou a usar só a descrição
pública, e o modal do anúncio avisa quando o item tem observação interna e nenhuma
descrição — senão o texto simplesmente encolheria sem explicação. O botão `↓` copia uma
coisa para a outra, por item e revisável antes de salvar; nada é migrado automaticamente,
porque migrar em silêncio seria justamente publicar o que é interno.

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

## Listas de venda (a vitrine pública)

Uma lista de venda é um **link próprio, por audiência**: a família vê um conjunto de itens
antes de os amigos verem outro. Quem abre marca o que quer e cai no WhatsApp com a mensagem
já escrita — nada é gravado do outro lado, sem formulário, sem cadastro, sem guardar dado de
ninguém.

No painel, `🔗 Listas` na barra do inventário. Cada lista tem nome (só vocês veem), um
número de WhatsApp próprio, um recado no topo da página, validade opcional, liga/desliga e
contador de visitas. O conteúdo é **filtro + exclusões**: o filtro que estava na tela quando
a lista foi criada define a base, e itens pontuais saem à mão — item novo que casar com o
filtro entra sozinho, o que a tela avisa em uma linha. Editar as exclusões acontece na
própria tabela do inventário: a última coluna vira checkbox, com busca, foto e preço no
lugar de sempre.

Item **vendido sai da lista sozinho** e a foto dele deixa de ser servida. Item **reservado**
continua visível, marcado, e não é selecionável. Item sem preço aparece como "a combinar" e
o painel avisa quantos são.

### Por que dois serviços

A vitrine é um **segundo serviço**, com domínio próprio, e não uma página deste painel. O
painel mora na raiz de um domínio e mostra piso de negociação, comprador e a thread de
negociação na mesma tela; um link que circula em grupo de WhatsApp não pode estar no mesmo
endereço que isso, porque apagar o caminho da URL é a primeira coisa que alguém curioso faz.

O endereço do painel só existe no ambiente do processo da vitrine: nunca vai para o HTML,
nem para o `<img src>` (as fotos passam por um proxy dela), nem para uma mensagem de erro. Há
uma guarda que varre o HTML antes de responder e recusa a resposta se o host do painel
aparecer nela.

### O contrato entre os dois

`GET /api/vitrine/:slug` no painel, com `X-Vitrine-Token` (só header — query string entra em
log de proxy). A resposta é uma **allowlist escrita à mão** (`vitrineItemView` em
`server.js`), irmã da `itemView` do snapshot e deliberadamente não derivada dela: com um
`delete` sobre a outra, o campo que o item ganhar em 2027 vazaria por default. Sai `{ id,
nome, estado, descricao, preco:{cents,brl}, reservado, fotos }` — e `fotos` são só nomes de
arquivo, para a vitrine ser obrigada a montar a URL do proxy dela.

Não existe `VITRINE_TOKEN` opcional: sem a variável a rota responde **503**. Ao contrário do
snapshot, esta é consumida por um serviço exposto à internet, e "aberta por esquecimento" não
pode ser um estado possível. Estados: 404 slug inexistente, 410 desligada ou vencida, 200 com
lista vazia quando tudo já saiu. A página pública mostra **os mesmos bytes** para inexistente,
desligada e vencida — distinguir criaria um oráculo de quais links existem, e "peça um link
novo" serve para os três.

Duas chaves novas no `kv_store`, e cada uma com um dono de escrita só — é o que dispensa
fundir contador com edição:

| Chave | Escreve | Lê |
|---|---|---|
| `toronto-tracker-shares` | só o navegador | painel e rota da vitrine |
| `toronto-tracker-share-hits` | só o servidor | painel |

### Visitas

Contadas por página aberta, não por busca de dados: a vitrine tem cache, então uma visita não
é uma requisição ao painel. Recarregar não conta duas vezes (dedup de 30 min por hash
truncado com sal sorteado a cada processo — serve para não contar em dobro, não para
identificar ninguém), e user-agent de robô não conta. **O preview de link do WhatsApp abre a
página sozinho** quando alguém cola o link; ele está na lista de robôs justamente por isso.

### Rodando as duas localmente

```bash
# terminal 1 — painel
VITRINE_TOKEN=segredo-local npm start                    # :3000

# terminal 2 — vitrine
PORT=4000 VITRINE_PAINEL_URL=http://localhost:3000 \
VITRINE_TOKEN=segredo-local VITRINE_PUBLIC_URL=http://localhost:4000 \
npm run vitrine                                          # :4000
```

Variáveis da vitrine: `VITRINE_PAINEL_URL` e `VITRINE_TOKEN` (obrigatórias),
`VITRINE_PUBLIC_URL` (o endereço dela mesma, para a mensagem do WhatsApp dizer de qual lista
a pessoa veio), `VITRINE_CACHE_TTL_MS` (45s), `VITRINE_STALE_MAX_MS` (6h — por quanto tempo
servir a lista de antes se o painel cair), `VITRINE_UPSTREAM_TIMEOUT_MS`, `VITRINE_TZ`,
`VITRINE_DESLIGADA=1` (interruptor geral para depois da mudança, sem tocar no painel).

O endereço da vitrine também precisa ser colado no campo "Endereço da vitrine" do modal de
listas — é ele que monta o link que você copia.

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

### O segundo serviço (vitrine)

5. Criar um **segundo serviço** no mesmo projeto, a partir do mesmo repositório, **sem
   volume**.
6. Definir o **start command** dele como `npm run vitrine` **antes de anexar domínio**. Sem
   isso o Railway roda `npm start` e sobe um segundo painel, vazio e com banco efêmero, num
   endereço público — falha silenciosa e feia. Conferir com `GET /healthz`, que responde
   `{"servico":"vitrine"}`.
7. Variáveis: `VITRINE_TOKEN` (o mesmo valor nos dois serviços), `VITRINE_PAINEL_URL` e
   `VITRINE_PUBLIC_URL`. Para `VITRINE_PAINEL_URL`, preferir a rede privada
   (`http://<servico-do-painel>.railway.internal:3000`): assim a URL pública do painel não
   existe nem como variável de ambiente do serviço público.

O `/healthz` da vitrine separa as duas saúdes de propósito: `ok` é sobre ela mesma, e o
estado do painel vai num campo próprio — painel fora do ar não pode fazer o Railway
reiniciar quem está de pé.

## O que ficou de fora deste corte

Conforme o handoff original, esta etapa só migrou o storage (Claude.ai artifact → SQLite
+ Express) e adicionou o gate leve de identidade. Ficam para depois, se fizer sentido:

- Refactor de categoria por `id` estável (hoje ainda é por nome, como no protótipo)
- Filtro por "atrasadas" / "prazo esta semana"
- Edição de comentário já enviado (hoje só dá para excluir e escrever outro)
- Aviso de comentário novo do outro lado (não há push nem polling — o inventário
  recarrega ao voltar para a aba, as demandas só ao recarregar a página)
- Qualquer autenticação real, caso o link privado deixe de ser suficiente. As listas de
  venda tornaram isto mais urgente: `GET/PUT /api/kv/:key` continua sem token, então quem
  descobrir o domínio **do painel** lê (e escreve) tudo, inclusive o piso de negociação e os
  números de WhatsApp das listas. A vitrine não piora isso — o domínio do painel não circula
  —, mas passa a existir mais um lugar onde ele está escrito (o ambiente do segundo serviço)
