const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');

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

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Painel de Mudança rodando na porta ${PORT}`);
});
