const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');
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
    temFoto: !!it.photo,
    observacoes: it.notes || null,
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

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Painel de Mudança rodando na porta ${PORT}`);
});
