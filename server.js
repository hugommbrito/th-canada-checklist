const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const Anthropic = require('@anthropic-ai/sdk');
// Mesmas regras que o navegador usa — ver o cabeçalho de public/domain.js.
const D = require('./public/domain.js');

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, 'data', 'app.db');

// As fotos do inventário moram ao lado do banco — ou seja, dentro do volume do
// Railway. public/ é reconstruído a cada deploy: foto ali dura até o próximo push.
const UPLOAD_DIR = path.join(path.dirname(DB_PATH), 'uploads');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS kv_store (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

const getStmt = db.prepare('SELECT value FROM kv_store WHERE key = ?');
const setStmt = db.prepare(`
  INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
`);

const app = express();
// O padrão do body-parser é 100kb. O blob de tarefas já tem ~11kb; o do
// inventário passa de 90kb com uma casa inteira cadastrada, e estourar o limite
// aqui falha de forma silenciosa no front (o catch só faz console.error).
app.use(express.json({ limit: '2mb' }));

// Mirrors the window.storage.get/set(key, value) contract the frontend used to
// call directly inside the Claude.ai artifact runtime — same shape, backed by SQLite now.
app.get('/api/kv/:key', (req, res) => {
  const row = getStmt.get(req.params.key);
  res.json({ value: row ? row.value : null });
});

app.put('/api/kv/:key', (req, res) => {
  const { value } = req.body || {};
  if (typeof value !== 'string') {
    return res.status(400).json({ error: 'value must be a string' });
  }
  setStmt.run(req.params.key, value, new Date().toISOString());
  res.json({ ok: true });
});

// ---- Fotos do inventário ----
// A extensão vem daqui, nunca do cliente, e o Content-Type de resposta é
// derivado dela — é o que torna inofensivo não conferir os magic bytes do
// arquivo. NÃO acrescente 'image/svg+xml': um SVG servido na própria origem
// é XSS armazenado, e o nosniff abaixo não protege contra isso.
const EXT_BY_TYPE = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};
const UPLOAD_NAME_RE = /^inv-\d+-[0-9a-f]{8}\.(jpg|png|webp)$/i;
// O inverso de EXT_BY_TYPE, para quem lê um arquivo do disco e precisa dizer o
// tipo dele: a rota de foto da vitrine e a sugestão com IA.
const TYPE_BY_EXT = { '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

// Upload sem multipart e sem multer: o cliente já reduz a imagem no canvas e
// manda o binário cru como corpo, então express.raw() entrega um Buffer pronto.
app.post('/api/upload', express.raw({ type: Object.keys(EXT_BY_TYPE), limit: '6mb' }), (req, res) => {
  const type = (req.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const ext = EXT_BY_TYPE[type];
  // Com um Content-Type fora da lista o express.raw nem roda, e o express.json
  // global já deixou req.body = {} — daí o teste ser de Buffer, não de vazio.
  if (!ext || !Buffer.isBuffer(req.body) || req.body.length === 0) {
    return res.status(415).json({ error: 'tipo de imagem não suportado' });
  }
  const name = 'inv-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex') + ext;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), req.body);
  res.json({ url: '/uploads/' + name });
});

app.delete('/api/upload/:name', (req, res) => {
  const name = path.basename(req.params.name); // corta qualquer ../
  if (!UPLOAD_NAME_RE.test(name)) {
    return res.status(400).json({ error: 'nome inválido' });
  }
  fs.rmSync(path.join(UPLOAD_DIR, name), { force: true }); // não erra se já sumiu
  res.json({ ok: true });
});

// Antes do static de public/. O nome do arquivo é único e imutável, então o
// cache longo evita ~100 requisições a cada redesenho da tabela.
app.use('/uploads', express.static(UPLOAD_DIR, {
  index: false,
  dotfiles: 'ignore',
  maxAge: '365d',
  immutable: true,
  setHeaders: (res) => res.setHeader('X-Content-Type-Options', 'nosniff'),
}));

// ---- Snapshot: leitura formatada de tudo, para consumo por automação ----
// Existe para o resumo diário: um agente busca isto, compara com o de ontem e
// conta o que mudou. Por isso é estável (ordenado por id), datado, e traz os
// números já calculados — quem consome não deveria ter que reimplementar o que
// "recebido" ou "a receber" significam.
const TZ = process.env.SNAPSHOT_TZ || 'America/Sao_Paulo';

function readKey(key, fallback) {
  const row = getStmt.get(key);
  if (!row || !row.value) return fallback;
  try { return JSON.parse(row.value); } catch (e) { return fallback; }
}

function money(cents) {
  return { cents: cents == null ? null : cents, brl: D.fmtMoney(cents) };
}

function taskView(t) {
  const cl = Array.isArray(t.checklist) ? t.checklist : [];
  const cm = Array.isArray(t.comments) ? t.comments : [];
  const last = cm.length ? cm[cm.length - 1] : null;
  return {
    id: t.id,
    titulo: t.title || '',
    status: t.status || '',
    fila: t.queue || null,
    categoria: t.category || '',
    responsavel: t.owner || '',
    prioridade: t.priority || '',
    prazo: t.deadline || null,
    atrasada: !!(t.deadline && t.status !== 'Concluído' && t.deadline < D.todayISO(TZ)),
    checklist: { feitos: cl.filter(c => c.done).length, total: cl.length },
    comentarios: {
      total: cm.length,
      ultimo: last ? { autor: last.author, quando: last.at, texto: last.text } : null,
    },
    editadoPor: t.lastEditedBy || null,
    editadoEm: t.lastEditedAt || null,
  };
}

function itemView(it, moveDate, today) {
  const risco = D.itemRisk(it, moveDate, today);
  const story = D.storyAge(it);
  const vende = it.destination === 'Vender';
  const doa = it.destination === 'Doar';
  return {
    id: it.id,
    nome: it.title,
    categoria: it.category,
    comodo: it.room || null,
    estado: it.condition,
    responsavel: it.owner,
    destino: it.destination,
    resolvido: D.isResolved(it),
    prazo: it.deadline || null,
    risco,                                   // 'late' | 'after' | 'none' | null
    // temFoto continua existindo para quem já consome o resumo; a lista é que
    // diz quantas são, agora que um item pode ter várias.
    temFoto: it.photos.length > 0,
    fotos: it.photos,
    // As duas, separadas: `observacoes` é interno e `descricaoPublica` é o que
    // sai nas listas compartilhadas — o resumo diário pode cobrar a segunda.
    observacoes: it.notes || null,
    descricaoPublica: it.publicNotes || null,
    venda: vende ? {
      status: it.saleStatus,
      pedido: money(it.askPrice),
      // Piso de negociação: combinado interno, nunca vai para o anúncio.
      pisoPrivado: money(it.minPrice),
      vendido: money(it.soldPrice),
      recebido: money(D.receivedOf(it)),
      aReceber: money(D.pendingOf(it)),
      formaDePagamento: it.paymentMethod || null,
      comprador: it.buyer || null,
      dataDaVenda: it.saleDate || null,
      recebimentos: (it.receipts || []).map(r => ({ valor: money(r.amount), quando: r.at })),
      canal: it.channel || null,
      linkDoAnuncio: it.listingUrl || null,
      story: story ? {
        postadoEm: it.storyPostedAt,
        horasNoAr: Math.round(story.hours * 10) / 10,
        venceu: story.expired,
      } : null,
    } : null,
    // Irmão de `venda`, e null pelo mesmo motivo: item que não vai à doação não
    // tem "status de doação nulo", tem outro destino.
    doacao: doa ? {
      status: it.donationStatus,
      paraQuem: it.donee || null,
      doadoEm: it.donationStatus === 'Doado' ? (it.resolvedAt || null) : null,
    } : null,
    comentarios: (it.comments || []).map(c => ({ autor: c.author, quando: c.at, texto: c.text })),
    editadoPor: it.lastEditedBy || null,
    editadoEm: it.lastEditedAt || null,
  };
}

function contar(lista, chave) {
  return lista.reduce((acc, x) => { const k = chave(x); acc[k] = (acc[k] || 0) + 1; return acc; }, {});
}

function buildSnapshot(since) {
  const today = D.todayISO(TZ);
  const tasks = readKey('toronto-tracker-tasks', []);
  const categories = readKey('toronto-tracker-categories', []);
  const invRaw = readKey('toronto-tracker-inventory', []);
  const invCats = readKey('toronto-tracker-inv-categories', D.DEFAULT_INV_CATEGORIES);
  const moveRow = getStmt.get('toronto-tracker-movedate');
  const moveDate = (moveRow && moveRow.value) || '';

  // normalizeItem aqui não é zelo: é o que garante que a rota veja os itens
  // exatamente como a tela vê, com os mesmos defaults e validações.
  const inv = invRaw.map(D.normalizeItem).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const t = D.invTotals(inv, moveDate, today);
  const tarefas = tasks.slice().sort((a, b) => String(a.id).localeCompare(String(b.id)));

  const editadoDesde = lista => since
    ? lista.filter(x => (x.editadoEm || '') > since).map(x => x.id)
    : null;

  const tarefasView = tarefas.map(taskView);
  const itensView = inv.map(i => itemView(i, moveDate, today));

  return {
    geradoEm: new Date().toISOString(),
    hoje: today,
    fusoHorario: TZ,
    mudanca: {
      dataPrevista: moveDate || null,
      diasRestantes: moveDate ? D.daysBetween(today, moveDate) : null,
    },
    demandas: {
      total: tarefasView.length,
      porStatus: contar(tarefasView.filter(x => !x.fila), x => x.status),
      foraDoFluxo: contar(tarefasView.filter(x => x.fila), x => x.fila),
      concluidas: tarefasView.filter(x => x.status === 'Concluído').length,
      atrasadas: tarefasView.filter(x => x.atrasada).length,
      categorias: categories,
      itens: tarefasView,
    },
    inventario: {
      total: t.count,
      resolvidos: t.resolved,
      porDestino: contar(itensView, x => x.destino),
      porStatusDeVenda: contar(itensView.filter(x => x.venda), x => x.venda.status),
      porStatusDeDoacao: contar(itensView.filter(x => x.doacao), x => x.doacao.status),
      categorias: invCats,
      dinheiro: {
        // Soma do que segue à venda. NÃO é pedido − recebido: vender acima do
        // preço pedido faria essa conta dizer que sobrou menos do que sobra.
        pedidoEmAberto: money(t.asked),
        pisoPrivado: money(t.floor),
        vendido: money(t.soldValue),
        // Dinheiro em mãos, não o valor combinado.
        recebido: money(t.received),
        // Vendido e ainda não pago.
        aReceberDeVendas: money(t.toReceive),
      },
      alertas: {
        semPreco: itensView.filter(x => x.venda && x.venda.status !== 'Vendido' && x.venda.pedido.cents == null).map(x => x.id),
        prazoEstourado: itensView.filter(x => x.risco === 'late').map(x => x.id),
        prazoDepoisDaMudanca: itensView.filter(x => x.risco === 'after').map(x => x.id),
        semPrazoEMudancaPerto: itensView.filter(x => x.risco === 'none').map(x => x.id),
        storyVencido: itensView.filter(x => x.venda && x.venda.story && x.venda.story.venceu).map(x => x.id),
        vendasParceladas: itensView.filter(x => x.venda && x.venda.aReceber.cents > 0).map(x => x.id),
      },
      itens: itensView,
    },
    editadoDesde: since ? {
      referencia: since,
      demandas: editadoDesde(tarefasView),
      itens: editadoDesde(itensView),
    } : null,
  };
}

app.get('/api/snapshot', (req, res) => {
  // Token opcional: se SNAPSHOT_TOKEN estiver definido, passa a ser exigido.
  // Sem ele o endpoint fica tão aberto quanto /api/kv/:key já é — o que muda é
  // poder dar a URL a um agendador sem entregar o painel inteiro.
  const esperado = process.env.SNAPSHOT_TOKEN;
  if (esperado) {
    const dado = req.get('x-snapshot-token') || req.query.token;
    if (dado !== esperado) return res.status(401).json({ error: 'token inválido' });
  }
  const since = D.isISODateTime(req.query.since) ? req.query.since : null;
  res.set('Cache-Control', 'no-store');
  res.json(buildSnapshot(since));
});

// ---- Vitrine pública: o que uma lista compartilhada pode ver ----
// Esta é a fronteira do painel com a internet. Do outro lado dela existe um
// serviço separado que renderiza a página e nunca vê o que não está aqui.
const SHARES_KEY = 'toronto-tracker-shares';
const HITS_KEY = 'toronto-tracker-share-hits';

// Token próprio, e obrigatório. O SNAPSHOT_TOKEN destranca o painel inteiro —
// piso de negociação, comprador, thread de negociação — e mora num agendador;
// este mora no ambiente de um serviço exposto à internet. Se vazar, o prejuízo
// tem que ser "alguém leu os anúncios", não "alguém leu a margem de tudo".
// E, ao contrário do snapshot, sem a variável definida a rota NÃO abre: rota
// consumida por serviço público não pode ter "aberta" como estado de esquecimento.
function vitrineAuth(req) {
  const esperado = process.env.VITRINE_TOKEN;
  if (!esperado) return 'sem-config';
  const dado = req.get('x-vitrine-token') || '';
  const a = Buffer.from(String(dado));
  const b = Buffer.from(esperado);
  return (a.length === b.length && crypto.timingSafeEqual(a, b)) ? 'ok' : 'nao';
}

function findShare(slug) {
  if (!D.isShareSlug(slug)) return null;   // corta lixo antes de varrer o blob
  const store = D.normalizeShareStore(readKey(SHARES_KEY, null));
  return store.lists.find(l => l.slug === slug) || null;
}

// Irmã de itemView(), e deliberadamente NÃO derivada dela: itemView monta o
// registro inteiro, então um `delete` sobre o retorno dela vazaria por default
// no dia em que o item ganhar um campo novo. Aqui a lista de campos é a
// especificação — o que não está escrito abaixo não sai.
// NÃO use spread, NÃO use delete, NÃO acrescente campo sem decidir que ele é público.
function vitrineItemView(it) {
  return {
    id: it.id,
    nome: it.title,
    estado: it.condition,
    // publicNotes, nunca notes: as observações são internas e é exatamente
    // onde mora "aceito 850" ou "combinado com o vizinho". Sem fallback.
    descricao: it.publicNotes || null,
    preco: money(it.askPrice),
    reservado: it.saleStatus === 'Reservado',
    // Só o nome do arquivo. A vitrine é obrigada a montar a URL do proxy dela,
    // e assim o domínio do painel não tem por onde escapar para o HTML de quem
    // recebe o link.
    fotos: it.photos.map(f => path.basename(f)),
  };
}

// Apresentação de uma vitrine, não regra de negócio: reservado por último,
// quem tem foto antes de quem não tem, mais caro primeiro, nome como desempate
// estável — a página não pode embaralhar entre duas visitas.
function vitrineOrder(a, b) {
  const res = (a.saleStatus === 'Reservado') - (b.saleStatus === 'Reservado');
  if (res) return res;
  const foto = (b.photos.length > 0) - (a.photos.length > 0);
  if (foto) return foto;
  const pa = a.askPrice == null ? -1 : a.askPrice;
  const pb = b.askPrice == null ? -1 : b.askPrice;
  if (pa !== pb) return pb - pa;
  return String(a.title).localeCompare(String(b.title), 'pt-BR');
}

function shareCtx() {
  const row = getStmt.get('toronto-tracker-movedate');
  return { moveDate: (row && row.value) || '', today: D.todayISO(TZ) };
}

function itensDaLista(share) {
  const ctx = shareCtx();
  const inv = readKey('toronto-tracker-inventory', []).map(D.normalizeItem);
  return D.shareItems(inv, share, ctx).sort(vitrineOrder);
}

// Ler-modificar-gravar num blob JSON só é seguro aqui porque NÃO existe await
// nenhum entre o get e o run: o event loop não roda no meio e o better-sqlite3
// é síncrono. NÃO transforme esta função em async.
function bumpHit(share) {
  const all = readKey(HITS_KEY, {});
  const cur = all[share.id] || { slug: share.slug, n: 0, primeira: null, ultima: null, dias: {} };
  const agora = new Date().toISOString();
  const dia = D.todayISO(TZ);
  cur.slug = share.slug;
  cur.n += 1;
  cur.primeira = cur.primeira || agora;
  cur.ultima = agora;
  cur.dias[dia] = (cur.dias[dia] || 0) + 1;
  // Aparado nos últimos 30 dias: sem isto o blob cresce para sempre.
  cur.dias = Object.fromEntries(Object.entries(cur.dias).sort().slice(-30));
  all[share.id] = cur;
  setStmt.run(HITS_KEY, JSON.stringify(all), agora);
  return cur.n;
}

// Resolve a lista e recusa o que não é público. Devolve { erro, status } ou { share }.
function resolveShare(req, res) {
  const auth = vitrineAuth(req);
  if (auth === 'sem-config') { res.status(503).json({ erro: 'VITRINE_TOKEN não configurado' }); return null; }
  if (auth !== 'ok') { res.status(401).json({ erro: 'token inválido' }); return null; }
  res.set('Cache-Control', 'no-store');   // lista desligada tem que apagar na hora
  const share = findShare(req.params.slug);
  if (!share) { res.status(404).json({ erro: 'nao_encontrada' }); return null; }
  const st = D.shareStatus(share, D.todayISO(TZ));
  if (st !== 'ativa') {
    // 410 e não 403: quem chamou está autorizado; o que acabou é o recurso. A
    // rota exige token, então distinguir "vencida" de "inexistente" aqui não é
    // oráculo para ninguém — e a página pública mostra o mesmo texto nos dois.
    res.status(410).json({ erro: st });
    return null;
  }
  return share;
}

app.get('/api/vitrine/:slug', (req, res) => {
  const share = resolveShare(req, res);
  if (!share) return;
  const itens = itensDaLista(share);
  res.json({
    geradoEm: new Date().toISOString(),
    lista: {
      nome: share.name,
      recado: share.intro || null,
      whatsapp: share.whatsapp,
      validade: share.expiresAt,
    },
    total: itens.length,
    itens: itens.map(vitrineItemView),
  });
});

// A visita é um POST explícito, e não efeito do GET acima, por dois motivos: a
// vitrine tem cache (uma visita não é um fetch, e um refresh de cache não é uma
// visita), e o preview de link do WhatsApp abre a página sozinho — quem decide
// o que conta é quem sabe o user-agent, não o painel.
app.post('/api/vitrine/:slug/visita', (req, res) => {
  const share = resolveShare(req, res);
  if (!share) return;
  res.json({ ok: true, n: bumpHit(share) });
});

// Foto com escopo na lista: a vitrine não busca em /uploads, busca aqui. Assim
// vender um item revoga o acesso à foto dele de graça, e o proxy nunca pode ser
// usado para pedir um arquivo qualquer do volume.
app.get('/api/vitrine/:slug/foto/:nome', (req, res) => {
  const share = resolveShare(req, res);
  if (!share) return;
  const nome = path.basename(req.params.nome);
  if (!UPLOAD_NAME_RE.test(nome)) return res.status(400).json({ erro: 'nome inválido' });
  const permitidas = new Set();
  itensDaLista(share).forEach(it => it.photos.forEach(f => permitidas.add(path.basename(f))));
  if (!permitidas.has(nome)) return res.status(404).json({ erro: 'nao_encontrada' });
  const ext = path.extname(nome).toLowerCase();
  const tipo = TYPE_BY_EXT[ext];
  if (!tipo) return res.status(400).json({ erro: 'nome inválido' });
  // Cache curto, e não o 365d immutable do /uploads: aqui a URL é revogável, e
  // um ano de cache imutável tornaria a revogação inútil para quem já visitou.
  res.set('Cache-Control', 'public, max-age=3600');
  res.set('X-Content-Type-Options', 'nosniff');
  res.type(tipo);
  res.sendFile(path.join(UPLOAD_DIR, nome));
});

// ---- Sugestão com IA (privada ao painel) ----
// Foto + nome mínimo entram; título, descrição pública, faixa de preço e
// anúncios comparáveis saem. A chamada é daqui, nunca do navegador: a chave
// não pode morar num HTML sem login. E o que vai para o modelo é só o que já
// é público por construção — nome, categoria, estado, descrição pública e as
// fotos. Piso e observações internas não entram nem no prompt.
const IA_CHAVE = String(process.env.ANTHROPIC_API_KEY || '').trim();
const IA_ATIVA = !!IA_CHAVE;
const IA_MODELO = 'claude-opus-5-5';
// Teto diário: o painel não tem login, então uma URL vazada não pode virar
// conta aberta na Anthropic. Contado em memória, por dia de São Paulo —
// reiniciar o processo zera, e tudo bem: é freio, não contabilidade.
const IA_LIMITE_DIA = (() => {
  const n = Number(process.env.IA_LIMITE_DIA);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 40;
})();
const IA_MAX_EM_VOO = 2;
// ~1,3k tokens por foto de 1280px; a capa vai primeiro, e quatro bastam para
// identificar marca, modelo e estado.
const IA_MAX_FOTOS = 4;
// O SDK conta o timeout em milissegundos. maxRetries 1: cada tentativa é
// dinheiro, e o navegador já oferece o "Refazer".
const ia = IA_ATIVA ? new Anthropic({ apiKey: IA_CHAVE, timeout: 180000, maxRetries: 1 }) : null;

let iaDia = D.todayISO(TZ), iaUsadas = 0, iaEmVoo = 0;
function iaUsadasHoje() {
  const hoje = D.todayISO(TZ);
  if (hoje !== iaDia) { iaDia = hoje; iaUsadas = 0; }
  return iaUsadas;
}

const IA_SISTEMA = `Você ajuda um casal no Brasil a vender objetos usados de casa, rápido, antes de se mudar para o Canadá. Os anúncios vão para OLX, Mercado Livre, Enjoei, Facebook Marketplace e grupos de WhatsApp.

Regras:
1. Pesquise na internet preços ATUAIS no Brasil, em reais: anúncios de USADO do mesmo produto (ou equivalente próximo) e, se possível, o preço de um exemplar NOVO no varejo. Prefira OLX, Mercado Livre, Enjoei e lojas brasileiras.
2. Não invente nada. Só cite preços e URLs que apareceram nos resultados da busca. Se não encontrou referência, devolva comparaveis vazio, confianca "baixa" e precoSugeridoReais null quando não houver base alguma. Diga na justificativa o que não foi possível confirmar.
3. Use as fotos para identificar marca, modelo, tamanho, material e estado visível. Se a foto contradiz o texto, confie na foto e avise na justificativa.
4. O preço sugerido é para vender em poucas semanas, não para maximizar: parta dos anúncios de usado encontrados, ajuste pelo estado informado (Novo, Ótimo, Bom, Usado) e fique um pouco abaixo da mediana dos anúncios semelhantes. Sem anúncio de usado, use de 35% a 55% do preço de novo como referência, e diga que foi assim.
5. Responda em português do Brasil, com valores em reais inteiros. descricaoPublica tem no máximo 280 caracteres, sem preço e sem prazo; titulo tem até 60 caracteres.`;

// Saída estruturada: a API garante o formato, e o que ela não garante (tamanho
// de texto, valor mínimo) vai na description e no prompt. Preço pode ser null
// de propósito — obrigar um inteiro forçaria o modelo a inventar.
const IA_INT_OU_NULL = { anyOf: [{ type: 'integer' }, { type: 'null' }] };
function iaSchema(categorias) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['titulo', 'descricaoPublica', 'categoriaSugerida', 'precoNovoReais', 'faixaUsadoReais',
      'precoSugeridoReais', 'confianca', 'justificativa', 'comparaveis'],
    properties: {
      titulo: { type: 'string', description: 'Título de anúncio, até 60 caracteres, com marca e modelo quando identificáveis.' },
      descricaoPublica: { type: 'string', description: 'Texto do anúncio em pt-BR, NO MÁXIMO 280 caracteres, sem preço, sem prazo, sem emoji; só características verificáveis (marca, modelo, medidas, material, estado).' },
      categoriaSugerida: { type: 'string', enum: categorias },
      precoNovoReais: { ...IA_INT_OU_NULL, description: 'Preço de um exemplar novo no varejo brasileiro hoje, em reais inteiros; null se não encontrou.' },
      faixaUsadoReais: {
        type: 'object', additionalProperties: false, required: ['min', 'max'],
        properties: { min: IA_INT_OU_NULL, max: IA_INT_OU_NULL },
        description: 'Faixa observada em anúncios de usado no Brasil, em reais inteiros; min e max null se não encontrou.',
      },
      precoSugeridoReais: { ...IA_INT_OU_NULL, description: 'Preço pedido sugerido para vender em poucas semanas, em reais inteiros, já descontado o estado informado; null se não há base nenhuma.' },
      confianca: { type: 'string', enum: ['alta', 'media', 'baixa'] },
      justificativa: { type: 'string', description: '2 a 4 frases em pt-BR: de onde saiu o preço, o que pesou (estado, urgência) e o que NÃO foi possível confirmar.' },
      comparaveis: {
        type: 'array',
        description: 'Até 6 anúncios ou páginas realmente encontradas na busca. Lista vazia se não encontrou nada. Nunca inventar URL.',
        items: {
          type: 'object', additionalProperties: false, required: ['titulo', 'precoReais', 'fonte', 'url', 'estado'],
          properties: {
            titulo: { type: 'string' },
            precoReais: IA_INT_OU_NULL,
            fonte: { type: 'string', description: 'Nome do site: OLX, Mercado Livre, Enjoei, Magalu…' },
            url: { type: 'string', description: 'URL exata da página encontrada.' },
            estado: { type: 'string', enum: ['novo', 'usado', 'desconhecido'] },
          },
        },
      },
    },
  };
}

// Categorias que o painel conhece, para a sugestão cair num valor que o
// <select> aceita. As gravadas primeiro; as padrão só se não houver nenhuma.
function iaCategorias() {
  const gravadas = readKey('toronto-tracker-inv-categories', null);
  const lista = (Array.isArray(gravadas) && gravadas.length ? gravadas : D.DEFAULT_INV_CATEGORIES)
    .filter(c => typeof c === 'string' && c.trim())
    .map(c => c.trim().slice(0, 40));
  if (!lista.includes(D.INV_UNCATEGORIZED)) lista.push(D.INV_UNCATEGORIZED);
  return [...new Set(lista)];
}

// Lê do disco as fotos que o navegador já subiu. O nome passa pelo mesmo
// crivo da rota de foto da vitrine: basename corta ../, a regex corta o resto.
function iaLerFotos(lista) {
  const out = [];
  for (const p of (Array.isArray(lista) ? lista : [])) {
    if (out.length >= IA_MAX_FOTOS) break;
    if (typeof p !== 'string') continue;
    const nome = path.basename(p);
    if (!UPLOAD_NAME_RE.test(nome)) continue;
    const tipo = TYPE_BY_EXT[path.extname(nome).toLowerCase()];
    if (!tipo) continue;
    try {
      out.push({ tipo, dados: fs.readFileSync(path.join(UPLOAD_DIR, nome)).toString('base64') });
    } catch (e) { /* foto sumiu do volume: segue sem ela */ }
  }
  return out;
}

async function iaConsultar({ imagens, texto, categorias }) {
  const content = [
    ...imagens.map(im => ({ type: 'image', source: { type: 'base64', media_type: im.tipo, data: im.dados } })),
    { type: 'text', text: texto },
  ];
  const messages = [{ role: 'user', content }];
  const params = {
    model: IA_MODELO,
    max_tokens: 16000,
    system: IA_SISTEMA,
    // A busca roda no servidor da Anthropic; max_uses é o teto de custo por
    // consulta (cada busca é cobrada à parte dos tokens).
    tools: [{
      type: 'web_search_20260209', name: 'web_search', max_uses: 5,
      user_location: { type: 'approximate', country: 'BR', timezone: 'America/Sao_Paulo' },
    }],
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: iaSchema(categorias) } },
    // Recusa do classificador de segurança vira nova tentativa noutro modelo,
    // no servidor da Anthropic — sem isso a resposta simplesmente para.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
  };
  const uso = { entrada: 0, saida: 0, buscas: 0, voltas: 0 };
  let resp;
  for (let i = 0; i < 3; i++) {
    resp = await ia.beta.messages.create({ ...params, messages });
    uso.voltas++;
    uso.entrada += resp.usage.input_tokens || 0;
    uso.saida += resp.usage.output_tokens || 0;
    uso.buscas += (resp.usage.server_tool_use && resp.usage.server_tool_use.web_search_requests) || 0;
    if (resp.stop_reason !== 'pause_turn') break;
    // O laço de busca do servidor pausou: reenvia com o turno parcial anexado
    // e SEM mensagem nova — a API vê o server_tool_use pendente e retoma.
    messages.push({ role: 'assistant', content: resp.content });
  }
  return { resp, uso };
}

// Do mais específico para o mais geral: APIConnectionError herda de APIError.
function iaErroHttp(err) {
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return [502, 'chave da Anthropic recusada — confira ANTHROPIC_API_KEY no Railway'];
  }
  if (err instanceof Anthropic.RateLimitError) return [429, 'a Anthropic pediu para esperar — tente daqui a 1 minuto'];
  if (err instanceof Anthropic.BadRequestError) return [502, 'pedido inválido para a IA (bug nosso) — veja o log do painel'];
  if (err instanceof Anthropic.InternalServerError) return [502, 'a Anthropic está instável agora — tente de novo'];
  if (err instanceof Anthropic.APIConnectionError) return [504, 'a consulta demorou demais — tente com menos fotos'];
  if (err instanceof Anthropic.APIError) return [502, `falha ao falar com a Anthropic (HTTP ${err.status})`];
  return [500, 'erro inesperado — veja o log do painel'];
}

app.get('/api/ia/status', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ativa: IA_ATIVA, limiteDia: IA_LIMITE_DIA, usadasHoje: iaUsadasHoje() });
});

app.post('/api/ia/sugerir', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!IA_ATIVA) return res.status(503).json({ erro: 'ANTHROPIC_API_KEY não configurada' });
  if (iaEmVoo >= IA_MAX_EM_VOO) return res.status(429).json({ erro: 'Já há duas consultas em andamento — aguarde um instante' });
  if (iaUsadasHoje() >= IA_LIMITE_DIA) return res.status(429).json({ erro: `Limite de ${IA_LIMITE_DIA} consultas por dia atingido — volta amanhã` });

  const b = req.body || {};
  const texto = (v, max) => String(v || '').trim().slice(0, max);
  const titulo = texto(b.titulo, 120);
  const categoria = texto(b.categoria, 40);
  const descricao = texto(b.descricaoPublica, 280);
  const estado = D.CONDITIONS.includes(b.estado) ? b.estado : 'Bom';
  const imagens = iaLerFotos(b.fotos);
  if (!titulo && !imagens.length) return res.status(422).json({ erro: 'Dê um nome ou uma foto ao item antes de pedir a sugestão' });

  const pedido = [
    `Item: ${titulo || '(sem nome — identifique pela foto)'}`,
    `Categoria atual: ${categoria || '(nenhuma)'}`,
    `Estado informado: ${estado}`,
    `Descrição atual: ${descricao || '(nenhuma)'}`,
    `Fotos: ${imagens.length || 'nenhuma'}`,
  ].join('\n');

  // Conta antes de chamar: chamada que falha também custou. Num freio de
  // dinheiro, errar para o lado de contar demais é o lado certo.
  iaUsadas++;
  iaEmVoo++;
  try {
    const { resp, uso } = await iaConsultar({ imagens, texto: pedido, categorias: iaCategorias() });
    // Estimativa só para o log (Opus 5.5: US$4/US$20 por milhão; US$0,01 por
    // busca). Não vai para o navegador porque tabela de preço muda.
    const custo = (uso.entrada * 4 + uso.saida * 20) / 1e6 + uso.buscas * 0.01;
    console.log(`[ia] "${titulo.slice(0, 40)}" fotos=${imagens.length} voltas=${uso.voltas} in=${uso.entrada} out=${uso.saida} buscas=${uso.buscas} stop=${resp.stop_reason} modelo=${resp.model} ~US$${custo.toFixed(3)}`);
    if (resp.stop_reason === 'refusal') return res.status(502).json({ erro: 'A IA recusou esta consulta — tente descrever o item de outro jeito' });
    if (resp.stop_reason !== 'end_turn') return res.status(502).json({ erro: 'A resposta veio cortada — tente de novo' });
    const bloco = resp.content.filter(c => c.type === 'text').pop();
    let json;
    try { json = JSON.parse(bloco ? bloco.text : ''); }
    catch (e) { return res.status(502).json({ erro: 'A IA respondeu num formato inesperado — tente de novo' }); }
    const reais = r => (typeof r === 'number' && Number.isFinite(r) ? Math.round(r) * 100 : null);
    const faixa = json.faixaUsadoReais || {};
    // Passa pela mesma normalização que o navegador aplica ao gravar: o que
    // sai daqui é exatamente o que vai parar no item.
    const sugestao = D.normalizeAiSuggestion({
      geradaEm: new Date().toISOString(),
      titulo: json.titulo,
      descricaoPublica: json.descricaoPublica,
      categoriaSugerida: json.categoriaSugerida,
      precoNovoCents: reais(json.precoNovoReais),
      faixaUsadoCents: { min: reais(faixa.min), max: reais(faixa.max) },
      precoSugeridoCents: reais(json.precoSugeridoReais),
      confianca: json.confianca,
      justificativa: json.justificativa,
      comparaveis: (Array.isArray(json.comparaveis) ? json.comparaveis : []).map(c => ({
        titulo: c.titulo, precoCents: reais(c.precoReais), fonte: c.fonte, url: c.url, estado: c.estado,
      })),
    });
    res.json({ sugestao, uso: { entrada: uso.entrada, saida: uso.saida, buscas: uso.buscas } });
  } catch (err) {
    // Classe, status e a mensagem do SDK (que não carrega a chave). Nunca o
    // corpo do pedido: a foto em base64 encheria o log e não diria nada.
    const [status, erro] = iaErroHttp(err);
    console.error('[ia] falhou:', err && err.constructor ? err.constructor.name : typeof err, err && err.status, String(err && err.message || '').slice(0, 300));
    res.status(status).json({ erro });
  } finally {
    iaEmVoo--;
  }
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Painel de Mudança rodando na porta ${PORT} · IA: ${IA_ATIVA ? `ativa (${IA_LIMITE_DIA}/dia)` : 'desligada'}`);
  if (!IA_ATIVA) console.error('[ia] falta ANTHROPIC_API_KEY — o botão "Sugerir com IA" não vai aparecer');
});
