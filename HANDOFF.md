# Handoff — Painel de Mudança (Hugo & Taís)

## Contexto

Ferramenta de acompanhamento das demandas pré-mudança (imigração, trabalho, financeiro,
pessoal/doméstico, família, saúde) durante o processo de imigração para Toronto, Canadá.
Uso a dois — Hugo e a esposa, Taís — precisando de edição compartilhada.

O protótipo atual foi criado como **artifact HTML dentro do Claude.ai** (chat), usando a
API de storage própria dos artifacts (`window.storage`). Este handoff existe para você
(Claude Code) avaliar se vale a pena evoluir isso para uma aplicação "de verdade" fora do
ambiente de artifacts, e por onde começar.

**Arquivo fonte atual:** `painel-mudanca.html` (mesmo diretório deste handoff).
Single-file HTML/CSS/JS vanilla — sem build step, sem dependências externas além de fontes
do Google Fonts via `<link>`.

---

## ⚠️ Ponto crítico antes de tocar no código

O arquivo usa `window.storage.get/set(key, value, shared)`, uma API **exclusiva do
runtime de artifacts do Claude.ai**. Ela não existe em navegador comum, Node, nem em
nenhum outro ambiente. Se este projeto for rodar fora do Claude.ai (ex: deploy próprio,
app real), **isso precisa ser inteiramente substituído** por uma camada de persistência
real antes de qualquer outra coisa — o resto do código (render, modais, etc.) pode ser
reaproveitado quase como está, mas sem storage funcional o app não segura estado nenhum.

Duas chaves usadas hoje, todas com `shared: true` (visível a qualquer um que abra o
artifact, sem autenticação):
- `toronto-tracker-tasks` → array JSON de tarefas
- `toronto-tracker-categories` → array JSON de strings (nomes de categorias)
- `toronto-tracker-movedate` → string `YYYY-MM-DD`

---

## Modelo de dados atual

```ts
type Task = {
  id: string;               // "task-<timestamp>"
  title: string;
  status: 'A fazer' | 'Em andamento' | 'Concluído';
  category: string;         // referencia por nome, não por id — ver observação abaixo
  owner: 'Hugo' | 'Taís' | 'Ambos';
  priority: 'Alta' | 'Média' | 'Baixa';
  deadline: string | null;  // "YYYY-MM-DD" ou null
  checklist: ChecklistItem[];
};

type ChecklistItem = {
  id: string;      // "ci-<timestamp><random>"
  text: string;
  done: boolean;
};

// categories: string[] — lista simples de nomes, sem id próprio.
// Categoria "Sem categoria" é criada automaticamente quando uma categoria
// com tarefas associadas é excluída (fallback, nunca deletável).
```

**Observação de design a revisitar:** categorias são referenciadas por *nome* (string),
não por id estável. Renomear uma categoria hoje funciona via find-and-replace em todas as
tarefas (`tasks.forEach(t => t.category === oldName && (t.category = newName))`). Isso é
frágil (colisão de nomes, case-sensitivity tratada manualmente) e seria o primeiro
refactor natural ao migrar para um backend real — trocar para `categoryId` com uma tabela
própria de categorias.

---

## Features implementadas

- Board estilo kanban (3 colunas: A fazer / Em andamento / Concluído)
- CRUD completo de tarefas (criar, editar, avançar/voltar status, excluir)
- Categorias: criar, renomear (propaga para tarefas existentes), excluir (com
  reatribuição das tarefas órfãs para "Sem categoria")
- Checklist por tarefa (subtarefas com toggle, expansível direto no card)
- Filtro por categoria (via chips de resumo, clicáveis) e por responsável
- Resumo de contagem por categoria (chips no topo, com total e concluídas)
- Data prevista da mudança + contador de dias restantes
- Indicador visual de tarefas atrasadas (prazo vencido e não concluídas)
- Tema visual próprio (paleta navy + âmbar, tipografia Fraunces/Inter/IBM Plex Mono,
  motivo "boarding pass" — ver seção de design abaixo)

## O que NÃO existe ainda

- Autenticação / distinção real de usuário (owner é só um campo de texto, não login)
- Notificações de prazo (e-mail, push, etc.)
- Histórico/auditoria de mudanças (quem editou o quê e quando)
- Acesso mobile nativo (é responsivo, mas é só a página web do artifact)
- Testes automatizados
- Qualquer tipo de persistência fora do `window.storage` do Claude.ai

---

## Se a decisão for evoluir para uma aplicação própria

Dado o stack que o Hugo já usa em outros projetos pessoais (HMMB Finance, MyBujo):
React/Vite no front, NestJS + PostgreSQL no back, deploy em Hetzner via Coolify por
custo. Sugestão de caminho incremental, do mais simples ao mais robusto:

1. **Mais simples — Google Sheets/planilha compartilhada.** Se o objetivo é só resolver
   o problema real (acompanhar demandas a dois) sem manter software, migrar os mesmos
   campos para uma planilha compartilhada resolve com zero manutenção. Vale considerar
   antes de investir em código.
2. **Meio-termo — mesmo HTML, storage trocado.** Trocar `window.storage` por
   `localStorage` + export/import manual de JSON, ou por um backend mínimo tipo
   Supabase/Firebase (CRUD simples, sem precisar montar API própria). Mantém 100% do
   front atual.
3. **Completo — stack própria.** NestJS + PostgreSQL (schema já meio que está pronto no
   modelo de dados acima — tasks, categories, checklist_items como tabelas), front em
   React/Vite reaproveitando a estrutura visual e os componentes deste HTML, deploy em
   Hetzner/Coolify. Only worth it if o Hugo quiser controle total ou usar isso como mais
   um projeto pessoal de portfólio (como fez com HMMB Finance/MyBujo).

## Design system usado (para manter consistência se evoluir)

- Paleta: navy (`#0e1830`, `#14213d`, `#1b2a4a`) + âmbar (`#e8a33d`) como accent, paper
  cream (`#f6f1e4`) para os cards, teal (`#3e8e7e`) para "sucesso/concluído", coral
  (`#d9635a`) para atrasos/exclusão
  como se fossem cartões de passagem/ticket)
- Tipografia: Fraunces (display/serifado, títulos), Inter (corpo), IBM Plex Mono
  (labels, datas, dados — sensação de "código de embarque")
- Motivo visual: cartão de embarque / passagem aérea (linha pontilhada com "furos" nas
  bordas simulando canhoto de ticket), coerente com o tema da mudança para o Canadá

---

## Próximos passos sugeridos (se for continuar aqui)

- [ ] Decidir se o projeto continua como artifact do Claude.ai ou vira app próprio
- [ ] Se virar app: definir hosting/storage (ver opções acima) antes de mexer em UI
- [ ] Refatorar categorias para usar `id` estável em vez de nome como chave
- [ ] Adicionar campo de notas/observações por tarefa (hoje só há título + checklist)
- [ ] Avaliar se falta um filtro por "atrasadas" ou por "prazo esta semana"
