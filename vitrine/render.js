// HTML da vitrine pública, montado no servidor.
//
// Este arquivo é o único que escreve HTML, e é de propósito que ele NÃO conheça
// o endereço do painel: ele recebe um view-model já pronto, com as fotos já
// apontando para o proxy local. Assim não existe caminho pelo qual o domínio do
// painel chegue ao navegador de quem recebeu o link.
//
// Por que renderizar no servidor, e não uma página estática que busca os dados:
// a fonte exige token (que não pode ir para o navegador), o layout de impressão
// precisa do conteúdo presente no momento do print, e uma requisição só pinta a
// página inteira num 4G.

// O escapeHtml do painel usa document.createElement e não roda no node; o
// escapeAttr dele é puro e é o que está copiado aqui. Uma função só, usada em
// texto E em atributo: escapar aspas em texto é inofensivo, e duas funções
// abririam a chance de usar a errada.
function esc(v){
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function nl2br(v){ return esc(v).replace(/\r?\n/g, '<br>'); }

const FONTES = '<link rel="preconnect" href="https://fonts.googleapis.com">'
  + '<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600&family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">';

function cabeca(titulo, o){
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(titulo)}</title>
<meta name="robots" content="noindex, nofollow, noarchive, noimageindex, nosnippet">
<meta name="referrer" content="no-referrer">
<meta name="theme-color" content="#0e1830">
<meta property="og:title" content="${esc(titulo)}">
<meta property="og:description" content="Itens disponíveis na nossa mudança. Marque o que te interessa.">
<meta property="og:type" content="website">
${o.canonical ? `<meta property="og:url" content="${esc(o.canonical)}">` : ''}
${FONTES}
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<style nonce="${esc(o.nonce)}">${o.css}</style>
</head>`;
}

// Cartão de item. `it` já vem com { id, nome, estado, descricao, precoTexto,
// cents, reservado, fotos:[url do proxy] } — nada de dado bruto do painel.
function card(it){
  const capa = it.fotos[0];
  const fotos = it.fotos.join('|');
  return `
  <article class="vt-card${it.reservado ? ' is-res' : ''}" data-id="${esc(it.id)}"
    data-nome="${esc(it.nome)}" data-cents="${it.cents == null ? '' : it.cents}"
    data-preco="${esc(it.precoTexto)}">
    <div class="vt-shot" ${it.fotos.length ? `data-fotos="${esc(fotos)}"` : ''}>
      ${capa
        ? `<img class="vt-photo" src="${esc(capa)}" alt="${esc(it.nome)}" loading="lazy" decoding="async">`
        : `<span class="vt-noshot">sem foto</span>`}
      ${it.fotos.length > 1 ? `<span class="vt-shot-count">1/${it.fotos.length}</span>` : ''}
      ${it.reservado ? '<span class="vt-flag">reservado</span>' : ''}
    </div>
    <div class="vt-body">
      <h2 class="vt-name">${esc(it.nome)}</h2>
      ${it.descricao ? `<p class="vt-desc">${nl2br(it.descricao)}</p>` : ''}
      <div class="vt-meta">
        <span class="vt-cond">${esc(it.estado)}</span>
        <span class="vt-price${it.cents == null ? ' vt-price--open' : ''}">${esc(it.precoTexto)}</span>
      </div>
    </div>
    ${it.reservado
      ? '<p class="vt-res-note">Já tem alguém levando este.</p>'
      : `<label class="vt-pick"><input type="checkbox" class="vt-pick-box"><span>Tenho interesse</span></label>`}
    <span class="vt-mark vt-so-print"></span>
  </article>`;
}

// vm = { titulo, recado, itens[], atualizadoEm, atrasado, whatsapp, urlDaLista, canonical }
function pagina(vm, o){
  const selecionaveis = vm.itens.filter(i => !i.reservado).length;
  return cabeca(vm.titulo, o) + `
<body data-wa="${esc(vm.whatsapp || '')}" data-url="${esc(vm.urlDaLista || '')}" data-chave="${esc(vm.chave)}">
<header class="vt-head stub-line">
  <p class="vt-eyebrow">✈ Mudança para o Canadá</p>
  <h1 class="vt-title">${esc(vm.titulo)}</h1>
  ${vm.recado ? `<p class="vt-msg">${nl2br(vm.recado)}</p>` : ''}
  <div class="vt-strip">
    <div class="vt-strip-cell"><span class="vt-strip-label">Itens</span><span class="vt-strip-value">${vm.itens.length}</span></div>
    ${vm.validadeTexto ? `<div class="vt-strip-cell"><span class="vt-strip-label">Até</span><span class="vt-strip-value amber">${esc(vm.validadeTexto)}</span></div>` : ''}
    <div class="vt-strip-cell vt-so-print"><span class="vt-strip-label">Lista de</span><span class="vt-strip-value">${esc(vm.impressaEm)}</span></div>
  </div>
</header>

${vm.itens.length
  ? `<p class="vt-hint">${vm.whatsapp
      ? 'Marque o que te interessa e toque em “Tenho interesse” — abre o WhatsApp com a lista pronta.'
      : 'Fale com quem te mandou este link para combinar.'}</p>
<main class="vt-grid">${vm.itens.map(card).join('')}</main>`
  : `<p class="vt-empty">Tudo já foi vendido ou reservado. Obrigado pelo interesse!</p>`}

<footer class="vt-foot">
  ${vm.atualizadoEm ? `<p class="vt-foot-when${vm.atrasado ? ' vt-stale' : ''}">Preços atualizados em ${esc(vm.atualizadoEm)}.</p>` : ''}
  <p class="vt-foot-dim">Retirada e pagamento combinados direto com a gente.</p>
  <button class="vt-print" type="button">Salvar em PDF / imprimir</button>
</footer>

${vm.whatsapp && selecionaveis ? `
<div class="vt-bar">
  <div class="vt-bar-sum"><b class="vt-bar-n">Nenhum item</b><span class="vt-bar-total"></span></div>
  <button class="vt-clear" type="button">Limpar</button>
  <a class="vt-cta vt-cta--off" id="vtCta" href="#" target="_blank" rel="noopener noreferrer nofollow">Tenho interesse</a>
</div>` : ''}

<div class="vt-lb" id="vtLb" hidden>
  <img class="vt-lb-img" id="vtLbImg" alt="">
  <button class="vt-lb-nav prev" type="button" title="Anterior">‹</button>
  <button class="vt-lb-nav next" type="button" title="Próxima">›</button>
  <button class="vt-lb-close" type="button" title="Fechar">✕</button>
  <span class="vt-lb-count"></span>
</div>

<script nonce="${esc(o.nonce)}">${o.js}</script>
</body>
</html>`;
}

function aviso(o){
  return cabeca(o.titulo, o) + `
<body class="vt-solo">
<div class="vt-aviso stub-line">
  <p class="vt-eyebrow">✈ Mudança para o Canadá</p>
  <h1 class="vt-title">${esc(o.titulo)}</h1>
  <p class="vt-msg">${esc(o.texto)}</p>
</div>
</body>
</html>`;
}

// Última barreira antes de responder: se por qualquer caminho o endereço do
// painel (ou um caminho /uploads/) apareceu no HTML, é melhor não responder do
// que vazar. Varrer alguns KB por requisição não custa nada perto disso.
function garantirSemPainel(html, agulhas){
  for(const a of agulhas){
    if(a && html.includes(a)) return a;
  }
  return null;
}

module.exports = { pagina, aviso, esc, nl2br, garantirSemPainel };
