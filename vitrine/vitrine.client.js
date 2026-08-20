// JS da vitrine. Não fala com rede nenhuma: os dados dos itens vêm em data-*
// nos próprios cartões (uma fonte de verdade, e sem o risco clássico de escapar
// JSON dentro de <script>). O que ele faz é seleção, total, link do WhatsApp,
// galeria e impressão.
(function(){
  var corpo = document.body;
  var CHAVE = 'vt:v1:' + (corpo.dataset.chave || '');
  var FONE = (corpo.dataset.wa || '').replace(/\D/g, '');
  var URL_LISTA = corpo.dataset.url || '';
  var cards = [].slice.call(document.querySelectorAll('.vt-card'));
  var barN = document.querySelector('.vt-bar-n');
  var barTotal = document.querySelector('.vt-bar-total');
  var cta = document.getElementById('vtCta');

  // localStorage joga exceção no Safari em aba privada. A página não pode morrer
  // por causa da lembrança de uma seleção.
  function lerSel(){
    try{ return new Set(JSON.parse(localStorage.getItem(CHAVE) || '[]')); }
    catch(e){ return new Set(); }
  }
  function gravarSel(sel){
    try{ localStorage.setItem(CHAVE, JSON.stringify(Array.from(sel))); }catch(e){}
  }

  function moeda(cents){
    var v = Math.round(Number(cents) || 0) / 100;
    var exato = (cents % 100) === 0;
    return 'R$ ' + v.toLocaleString('pt-BR', {
      minimumFractionDigits: exato ? 0 : 2,
      maximumFractionDigits: exato ? 0 : 2
    });
  }

  var sel = lerSel();
  // Item que saiu da lista desde a última visita (vendido, ou reservado agora)
  // não pode ressuscitar na seleção de quem volta.
  var vivos = {};
  cards.forEach(function(c){ if(!c.classList.contains('is-res')) vivos[c.dataset.id] = true; });
  var limpou = false;
  sel.forEach(function(id){ if(!vivos[id]){ sel.delete(id); limpou = true; } });
  if(limpou) gravarSel(sel);

  function mensagem(){
    var linhas = ['Oi! Vi a lista de itens da mudança e tenho interesse em:', ''];
    var soma = 0, semPreco = 0;
    cards.forEach(function(c){
      if(!sel.has(c.dataset.id)) return;
      var cents = c.dataset.cents === '' ? null : Number(c.dataset.cents);
      if(cents == null) semPreco++; else soma += cents;
      linhas.push('• ' + c.dataset.nome + ' — ' + (cents == null ? 'a combinar' : moeda(cents)));
    });
    linhas.push('');
    if(soma) linhas.push('Total dos itens com preço: ' + moeda(soma));
    if(semPreco) linhas.push(semPreco === 1 ? '(1 item a combinar)' : '(' + semPreco + ' itens a combinar)');
    // O endereço da própria lista, para quem recebe saber de qual link a pessoa
    // veio. Não revela nada novo: quem está lendo já tem essa URL.
    if(URL_LISTA) linhas.push('Lista: ' + URL_LISTA);
    var texto = linhas.join('\n');
    // Teto de segurança: WhatsApp engasga com texto muito longo.
    return texto.length > 1200 ? texto.slice(0, 1180) + '\n…e mais alguns itens' : texto;
  }

  function pintar(){
    var n = 0, soma = 0, semPreco = 0;
    cards.forEach(function(c){
      var on = sel.has(c.dataset.id);
      c.classList.toggle('is-sel', on);
      var box = c.querySelector('.vt-pick-box');
      if(box) box.checked = on;
      if(on){
        n++;
        var cents = c.dataset.cents === '' ? null : Number(c.dataset.cents);
        if(cents == null) semPreco++; else soma += cents;
      }
    });
    if(barN){
      barN.textContent = n === 0 ? 'Nenhum item' : (n === 1 ? '1 item' : n + ' itens');
      barTotal.textContent = n === 0
        ? 'marque o que te interessa'
        // Sem nenhum item com preço, "R$ 0" seria mentira: some o valor.
        : (soma ? moeda(soma) : '') + (semPreco ? (soma ? ' + ' : '') + semPreco + ' a combinar' : '');
    }
    if(cta){
      cta.classList.toggle('vt-cta--off', n === 0);
      // href atualizado a cada mudança, e não no clique: assim segurar o link
      // para copiar no celular também funciona.
      cta.href = n && FONE ? 'https://wa.me/' + FONE + '?text=' + encodeURIComponent(mensagem()) : '#';
    }
  }

  cards.forEach(function(c){
    var box = c.querySelector('.vt-pick-box');
    if(box) box.addEventListener('change', function(){
      if(box.checked) sel.add(c.dataset.id); else sel.delete(c.dataset.id);
      gravarSel(sel);
      pintar();
    });
    var desc = c.querySelector('.vt-desc');
    if(desc) desc.addEventListener('click', function(){ desc.classList.toggle('vt-desc--full'); });
  });

  var limpar = document.querySelector('.vt-clear');
  if(limpar) limpar.addEventListener('click', function(){ sel.clear(); gravarSel(sel); pintar(); });

  var imprimir = document.querySelector('.vt-print');
  if(imprimir) imprimir.addEventListener('click', function(){ window.print(); });

  // ---- galeria: mesma mecânica da do painel (setas, Esc, contador) ----
  var lb = document.getElementById('vtLb');
  var lbImg = document.getElementById('vtLbImg');
  var lbCount = lb ? lb.querySelector('.vt-lb-count') : null;
  var prev = lb ? lb.querySelector('.vt-lb-nav.prev') : null;
  var next = lb ? lb.querySelector('.vt-lb-nav.next') : null;
  var atual = { fotos: [], i: 0 };

  function pintarGaleria(){
    var n = atual.fotos.length;
    if(!n) return fechar();
    atual.i = ((atual.i % n) + n) % n;
    lbImg.src = atual.fotos[atual.i];
    lbCount.textContent = n > 1 ? (atual.i + 1) + '/' + n : '';
    prev.hidden = next.hidden = n < 2;
  }
  function abrir(fotos, i){
    atual = { fotos: fotos, i: i || 0 };
    pintarGaleria();
    lb.hidden = false;
    document.body.style.overflow = 'hidden';
  }
  function fechar(){
    lb.hidden = true;
    lbImg.removeAttribute('src');
    document.body.style.overflow = '';
  }
  document.querySelectorAll('.vt-shot[data-fotos]').forEach(function(shot){
    shot.addEventListener('click', function(){ abrir(shot.dataset.fotos.split('|'), 0); });
  });
  if(lb){
    lb.addEventListener('click', function(e){ if(e.target === lb) fechar(); });
    lb.querySelector('.vt-lb-close').addEventListener('click', fechar);
    prev.addEventListener('click', function(){ atual.i--; pintarGaleria(); });
    next.addEventListener('click', function(){ atual.i++; pintarGaleria(); });
    document.addEventListener('keydown', function(e){
      if(lb.hidden) return;
      if(e.key === 'Escape') fechar();
      if(e.key === 'ArrowLeft'){ atual.i--; pintarGaleria(); }
      if(e.key === 'ArrowRight'){ atual.i++; pintarGaleria(); }
    });
  }

  pintar();
})();
