# Handoff — resumo diário do painel de mudança (Claude Cowork)

Este documento é o pedido a ser entregue ao **Claude Cowork**, para criar um
**schedule diário às 12h** que lê o estado do painel, compara com o dia anterior e
devolve três coisas: o que foi feito, como está agora, e o que fazer até amanhã.

O conteúdo abaixo pode ser colado direto na configuração do schedule.

---

## Contexto

Hugo e Taís estão se mudando do Brasil para Toronto. O painel
(`https://<URL-PÚBLICA-DO-RAILWAY>`) tem duas abas:

- **Demandas** — as tarefas da mudança (imigração, financeiro, saúde, documentação),
  num board *A fazer → Em andamento → Concluído*, mais duas filas fora do fluxo
  (*Bloqueado* e *Aguardando terceiros*).
- **Inventário** — a triagem da casa: cada objeto tem um **destino**
  (*A decidir / Vender / Levar / Doar / Descartar*), e quem vai à venda tem preço,
  anúncio, comprador e recebimentos.

Os dois usam a mesma data prevista da mudança, que é o prazo de tudo.

## A rota

```
GET https://<URL-PÚBLICA-DO-RAILWAY>/api/snapshot
GET .../api/snapshot?since=2026-08-17T15:00:00.000Z     # opcional
```

Devolve JSON com **todo** o estado, ordenado por `id` (estável entre chamadas, para
diff), com `geradoEm`, `hoje` e `fusoHorario` no topo. Sem cache.

**Se `SNAPSHOT_TOKEN` estiver configurado no Railway**, mande o token em
`?token=...` ou no header `X-Snapshot-Token`. Sem token configurado, a rota é
aberta — a URL é o controle de acesso, como no resto do painel.

O parâmetro `since` é uma conveniência: acrescenta `editadoDesde` com os ids
editados após aquele instante. **Não confie só nele** — ele se baseia em
`editadoEm`, então não enxerga exclusões nem itens sem carimbo. Para saber o que
mudou de verdade, compare os dois snapshots por `id`.

### Como os números se chamam

Dinheiro vem sempre como `{ "cents": 120000, "brl": "R$ 1.200,00" }`. Use `brl` ao
escrever e `cents` ao comparar. Nunca divida `cents` por 100 na mão.

| Campo em `inventario.dinheiro` | O que é |
|---|---|
| `pedidoEmAberto` | Soma do preço pedido do que **ainda está à venda**. Não é `pedido − recebido`. |
| `vendido` | Soma do valor combinado nas vendas fechadas. |
| `recebido` | **Dinheiro em mãos.** Inclui sinal de item apenas reservado. |
| `aReceberDeVendas` | Vendido e ainda **não** pago (venda parcelada). |
| `pisoPrivado` | 🔒 **Combinado interno. Nunca escreva este número em nada que possa ser mostrado a um comprador.** É o limite de negociação. |

`inventario.alertas` já vem com as listas de ids: `semPreco`, `prazoEstourado`,
`prazoDepoisDaMudanca` (o prazo cai **depois** do voo — não vai dar tempo),
`semPrazoEMudancaPerto`, `storyVencido`, `vendasParceladas`.

Em cada item, `venda.story` aparece quando o anúncio é um story do Instagram:
`{ postadoEm, horasNoAr, venceu }`. **Story sai do ar 24h depois de postado** — um
item "Anunciado" com `venceu: true` não está sendo mostrado a ninguém.

`resolvido` significa: vendido, se o destino é Vender; marcado como "já saiu de
casa", nos outros destinos. É o que mede o progresso da triagem.

**Cuidado ao diferenciar:** o bloco `venda` é `null` em item que não vai à venda. Se
um item mudou de *Vender* para *Doar*, o certo é dizer "mudou de destino", e não
"status de venda virou nulo" — o segundo é artefato do diff, não algo que aconteceu.
Pelo mesmo motivo, dinheiro em item não-vendável vem como `{ "cents": null,
"brl": "—" }`: `null` é "não informado", que é diferente de zero.

---

## O pedido ao Cowork

> Crie um schedule que rode **todos os dias às 12h (America/Sao_Paulo)**.
>
> Em cada execução:
>
> 1. Busque `GET <URL>/api/snapshot` (com o token, se houver).
> 2. Recupere o snapshot da execução anterior. Guarde o atual para a próxima.
> 3. Compare os dois **por `id`**, em demandas e em itens do inventário.
> 4. Me entregue um relatório com as três seções abaixo.
>
> **1. O que foi feito desde ontem ao meio-dia**
>
> Mudanças concretas, não paráfrase do estado. Cada linha diz o que era e o que
> ficou. Por exemplo: demanda que mudou de coluna, item que mudou de destino ou de
> status de venda, preço alterado, recebimento lançado, foto adicionada,
> comentário novo (cite o texto), item criado ou excluído, prazo alterado, data da
> mudança alterada. Diga também quem editou, que vem em `editadoPor`.
>
> Se nada mudou, diga exatamente isso em uma linha. Não encha o relatório.
>
> **2. Panorama de agora**
>
> - Dias restantes até a mudança.
> - Demandas: quantas em cada coluna, quantas atrasadas, quantas paradas em
>   *Bloqueado* ou *Aguardando terceiros* — e há quanto tempo, se der para saber
>   por `editadoEm`.
> - Triagem: quantos itens resolvidos de quantos, e quantos ainda em *A decidir*.
> - Dinheiro: recebido, a receber de vendas, e pedido em aberto. Deixe claro que
>   "recebido" é dinheiro em mãos.
> - Alertas que não estão vazios, com o nome dos itens (não só os ids).
>
> **3. O que fazer até amanhã às 12h**
>
> De três a cinco ações concretas, na ordem em que eu deveria fazer, cada uma com
> o motivo em uma frase. Priorize por essa ordem:
>
> 1. Prazo já estourado.
> 2. Prazo que cai depois da data da mudança.
> 3. Story vencido em item que segue à venda (o anúncio está fora do ar).
> 4. Item "à venda" sem preço (o total de arrecadação está subestimado).
> 5. Venda parcelada com parcela em aberto há mais de uma semana.
> 6. Item em *A decidir* com a mudança se aproximando.
> 7. Demanda parada em *Aguardando terceiros* que talvez precise de cobrança.
>
> Se o painel estiver em ordem, diga isso e sugira menos coisas. Três boas valem
> mais que cinco preenchendo espaço.
>
> **Regras**
>
> - Não invente nada que não esteja no snapshot. Se um dado está ausente, diga que
>   está ausente — não estime.
> - Nunca inclua o `pisoPrivado` de nenhum item, em nenhuma seção.
> - Português do Brasil, direto. Sem emoji decorativo.
> - Valores em reais no formato do campo `brl`.
> - Se a rota falhar ou vier vazia, diga isso e não produza um relatório fabricado.
> - Se for a primeira execução (sem snapshot anterior), pule a seção 1 e diga que
>   é a primeira coleta.

---

## Notas para quem for configurar

- **O fuso importa.** A rota calcula "hoje" em `America/Sao_Paulo`
  (configurável por `SNAPSHOT_TZ`). Rode o schedule no mesmo fuso, senão "o que
  foi feito ontem" desalinha do que o painel mostra.
- **Onde os números nascem.** As definições vivem em `public/domain.js`, o mesmo
  arquivo que o navegador carrega. A rota não recalcula nada por conta própria —
  é por isso que o resumo não pode divergir do que a tela mostra. Se alguma regra
  mudar, muda nos dois ao mesmo tempo.
- **Recomendação de segurança.** Defina `SNAPSHOT_TOKEN` no Railway antes de dar a
  URL a um agendador. Sem ele a rota fica tão aberta quanto o resto do painel, e
  aí a URL circula em mais um lugar.
- **Volume de dados.** O snapshot traz todos os itens e todos os comentários. Com
  uma casa inteira cadastrada são algumas centenas de KB — cabe num contexto sem
  problema, mas não vale pedir para o agente repetir o JSON inteiro na resposta.
