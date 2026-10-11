// Regras de negócio do painel, compartilhadas entre o navegador e o servidor.
//
// Isto existe por um motivo específico: as definições que dão sentido aos
// números — o que conta como "recebido", por que "a receber" não é
// pedido − recebido, quando um story do Instagram saiu do ar — precisam ser as
// mesmas na tela e na rota /api/snapshot. Duas implementações divergiriam, e o
// resumo diário passaria a contar uma história diferente da que o painel mostra.
//
// Só entra aqui o que é puro: nada de DOM, nada de fetch. As funções que
// dependem da data da mudança recebem-na por parâmetro, porque no navegador ela
// vem de um input e no servidor vem do banco.
//
// Sem build step: o mesmo arquivo é <script src> no navegador e require() no
// node. No navegador os nomes ficam em window.Painel.

(function(raiz, fabrica){
  const api = fabrica();
  if(typeof module === 'object' && module.exports) module.exports = api;
  else raiz.Painel = api;
})(typeof self !== 'undefined' ? self : this, function(){

  const DESTINATIONS = [
    { id:'A decidir', cls:'adecidir' },
    { id:'Vender',    cls:'vender' },
    { id:'Levar',     cls:'levar' },
    { id:'Doar',      cls:'doar' },
    { id:'Descartar', cls:'descartar' },
  ];
  const SALE_STAGES = ['Não anunciado','Anunciado','Negociando','Reservado','Vendido'];
  // Doação tem o mesmo ciclo que venda, sem o dinheiro: oferecer, alguém dizer
  // "eu quero", entregar. Sem estes estágios o acompanhamento ia parar nas
  // observações ("prometido para a Renata"), que ninguém consegue contar.
  // "Doado" é o "Vendido" daqui: o único estágio que resolve o item.
  const DONATION_STAGES = ['Não oferecido','Oferecido','Prometido','Doado'];
  const CONDITIONS = ['Novo','Ótimo','Bom','Usado'];
  const PAYMENT_METHODS = ['PIX','Dinheiro','Transferência','Cartão','Outro'];
  const DEFAULT_INV_CATEGORIES = ['Móveis','Eletrodomésticos','Eletrônicos','Cozinha','Decoração','Roupas','Ferramentas','Outros'];
  const DEFAULT_ROOMS = ['Sala','Cozinha','Quarto','Quarto 2','Banheiro','Área de serviço','Escritório','Garagem','Varanda'];
  const INV_UNCATEGORIZED = 'Sem categoria';
  // Story do Instagram some da timeline em 24h: passado isso o anúncio não está
  // mais no ar para ninguém, mesmo com o item ainda "Anunciado".
  const STORY_TTL_H = 24;
  // Teto de fotos por item. Existe por causa do blob: o inventário inteiro vai
  // num único valor do kv_store, e cada caminho de foto custa ~30 bytes ali —
  // o limite real é a paciência de quem tira as fotos, não o tamanho.
  const MAX_PHOTOS = 8;
  // Só caminho do nosso próprio /uploads: é o que fecha 'javascript:' e 'data:'
  // antes de a URL virar src de um <img> na tabela.
  const PHOTO_PATH_RE = /^\/uploads\/[\w.\-]+$/;
  // Sugestão de IA gravada no item: quanto o modelo confia no preço, e quantos
  // anúncios comparáveis vale guardar. O teto existe pelo mesmo motivo do de
  // fotos — tudo vai no blob único do kv_store.
  const AI_CONFIDENCES = ['alta','media','baixa'];
  const AI_MAX_COMPARABLES = 8;
  const OWNERS = ['Hugo','Taís','Ambos'];
  const TASK_STATUSES = ['A fazer','Em andamento','Concluído'];
  const TASK_QUEUES = [
    { id:'blocked', label:'Bloqueado' },
    { id:'waiting', label:'Aguardando terceiros' },
  ];

  // ---- Listas de venda (a vitrine pública) ----
  // O slug é a única credencial de um link compartilhado, então é sorteado com
  // CSPRNG e não com Math.random — que é previsível a partir de dois valores
  // consecutivos. Alfabeto sem 0/o/1/l/i: o link vai ser lido em voz alta ou
  // digitado à mão em algum momento.
  const SHARE_SLUG_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';   // 31 símbolos
  const SHARE_SLUG_LEN = 12;                                       // 31^12 ≈ 59 bits
  const SHARE_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,62})[a-z0-9]$/;
  // Teto para o blob não crescer sem limite; a casa inteira não passa de 200 itens.
  const MAX_SHARE_EXCLUDED = 500;
  // Destinos que podem aparecer numa lista pública: venda e doação. Os dois têm
  // um ciclo com "alguém disse eu quero" (Reservado / Prometido) e um estágio
  // final que tira o item da página (Vendido / Doado). "A decidir", "Levar" e
  // "Descartar" não têm o que oferecer a ninguém — triagem não é vitrine.
  // Cada lista escolhe um subconjunto disto (ver normalizeShareDestinations).
  const PUBLIC_DESTINATIONS = ['Vender','Doar'];

  function todayISO(tz){
    // Com timeZone explícito o "hoje" é o de quem usa o painel, não o do
    // container: no servidor em UTC, 21h de Brasília já é o dia seguinte.
    if(tz) return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }
  function daysBetween(a, b){
    return Math.ceil((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 86400000);
  }
  function fmtDate(iso){
    const [y,m,d] = iso.split('-');
    return `${d}/${m}`;
  }
  function fmtDateBR(iso){
    const [y,m,d] = String(iso).split('-');
    return `${d}/${m}/${y}`;
  }
  function fmtDateTime(iso){
    const d = new Date(iso);
    const dd = String(d.getDate()).padStart(2,'0');
    const mm = String(d.getMonth()+1).padStart(2,'0');
    const hh = String(d.getHours()).padStart(2,'0');
    const mi = String(d.getMinutes()).padStart(2,'0');
    return `${dd}/${mm} ${hh}:${mi}`;
  }
  function fmtAge(hours){
    if(hours < 1) return Math.max(1, Math.round(hours * 60)) + 'min';
    if(hours < 48) return Math.floor(hours) + 'h';
    return Math.floor(hours / 24) + 'd';
  }
  // "Sofa" acha "Sofá"; "geladeira" acha "Geladeira Brastemp".
  function norm(v){
    return String(v || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
  }
  function newInvId(){ return 'inv-' + Date.now() + Math.random().toString(36).slice(2,5); }
  function newShareId(){ return 'lst-' + Date.now() + Math.random().toString(36).slice(2,5); }
  function newReceiptId(){ return 'r-' + Date.now() + Math.random().toString(36).slice(2,6); }
  function isISODate(v){
    return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
  }
  function isISODateTime(v){
    return typeof v === 'string'
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?$/.test(v)
      && isFinite(new Date(v).getTime());
  }
  function parseMoney(raw){
    if(raw == null) return null;
    let s = String(raw).trim();
    if(!s) return null;
    s = s.replace(/[^\d.,]/g, '');   // o "-" cai aqui: preço negativo não existe
    if(!s) return null;
    const lastC = s.lastIndexOf(','), lastD = s.lastIndexOf('.');
    let cut;
    if(lastC >= 0 && lastD >= 0) cut = Math.max(lastC, lastD);
    else if(lastC >= 0)          cut = lastC;
    else if(lastD >= 0){
      const dots = (s.match(/\./g) || []).length;
      cut = (dots > 1 || s.length - lastD - 1 === 3) ? -1 : lastD;
    } else cut = -1;
    const intPart  = (cut >= 0 ? s.slice(0, cut)  : s ).replace(/[.,]/g, '');
    const fracPart = (cut >= 0 ? s.slice(cut + 1) : '').replace(/[.,]/g, '');
    if(!intPart && !fracPart) return null;
    const cents = Number(intPart || '0') * 100 + Number((fracPart + '00').slice(0, 2));
    if(!Number.isFinite(cents) || cents > 1e11) return null;
    return cents;
  }
  function toCents(v){
    if(v == null || v === '') return null;
    const n = typeof v === 'string' ? parseMoney(v) : Math.round(v);
    return typeof n === 'number' && isFinite(n) ? n : null;
  }
  function fmtMoneyPlain(cents){
    const v = Math.round(Number(cents) || 0) / 100;
    return v.toLocaleString('pt-BR', { minimumFractionDigits:2, maximumFractionDigits:2 });
  }
  function fmtMoney(cents){
    return cents == null ? '—' : 'R$ ' + fmtMoneyPlain(cents);
  }
  function fmtMoneyShort(cents){
    if(cents == null) return '—';
    const exact = (cents % 100) === 0;
    const v = Math.round(Number(cents) || 0) / 100;
    return 'R$ ' + v.toLocaleString('pt-BR', {
      minimumFractionDigits: exact ? 0 : 2,
      maximumFractionDigits: exact ? 0 : 2,
    });
  }
  function moneyToInput(cents){ return cents == null ? '' : fmtMoneyPlain(cents); }
  // Um item tem uma lista de fotos, e a primeira é a capa (a que aparece na
  // tabela). `photo`, no singular, é o formato de quando era uma foto só:
  // item gravado antes da mudança continua vindo assim, e entra como capa.
  function normalizePhotos(raw){
    const list = Array.isArray(raw.photos) ? raw.photos : (raw.photo ? [raw.photo] : []);
    const out = [];
    for(const p of list){
      // Duplicata aqui não é hipótese remota: dois itens na mesma foto fazem a
      // exclusão de um apagar o arquivo do outro, e é o que este de-dup evita
      // dentro do item. A validação é aqui, uma vez, para quem desenha o <img>
      // depois poder confiar no valor.
      if(typeof p === 'string' && PHOTO_PATH_RE.test(p) && !out.includes(p)) out.push(p);
    }
    return out.slice(0, MAX_PHOTOS);
  }
  // ---- Sugestão de IA ----
  // 🔒 Privada: fica gravada no item para a negociação (preço de referência,
  // links dos anúncios comparáveis), mas NÃO entra em vitrineItemView nem em
  // itemView (server.js) — as duas são allowlists, então basta não acrescentar.
  // Normalizada aqui, uma vez, para quem desenha o painel poder confiar no
  // valor: a URL vira href de <a>, o texto vira innerHTML escapado.
  function aiText(v, max){ return typeof v === 'string' ? v.trim().slice(0, max) : ''; }
  // Só http(s): é o que fecha 'javascript:' antes de a URL virar link clicável.
  function aiUrl(v){ return (typeof v === 'string' && /^https?:\/\/\S+$/i.test(v)) ? v.slice(0, 500) : ''; }
  function aiCents(v){ const c = toCents(v); return c != null && c >= 0 ? c : null; }
  function normalizeAiSuggestion(raw){
    if(!raw || typeof raw !== 'object') return null;
    const faixa = (raw.faixaUsadoCents && typeof raw.faixaUsadoCents === 'object') ? raw.faixaUsadoCents : {};
    const comps = Array.isArray(raw.comparaveis) ? raw.comparaveis : [];
    return {
      geradaEm: isISODateTime(raw.geradaEm) ? raw.geradaEm : new Date().toISOString(),
      titulo: aiText(raw.titulo, 80),
      descricaoPublica: aiText(raw.descricaoPublica, 280),
      categoriaSugerida: aiText(raw.categoriaSugerida, 40),
      precoNovoCents: aiCents(raw.precoNovoCents),
      faixaUsadoCents: { min: aiCents(faixa.min), max: aiCents(faixa.max) },
      precoSugeridoCents: aiCents(raw.precoSugeridoCents),
      confianca: AI_CONFIDENCES.includes(raw.confianca) ? raw.confianca : 'baixa',
      justificativa: aiText(raw.justificativa, 800),
      comparaveis: comps.slice(0, AI_MAX_COMPARABLES).map(c => ({
        titulo: aiText(c && c.titulo, 120),
        precoCents: aiCents(c && c.precoCents),
        fonte: aiText(c && c.fonte, 40),
        url: aiUrl(c && c.url),
        estado: ['novo','usado'].includes(c && c.estado) ? c.estado : 'desconhecido',
      })).filter(c => c.titulo || c.url),
    };
  }
  function normalizeItem(raw){
    raw = raw || {};
    return {
      id: raw.id || newInvId(),
      title: raw.title || '',
      category: raw.category || INV_UNCATEGORIZED,
      room: raw.room || '',
      condition: CONDITIONS.includes(raw.condition) ? raw.condition : 'Bom',
      owner: ['Hugo','Taís','Ambos'].includes(raw.owner) ? raw.owner : 'Ambos',
      destination: DESTINATIONS.some(d=>d.id===raw.destination) ? raw.destination : 'A decidir',
      deadline: isISODate(raw.deadline) ? raw.deadline : null,
      notes: raw.notes || '',
      // Vizinho de `notes` de propósito: um é interno e o outro é o que sai nos
      // links de venda e no texto do anúncio. Lado a lado no arquivo, ninguém
      // confunde qual é qual.
      publicNotes: raw.publicNotes || '',
      photos: normalizePhotos(raw),
      // 🔒 Ver normalizeAiSuggestion: privada, e fora das allowlists do servidor.
      aiSuggestion: normalizeAiSuggestion(raw.aiSuggestion),
      saleStatus: SALE_STAGES.includes(raw.saleStatus) ? raw.saleStatus : 'Não anunciado',
      askPrice: toCents(raw.askPrice),
      minPrice: toCents(raw.minPrice),
      soldPrice: toCents(raw.soldPrice),
      buyer: raw.buyer || '',
      paymentMethod: PAYMENT_METHODS.includes(raw.paymentMethod) ? raw.paymentMethod : '',
      // Cada entrada é dinheiro que efetivamente caiu: {id, amount (centavos), at}
      receipts: Array.isArray(raw.receipts)
        ? raw.receipts.map(r => ({ id: r.id || newReceiptId(), amount: toCents(r.amount), at: isISODate(r.at) ? r.at : null }))
                      .filter(r => r.amount != null)
        : [],
      channel: raw.channel || '',
      storyPostedAt: isISODateTime(raw.storyPostedAt) ? raw.storyPostedAt : null,
      listingUrl: raw.listingUrl || '',
      saleDate: raw.saleDate || null,
      // Item de doação gravado antes de existir o ciclo só tinha o "já saiu de
      // casa" (resolvedAt). Ele entra como "Doado", senão o deploy desfaria o
      // que já estava resolvido — e o chip de Doar perderia o "N ok" de graça.
      donationStatus: DONATION_STAGES.includes(raw.donationStatus) ? raw.donationStatus
        : (raw.destination === 'Doar' && raw.resolvedAt ? 'Doado' : 'Não oferecido'),
      // Para quem vai: o "comprador" da doação. Nunca sai do painel.
      donee: raw.donee || '',
      resolvedAt: raw.resolvedAt || null,
      order: typeof raw.order === 'number' ? raw.order : 0,
      comments: Array.isArray(raw.comments) ? raw.comments : [],
      lastEditedBy: raw.lastEditedBy || '',
      lastEditedAt: raw.lastEditedAt || '',
    };
  }
  function isResolved(it){
    if(it.destination === 'A decidir') return false;
    if(it.destination === 'Vender')    return it.saleStatus === 'Vendido';
    // Doação resolve pelo estágio, como venda — e não pelo resolvedAt, que aqui
    // vira só o carimbo de quando "Doado" aconteceu.
    if(it.destination === 'Doar')      return it.donationStatus === 'Doado';
    return !!it.resolvedAt;
  }
  function receivedOf(it){
    if(it.destination !== 'Vender') return 0;
    const r = it.receipts || [];
    if(r.length) return r.reduce((a, x) => a + (x.amount || 0), 0);
    return it.saleStatus === 'Vendido' ? (it.soldPrice || 0) : 0;
  }
  function pendingOf(it){
    if(it.destination !== 'Vender' || it.saleStatus !== 'Vendido') return 0;
    return Math.max(0, (it.soldPrice || 0) - receivedOf(it));
  }
  function isStoryChannel(ch){ return /stor/i.test(ch || ''); }
  function storyAge(it){
    if(!it.storyPostedAt || !isStoryChannel(it.channel)) return null;
    if(!isISODateTime(it.storyPostedAt)) return null;
    const t = new Date(it.storyPostedAt).getTime();
    const hours = (Date.now() - t) / 3600000;
    return { hours, expired: hours >= STORY_TTL_H };
  }
  function storyExpired(it){
    const a = storyAge(it);
    return !!(a && a.expired && !isResolved(it));
  }
  function itemRisk(it, moveDate, today){
    if(isResolved(it)) return null;
    today = today || todayISO();
    const move = moveDate || '';
    if(it.deadline && it.deadline < today) return 'late';
    if(move){
      if(it.deadline && it.deadline > move) return 'after';
      if(!it.deadline && daysBetween(today, move) <= 30) return 'none';
    }
    return null;
  }
  function invTotals(list, moveDate, today){
    const sum = (arr, k) => arr.reduce((a, i) => a + (i[k] || 0), 0);
    const forSale = list.filter(i => i.destination === 'Vender');
    const sold    = forSale.filter(i => i.saleStatus === 'Vendido');
    const open    = forSale.filter(i => i.saleStatus !== 'Vendido');
    return {
      count: list.length,
      forSale: forSale.length,
      sold: sold.length,
      resolved: list.filter(isResolved).length,
      // Pedido "em aberto": o já-vendido sai daqui e entra em `received`, senão
      // o mesmo dinheiro é contado duas vezes.
      asked: sum(open, 'askPrice'),
      // Cenário pessimista, sobre os mesmos itens que compõem `asked`: sem preço
      // pedido o item conta como "sem preço", e exibir um piso para ele deixaria
      // o rodapé se contradizendo ("Pedido —" com um piso embaixo).
      floor: open.reduce((a,i)=> a + (i.askPrice == null ? 0 : (i.minPrice != null ? i.minPrice : i.askPrice)), 0),
      // "Vendido" é o valor combinado; "recebido" é o que caiu na conta. Com
      // venda parcelada os dois deixam de ser o mesmo número.
      soldValue: sum(sold, 'soldPrice'),
      received: forSale.reduce((a, i) => a + receivedOf(i), 0),
      toReceive: forSale.reduce((a, i) => a + pendingOf(i), 0),
      partial: sold.filter(i => pendingOf(i) > 0).length,
      unpriced: open.filter(i => i.askPrice == null).length,
      atRisk: list.filter(i => itemRisk(i, moveDate, today)).length,
      storyExpired: list.filter(storyExpired).length,
    };
  }

  // ---- Filtro do inventário ----
  // Vive aqui, e não no index.html, pelo mesmo motivo das regras de dinheiro: a
  // rota que serve a vitrine tem de resolver o filtro de uma lista exatamente
  // como a tela resolve o da toolbar. Duas implementações divergiriam, e a
  // divergência apareceria como item errado na tela de um estranho.
  //
  // Cada destino tem o seu ciclo, e o filtro por estágio só existe dentro de
  // um destino: "Vendido" é um estágio de Vender, "Já saiu de casa" é a
  // situação de quem leva ou descarta. Para Levar/Descartar o estágio não é
  // gravado — é o resolvedAt lido como dois estados, para o chip do filtro
  // falar a mesma língua do checkbox do detalhe. "A decidir" não tem ciclo.
  const RESOLVE_STAGES = ['Em casa','Já saiu de casa'];
  function destStages(destination){
    if(destination === 'Vender') return SALE_STAGES;
    if(destination === 'Doar')   return DONATION_STAGES;
    if(destination === 'Levar' || destination === 'Descartar') return RESOLVE_STAGES;
    return [];
  }
  function itemStage(it){
    if(it.destination === 'Vender') return it.saleStatus;
    if(it.destination === 'Doar')   return it.donationStatus;
    if(it.destination === 'Levar' || it.destination === 'Descartar') return it.resolvedAt ? RESOLVE_STAGES[1] : RESOLVE_STAGES[0];
    return null;
  }
  const INV_FILTER_KEYS = ['q','category','room','owner','destination','stage'];
  function normalizeInvFilter(raw){
    raw = raw || {};
    const destination = DESTINATIONS.some(d => d.id === raw.destination) ? raw.destination : '';
    return {
      q: String(raw.q || ''),
      category: String(raw.category || ''),
      room: String(raw.room || ''),
      owner: OWNERS.includes(raw.owner) ? raw.owner : '',
      destination,
      // Estágio sem destino não quer dizer nada, e "Vendido" com o chip em
      // Doar também não: fora do ciclo do destino ativo ele cai.
      stage: destStages(destination).includes(raw.stage) ? raw.stage : '',
      risk: !!raw.risk,
      storyOut: !!raw.storyOut,
    };
  }
  // ctx = { moveDate, today }: risco depende dos dois, e no navegador eles vêm
  // de um input e no servidor do banco — a mesma razão pela qual itemRisk
  // recebe a data por parâmetro em vez de ir buscá-la.
  function matchesInvFilter(it, f, ctx){
    ctx = ctx || {};
    const q = norm(f.q);
    return (!f.destination || it.destination === f.destination)
        && (!f.stage       || itemStage(it) === f.stage)
        && (!f.category    || it.category === f.category)
        && (!f.room        || it.room === f.room)
        && (!f.owner       || it.owner === f.owner)
        && (!f.risk        || !!itemRisk(it, ctx.moveDate, ctx.today))
        && (!f.storyOut    || storyExpired(it))
        && (!q || norm(it.title).includes(q) || norm(it.publicNotes).includes(q)
               || norm(it.notes).includes(q) || norm(it.buyer).includes(q)
               || norm(it.donee).includes(q));
  }
  function filterInvItems(list, f, ctx){
    const nf = normalizeInvFilter(f);
    return list.filter(it => matchesInvFilter(it, nf, ctx));
  }

  // ---- Itens com nome parecido ----
  // Duplicata é permitida de propósito — "Cadeira" seis vezes é o resultado
  // legítimo de varrer uma sala (ver captura rápida). O que isto evita é a
  // duplicata por engano: cadastrar a geladeira de novo porque ninguém lembrava
  // que ela já estava na lista. Por isso não bloqueia nada: só devolve o que já
  // existe com nome parecido, para a tela mostrar antes de o Enter acontecer.
  //
  // Mora aqui por ser puro (texto entra, lista sai) e para o teste rodar em node.
  //
  // "Parecido" é por palavra, não por caractere: "Sofá 3 lugares" acha "Sofa de
  // três lugares" porque as duas têm "sofa" e "lugares", e "de" não conta. Um
  // erro de digitação ("geladera") ainda acha, e a última palavra vale como
  // prefixo ("cadei" acha "Cadeira") porque a lista aparece enquanto o nome
  // ainda está sendo escrito.
  const TITLE_STOPWORDS = new Set(['de','da','do','das','dos','e','com','sem','para','pra','em','no','na','nos','nas','o','a','os','as','um','uma']);
  function titleTokens(v){
    return norm(v).replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(t => t && !TITLE_STOPWORDS.has(t));
  }
  // Distância de edição (Levenshtein) com teto: devolve max+1 assim que passa
  // dele. Nome de item tem dez letras — não vale otimizar além disso.
  function editDistance(a, b, max){
    if(a === b) return 0;
    if(Math.abs(a.length - b.length) > max) return max + 1;
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for(let i = 1; i <= a.length; i++){
      const cur = [i];
      let best = i;
      for(let j = 1; j <= b.length; j++){
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        if(cur[j] < best) best = cur[j];
      }
      if(best > max) return max + 1;
      prev = cur;
    }
    return prev[b.length];
  }
  // a é a palavra digitada, b a do item já cadastrado. Palavra curta só casa
  // exata ("mesa" ≠ "meia"); de 5 letras em diante tolera 1 erro, de 8 em
  // diante 2 ("geladera" ~ "geladeira", "microndas" ~ "microondas").
  function tokenLike(a, b, prefixOk){
    if(a === b) return true;
    if(prefixOk && a.length >= 3 && b.startsWith(a)) return true;
    const n = Math.max(a.length, b.length);
    if(n < 5) return false;
    const tol = n >= 8 ? 2 : 1;
    return editDistance(a, b, tol) <= tol;
  }
  // Devolve [{ item, score }] do maior para o menor, no máximo opts.limit (6).
  // opts.excludeId tira o próprio item quando ele está sendo editado.
  // Score: 100 mesmo nome; 80 tudo que foi digitado está no item ("cadeira"
  // acha "Cadeira de escritório"); 70 o item é a versão genérica ("cadeira de
  // escritório" acha "Cadeira"); 42–65 parte das palavras em comum; 60 nome
  // junto igual a menos de duas letras ("micro-ondas" vs "microondas").
  function similarTitles(title, items, opts){
    opts = opts || {};
    const q = titleTokens(title);
    if(!q.length) return [];
    const qs = q.join('');
    const last = q.length - 1;
    const like = (a, i, b) => tokenLike(a, b, i === last);
    const out = [];
    for(const it of items || []){
      if(!it || it.id === opts.excludeId) continue;
      const t = titleTokens(it.title);
      if(!t.length) continue;
      const ts = t.join('');
      let score = 0;
      if(ts === qs) score = 100;
      else {
        const hitQ = q.filter((a, i) => t.some(b => like(a, i, b))).length;
        const hitT = t.filter(b => q.some((a, i) => like(a, i, b))).length;
        if(hitQ === q.length) score = 80;
        else if(hitT === t.length) score = 70;
        else if(hitQ){
          const dice = (hitQ + hitT) / (q.length + t.length);
          if(dice >= 0.25) score = Math.round(30 + 50 * dice);
        }
        if(!score && Math.max(qs.length, ts.length) >= 6 && editDistance(qs, ts, 2) <= 2) score = 60;
      }
      if(score) out.push({ item: it, score });
    }
    out.sort((x, y) => y.score - x.score || String(x.item.title).localeCompare(String(y.item.title), 'pt-BR'));
    return out.slice(0, opts.limit || 6);
  }

  // ---- Listas de venda ----
  function onlyDigits(v, min, max){
    const d = String(v == null ? '' : v).replace(/\D/g, '');
    return (d.length >= min && d.length <= max) ? d : '';
  }
  function slugifyName(v){
    return norm(v).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24).replace(/-+$/, '');
  }
  function randomSlugTail(n){
    const A = SHARE_SLUG_ALPHABET, out = [];
    const buf = new Uint8Array(n * 2);
    while(out.length < n){
      globalThis.crypto.getRandomValues(buf);
      for(const b of buf){
        // Descarte por rejeição: 248 = 31*8, então os bytes aceitos caem de
        // forma uniforme no alfabeto. Com `b % 31` puro os sete primeiros
        // símbolos sairiam mais que os outros — viés pequeno e gratuito.
        if(b >= 248) continue;
        out.push(A[b % A.length]);
        if(out.length === n) break;
      }
    }
    return out.join('');
  }
  function newShareSlug(name){
    const base = slugifyName(name);
    const tail = randomSlugTail(SHARE_SLUG_LEN);
    return base ? base + '-' + tail : tail;
  }
  function isShareSlug(v){
    return typeof v === 'string' && v.length >= SHARE_SLUG_LEN && SHARE_SLUG_RE.test(v);
  }
  function normalizeShareFilter(raw){
    const f = normalizeInvFilter(raw);
    // "Em risco" e "story vencido" são lentes de triagem, não critério de
    // vitrine: salvos numa lista, o conteúdo dela mudaria com o relógio — um
    // item entrando na lista porque o story dele venceu. Ninguém pediu isso.
    f.risk = false;
    f.storyOut = false;
    // Destino também não: o que a lista mostra é `destinos` (venda, doação ou
    // os dois), decidido na criação a partir deste chip e editável depois no
    // card. Guardá-lo aqui também criaria uma armadilha silenciosa — a lista
    // criada com o chip "A decidir" (ou "Levar", ou "Descartar") ativo salvaria
    // um filtro que só admite itens que isPublicItem depois recusa, e nasceria
    // vazia PARA SEMPRE, com o link abrindo normalmente. Zerar aqui é o que
    // impede a combinação de existir.
    f.destination = '';
    // E o estágio vai junto: é a lente de um destino, e gravado numa lista
    // daria o mesmo vazio permanente — "só os vendidos" nunca é público.
    f.stage = '';
    return f;
  }
  // Lista gravada antes de existir `destinos` continua sendo só de venda, como
  // sempre foi: o link já circulou, e ele passar a mostrar as doações sem
  // ninguém pedir seria uma mudança silenciosa numa página pública.
  function normalizeShareDestinations(raw){
    const list = Array.isArray(raw) ? raw.filter(d => PUBLIC_DESTINATIONS.includes(d)) : [];
    const out = PUBLIC_DESTINATIONS.filter(d => list.includes(d));   // ordem fixa
    return out.length ? out : ['Vender'];
  }
  // O chip de destino da tela decide o escopo da lista nova: "Vender" ou "Doar"
  // ativo faz uma lista só daquilo; sem chip (ou com um chip que não é
  // público) a lista mostra tudo que é publicável — a base é o que a tela
  // mostra, restrito ao que pode sair.
  function shareDestinationsFromFilter(f){
    const d = f && f.destination;
    return PUBLIC_DESTINATIONS.includes(d) ? [d] : PUBLIC_DESTINATIONS.slice();
  }
  function normalizeShare(raw){
    raw = raw || {};
    return {
      id: raw.id || newShareId(),
      // Slug inválido NÃO virá um slug novo: regenerar em silêncio mataria um
      // link já mandado no WhatsApp. Fica vazio, e a tela oferece "gerar novo"
      // como decisão explícita.
      slug: isShareSlug(raw.slug) ? raw.slug : '',
      name: String(raw.name || '').trim().slice(0, 60),
      intro: String(raw.intro || '').trim().slice(0, 400),
      // Só dígitos: '(31) 99999-8888' e '+55 31 99999 8888' viram a mesma
      // coisa, que é o que o wa.me aceita. Fora de 10..15 não é telefone.
      whatsapp: onlyDigits(raw.whatsapp, 10, 15),
      active: raw.active !== false,          // nasce ligada
      expiresAt: isISODate(raw.expiresAt) ? raw.expiresAt : null,
      // O que entra: ['Vender'], ['Doar'] ou os dois. Separado do filtro para
      // a lista antiga (sem o campo) continuar sendo só de venda.
      destinos: normalizeShareDestinations(raw.destinos),
      filter: normalizeShareFilter(raw.filter),
      excluded: Array.isArray(raw.excluded)
        ? [...new Set(raw.excluded.filter(x => typeof x === 'string' && x))].slice(0, MAX_SHARE_EXCLUDED)
        : [],
      createdAt: isISODateTime(raw.createdAt) ? raw.createdAt : new Date().toISOString(),
      lastEditedBy: raw.lastEditedBy || '',
      lastEditedAt: raw.lastEditedAt || '',
    };
  }
  // O blob é objeto e não array porque carrega também o endereço onde a vitrine
  // está publicada: o front é arquivo estático e não lê variável de ambiente.
  function normalizeShareStore(raw){
    const obj = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : { lists: raw };
    const lists = Array.isArray(obj.lists) ? obj.lists : [];
    return {
      baseUrl: String(obj.baseUrl || '').trim().replace(/\/+$/, ''),
      lists: lists.map(normalizeShare),
    };
  }
  function shareStatus(share, today){
    if(!share.slug) return 'sem-link';
    if(!share.active) return 'desativada';
    if(share.expiresAt && share.expiresAt < (today || todayISO())) return 'vencida';
    return 'ativa';
  }
  // O que um item é para quem está do lado de fora: 'venda', 'doacao' ou
  // null (não tem o que mostrar). Mora aqui, e não na rota, porque a tela de
  // gestão precisa contar exatamente os mesmos itens que a vitrine vai
  // mostrar: dizer "12 itens" e a página mostrar 9 acaba com a confiança na tela.
  function publicKind(it){
    if(!it.title) return null;
    if(it.destination === 'Vender') return it.saleStatus === 'Vendido' ? null : 'venda';      // vendido sai sozinho
    if(it.destination === 'Doar')   return it.donationStatus === 'Doado' ? null : 'doacao';   // doado também
    return null;   // triagem não é vitrine
  }
  // Com `share`, responde se o item cabe NAQUELA lista (escopo de venda e/ou
  // doação); sem, se cabe em alguma.
  function isPublicItem(it, share){
    if(!publicKind(it) || isResolved(it)) return false;   // isResolved: rede de segurança
    return !share || share.destinos.includes(it.destination);
  }
  // "Alguém já disse eu quero": Reservado na venda, Prometido na doação. A
  // página mostra o item marcado e não deixa escolher.
  function isPublicReserved(it){
    if(it.destination === 'Vender') return it.saleStatus === 'Reservado';
    if(it.destination === 'Doar')   return it.donationStatus === 'Prometido';
    return false;
  }
  // Preço que pode sair: só de quem está à venda. Item de doação pode carregar
  // um askPrice de quando era "Vender" (trocar o destino nunca apaga nada), e
  // esse número não é de ninguém de fora.
  function publicPrice(it){
    return it.destination === 'Vender' ? it.askPrice : null;
  }
  function shareItems(list, share, ctx){
    const fora = new Set(share.excluded);
    return filterInvItems(list, share.filter, ctx)
      .filter(it => !fora.has(it.id) && isPublicItem(it, share));
  }
  function waLink(whatsapp, text){
    const fone = onlyDigits(whatsapp, 10, 15);
    if(!fone) return null;
    return 'https://wa.me/' + fone + (text ? '?text=' + encodeURIComponent(text) : '');
  }

  return {
    DESTINATIONS, SALE_STAGES, DONATION_STAGES, CONDITIONS, PAYMENT_METHODS, DEFAULT_INV_CATEGORIES,
    DEFAULT_ROOMS, INV_UNCATEGORIZED, STORY_TTL_H, MAX_PHOTOS, OWNERS, TASK_STATUSES, TASK_QUEUES,
    SHARE_SLUG_LEN, INV_FILTER_KEYS, PUBLIC_DESTINATIONS,
    norm, todayISO, daysBetween, fmtDate, fmtDateBR, fmtDateTime, fmtAge,
    newInvId, newReceiptId, newShareId, isISODate, isISODateTime, parseMoney, toCents,
    fmtMoneyPlain, fmtMoney, fmtMoneyShort, moneyToInput, normalizePhotos, normalizeItem,
    normalizeAiSuggestion,
    isResolved, receivedOf, pendingOf, isStoryChannel, storyAge, storyExpired,
    itemRisk, invTotals, destStages, itemStage,
    normalizeInvFilter, matchesInvFilter, filterInvItems, similarTitles,
    newShareSlug, isShareSlug, normalizeShare, normalizeShareStore, shareStatus,
    normalizeShareDestinations, shareDestinationsFromFilter,
    publicKind, isPublicItem, isPublicReserved, publicPrice, shareItems, waLink,
  };
});
