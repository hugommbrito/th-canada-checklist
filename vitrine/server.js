// Vitrine pública — o segundo serviço.
//
// Existe separado do painel por um motivo só: o painel mora na raiz de um
// domínio e mostra piso de negociação, comprador e a thread de negociação. Um
// link que circula em grupo de WhatsApp não pode estar no mesmo endereço que
// isso, porque apagar o caminho da URL é a primeira coisa que alguém curioso
// faz. Aqui, o endereço do painel só existe no ambiente deste processo: ele
// nunca vai para o HTML, nem para o <img src> (as fotos passam pelo proxy), nem
// para uma mensagem de erro.
//
// ATENÇÃO: este serviço NÃO tem express.static. Servir a pasta public/ aqui
// publicaria o painel inteiro no domínio público. CSS e JS são lidos no boot e
// embutidos no HTML — é o que mantém "sem build step" sem abrir essa porta.
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const render = require('./render.js');

const PORT = process.env.PORT || 3100;
// Preferir a rede privada do Railway (http://painel.railway.internal:3000):
// assim a URL pública do painel não existe nem como variável de ambiente aqui.
const PAINEL = String(process.env.VITRINE_PAINEL_URL || '').trim().replace(/\/+$/, '');
const TOKEN = String(process.env.VITRINE_TOKEN || '');
const TTL_MS = Number(process.env.VITRINE_CACHE_TTL_MS || 45000);
const STALE_MAX_MS = Number(process.env.VITRINE_STALE_MAX_MS || 6 * 3600 * 1000);
const TIMEOUT_MS = Number(process.env.VITRINE_UPSTREAM_TIMEOUT_MS || 8000);
const TZ = process.env.VITRINE_TZ || 'America/Sao_Paulo';
// Alavanca para depois da mudança: desliga tudo sem tocar no painel.
const DESLIGADA = !!String(process.env.VITRINE_DESLIGADA || '').trim();
const PUBLIC_URL = String(process.env.VITRINE_PUBLIC_URL || '').trim().replace(/\/+$/, '');

const CSS = fs.readFileSync(path.join(__dirname, 'vitrine.css'), 'utf8');
const JS = fs.readFileSync(path.join(__dirname, 'vitrine.client.js'), 'utf8');
const FAVICON = fs.readFileSync(path.join(__dirname, '..', 'public', 'favicon.svg'), 'utf8');

// Uma URL malformada não é "configurado": sem esta checagem o serviço sobe
// parecendo saudável e só falha na primeira visita, com ERR_INVALID_URL vindo
// de dentro do fetch — longe de onde o erro foi cometido.
function motivoUrlInvalida(v) {
  if (!v) return 'não definida';
  if (/\s/.test(v)) return 'contém espaço — confira se o valor foi colado inteiro';
  if (/^["']|["']$/.test(v)) return 'está entre aspas — a Railway não precisa delas, tire-as';
  if (v.includes('${{')) return 'ficou com uma referência ${{...}} sem resolver — confira o nome do serviço na referência';
  let u;
  try { u = new URL(v); } catch (e) {
    return /^https?:\/\//i.test(v)
      ? 'não é uma URL válida'
      : 'falta o esquema no começo — precisa começar com http:// ou https://';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'o esquema tem que ser http:// ou https://';
  if (!u.hostname) return 'não tem hostname';
  return null;
}
const MOTIVO_URL = motivoUrlInvalida(PAINEL);

// Aviso, não erro: a URL é válida, mas quase certamente aponta para o lugar
// errado. Host de rede privada da Railway sem porta explícita significa porta
// 80, e nenhum serviço da Railway escuta em 80 — o app escuta na PORT dele.
// Não é fatal porque alguém pode, em teoria, ter posto o painel atrás de um
// proxy na 80; é aviso porque nas nossas mãos isso nunca foi verdade.
const AVISO_PORTA = (() => {
  if (MOTIVO_URL) return null;
  try {
    const u = new URL(PAINEL);
    if (!/\.railway\.internal$/i.test(u.hostname)) return null;
    if (u.port) return null;
    return 'VITRINE_PAINEL_URL não tem porta, então vai para a 80 — na rede privada da '
      + 'Railway o painel escuta na PORT dele (3000 se você não definiu nenhuma). '
      + 'Acrescente :3000 no fim da URL.';
  } catch (e) { return null; }
})();
const CONFIGURADO = !!(PAINEL && TOKEN && !MOTIVO_URL);
// O host do painel, que a guarda antivazamento procura no HTML antes de responder.
const HOST_PAINEL = (() => {
  try { return PAINEL ? new URL(PAINEL).host : ''; } catch (e) { return ''; }
})();

// Esquema e porta do alvo, sem o hostname. Porta sozinha não identifica ninguém,
// e é o dado que fecha o diagnóstico de ECONNREFUSED: dá para comparar com a
// PORT do painel sem precisar abrir a variável para conferir o que ela diz.
const ALVO = (() => {
  try {
    const u = new URL(PAINEL);
    return { esquema: u.protocol.replace(':', ''), porta: u.port || (u.protocol === 'https:' ? '443' : '80') };
  } catch (e) { return null; }
})();

// Mesma forma de nome que o painel gera (server.js, UPLOAD_NAME_RE). Estrita de
// propósito: o PHOTO_PATH_RE do domain.js aceita "..", inofensivo como src no
// painel e não aqui.
const NOME_FOTO_RE = /^inv-\d+-[0-9a-f]{8}\.(jpg|png|webp)$/i;
const TIPO_POR_EXT = { '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
// Slug: o mesmo formato que domain.js gera, validado antes de qualquer chamada.
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,62})[a-z0-9]$/;

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

// Express 4 não encaminha rejeição de handler async para o middleware de erro:
// sem este embrulho, uma falha deixa a requisição pendurada até o timeout.
const ac = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

app.use((req, res, next) => {
  res.locals.nonce = crypto.randomBytes(16).toString('base64');
  res.set('X-Robots-Tag', 'noindex, nofollow, noarchive, noimageindex, nosnippet');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('X-Content-Type-Options', 'nosniff');
  // connect-src 'none' é a prova formal de que a página não fala com ninguém.
  res.set('Content-Security-Policy', [
    "default-src 'none'",
    "img-src 'self'",
    `style-src 'nonce-${res.locals.nonce}' https://fonts.googleapis.com`,
    'font-src https://fonts.gstatic.com',
    `script-src 'nonce-${res.locals.nonce}'`,
    "connect-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; '));
  next();
});

// ---- Cache em memória ----
// A vitrine não pode bater no painel a cada visita: o link cai num grupo e dez
// pessoas abrem no mesmo minuto.
const cache = new Map();     // slug -> { at, vm, fim, fotos:Set }
const emVoo = new Map();     // slug -> Promise (single-flight)
const MAX_ENTRADAS = 50;
// Último resultado de conversa com o painel, só para o /healthz poder ser
// honesto sobre de quem é o problema.
let ultimoPainel = { ok: null, quando: null };

function fmtQuando(iso) {
  try {
    return new Intl.DateTimeFormat('pt-BR', {
      timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
    }).format(new Date(iso)).replace(',', ' às');
  } catch (e) { return ''; }
}
function hojeISO() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
}

async function buscaNoPainel(slug) {
  const r = await fetch(`${PAINEL}/api/vitrine/${encodeURIComponent(slug)}`, {
    headers: { 'X-Vitrine-Token': TOKEN },
    redirect: 'error',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  ultimoPainel = { ok: true, quando: new Date().toISOString() };
  if (r.status === 404 || r.status === 410) return { fim: true };
  if (!r.ok) {
    // O status vai num campo próprio para o log poder mostrá-lo: 401 (token
    // diferente entre os dois serviços) e 503 (painel sem VITRINE_TOKEN) são
    // problemas distintos, e ambos apareciam no log só como "Error".
    const err = new Error('painel respondeu ' + r.status);
    err.statusUpstream = r.status;
    throw err;
  }
  return { dados: await r.json() };
}

// Transforma a resposta do painel no view-model da página. É aqui, e em nenhum
// outro lugar, que o caminho da foto vira URL do proxy: depois deste ponto não
// existe mais nada que aponte para o painel.
function paraViewModel(slug, d) {
  const fotos = new Set();
  const itens = (d.itens || []).map(it => {
    const nomes = (it.fotos || []).filter(n => NOME_FOTO_RE.test(n));
    nomes.forEach(n => fotos.add(n));
    return {
      id: it.id,
      nome: it.nome,
      estado: it.estado,
      descricao: it.descricao,
      cents: it.preco ? it.preco.cents : null,
      precoTexto: (it.preco && it.preco.cents != null) ? it.preco.brl : 'a combinar',
      reservado: !!it.reservado,
      fotos: nomes.map(n => `/f/${encodeURIComponent(slug)}/${encodeURIComponent(n)}`),
    };
  });
  const lista = d.lista || {};
  return {
    vm: {
      chave: slug,
      titulo: 'Itens à venda',
      recado: lista.recado || '',
      whatsapp: String(lista.whatsapp || '').replace(/\D/g, ''),
      validade: lista.validade || null,
      validadeTexto: lista.validade ? lista.validade.split('-').reverse().slice(0, 2).join('/') : '',
      itens,
      atualizadoEm: d.geradoEm ? fmtQuando(d.geradoEm) : '',
      geradoEm: d.geradoEm,
      impressaEm: fmtQuando(new Date().toISOString()),
      urlDaLista: PUBLIC_URL ? `${PUBLIC_URL}/l/${slug}` : '',
      canonical: PUBLIC_URL ? `${PUBLIC_URL}/l/${slug}` : '',
    },
    fotos,
  };
}

function guardaEntrada(slug, entrada) {
  cache.set(slug, entrada);
  // Teto de memória: o Map preserva ordem de inserção, então o mais velho sai.
  while (cache.size > MAX_ENTRADAS) cache.delete(cache.keys().next().value);
}

// Devolve { estado: 'ok'|'fim'|'fora', vm, atrasado }.
async function pegaLista(slug) {
  const agora = Date.now();
  const cached = cache.get(slug);
  if (cached && agora - cached.at < TTL_MS) {
    return cached.fim ? { estado: 'fim' } : { estado: 'ok', vm: cached.vm, atrasado: false };
  }
  if (!CONFIGURADO) return { estado: 'fora' };

  let p = emVoo.get(slug);
  if (!p) {
    p = buscaNoPainel(slug).finally(() => emVoo.delete(slug));
    emVoo.set(slug, p);
  }
  try {
    const r = await p;
    if (r.fim) {
      // Cacheia a negativa: sem isto, um link morto circulando martela o painel.
      guardaEntrada(slug, { at: Date.now(), fim: true });
      return { estado: 'fim' };
    }
    const { vm, fotos } = paraViewModel(slug, r.dados);
    guardaEntrada(slug, { at: Date.now(), vm, fotos, fim: false });
    return { estado: 'ok', vm, atrasado: false };
  } catch (err) {
    const codigo = codigoDoErro(err);
    ultimoPainel = {
      ok: false, quando: new Date().toISOString(),
      status: err.statusUpstream || null, codigo,
    };
    // Nome e código, nunca a mensagem — ver a nota em sondaPainel().
    console.error('[vitrine] painel indisponível:',
      err.statusUpstream ? 'painel respondeu ' + err.statusUpstream
        : err.name + (codigo ? ' (' + codigo + ')' : ''));
    // Painel fora do ar: melhor a lista de meia hora atrás que uma página de
    // erro. Passado o teto, não: vender o que já foi vendido é pior.
    if (cached && !cached.fim && agora - cached.at < STALE_MAX_MS) {
      return { estado: 'ok', vm: cached.vm, atrasado: agora - cached.at > 3600 * 1000 };
    }
    if (cached && cached.fim) return { estado: 'fim' };
    return { estado: 'fora' };
  }
}

// ---- Contagem de visitas ----
// Visita é uma pessoa abrindo a página, não um fetch de dados (o cache faz uma
// coisa não ser a outra). E o preview de link do WhatsApp abre a página sozinho
// quando alguém cola o link — quem cola é o próprio casal, então não conta.
const ROBO_RE = /bot|crawl|spider|preview|whatsapp|facebookexternalhit|telegram|slurp|curl|wget|python|node-fetch|headlesschrome|monitor/i;
const SAL = crypto.randomBytes(16);
const vistos = new Map();    // hash -> quando
const DEDUP_MS = 30 * 60 * 1000;
setInterval(() => {
  const corte = Date.now() - DEDUP_MS;
  for (const [k, v] of vistos) if (v < corte) vistos.delete(k);
}, 5 * 60 * 1000).unref();

function contaVisita(req, slug) {
  if (!CONFIGURADO) return;
  const ua = req.get('user-agent') || '';
  if (ROBO_RE.test(ua)) return;
  // Hash truncado, com sal sorteado a cada processo: serve para não contar duas
  // vezes quem recarrega, e não serve para identificar ninguém. Nada é gravado
  // em disco, nada vai para o painel além do "mais um".
  const h = crypto.createHash('sha256').update(SAL).update(slug + '|' + (req.ip || '') + '|' + ua).digest('base64').slice(0, 16);
  const agora = Date.now();
  if (vistos.has(h) && agora - vistos.get(h) < DEDUP_MS) return;
  vistos.set(h, agora);
  fetch(`${PAINEL}/api/vitrine/${encodeURIComponent(slug)}/visita`, {
    method: 'POST',
    headers: { 'X-Vitrine-Token': TOKEN },
    redirect: 'error',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch(() => {});   // best-effort: contador não atrapalha quem está lendo
}

// ---- Páginas ----
function responde(res, status, html) {
  // Guarda antivazamento: se por qualquer caminho o endereço do painel apareceu
  // no HTML, é melhor não responder do que vazar.
  const achou = render.garantirSemPainel(html, [HOST_PAINEL, '/uploads/']);
  if (achou) {
    console.error('[vitrine] BLOQUEADO: o HTML continha', achou);
    return res.status(500).type('html').send(render.aviso({
      titulo: 'Um instante', texto: 'Não conseguimos montar a página agora. Tente de novo em alguns minutos.',
      nonce: res.locals.nonce, css: CSS,
    }));
  }
  res.status(status).type('html').send(html);
}

// Mesmos bytes para "não existe", "desligada" e "vencida": distinguir criaria um
// oráculo de quais links existem, e o texto abaixo serve para os três casos.
function paginaSemLink(res) {
  responde(res, 404, render.aviso({
    titulo: 'Link não encontrado',
    texto: 'Este link não está mais válido. Se alguém te mandou, peça um link novo.',
    nonce: res.locals.nonce, css: CSS,
  }));
}
function paginaIndisponivel(res) {
  res.set('Retry-After', '120');
  responde(res, 503, render.aviso({
    titulo: 'Um instante',
    texto: 'Não conseguimos carregar a lista agora. Tente de novo em alguns minutos.',
    nonce: res.locals.nonce, css: CSS,
  }));
}

app.get('/l/:slug', ac(async (req, res) => {
  const slug = String(req.params.slug || '');
  res.set('Cache-Control', 'no-store');   // o cache é deste servidor, não do navegador
  if (DESLIGADA || !SLUG_RE.test(slug) || slug.length < 12) return paginaSemLink(res);

  const r = await pegaLista(slug);
  if (r.estado === 'fim') return paginaSemLink(res);
  if (r.estado === 'fora') return paginaIndisponivel(res);

  // Validade reavaliada aqui, e não só no fetch: assim a lista vence sozinha
  // mesmo servida do cache e mesmo com o painel fora do ar.
  if (r.vm.validade && r.vm.validade < hojeISO()) return paginaSemLink(res);

  const vm = Object.assign({}, r.vm, { atrasado: r.atrasado, impressaEm: fmtQuando(new Date().toISOString()) });
  responde(res, 200, render.pagina(vm, { nonce: res.locals.nonce, css: CSS, js: JS }));
  contaVisita(req, slug);   // depois de responder: nunca atrasa a página
}));

// Proxy de foto, com escopo na lista. Nunca aceita URL — só nome de arquivo, e
// só se aquele arquivo pertence a um item visível daquela lista.
app.get('/f/:slug/:nome', ac(async (req, res) => {
  const slug = String(req.params.slug || '');
  const nome = path.basename(String(req.params.nome || ''));
  if (DESLIGADA || !SLUG_RE.test(slug) || !NOME_FOTO_RE.test(nome)) return res.status(404).end();

  const r = await pegaLista(slug);
  if (r.estado !== 'ok') return res.status(404).end();
  const entrada = cache.get(slug);
  if (!entrada || !entrada.fotos || !entrada.fotos.has(nome)) return res.status(404).end();

  const tipo = TIPO_POR_EXT[path.extname(nome).toLowerCase()];
  if (!tipo) return res.status(404).end();

  let up;
  try {
    up = await fetch(`${PAINEL}/api/vitrine/${encodeURIComponent(slug)}/foto/${encodeURIComponent(nome)}`, {
      headers: { 'X-Vitrine-Token': TOKEN },
      // Um Location do painel jamais pode chegar ao navegador: seria o domínio
      // vazando pelo caminho mais bobo.
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    console.error('[vitrine] foto indisponível:', err.name);
    return res.status(502).end();
  }
  if (!up.ok || !up.body) return res.status(404).end();

  // Content-Type derivado da extensão, nunca do upstream — mesma regra do painel
  // (e é o que torna inofensivo não conferir os magic bytes).
  res.type(tipo);
  // Uma hora, e não o "365d immutable" do painel: aqui a URL é revogável (item
  // vendido sai da lista), e cache de um ano tornaria a revogação inútil.
  res.set('Cache-Control', 'public, max-age=3600');
  res.set('X-Robots-Tag', 'noindex, noimageindex');
  const fluxo = Readable.fromWeb(up.body);
  req.on('close', () => fluxo.destroy());
  fluxo.pipe(res);
}));

app.get('/favicon.svg', (req, res) => {
  res.type('image/svg+xml').set('Cache-Control', 'public, max-age=604800').send(FAVICON);
});

app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send('User-agent: *\nDisallow: /\n');
});

// Sonda opcional do painel. O /healthz sozinho só sabe da última conversa que
// aconteceu, e num processo recém-subido isso é "nenhuma" — que é justamente
// quando alguém está olhando. A sonda pergunta na hora, com um slug que não
// existe: o status da resposta distingue os quatro modos de falha sem depender
// de ter havido tráfego antes.
// Só código de texto (ENOTFOUND, ECONNREFUSED...). DOMException carrega um
// `code` numérico legado — 23 para timeout — que não informa nada a quem lê.
function codigoDoErro(err) {
  const c = (err && err.cause && err.cause.code) || (err && err.code) || null;
  return typeof c === 'string' && c ? c : null;
}

const PROBE_SLUG = 'probe-inexistente-000000000000';
const PROBE_THROTTLE_MS = 10000;
let ultimaSonda = { em: 0, resultado: null };

async function sondaPainel() {
  if (MOTIVO_URL) return { veredito: 'VITRINE_PAINEL_URL ' + MOTIVO_URL };
  if (!TOKEN) return { veredito: 'falta VITRINE_TOKEN neste serviço' };
  if (!CONFIGURADO) return { veredito: 'faltam VITRINE_PAINEL_URL e/ou VITRINE_TOKEN neste serviço' };
  // Throttle: /healthz é público, e sem isto viraria um jeito de fazer a
  // vitrine martelar o painel de graça.
  if (ultimaSonda.resultado && Date.now() - ultimaSonda.em < PROBE_THROTTLE_MS) {
    return Object.assign({}, ultimaSonda.resultado, { deCache: true });
  }
  let r;
  try {
    const up = await fetch(`${PAINEL}/api/vitrine/${PROBE_SLUG}`, {
      headers: { 'X-Vitrine-Token': TOKEN },
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const veredito =
      up.status === 404 || up.status === 410 ? 'ok: painel alcançado e token aceito'
      : up.status === 401 ? 'VITRINE_TOKEN diferente entre os dois serviços'
      : up.status === 503 ? 'o painel está sem VITRINE_TOKEN'
      : 'o painel respondeu ' + up.status + ', que não era esperado aqui';
    r = { status: up.status, veredito };
  } catch (err) {
    // Nome e código do erro, nunca a mensagem: a de um fetch falho carrega o
    // endereço do painel no `cause`. Um código como ENOTFOUND não carrega
    // endereço nenhum, e é ele que separa "nome errado" de "porta errada".
    const codigo = codigoDoErro(err);
    const porCodigo = {
      ENOTFOUND: 'o hostname do painel não resolve — confira o nome do serviço em VITRINE_PAINEL_URL (na Railway é <nome-do-serviço>.railway.internal)',
      EAI_AGAIN: 'a resolução de DNS falhou temporariamente — se persistir, confira o hostname em VITRINE_PAINEL_URL',
      ECONNREFUSED: AVISO_PORTA
        ? 'o hostname resolve, mas nada aceita conexão na porta 80. ' + AVISO_PORTA
        : 'o hostname resolve, mas nada aceita conexão na porta '
          + (ALVO ? ALVO.porta : '?') + '. Compare esta porta com a PORT do serviço do painel '
          + '(se ele não define PORT, escuta na 3000)',
      ERR_INVALID_URL: 'VITRINE_PAINEL_URL não é uma URL válida — as causas comuns são falta de http:// no começo, aspas em volta do valor, espaço no meio, ou uma referência ${{...}} que não resolveu',
      ECONNRESET: 'a conexão foi cortada no meio — pode ser o painel reiniciando',
      ETIMEDOUT: 'a conexão não completou — rede privada indisponível entre os dois serviços, ou porta errada',
      CERT_HAS_EXPIRED: 'certificado do painel expirado',
    };
    r = {
      status: null,
      erro: err.name,
      codigo,
      veredito: err.name === 'TimeoutError'
        ? 'o painel não respondeu dentro do tempo limite'
        : (porCodigo[codigo] || 'não foi possível conectar ao painel — confira VITRINE_PAINEL_URL, e se o painel está no ar'),
    };
  }
  ultimaSonda = { em: Date.now(), resultado: r };
  return r;
}

// O "servico" existe para pegar o erro de deploy mais provável: o Railway rodar
// `npm start` neste serviço e subir um segundo painel, vazio, num endereço
// público. Confira isto antes de mandar qualquer link.
app.get('/healthz', ac(async (req, res) => {
  // ?probe=1 pergunta ao painel agora. Sem ele, o healthz continua sendo o
  // relatório barato de sempre, que não gera tráfego nenhum.
  const sonda = req.query.probe ? await sondaPainel() : null;
  res.set('Cache-Control', 'no-store').json({
    servico: 'vitrine',
    ok: CONFIGURADO && !DESLIGADA,
    configurado: CONFIGURADO,
    // O motivo, quando há: sem isto "configurado: false" não diz o que corrigir.
    painelUrl: MOTIVO_URL ? 'inválida: ' + MOTIVO_URL : 'ok',
    // Sem o hostname, de propósito: ver a nota em ALVO.
    painelEsquema: ALVO ? ALVO.esquema : null,
    painelPorta: ALVO ? ALVO.porta : null,
    aviso: AVISO_PORTA,
    desligada: DESLIGADA,
    sonda,
    // Nunca entra no `ok`: painel fora do ar é problema do painel, e derrubar o
    // healthcheck daqui só faria o Railway reiniciar quem está são.
    painel: ultimoPainel.ok === null ? 'ainda não consultado' : (ultimoPainel.ok ? 'ok' : 'inalcançável'),
    // 401 = token diferente entre os serviços; 503 = painel sem VITRINE_TOKEN;
    // null = nem chegou a responder (URL errada, painel fora, timeout).
    painelStatus: ultimoPainel.status || null,
    // ENOTFOUND = hostname errado; ECONNREFUSED = porta errada ou painel fora.
    painelCodigo: ultimoPainel.codigo || null,
    painelEm: ultimoPainel.quando,
    // Zero num processo recém-subido não quer dizer que algo esteja errado:
    // quer dizer que ninguém abriu lista ainda. Daí a sonda.
    listasEmCache: cache.size,
  });
}));

// Raiz e qualquer outra coisa: a mesma página de link inválido. Nada aqui conta
// que existe um painel, nem quantas listas existem.
app.use((req, res) => paginaSemLink(res));

// Erro: o nome do erro vai para o log (a mensagem de um fetch falho carrega o
// endereço do painel no cause), e para a página vai texto fixo.
app.use((err, req, res, next) => {
  console.error('[vitrine] erro:', err && err.name);
  if (res.headersSent) return;
  paginaIndisponivel(res);
});

app.listen(PORT, () => {
  console.log(`[vitrine] no ar na porta ${PORT} · painel: ${CONFIGURADO ? 'configurado' : 'NÃO CONFIGURADO'} · ttl: ${Math.round(TTL_MS / 1000)}s${DESLIGADA ? ' · DESLIGADA' : ''}`);
  if (MOTIVO_URL) console.error('[vitrine] VITRINE_PAINEL_URL ' + MOTIVO_URL + ' — nenhuma lista vai abrir');
  else if (!TOKEN) console.error('[vitrine] falta VITRINE_TOKEN — nenhuma lista vai abrir');
  if (AVISO_PORTA) console.error('[vitrine] ATENÇÃO: ' + AVISO_PORTA);
});
