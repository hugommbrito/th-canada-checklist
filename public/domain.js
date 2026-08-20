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
  const OWNERS = ['Hugo','Taís','Ambos'];
  const TASK_STATUSES = ['A fazer','Em andamento','Concluído'];
  const TASK_QUEUES = [
    { id:'blocked', label:'Bloqueado' },
    { id:'waiting', label:'Aguardando terceiros' },
  ];

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
  const INV_FILTER_KEYS = ['q','category','room','owner','destination'];
  function normalizeInvFilter(raw){
    raw = raw || {};
    return {
      q: String(raw.q || ''),
      category: String(raw.category || ''),
      room: String(raw.room || ''),
      owner: OWNERS.includes(raw.owner) ? raw.owner : '',
      destination: DESTINATIONS.some(d => d.id === raw.destination) ? raw.destination : '',
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
        && (!f.category    || it.category === f.category)
        && (!f.room        || it.room === f.room)
        && (!f.owner       || it.owner === f.owner)
        && (!f.risk        || !!itemRisk(it, ctx.moveDate, ctx.today))
        && (!f.storyOut    || storyExpired(it))
        && (!q || norm(it.title).includes(q) || norm(it.publicNotes).includes(q)
               || norm(it.notes).includes(q) || norm(it.buyer).includes(q));
  }
  function filterInvItems(list, f, ctx){
    const nf = normalizeInvFilter(f);
    return list.filter(it => matchesInvFilter(it, nf, ctx));
  }

  return {
    DESTINATIONS, SALE_STAGES, CONDITIONS, PAYMENT_METHODS, DEFAULT_INV_CATEGORIES,
    DEFAULT_ROOMS, INV_UNCATEGORIZED, STORY_TTL_H, MAX_PHOTOS, OWNERS, TASK_STATUSES, TASK_QUEUES,
    INV_FILTER_KEYS,
    norm, todayISO, daysBetween, fmtDate, fmtDateBR, fmtDateTime, fmtAge,
    newInvId, newReceiptId, isISODate, isISODateTime, parseMoney, toCents,
    fmtMoneyPlain, fmtMoney, fmtMoneyShort, moneyToInput, normalizePhotos, normalizeItem,
    isResolved, receivedOf, pendingOf, isStoryChannel, storyAge, storyExpired,
    itemRisk, invTotals,
    normalizeInvFilter, matchesInvFilter, filterInvItems,
  };
});
