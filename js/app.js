import { createStore, PREFS_PADRAO } from './store.js?v=20261117191936';
import { MESES, MESES_CURTO, indexMeses, linhaMes, linhasDoAno, estatisticas, anosComDados, mesTemDados, aplicarLancamentos } from './calc.js?v=20261117191936';
import { fmtBRL, fmtNum, fmtPct, esc, parseExpr, toInputText, round2 } from './util.js?v=20261117191936';
import { lerPlanilha } from './importer.js?v=20261117191936';
import { lerExtrato, normDesc } from './extrato.js?v=20261117191936';
import { CLASSES_SUGERIDAS, textoBase, regraPara, sugerir, regraPadrao, detectarTransferencia, palavrasChave, mesmaLoja } from './classes.js?v=20261117191936';
import { ILUSTRA } from './ilustra.js?v=20261117191936';

const app = document.getElementById('app');
const S = {
  store: null,
  user: null,
  data: dadosVazios(),
  perfilId: null,
  charts: [],
};

/* ================================================================ helpers */
function toast(msg, tipo = 'ok') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = `show ${tipo}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.className = ''), 3200);
}

const cls = (v) => (v === null || v === undefined ? '' : v < 0 ? 'neg' : v > 0 ? 'pos' : '');
const money = (v) => `<span class="${cls(v)}">${fmtBRL(v)}</span>`;
/** Valor em destaque com centavos menores: R$ 1.566<small>,15</small> */
const grande = (v) => {
  const s = fmtBRL(v);
  const m = /^(.*)(,\d{2})$/.exec(s);
  return m ? `${m[1]}<small>${m[2]}</small>` : s;
};

/* tema: 'light' (padrão), 'dark' ou 'auto' (segue o aparelho) */
function temaAtual() { try { return localStorage.getItem('financas-tema') || 'dark'; } catch { return 'dark'; } }
function definirTema(t) {
  try { localStorage.setItem('financas-tema', t); } catch { /* sem armazenamento */ }
  if (t === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
  render();
}
function seletorTema() {
  const t = temaAtual();
  return `<div class="tema" role="group" aria-label="Tema">
    ${[['light', 'Claro'], ['auto', 'Auto'], ['dark', 'Escuro']].map(([v, n]) =>
      `<button type="button" data-tema="${v}" class="${t === v ? 'ativo' : ''}" aria-pressed="${t === v}">${n}</button>`).join('')}
  </div>`;
}

/* modo de uso: 'organizacao' (planilha) ou 'controle' (extratos e categorias) */
const MODOS = {
  organizacao: {
    nome: 'Organização',
    texto: 'Como a planilha: você lança os totais do mês (receita, débito, cada cartão, investimento, saldo) e vê o resumo do mês e do ano.',
  },
  controle: {
    nome: 'Controle',
    texto: 'Para acompanhar tudo de perto: importa os extratos das contas e cartões, classifica cada gasto (pessoal ou empresa) e vê quanto foi para cada categoria.',
  },
};
function modo() { return prefs().modo || 'organizacao'; }
function ehControle() { return modo() === 'controle'; }
async function definirModo(m) {
  S.data.prefs[S.perfilId] = await S.store.savePrefs(S.perfilId, { ...prefs(), modo: m });
}
/** Cartões para escolher o modo (conta nova e Ajustes). */
function escolhaModo(titulo = 'Como você vai usar o site?') {
  const atual = prefs().modo;
  return `<section class="card escolha-modo">
    <h2>${titulo}</h2>
    <div class="modos">
      ${Object.entries(MODOS).map(([k, m]) => `
        <button type="button" class="modo-op ${atual === k ? 'ativo' : ''}" data-modo="${k}" aria-pressed="${atual === k}">
          <span class="modo-icone" aria-hidden="true">${k === 'controle' ? ICON.classificar : ICON.ano}</span>
          <b>Modo ${m.nome}</b><span>${m.texto}</span>
          ${atual === k ? '<em>Em uso</em>' : ''}
        </button>`).join('')}
    </div>
    <p class="hint">Dá para trocar quando quiser em Ajustes. Nada é apagado ao trocar.</p>
  </section>`;
}
const cats = () => [...S.data.categorias].sort((a, b) => (a.ordem ?? 0) - (b.ordem ?? 0) || a.nome.localeCompare(b.nome));
const anoAtual = () => new Date().getFullYear();

function dadosVazios() {
  return { perfis: [], categorias: [], classes: [], regras: [], meses: [], lancamentos: [], prefs: {} };
}
/** Categorias de gasto (Funcionários, Assinaturas...) em ordem. */
const classes = () => [...S.data.classes].sort((a, b) => (a.ordem ?? 0) - (b.ordem ?? 0) || a.nome.localeCompare(b.nome));
const classePorId = (id) => S.data.classes.find((c) => c.id === id);
const LADO = { pessoal: 'Pessoal', empresa: 'Empresa' };
/** Despesas ainda sem categoria de gasto. */
const semClasse = (lista) => lista.filter((l) => l.destino === 'despesa' && !l.classe_id);
const receitasSemClasse = (lista) => lista.filter((l) => l.destino === 'receita' && !l.classe_id);
/** Que tipo de categoria um lançamento usa: gasto (despesa) ou receita (receita/rendimento). Transferência não tem. */
const tipoClasseDe = (destino) => (destino === 'despesa' ? 'despesa' : destino === 'receita' || destino === 'rendimento' ? 'receita' : null);
const tipoDaClasse = (c) => (c?.tipo === 'receita' ? 'receita' : 'despesa');
const TIPOS_CLASSE = { despesa: 'Gastos', receita: 'Receitas' };
/** Nome completo: "Mercado › Hortifruti" para subcategorias. */
function nomeClasse(c) {
  if (!c) return '';
  const p = c.pai_id && classePorId(c.pai_id);
  return p ? `${p.nome} › ${c.nome}` : c.nome;
}
/** Categoria principal (a própria, se não for subcategoria). */
const raizClasse = (c) => (c?.pai_id && classePorId(c.pai_id)) || c;
/** Categorias de um tipo em árvore: cada principal seguida das suas subcategorias (nivel 0/1). */
function arvoreClasses(tipo, { incluir = null, todas = false } = {}) {
  const lista = classes().filter((c) => tipoDaClasse(c) === tipo && (todas || c.ativo !== false || c.id === incluir));
  const ids = new Set(lista.map((c) => c.id));
  const raizes = lista.filter((c) => !c.pai_id || !ids.has(c.pai_id));
  return raizes.flatMap((r) => [{ ...r, nivel: 0 }, ...lista.filter((c) => c.pai_id === r.id).map((c) => ({ ...c, nivel: 1 }))]);
}
/** <option>s de categoria do tipo, com as subcategorias recuadas. */
function opcoesClasses(tipo, sel, vazio = '— sem categoria —') {
  return `<option value="">${vazio}</option>` + arvoreClasses(tipo, { incluir: sel }).map((c) =>
    `<option value="${c.id}" ${sel === c.id ? 'selected' : ''}>${c.nivel ? '   ↳ ' : ''}${esc(c.nome)}</option>`).join('');
}
/** Sugere categoria (regra → histórico → parecido) só entre as do tipo certo. */
function sugerirClasse(descricao, tipo, escopoPadrao) {
  const ok = (id) => !!id && !!classePorId(id) && tipoDaClasse(classePorId(id)) === tipo;
  return sugerir(descricao, {
    regras: S.data.regras.filter((r) => ok(r.classe_id)),
    classes: S.data.classes,
    lancamentos: S.data.lancamentos.filter((l) => ok(l.classe_id)),
    escopoPadrao,
  });
}
/* ------------------------------------------------ parcelas e recorrência */
const RECORRENCIAS = { fixa: 'Fixa', parcelada: 'Parcelada', variavel: 'Variável' };
const COR_RECORRENCIA = { fixa: '#818cf8', parcelada: '#f59e0b', variavel: '#2dd4bf' };
/** "PARC 03/10", "PARCELA 3 DE 10" e, em cartão, "LOJA 03/10" no fim da descrição → { parcela: 3, parcelas: 10 }. */
function detectarParcela(desc, { cartao = false } = {}) {
  const s = String(desc || '').toUpperCase();
  const m = s.match(/PARC(?:ELA)?\.?\s*(\d{1,2})\s*(?:\/|DE)\s*(\d{1,2})/) || s.match(/(\d{1,2})\s+DE\s+(\d{1,2})\s*$/)
    || (cartao && s.match(/(?:^|\s)(\d{1,2})\s*\/\s*(\d{1,2})\s*$/));
  if (!m) return null;
  const p = Number(m[1]), t = Number(m[2]);
  return p >= 1 && t >= 2 && p <= t && t <= 99 ? { parcela: p, parcelas: t } : null;
}
/**
 * Gasto fixo = mesma descrição com o MESMO valor (até 3% de diferença) em 2 ou mais meses:
 * assinaturas, mensalidades, contas de valor certo. Mercado e posto variam e ficam como variáveis.
 */
let cacheFixas = { n: -1, mapa: null };
function gastosPorDescricao() {
  if (cacheFixas.n === S.data.lancamentos.length && cacheFixas.ref === S.data.lancamentos) return cacheFixas.mapa;
  const mapa = new Map();
  for (const l of S.data.lancamentos) {
    if (l.destino !== 'despesa' || l.parcelas) continue;
    const k = textoBase(l.descricao); if (!k) continue;
    if (!mapa.has(k)) mapa.set(k, []);
    mapa.get(k).push({ mes: String(l.data).slice(0, 7), valor: l.valor });
  }
  cacheFixas = { n: S.data.lancamentos.length, ref: S.data.lancamentos, mapa };
  return mapa;
}
/** Fixa, parcelada ou variável: o que foi marcado, senão o que dá para deduzir. */
function recorrenciaDe(l) {
  if (l.recorrencia) return l.recorrencia;
  if (l.parcelas) return 'parcelada';
  const iguais = (gastosPorDescricao().get(textoBase(l.descricao)) || []).filter((x) => Math.abs(x.valor - l.valor) <= l.valor * 0.03);
  return new Set(iguais.map((x) => x.mes)).size >= 2 ? 'fixa' : 'variavel';
}
const textoParcela = (l) => (l.parcelas ? `${l.parcela}/${l.parcelas}` : '');

/** Texto curto de um lançamento: categoria (ou "sem categoria" / tipo). */
function rotuloLanc(l) {
  const c = classePorId(l.classe_id);
  if (c) return nomeClasse(c);
  return l.destino === 'despesa' ? 'sem categoria' : DESTINOS[l.destino];
}

/* ------------------------------------------------ conferência de erros */
const IGNORADOS_KEY = 'financas-conferencia-ok';
function lerIgnorados() { try { return new Set(JSON.parse(localStorage.getItem(IGNORADOS_KEY)) || []); } catch { return new Set(); } }
function ignorar(chave) {
  const s = lerIgnorados(); s.add(chave);
  try { localStorage.setItem(IGNORADOS_KEY, JSON.stringify([...s])); } catch { /* sem armazenamento */ }
}
const diasEntre = (a, b) => Math.abs((new Date(a + 'T12:00:00') - new Date(b + 'T12:00:00')) / 86400000);

/**
 * Procura erros comuns nos lançamentos de um mês (ou de todos, sem prefixo).
 * Cada problema: { chave, tipo, titulo, texto, ids, acoes: [{rotulo, fazer}] }
 */
function conferir(prefixo = '') {
  const doMes = S.data.lancamentos.filter((l) => !prefixo || String(l.data).startsWith(prefixo));
  const ignorados = lerIgnorados();
  const nomes = prefs().meus_nomes || [];
  const problemas = [];
  const usados = new Set();

  // 1) Mesmo valor saindo de uma conta e entrando em outra (até 3 dias): transferência entre as próprias contas
  const saidas = doMes.filter((l) => sentidoDe(l) === 'saida');
  for (const s of saidas) {
    const e = doMes.find((x) => x.id !== s.id && !usados.has(x.id) && sentidoDe(x) === 'entrada'
      && Math.abs(x.valor - s.valor) < 0.005 && diasEntre(x.data, s.data) <= 3 && contaDe(x) !== contaDe(s));
    if (!e || usados.has(s.id)) continue;
    if (s.destino === 'transferencia' && e.destino === 'transferencia') continue;
    usados.add(s.id); usados.add(e.id);
    problemas.push({
      chave: `par:${s.id}:${e.id}`, tipo: 'transferencia',
      titulo: `Parece transferência entre suas contas: ${fmtBRL(s.valor)}`,
      texto: `Saiu de <b>${esc(contaDe(s) || '?')}</b> em ${fmtDia(s.data)} ("${esc(s.descricao)}") e entrou em <b>${esc(contaDe(e) || '?')}</b> em ${fmtDia(e.data)} ("${esc(e.descricao)}").
        Se for dinheiro passando de uma conta sua para outra, não é gasto nem receita.`,
      ids: [s.id, e.id],
      acoes: [{ rotulo: 'É transferência (não contar)', fazer: () => virarTransferencia([s.id, e.id]) }],
    });
  }

  // 2) Receita/despesa com o nome das próprias contas ou "mesma titularidade"
  for (const l of doMes) {
    if (usados.has(l.id) || l.destino === 'transferencia') continue;
    const t = detectarTransferencia(l.descricao, nomes);
    if (t === 'propria') {
      problemas.push({
        chave: `propria:${l.id}`, tipo: 'transferencia',
        titulo: `${l.destino === 'receita' ? 'Receita' : DESTINOS[l.destino]} que parece transferência: ${fmtBRL(l.valor)}`,
        texto: `"${esc(l.descricao)}" em ${fmtDia(l.data)} (${esc(contaDe(l))}) tem o nome de uma conta sua. Se foi entre suas contas, não conta como ${l.destino === 'receita' ? 'receita' : 'gasto'}.`,
        ids: [l.id],
        acoes: [{ rotulo: 'É transferência (não contar)', fazer: () => virarTransferencia([l.id]) }],
      });
    }
  }

  // 3) Pagamento de fatura do cartão
  const comprasCartao = doMes.filter((l) => l.destino === 'despesa' && S.data.categorias.find((c) => c.id === l.categoria_id)?.tipo === 'credito');
  for (const l of doMes) {
    if (detectarTransferencia(l.descricao, []) !== 'fatura') continue;
    if (l.destino === 'despesa' && comprasCartao.length && !comprasCartao.includes(l)) {
      problemas.push({
        chave: `fatura2x:${l.id}`, tipo: 'duplicado',
        titulo: `Fatura contada duas vezes: ${fmtBRL(l.valor)}`,
        texto: `"${esc(l.descricao)}" está como gasto, mas as compras do cartão também foram lançadas neste mês. Assim o mesmo dinheiro conta duas vezes.`,
        ids: [l.id],
        acoes: [{ rotulo: 'Pagamento é transferência', fazer: () => virarTransferencia([l.id]) }],
      });
    } else if (l.destino === 'transferencia' && !comprasCartao.length) {
      problemas.push({
        chave: `fatura0:${l.id}`, tipo: 'aviso',
        titulo: `Fatura paga sem as compras do cartão: ${fmtBRL(l.valor)}`,
        texto: `O pagamento "${esc(l.descricao)}" (${fmtDia(l.data)}) não está contando como gasto, e as compras do cartão ainda não foram lançadas.
          Importe o extrato do cartão, ou conte o pagamento como um gasto único.`,
        ids: [l.id],
        acoes: [
          { rotulo: 'Contar como gasto (Fatura do cartão)', fazer: () => faturaComoGasto(l.id) },
          { rotulo: 'Vou importar o cartão', link: `#/lancamentos/${l.data.slice(0, 4)}/${Number(l.data.slice(5, 7))}` },
        ],
      });
    }
  }

  // 4) Possível repetido: mesmo dia, mesmo valor, mesma loja/pessoa, em lançamentos diferentes
  const vistos = [];
  for (const l of doMes) {
    if (l.destino === 'transferencia') continue;
    const igual = vistos.find((x) => x.data === l.data && Math.abs(x.valor - l.valor) < 0.005 && x.destino === l.destino
      && (normDesc(x.descricao) === normDesc(l.descricao) || mesmaLoja(palavrasChave(x.descricao), palavrasChave(l.descricao)))
      && !(x.chave && l.chave && x.chave !== l.chave && contaDe(x) === contaDe(l))); // no mesmo extrato, ids diferentes = compras diferentes
    if (igual) {
      problemas.push({
        chave: `dup:${igual.id}:${l.id}`, tipo: 'duplicado',
        titulo: `Possível lançamento repetido: ${fmtBRL(l.valor)} em ${fmtDia(l.data)}`,
        texto: `"${esc(igual.descricao)}" (${esc(contaDe(igual))}) e "${esc(l.descricao)}" (${esc(contaDe(l))}). Se for o mesmo gasto lançado duas vezes, exclua um.`,
        ids: [igual.id, l.id],
        acoes: [{ rotulo: 'Excluir o segundo', fazer: () => excluirLancamentos([l.id]) }],
      });
    }
    vistos.push(l);
  }
  return problemas.filter((p) => !ignorados.has(p.chave));
}

async function virarTransferencia(ids) {
  const porSentido = { entrada: [], saida: [] };
  for (const id of ids) {
    const l = S.data.lancamentos.find((x) => x.id === id);
    if (l) porSentido[sentidoDe(l)].push(id);
  }
  for (const [sentido, grupo] of Object.entries(porSentido)) {
    if (!grupo.length) continue;
    const salvos = await S.store.atualizarLancamentos(grupo, { destino: 'transferencia', classe_id: null, sentido });
    for (const s of salvos) {
      const i = S.data.lancamentos.findIndex((x) => x.id === s.id);
      if (i >= 0) S.data.lancamentos[i] = { ...S.data.lancamentos[i], ...s };
    }
  }
}
async function faturaComoGasto(id) {
  const l = S.data.lancamentos.find((x) => x.id === id);
  let classe = S.data.classes.find((c) => normDesc(c.nome).startsWith('fatura do cartao'));
  if (!classe) {
    classe = await S.store.saveClasse({ perfil_id: S.perfilId, nome: 'Fatura do cartão (sem detalhe)', cor: '#475569', ordem: S.data.classes.length + 1, ativo: true, escopo_padrao: null });
    S.data.classes.push(classe);
  }
  const conta = l.categoria_id || cats().find((c) => c.tipo === 'debito')?.id || cats()[0]?.id;
  const [salvo] = await S.store.atualizarLancamentos([id], { destino: 'despesa', classe_id: classe.id, categoria_id: conta, sentido: 'saida' });
  const i = S.data.lancamentos.findIndex((x) => x.id === id);
  if (i >= 0 && salvo) S.data.lancamentos[i] = { ...S.data.lancamentos[i], ...salvo };
}
async function excluirLancamentos(ids) {
  for (const id of ids) await S.store.deleteLancamento(id);
  S.data.lancamentos = S.data.lancamentos.filter((x) => !ids.includes(x.id));
}

/** Bloco "Conferir antes de classificar" com os problemas e botões de correção. */
function blocoConferencia(problemas) {
  if (!problemas.length) return '';
  const icone = { transferencia: '⇄', duplicado: '⧉', aviso: '!' };
  return `<section class="card conferencia">
    <h2>Conferir (${problemas.length})</h2>
    <p class="sub">O site encontrou movimentações que podem distorcer as contas. Confira e corrija com um clique — ou marque "Está certo".</p>
    ${problemas.map((p, i) => `
      <div class="problema ${p.tipo}" data-p="${i}">
        <span class="problema-icone" aria-hidden="true">${icone[p.tipo] || '!'}</span>
        <div class="problema-txt"><b>${p.titulo}</b><p class="sub">${p.texto}</p>
          <div class="acoes">
            ${p.acoes.map((a, j) => a.link ? `<a class="btn" href="${a.link}">${a.rotulo}</a>` : `<button class="btn ${j === 0 ? 'primario' : ''}" data-acao-p="${j}">${a.rotulo}</button>`).join('')}
            <button class="btn fantasma" data-ok>Está certo</button>
          </div>
        </div>
      </div>`).join('')}
  </section>`;
}
function bindConferencia(main, problemas) {
  main.querySelectorAll('.problema').forEach((el) => {
    const p = problemas[Number(el.dataset.p)];
    el.querySelectorAll('[data-acao-p]').forEach((b) => b.addEventListener('click', async () => {
      b.disabled = true;
      try { await p.acoes[Number(b.dataset.acaoP)].fazer(); toast('Corrigido.'); render(); }
      catch (e) { toast(e.message, 'erro'); b.disabled = false; }
    }));
    el.querySelector('[data-ok]').addEventListener('click', () => { ignorar(p.chave); render(); });
  });
}

/** Cria as categorias sugeridas (Funcionários, Fornecedores, Mercado...). */
async function criarClassesSugeridas(tipo = 'despesa') {
  const existentes = new Set(S.data.classes.filter((c) => tipoDaClasse(c) === tipo).map((c) => normDesc(c.nome)));
  let ordem = S.data.classes.length;
  for (const [nome, cor, escopo_padrao] of tipo === 'receita' ? RECEITAS_SUGERIDAS : CLASSES_SUGERIDAS) {
    if (existentes.has(normDesc(nome))) continue;
    S.data.classes.push(await S.store.saveClasse({ perfil_id: S.perfilId, nome, cor, escopo_padrao, tipo, ordem: ++ordem, ativo: true }));
  }
}
/** Categorias de receita sugeridas (de onde veio o dinheiro). */
const RECEITAS_SUGERIDAS = [
  ['Vendas / clientes', '#10b981', 'empresa'],
  ['Serviços prestados', '#0d9488', 'empresa'],
  ['Salário', '#22c55e', 'pessoal'],
  ['Pró-labore recebido', '#0f766e', 'pessoal'],
  ['Rendimentos', '#0ea5e9', null],
  ['Aluguel recebido', '#a855f7', null],
  ['Reembolsos e estornos', '#64748b', null],
  ['Outras receitas', '#94a3b8', null],
];

/** Aplica uma categoria (e o lado) a vários lançamentos; se pedido, cria a regra para as próximas vezes. */
async function classificar(ids, classeId, ladoEscolhido, textoRegra) {
  const classe = classePorId(classeId);
  const porLado = new Map();
  for (const id of ids) {
    const l = S.data.lancamentos.find((x) => x.id === id);
    const lado = ladoEscolhido || classe?.escopo_padrao || l?.escopo || 'pessoal';
    if (!porLado.has(lado)) porLado.set(lado, []);
    porLado.get(lado).push(id);
  }
  for (const [lado, grupo] of porLado) {
    const salvos = await S.store.atualizarLancamentos(grupo, { classe_id: classeId, escopo: lado });
    for (const s of salvos) {
      const i = S.data.lancamentos.findIndex((x) => x.id === s.id);
      if (i >= 0) S.data.lancamentos[i] = { ...S.data.lancamentos[i], ...s };
    }
  }
  if (textoRegra && textoRegra.length >= 2) {
    const regra = await S.store.saveRegra({ perfil_id: S.perfilId, texto: textoRegra, classe_id: classeId, escopo: ladoEscolhido || null });
    const i = S.data.regras.findIndex((r) => r.texto === regra.texto);
    if (i >= 0) S.data.regras[i] = regra; else S.data.regras.push(regra);
  }
}
/** Meses com os lançamentos já somados (é isso que as telas mostram). */
function efetivos() {
  return aplicarLancamentos(S.data.meses, S.data.lancamentos);
}
/** Percentuais de "Organização finanças" do perfil do usuário. */
function prefs() {
  return { ...PREFS_PADRAO, ...(S.data.prefs[S.perfilId] || {}) };
}

/** Mês mostrado por padrão: o último lançado (até o mês atual) ou o mês atual. */
function mesPadrao() {
  const hoje = new Date();
  const limite = hoje.getFullYear() * 100 + hoje.getMonth() + 1;
  const ult = efetivos().filter(mesTemDados).map((m) => m.ano * 100 + m.mes).filter((n) => n <= limite).sort((a, b) => b - a)[0];
  const n = ult || limite;
  return { ano: Math.floor(n / 100), mes: n % 100 };
}

function rota() {
  const h = location.hash.replace(/^#\/?/, '').split('/');
  if (h[0] === 'ano') return { view: 'ano', ano: Number(h[1]) || anoAtual(), aba: h[2] === 'planilha' ? 'planilha' : 'resumo' };
  if (h[0] === 'ajustes') return { view: 'ajustes' };
  if (h[0] === 'ajuda') return { view: 'ajuda' };
  if (h[0] === 'geral') return { view: 'geral' };
  const ano = Number(h[1]), mes = Number(h[2]);
  if (['lancamentos', 'classificar', 'cartoes', 'contas', 'calendario', 'graficos'].includes(h[0])) {
    const aba = h[0] === 'lancamentos' ? h[3] || 'despesas' : undefined; // aba de Transações
    const id = h[0] === 'cartoes' || h[0] === 'contas' ? h[3] || null : null; // página de um cartão / conta
    if (ano && mes >= 1 && mes <= 12) return { view: h[0], ano, mes, aba, id };
    return { view: h[0], ...mesPadrao(), aba, id };
  }
  // A antiga tela Categorias agora fica dentro de Gráficos
  if (h[0] === 'categorias') {
    if (ano && !h[2]) { S.grafPer = 'ano'; return { view: 'graficos', ano, mes: 12 }; }
    if (ano && mes >= 1 && mes <= 12) return { view: 'graficos', ano, mes };
    return { view: 'graficos', ...mesPadrao() };
  }
  if (h[0] === 'mes' && ano && mes >= 1 && mes <= 12) return { view: 'mes', ano, mes };
  return { view: 'mes', ...mesPadrao() };
}

function destroyCharts() {
  S.charts.forEach((c) => c.destroy());
  S.charts = [];
}

function cssVar(n) {
  return getComputedStyle(document.documentElement).getPropertyValue(n).trim();
}

function grafico(canvas, linhas) {
  if (!window.Chart || !canvas) return;
  const labels = linhas.map((r) => `${MESES_CURTO[r.mes - 1]}/${String(r.ano).slice(2)}`);
  const grid = cssVar('--border');
  const text = cssVar('--muted');
  const chart = new Chart(canvas, {
    data: {
      labels,
      datasets: [
        { type: 'bar', label: 'Receita', data: linhas.map((r) => r.receita), backgroundColor: cssVar('--c-receita'), borderRadius: 4, maxBarThickness: 28 },
        { type: 'bar', label: 'Despesas', data: linhas.map((r) => r.totalDesp), backgroundColor: cssVar('--c-despesa'), borderRadius: 4, maxBarThickness: 28 },
        { type: 'line', label: 'Saldo do mês', data: linhas.map((r) => r.saldoMes), borderColor: cssVar('--c-saldo'), backgroundColor: cssVar('--c-saldo'), tension: 0.3, pointRadius: 3, spanGaps: true },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: text, boxWidth: 12, usePointStyle: true } },
        tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${fmtBRL(c.parsed.y)}` } },
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: text } },
        y: { grid: { color: grid }, ticks: { color: text, callback: (v) => v.toLocaleString('pt-BR') } },
      },
    },
  });
  S.charts.push(chart);
}

/* ================================================================== boot */
async function boot() {
  S.filtro = lerFiltro();
  try {
    S.store = await createStore();
  } catch (e) {
    app.innerHTML = `<div class="boot erro">Não foi possível conectar: ${esc(e.message)}</div>`;
    return;
  }
  S.user = await S.store.getUser();
  S.store.onAuthChange(async (u) => {
    const mudou = (u?.id || null) !== (S.user?.id || null);
    S.user = u;
    if (mudou) { if (u) await carregar(); render(); }
  });
  if (S.user) await carregar();
  window.addEventListener('hashchange', render);
  render();
}

async function carregar() {
  try {
    S.autorizado = await S.store.autorizado();
    if (!S.autorizado) { S.data = dadosVazios(); return; }
    S.data = await S.store.load();
    // Cada login tem um perfil interno (o banco suporta mais de um, a tela não mostra).
    if (!S.data.perfis.length) S.data.perfis.push(await S.store.savePerfil({ nome: 'Pessoal', tipo: 'pessoal', ordem: 1 }));
    S.perfilId = S.data.perfis[0].id;
  } catch (e) {
    toast('Erro ao carregar dados: ' + e.message, 'erro');
  }
}

/* ================================================================ render */
function render() {
  destroyCharts();
  if (!S.user) return renderLogin();
  if (S.autorizado === false) return renderSemAcesso();
  const r = rota();
  app.innerHTML = shell(r);
  const main = app.querySelector('main');
  if (r.view === 'mes') (ehControle() ? renderResumo : renderMes)(main, r.ano, r.mes);
  else if (r.view === 'contas') (r.id ? renderConta(main, r.ano, r.mes, r.id) : renderContas(main, r.ano, r.mes));
  else if (r.view === 'cartoes') (r.id && ehControle() ? renderCartao(main, r.ano, r.mes, r.id) : renderCartoes(main, r.ano, r.mes));
  else if (r.view === 'lancamentos') renderLancamentos(main, r.ano, r.mes, r.aba);
  else if (r.view === 'calendario') renderCalendario(main, r.ano, r.mes);
  else if (r.view === 'graficos') renderGraficos(main, r.ano, r.mes);
  else if (r.view === 'classificar') renderClassificar(main, r.ano, r.mes);
  else if (r.view === 'geral') renderGeral(main);
  else if (r.view === 'ano') renderAno(main, r.ano, r.aba);
  else if (r.view === 'ajuda') renderAjuda(main);
  else renderAjustes(main);
  bindShell(r);
}

function shell(r) {
  const item = (href, view, label, icon, extra = '', classe = '') =>
    `<a href="${href}" class="${r.view === view ? 'ativo' : ''} ${classe}" ${r.view === view ? 'aria-current="page"' : ''}>${icon}<span>${label}</span>${extra}</a>`;
  const ano = r.ano || anoAtual();
  // Telas por mês mantêm o mês aberto ao trocar de tela
  const sufixoMes = r.ano && r.mes ? `/${r.ano}/${r.mes}` : '';
  const controle = ehControle();
  // Contador do menu (modo controle): gastos sem categoria + itens para conferir
  const pendentes = controle && S.user && S.autorizado !== false ? semClasse(S.data.lancamentos).length + conferir().length : 0;
  const email = S.user?.email || '';
  const marca = `<div class="marca"><button type="button" class="menu-alternar" data-a="menu-compacto" aria-label="Recolher ou abrir o menu" title="Recolher menu">${ICON.menu}</button><img src="icons/icon.svg" alt="" width="30" height="30">
    <span>Finanças Marques<small>Modo ${MODOS[modo()].nome.toLowerCase()}</small></span></div>`;
  // Menu como no Minhas Finanças: o dia a dia em cima, "Analisar" e "Configurar" em grupos
  const menu = controle
    ? `${item(`#/mes${sufixoMes}`, 'mes', 'Resumo', ICON.mes)}
        ${item(`#/contas${sufixoMes}`, 'contas', 'Contas', ICON.banco)}
        ${item(`#/lancamentos${sufixoMes}`, 'lancamentos', 'Transações', ICON.lista)}
        ${item(`#/cartoes${sufixoMes}`, 'cartoes', 'Cartões<span class="so-desktop-inline"> de crédito</span>', ICON.cartao)}
        ${item(`#/classificar${sufixoMes}`, 'classificar', 'Classificar', ICON.classificar, pendentes ? `<b class="badge">${pendentes > 99 ? '99+' : pendentes}</b>` : '')}
        <span class="nav-titulo nav-sep">Analisar</span>
        ${item(`#/graficos${sufixoMes}`, 'graficos', 'Gráficos', ICON.grafico)}
        ${item(`#/calendario${sufixoMes}`, 'calendario', 'Calendário', ICON.calendario, '', 'so-desktop')}
        ${item(`#/ano/${ano}`, 'ano', 'Ano', ICON.ano, '', 'so-desktop')}
        ${item('#/geral', 'geral', 'Todos os anos', ICON.geral, '', 'so-desktop')}
        <span class="nav-titulo nav-sep">Configurar</span>
        ${item('#/ajustes', 'ajustes', 'Ajustes', ICON.ajustes)}
        ${item('#/ajuda', 'ajuda', 'Ajuda', ICON.ajuda, '', 'so-desktop')}`
    : `${item(`#/mes${sufixoMes}`, 'mes', 'Visão do mês', ICON.mes)}
        ${item(`#/cartoes${sufixoMes}`, 'cartoes', 'Cartões<span class="so-desktop-inline"> de crédito</span>', ICON.cartao)}
        <span class="nav-titulo nav-sep">Analisar</span>
        ${item(`#/graficos${sufixoMes}`, 'graficos', 'Gráficos', ICON.grafico)}
        ${item(`#/ano/${ano}`, 'ano', 'Ano', ICON.ano)}
        ${item('#/geral', 'geral', 'Todos os anos', ICON.geral)}
        <span class="nav-titulo nav-sep">Configurar</span>
        ${item('#/ajustes', 'ajustes', 'Ajustes', ICON.ajustes)}
        ${item('#/ajuda', 'ajuda', 'Ajuda', ICON.ajuda, '', 'so-desktop')}`;
  let compacto = false;
  try { compacto = localStorage.getItem('financas-menu') === 'compacto'; } catch { /* sem armazenamento */ }
  return `
  <div class="layout ${compacto ? 'compacto' : ''}">
    <aside class="lateral">
      ${marca}
      <nav class="nav" aria-label="Menu">${menu}</nav>
      ${seletorTema()}
      <div class="lateral-pe">
        <span class="avatar">${esc((email[0] || '?').toUpperCase())}</span>
        <div><b>${esc(email.split('@')[0] || 'Conta')}</b><small>${S.store.mode === 'local' ? 'modo local' : esc(email)}</small></div>
      </div>
    </aside>
    <div class="conteudo">
      <header class="topo">${marca}</header>
      ${S.store.mode === 'local' ? '<div class="aviso">Modo local: os dados ficam só neste navegador.</div>' : ''}
      <main></main>
    </div>
  </div>`;
}

function bindShell(r) {
  app.querySelectorAll('[data-tema]').forEach((b) => b.addEventListener('click', () => definirTema(b.dataset.tema)));
  // Recolher / abrir o menu lateral (fica lembrado neste navegador)
  app.querySelector('.lateral [data-a="menu-compacto"]')?.addEventListener('click', () => {
    const lay = app.querySelector('.layout');
    lay.classList.toggle('compacto');
    try { localStorage.setItem('financas-menu', lay.classList.contains('compacto') ? 'compacto' : 'aberto'); } catch { /* sem armazenamento */ }
  });
  // Escolha do modo de uso
  app.querySelectorAll('[data-modo]').forEach((b) => b.addEventListener('click', async () => {
    try {
      await definirModo(b.dataset.modo);
      toast(`Modo ${MODOS[b.dataset.modo].nome} ativado.`);
      render();
    } catch (e) { toast(e.message, 'erro'); }
  }));
  // Importar extrato a partir da Visão do mês (modo controle)
  app.querySelectorAll('[data-a="importar-mes"]').forEach((b) => b.addEventListener('click', () => abrirImportacao({ ano: r.ano || anoAtual(), mes: r.mes || new Date().getMonth() + 1 })));
  // Seletor de mês (popover)
  const btn = app.querySelector('.titulo-mes');
  const pop = app.querySelector('.seletor-mes .popover');
  if (btn && pop) {
    const fechar = () => { pop.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      pop.hidden = !pop.hidden;
      btn.setAttribute('aria-expanded', String(!pop.hidden));
    });
    pop.addEventListener('click', (e) => e.stopPropagation());
    btn.addEventListener('keydown', (e) => { if (e.key === 'Escape') fechar(); });
  }
}
// Clique fora fecha o seletor de mês (um único ouvinte para o site todo)
document.addEventListener('click', () => {
  const pop = document.querySelector('.seletor-mes .popover');
  if (pop && !pop.hidden) {
    pop.hidden = true;
    document.querySelector('.titulo-mes')?.setAttribute('aria-expanded', 'false');
  }
});

/* =========================================================== login view */
function renderLogin(modo = 'entrar') {
  const titulo = { entrar: 'Entrar', criar: 'Criar conta', senha: 'Recuperar senha' }[modo];
  app.innerHTML = `
  <div class="login">
    <form class="card login-card">
      <div class="marca grande"><img src="icons/icon.svg" alt="" width="40" height="40"><span>Finanças Marques</span></div>
      <h1>${titulo}</h1>
      <label>E-mail<input type="email" name="email" autocomplete="email" required></label>
      ${modo !== 'senha' ? `<label>Senha<input type="password" name="senha" autocomplete="${modo === 'criar' ? 'new-password' : 'current-password'}" minlength="6" required></label>` : ''}
      <button class="btn primario" type="submit">${titulo}</button>
      <p class="erro-msg" hidden></p>
      <div class="login-links">
        ${modo !== 'entrar' ? '<a href="#" data-m="entrar">Já tenho conta</a>' : '<a href="#" data-m="criar">Criar conta</a>'}
        ${modo !== 'senha' ? '<a href="#" data-m="senha">Esqueci a senha</a>' : ''}
      </div>
    </form>
  </div>`;
  app.querySelectorAll('[data-m]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); renderLogin(a.dataset.m); }));
  const form = app.querySelector('form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button');
    const err = form.querySelector('.erro-msg');
    btn.disabled = true;
    err.hidden = true;
    try {
      const email = form.email.value.trim();
      if (modo === 'entrar') {
        S.user = await S.store.signIn(email, form.senha.value);
        await carregar();
        render();
      } else if (modo === 'criar') {
        const u = await S.store.signUp(email, form.senha.value);
        const logado = await S.store.getUser();
        if (logado) { S.user = logado; await carregar(); render(); }
        else { toast('Conta criada! Confirme pelo link enviado ao seu e-mail.'); renderLogin('entrar'); }
        void u;
      } else {
        await S.store.resetPassword(email);
        toast('Enviamos um link de recuperação para o seu e-mail.');
        renderLogin('entrar');
      }
    } catch (ex) {
      err.textContent = traduzErro(ex.message);
      err.hidden = false;
    } finally {
      btn.disabled = false;
    }
  });
}

function renderSemAcesso() {
  app.innerHTML = `
  <div class="login">
    <div class="card login-card">
      <div class="marca grande"><img src="icons/icon.svg" alt="" width="40" height="40"><span>Finanças Marques</span></div>
      <h1>Conta sem acesso</h1>
      <p class="sub">Você entrou como <b>${esc(S.user.email || '')}</b>, mas esta conta ainda não foi liberada para o site de finanças.</p>
      <p class="sub">Código da conta (para liberar o acesso):</p>
      <code class="codigo">${esc(S.user.id)}</code>
      <button class="btn" data-a="recarregar">Já foi liberada — tentar de novo</button>
      <button class="btn perigo" data-a="sair">Sair</button>
    </div>
  </div>`;
  app.querySelector('[data-a="recarregar"]').addEventListener('click', async () => { await carregar(); render(); });
  app.querySelector('[data-a="sair"]').addEventListener('click', async () => {
    await S.store.signOut();
    S.user = null;
    S.autorizado = undefined;
    render();
  });
}

function traduzErro(m) {
  if (/invalid login/i.test(m)) return 'E-mail ou senha incorretos.';
  if (/email not confirmed/i.test(m)) return 'Confirme seu e-mail pelo link enviado antes de entrar.';
  if (/already registered/i.test(m)) return 'Este e-mail já tem conta.';
  if (/signups not allowed/i.test(m)) return 'Novos cadastros estão desativados.';
  return m;
}

/* ========================================================== visão geral */
/* ================================================================ mês */
// Cores das categorias (mesma ordem das categorias do usuário)
const PALETA = ['#2a9d8f', '#e76f51', '#457b9d', '#e9a23b', '#8d6cab', '#c05780', '#6a994e', '#5c7c8a'];
/** Cor de um cartão/conta nos gráficos e bolinhas: a do modelo escolhido (sempre visível no claro e no escuro); sem modelo, uma da paleta. */
const corCat = (cat) => (cat?.estilo && ESTILOS[cat.estilo]?.cor) || PALETA[Math.max(0, cats().findIndex((c) => c.id === cat.id)) % PALETA.length];
const anterior = (ano, mes) => (mes === 1 ? { ano: ano - 1, mes: 12 } : { ano, mes: mes - 1 });
const seguinte = (ano, mes) => (mes === 12 ? { ano: ano + 1, mes: 1 } : { ano, mes: mes + 1 });

/** "↑ 12% vs out" — menorMelhor: para despesas, subir é ruim (vermelho). */
function delta(v, ref, rotulo, menorMelhor = false) {
  if (v === null || v === undefined || ref === null || ref === undefined || ref === 0) return '';
  const p = (v - ref) / Math.abs(ref);
  if (Math.abs(p) < 0.005) return `<span class="delta">= ${rotulo}</span>`;
  const bom = menorMelhor ? p < 0 : p > 0;
  return `<span class="delta ${bom ? 'pos' : 'neg'}">${p > 0 ? '↑' : '↓'} ${Math.round(Math.abs(p) * 100)}% ${rotulo}</span>`;
}

function renderMes(main, ano, mes) {
  const c = cats();
  const map = indexMeses(efetivos());
  const l = linhaMes(ano, mes, map, c);
  const pa = anterior(ano, mes), px = seguinte(ano, mes);
  const ant = linhaMes(pa.ano, pa.mes, map, c);
  const st = estatisticas(linhasDoAno(ano, map, c), c, prefs());
  const p = prefs();
  const vsAnt = `vs ${MESES_CURTO[pa.mes - 1].toLowerCase()}`;

  const topo = `
    ${cabecalhoMes(ano, mes, '#/mes', ehControle()
      ? `<a class="btn" href="#/lancamentos/${ano}/${mes}">${ICON.lista}<span>Transações</span></a>
         <button class="btn primario" data-a="importar-mes">${ICON.upload}<span>Importar extrato</span></button>`
      : `<button class="btn primario" data-a="editar">${l.temDados ? ICON.editar : ICON.mais}<span>${l.temDados ? 'Editar mês' : 'Lançar mês'}</span></button>`)}
    ${!prefs().modo ? escolhaModo() : ''}`;

  if (!efetivos().some(mesTemDados)) {
    // Conta nova: guia de primeiros passos
    const temCats = S.data.categorias.length > 0;
    const passo = (ok, titulo, texto, acao) => `
      <li class="${ok ? 'feito' : ''}">
        <span class="check" aria-hidden="true">${ok ? '✓' : ''}</span>
        <div><b>${titulo}</b><p class="sub">${texto}</p>${acao || ''}</div>
      </li>`;
    main.innerHTML = `${topo}
      <section class="card primeiros">
        <h2>Primeiros passos</h2>
        <p class="sub">Dúvidas sobre algum termo? Veja a <a href="#/ajuda">Ajuda</a>.</p>
        <ol class="checklist">
          ${ehControle() ? `
            ${passo(temCats, 'Cadastrar as contas e cartões', 'Ex.: "Santander pessoal", "Santander Empresas", "Cartão Santander".', '<a class="btn" href="#/ajustes">Abrir Ajustes</a>')}
            ${passo(S.data.classes.length > 0, 'Criar as categorias de gasto', 'Funcionários, Fornecedores, Mercado… Comece pelas sugeridas.', '<a class="btn" href="#/ajustes#classes">Categorias</a>')}
            ${passo(false, 'Importar o extrato do mês', 'Um arquivo OFX ou CSV por conta ou cartão. Depois é só classificar.', '<button class="btn primario" data-a="importar-mes">Importar extrato</button>')}`
          : `
            ${passo(temCats, 'Cadastrar contas e cartões', 'Um item para cada cartão de crédito e um para o débito (as colunas da sua planilha).', '<a class="btn" href="#/ajustes">Abrir Ajustes</a>')}
            ${passo(false, 'Trazer o histórico (opcional)', 'Se existir a planilha FINANÇAS GERAIS.xlsx, importe em Ajustes e todos os meses aparecem aqui.', '<a class="btn" href="#/ajustes">Importar planilha</a>')}
            ${passo(false, `Lançar ${MESES[mes - 1].toLowerCase()} de ${ano}`, 'Receita, débito, fatura de cada cartão, investimento e o saldo do dia 1º.', '<button class="btn primario" data-a="editar">Lançar este mês</button>')}`}
        </ol>
      </section>`;
    main.querySelectorAll('[data-a="editar"]').forEach((b) => b.addEventListener('click', () => abrirEditor(ano, mes)));
    return;
  }

  if (!l.temDados) {
    main.innerHTML = `${topo}
      <section class="card vazio">
        <h2>${MESES[mes - 1]} de ${ano} ainda não tem dados</h2>
        ${ehControle()
          ? `<p>Importe os extratos das contas e cartões deste mês.</p>
             <div class="acoes"><button class="btn primario" data-a="importar-mes">Importar extrato</button>
             <a class="btn" href="#/lancamentos/${ano}/${mes}">Lançar à mão</a></div>`
          : `<p>Lance a receita, os gastos no débito e nos cartões, o investimento e o saldo do dia 1º.</p>
             <div class="acoes"><button class="btn primario" data-a="editar">Lançar ${MESES[mes - 1]}</button></div>`}
      </section>`;
    main.querySelectorAll('[data-a="editar"]').forEach((b) => b.addEventListener('click', () => abrirEditor(ano, mes)));
    return;
  }

  // Para onde foi a receita: uma faixa por categoria + a sobra
  const receita = l.receita ?? 0;
  const gastos = c.filter((cat) => (l.desp[cat.id] ?? 0) > 0).map((cat) => ({ nome: cat.nome, valor: l.desp[cat.id], cor: corCat(cat) }));
  const sobra = l.saldoMes ?? 0;
  const base = Math.max(receita, l.totalDesp ?? 0) || 1;
  const partes = [...gastos, ...(sobra > 0 ? [{ nome: 'Sobra', valor: sobra, cor: 'var(--sobra)' }] : [])];
  const pctReceita = (v) => (receita > 0 ? ` <small>${Math.round((v / receita) * 100)}%</small>` : '');

  const linhaCat = (cat) => {
    const v = l.desp[cat.id];
    const media = st.porCategoria.find((x) => x.cat.id === cat.id)?.media;
    return `<div class="linha-cat">
      <span class="dot" style="background:${corCat(cat)}"></span>
      <div class="nome">${esc(cat.nome)}<small>média ${ano}: ${fmtBRL(media || 0)}</small></div>
      <div class="val"><strong>${v === null || v === undefined ? '—' : fmtBRL(v)}</strong>${delta(v, ant.desp[cat.id], vsAnt, true)}</div>
    </div>`;
  };
  const doTipo = (tipo) => c.filter((cat) => cat.tipo === tipo && (cat.ativo !== false || l.desp[cat.id] !== null));
  const creditos = doTipo('credito');
  const debitos = doTipo('debito');

  const metaInvest = receita * p.pct_investir;
  const pctMeta = metaInvest > 0 ? Math.min(100, ((l.investimento ?? 0) / metaInvest) * 100) : 0;
  const prox = seguinte(ano, mes);

  main.innerHTML = `${topo}
    <div class="mes-grid">
      <section class="card hero">
        <div class="hero-cab">
          <div>
            <span class="rotulo">Sobra do mês (receita − despesas)</span>
            <strong class="valor-grande ${cls(sobra)}">${grande(sobra)}</strong>
            <p class="sub">${receita > 0
              ? sobra >= 0 ? `<span class="pos">${Math.round((sobra / receita) * 100)}% da receita</span> ficou com você`
                : `<span class="neg">gastou ${fmtBRL(-sobra)} além da receita</span>`
              : 'sem receita lançada'} ${delta(sobra, ant.saldoMes, vsAnt)}</p>
          </div>
          <div class="hero-lado">
            <div><span>Receita</span><strong>${fmtBRL(l.receita)}</strong>${delta(l.receita, ant.receita, vsAnt)}</div>
            <div><span>Despesas</span><strong>${fmtBRL(l.totalDesp)}</strong>${delta(l.totalDesp, ant.totalDesp, vsAnt, true)}</div>
          </div>
          <div class="ilustra hero-ilustra">${ILUSTRA.carteira}</div>
        </div>
        <div class="barra-empilhada" role="img" aria-label="Divisão da receita">
          ${partes.map((x) => `<span style="width:${(x.valor / base) * 100}%;background:${x.cor}" title="${esc(x.nome)}: ${fmtBRL(x.valor)}"></span>`).join('')}
        </div>
        <ul class="legenda">
          ${partes.map((x) => `<li><span class="dot" style="background:${x.cor}"></span><span>${esc(x.nome)}</span><b>${fmtBRL(x.valor)}${pctReceita(x.valor)}</b></li>`).join('')}
        </ul>
      </section>

      <section class="card">
        ${tituloCard('Saldo financeiro', 'Quanto você tinha no dia 1º e quanto o dinheiro guardado cresceu.', 'cofre')}
        <dl class="lista">
          <div><dt>Saldo inicial (1º de ${MESES_CURTO[mes - 1].toLowerCase()})</dt><dd>${fmtBRL(l.saldoIni)}</dd></div>
          <div><dt>Saldo final (1º de ${MESES_CURTO[prox.mes - 1].toLowerCase()})</dt><dd>${fmtBRL(l.saldoFin)}</dd></div>
          <div class="destaque"><dt>Resultado do saldo</dt><dd class="${cls(l.resultado)}">${fmtBRL(l.resultado)}</dd></div>
        </dl>
        ${l.saldoFin === null ? `<p class="hint">O saldo final aparece quando você lançar o saldo de 1º de ${MESES[prox.mes - 1].toLowerCase()}.</p>` : ''}
      </section>

      ${creditos.length ? `
      <section class="card">
        ${tituloCard('Cartões de crédito', 'Fatura de cada cartão neste mês.', 'cartoes')}
        ${creditos.map(linhaCat).join('')}
        <div class="linha-total"><span>Total no crédito</span><strong>${fmtBRL(l.credito)}</strong></div>
      </section>` : ''}

      ${debitos.length ? `
      <section class="card">
        ${tituloCard('Débito e contas', 'O que saiu direto da conta: Pix, boleto, débito.')}
        ${debitos.map(linhaCat).join('')}
        <div class="linha-total"><span>Total no débito</span><strong>${fmtBRL(l.debito)}</strong></div>
      </section>` : ''}

      <section class="card">
        ${tituloCard('Investimento', 'Quanto foi guardado e quanto rendeu.', 'cofrinho')}
        <dl class="lista">
          <div><dt>Investido no mês</dt><dd>${fmtBRL(l.investimento)}</dd></div>
          <div><dt>Meta (${fmtPct(p.pct_investir)} da receita)</dt><dd>${fmtBRL(metaInvest)}</dd></div>
        </dl>
        <div class="progresso" role="progressbar" aria-valuenow="${Math.round(pctMeta)}" aria-valuemin="0" aria-valuemax="100"><span style="width:${pctMeta}%"></span></div>
        <dl class="lista">
          <div><dt>Rendimento / outras entradas</dt><dd>${fmtBRL(l.rendimento)}</dd></div>
          <div><dt>Total investido em ${ano}</dt><dd>${fmtBRL(st.totalInvestido)}</dd></div>
        </dl>
      </section>

      <section class="card">
        ${tituloCard(`Comparado à média de ${ano}`, 'Este mês ficou acima ou abaixo do normal?', 'grafico')}
        <dl class="lista">
          <div><dt>Receita</dt><dd>${fmtBRL(l.receita)} ${delta(l.receita, st.mediaReceita, 'vs média')}</dd></div>
          <div><dt>Despesas</dt><dd>${fmtBRL(l.totalDesp)} ${delta(l.totalDesp, st.mediaDespesas, 'vs média', true)}</dd></div>
          <div><dt>Máximo para gastar (${fmtPct(p.pct_max_gasto)})</dt><dd>${fmtBRL(receita * p.pct_max_gasto)}</dd></div>
        </dl>
        ${l.totalDesp !== null && receita > 0 && l.totalDesp > receita * p.pct_max_gasto
          ? `<p class="hint neg">Despesas acima do máximo de ${fmtPct(p.pct_max_gasto)} da receita.</p>`
          : receita > 0 ? `<p class="hint pos">Despesas dentro do máximo de ${fmtPct(p.pct_max_gasto)} da receita.</p>` : ''}
      </section>

      <section class="card">
        ${tituloCard('Para onde foi o dinheiro', 'Gastos do mês em cada cartão e conta.')}
        ${gastos.length ? `<div class="graf-rosca">
          <div class="rosca"><canvas id="g-mes-rosca"></canvas><div class="rosca-centro"><span>Gastos</span><strong>${grande(l.totalDesp ?? 0)}</strong></div></div>
          <ul class="leg-rosca">${[...gastos].sort((a, b) => b.valor - a.valor).map((x) => `<li><i style="background:${x.cor}"></i><span>${esc(x.nome)}</span>
            <b>${fmtBRL(x.valor)}</b><small>${l.totalDesp ? Math.round((x.valor / l.totalDesp) * 100) : 0}%</small></li>`).join('')}</ul>
        </div>` : '<p class="sub">Nenhum gasto lançado neste mês.</p>'}
      </section>

      <section class="card">
        ${tituloCard(`${ano} até agora`, `${st.mesesComDados} ${st.mesesComDados === 1 ? 'mês lançado' : 'meses lançados'} no ano.`, 'calendario')}
        <dl class="lista">
          <div><dt>Receita no ano</dt><dd class="pos">${fmtBRL(st.receitaTotal)}</dd></div>
          <div><dt>Despesas no ano</dt><dd>${fmtBRL(st.gastoTotal)}</dd></div>
          <div class="destaque"><dt>Sobra acumulada</dt><dd class="${cls(st.saldoTotal)}">${fmtBRL(st.saldoTotal)}</dd></div>
          <div><dt>Investido no ano</dt><dd>${fmtBRL(st.totalInvestido)}</dd></div>
          <div><dt>Meses no vermelho</dt><dd class="${st.mesesNegativos ? 'neg' : 'pos'}">${st.mesesNegativos}</dd></div>
        </dl>
        ${st.reservaEsperada > 0 && st.ultimoSaldo !== null ? `
          <p class="sub">Reserva de emergência: ${fmtBRL(st.ultimoSaldo)} de ${fmtBRL(st.reservaEsperada)} (${p.meses_reserva}× a receita média)</p>
          <div class="progresso" role="progressbar" aria-valuenow="${Math.round(Math.min(100, (st.ultimoSaldo / st.reservaEsperada) * 100))}" aria-valuemin="0" aria-valuemax="100"><span style="width:${Math.max(0, Math.min(100, (st.ultimoSaldo / st.reservaEsperada) * 100))}%"></span></div>` : ''}
      </section>

      ${(() => {
        // Gastos por categoria de gasto + pessoal × empresa (vem dos lançamentos) — só no modo Controle
        if (!ehControle()) return '';
        const gastos = S.data.lancamentos.filter((x) => x.destino === 'despesa' && String(x.data).startsWith(`${ano}-${pad2(mes)}`));
        if (!gastos.length) return '';
        const tot = gastos.reduce((s, x) => s + x.valor, 0);
        const emp = gastos.filter((x) => x.escopo === 'empresa').reduce((s, x) => s + x.valor, 0);
        const porClasse = new Map();
        for (const x of gastos) { const k = raizClasse(classePorId(x.classe_id))?.id || ''; porClasse.set(k, (porClasse.get(k) || 0) + x.valor); }
        const top = [...porClasse.entries()].filter(([id]) => id).sort((a, b) => b[1] - a[1]).slice(0, 6);
        const pend = semClasse(gastos).length;
        const pctEmp = tot ? (emp / tot) * 100 : 0;
        return `<section class="card">
          ${tituloCard('Gastos por categoria', 'Com o que o dinheiro foi gasto.')}
          <div class="divisao" title="Pessoal × empresa">
            <div class="divisao-barra"><span style="width:${100 - pctEmp}%"></span><span class="emp" style="width:${pctEmp}%"></span></div>
            <div class="divisao-leg"><span>Pessoal <b>${fmtBRL(tot - emp)}</b></span><span>Empresa <b>${fmtBRL(emp)}</b></span></div>
          </div>
          ${top.map(([id, v]) => { const c = classePorId(id); return `<div class="linha-cat"><span class="dot" style="background:${c?.cor}"></span>
            <div class="nome">${esc(c?.nome || '')}</div><div class="val"><strong>${fmtBRL(v)}</strong><span class="delta">${Math.round((v / tot) * 100)}%</span></div></div>`; }).join('')}
          ${pend ? `<p class="hint aviso-txt">${pend} ${pend === 1 ? 'gasto' : 'gastos'} sem categoria. <a href="#/classificar/${ano}/${mes}">Classificar agora →</a></p>` : ''}
          ${(() => { const n = conferir(`${ano}-${pad2(mes)}`).length; return n ? `<p class="hint aviso-txt">${n} ${n === 1 ? 'item' : 'itens'} para conferir (transferências, fatura, repetidos). <a href="#/classificar/${ano}/${mes}">Conferir →</a></p>` : ''; })()}
          <div class="linha-total"><a href="#/graficos/${ano}/${mes}">Ver todas as categorias →</a></div>
        </section>`;
      })()}

      ${(() => {
        if (!ehControle()) return '';
        const doMes = S.data.lancamentos.filter((x) => String(x.data).startsWith(`${ano}-${pad2(mes)}`))
          .sort((a, b) => b.data.localeCompare(a.data)).slice(0, 6);
        if (!doMes.length) return '';
        const catPorId = new Map(S.data.categorias.map((x) => [x.id, x]));
        return `<section class="card">
          ${tituloCard('Últimos lançamentos')}
          ${doMes.map((x) => {
            const entrada = x.destino === 'receita' || x.destino === 'rendimento';
            return `<div class="linha-cat"><span class="dot" style="background:${catPorId.get(x.categoria_id) ? corCat(catPorId.get(x.categoria_id)) : 'var(--pos)'}"></span>
              <div class="nome">${esc(x.descricao)}<small>${fmtDia(x.data)} · ${esc(catPorId.get(x.categoria_id)?.nome || DESTINOS[x.destino])}${x.escopo === 'empresa' ? ' · Empresa' : ''}</small></div>
              <div class="val"><strong class="${entrada ? 'pos' : ''}">${entrada ? '+' : '−'} ${fmtBRL(x.valor)}</strong></div></div>`;
          }).join('')}
          <div class="linha-total"><a href="#/lancamentos/${ano}/${mes}">Ver todos os lançamentos →</a></div>
        </section>`;
      })()}

      <section class="card grafico largo">
        ${tituloCard('Últimos 6 meses', 'Receita, despesas e sobra de cada mês.')}
        <div class="canvas-box"><canvas id="g-mes"></canvas></div>
      </section>

      ${l.rec?.observacao ? `<section class="card largo"><h2>Observação</h2><p>${esc(l.rec.observacao)}</p></section>` : ''}
    </div>`;

  main.querySelectorAll('[data-a="editar"]').forEach((b) => b.addEventListener('click', () => abrirEditor(ano, mes)));
  const ult6 = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(ano, mes - 1 - i, 1);
    ult6.push(linhaMes(d.getFullYear(), d.getMonth() + 1, map, c));
  }
  grafico(main.querySelector('#g-mes'), ult6);
  const rosca = main.querySelector('#g-mes-rosca');
  if (rosca && window.Chart) {
    S.charts.push(new Chart(rosca, {
      type: 'doughnut',
      data: { labels: gastos.map((x) => x.nome), datasets: [{ data: gastos.map((x) => x.valor), backgroundColor: gastos.map((x) => x.cor), borderWidth: 2, borderColor: cssVar('--surface'), hoverOffset: 4 }] },
      options: { responsive: true, maintainAspectRatio: false, cutout: '68%', plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${c.label}: ${fmtBRL(c.parsed)}` } } } },
    }));
  }
}

/* ===================================================== lançamentos */
const DESTINOS = {
  despesa: 'Despesa', receita: 'Receita', rendimento: 'Rendimento / outras', investimento: 'Investimento',
  transferencia: 'Transferência entre contas',
};
/** Sentido do dinheiro na conta (transferência não diz pelo tipo). */
const sentidoDe = (l) => l.sentido || (l.destino === 'receita' || l.destino === 'rendimento' ? 'entrada' : 'saida');
/** Nome da conta/cartão do lançamento. */
const contaDe = (l) => S.data.categorias.find((c) => c.id === l.categoria_id)?.nome || l.conta || '';
const DIAS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const pad2 = (n) => String(n).padStart(2, '0');
const isoHoje = () => { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
const fmtDia = (iso) => { const [a, m, d] = iso.split('-').map(Number); return `${pad2(d)}/${pad2(m)}`; };
const campoDe = (l) => (l.destino === 'despesa' ? 'cat:' + l.categoria_id : l.destino);
function nomeCampo(campo) {
  if (campo.startsWith('cat:')) return S.data.categorias.find((c) => c.id === campo.slice(4))?.nome || 'categoria';
  return DESTINOS[campo] || campo;
}
/** Valor que já foi digitado como total do mês para um campo (ignorado quando há lançamentos). */
function totalDigitado(ano, mes, campo) {
  const rec = S.data.meses.find((x) => x.ano === ano && x.mes === mes);
  if (!rec) return null;
  const v = campo.startsWith('cat:') ? rec.despesas?.[campo.slice(4)] : rec[campo];
  return v === undefined ? null : v;
}

/**
 * Barra do topo das telas por mês (como na referência): ‹ › e o nome do mês à esquerda;
 * clicar no nome abre um seletor com os 12 meses; ações à direita.
 */
function cabecalhoMes(ano, mes, base, acoes = '', sufixo = '') {
  const pa = anterior(ano, mes), px = seguinte(ano, mes);
  const u = (a, m) => `${base}/${a}/${m}${sufixo}`; // mantém a aba aberta ao trocar de mês
  const map = indexMeses(efetivos());
  const hoje = new Date();
  const ehHoje = hoje.getFullYear() === ano && hoje.getMonth() + 1 === mes;
  return `
    <div class="barra-pagina">
      <div class="barra-esq">
        <a class="btn icone discreto" href="${u(pa.ano, pa.mes)}" aria-label="Mês anterior">‹</a>
        <a class="btn icone discreto" href="${u(px.ano, px.mes)}" aria-label="Próximo mês">›</a>
        <div class="seletor-mes">
          <button type="button" class="titulo-mes" aria-haspopup="true" aria-expanded="false">
            ${MESES[mes - 1]} <span>${ano}</span> <i aria-hidden="true">▾</i></button>
          <div class="popover" hidden>
            <div class="pop-ano">
              <a class="btn icone discreto" href="${u(ano - 1, mes)}" aria-label="Ano anterior">‹</a>
              <b>${ano}</b>
              <a class="btn icone discreto" href="${u(ano + 1, mes)}" aria-label="Próximo ano">›</a>
            </div>
            <div class="pop-grid">
              ${MESES_CURTO.map((m, i) => {
                const tem = mesTemDados(map.get(ano * 100 + i + 1));
                return `<a href="${u(ano, i + 1)}" class="${i + 1 === mes ? 'ativo' : ''} ${tem ? 'com-dados' : ''}"
                  title="${MESES[i]}: ${tem ? 'com dados' : 'sem dados'}">${m}<i aria-hidden="true"></i></a>`;
              }).join('')}
            </div>
            ${ehHoje ? '' : `<a class="pop-hoje" href="${u(hoje.getFullYear(), hoje.getMonth() + 1)}">Ir para o mês atual</a>`}
          </div>
        </div>
      </div>
      <div class="barra-dir">${acoes}</div>
    </div>`;
}

/** Barra simples para telas que não são por mês. */
function cabecalhoSimples(titulo, acoes = '') {
  return `<div class="barra-pagina"><div class="barra-esq"><h1>${titulo}</h1></div><div class="barra-dir">${acoes}</div></div>`;
}

/* ========================================================= transações */
// Abas como no Minhas Finanças: Despesas | Receitas | Transferências | Extrato (tudo do mês)
const ABAS_TRANS = { despesas: 'Despesas', receitas: 'Receitas', transferencias: 'Transferências', extrato: 'Extrato' };
const fmtData = (iso) => { const [a, m, d] = iso.split('-'); return `${d}/${m}/${a}`; };
const contaPorId = (id) => S.data.categorias.find((c) => c.id === id);

/** Junta as duas pontas de cada transferência (saiu de uma conta, entrou em outra, mesmo valor, até 3 dias). */
function paresTransferencia(lista) {
  const usados = new Set();
  const pares = [];
  const saidas = lista.filter((l) => sentidoDe(l) === 'saida');
  for (const s of saidas) {
    const e = lista.find((x) => !usados.has(x.id) && x.id !== s.id && sentidoDe(x) === 'entrada'
      && Math.abs(x.valor - s.valor) < 0.005 && diasEntre(x.data, s.data) <= 3 && x.categoria_id !== s.categoria_id);
    usados.add(s.id);
    if (e) usados.add(e.id);
    pares.push({ saida: s, entrada: e || null, data: s.data, valor: s.valor });
  }
  for (const e of lista.filter((l) => sentidoDe(l) === 'entrada' && !usados.has(l.id))) pares.push({ saida: null, entrada: e, data: e.data, valor: e.valor });
  return pares.sort((a, b) => b.data.localeCompare(a.data));
}

function renderLancamentos(main, ano, mes, aba = 'despesas') {
  if (!ABAS_TRANS[aba]) aba = 'despesas';
  const pre = `${ano}-${pad2(mes)}`;
  const doMes = S.data.lancamentos.filter((l) => String(l.data).startsWith(pre));
  const ft = S.filtroTrans || (S.filtroTrans = { busca: '', conta: '', escopo: 'todos', classe: '' });
  // filtro de categoria só vale na aba do mesmo tipo (gasto x receita); escolher a principal inclui as subcategorias
  const tipoAba = aba === 'despesas' ? 'despesa' : aba === 'receitas' ? 'receita' : null;
  const classeFiltro = tipoAba && ft.classe && (ft.classe === 'sem' || tipoDaClasse(classePorId(ft.classe)) === tipoAba) ? ft.classe : '';
  const passa = (l) => (!ft.conta || l.categoria_id === ft.conta)
    && (ft.escopo === 'todos' || l.destino === 'transferencia' || l.escopo === ft.escopo)
    && (!ft.busca || normDesc(l.descricao).includes(normDesc(ft.busca)))
    && (!classeFiltro || (classeFiltro === 'sem' ? !l.classe_id : l.classe_id === classeFiltro || classePorId(l.classe_id)?.pai_id === classeFiltro));
  const soma = (arr) => arr.reduce((s, l) => s + l.valor, 0);
  const desp = doMes.filter((l) => l.destino === 'despesa');
  const rec = doMes.filter((l) => l.destino === 'receita' || l.destino === 'rendimento');
  const transf = doMes.filter((l) => l.destino === 'transferencia');
  const contagem = { despesas: [desp.length, soma(desp)], receitas: [rec.length, soma(rec)], transferencias: [paresTransferencia(transf).length, null], extrato: [doMes.length, null] };

  const chipClasse = (l) => {
    const c = classePorId(l.classe_id);
    if (c) return `<span class="chip-cat" style="--cor:${c.cor}">${esc(nomeClasse(c))}</span>`;
    if (l.destino !== 'despesa') return `<span class="chip-cat ${l.destino === 'receita' ? 'sem' : ''}" style="--cor:${l.destino === 'rendimento' ? '#0ea5e9' : '#10b981'}">${l.destino === 'receita' ? 'receita sem categoria' : DESTINOS[l.destino]}</span>`;
    return '<span class="chip-cat sem">sem categoria</span>';
  };
  const chipLado = (l) => (l.destino === 'transferencia' ? '' : `<span class="tag ${l.escopo === 'empresa' ? 'empresa' : ''}">${LADO[l.escopo] || 'Pessoal'}</span>`);
  const celConta = (c, extra = '') => (c ? `<span class="conta-nome">${avatarConta(c)}<span>${esc(c.banco || c.nome)}${extra}</span></span>` : '—');
  const linhaTabela = (l) => {
    const entrada = sentidoDe(l) === 'entrada';
    const c = contaPorId(l.categoria_id);
    return `<tr class="clicavel" data-id="${l.id}" tabindex="0">
      <td class="t-desc"><div class="t-desc-in">${l.destino === 'transferencia' ? '<span class="ic-cat transf" aria-hidden="true">⇄</span>' : iconeCat(classePorId(l.classe_id))}<div><b>${esc(l.descricao)}</b>${l.parcelas ? ` <span class="tag parcela">${textoParcela(l)}</span>` : ''}<small class="t-meta">${fmtDia(l.data)} · ${esc(c?.banco || c?.nome || l.conta || '')}</small></div></div></td>
      <td class="t-cat">${chipClasse(l)} ${chipLado(l)}</td>
      <td class="t-conta">${celConta(c)}</td>
      <td class="t-data">${fmtData(l.data)}</td>
      <td class="t-valor ${entrada ? 'pos' : l.destino === 'despesa' ? 'neg' : ''}">${entrada ? '+' : '−'} ${fmtBRL(l.valor)}</td>
    </tr>`;
  };
  const tabela = (lista, vazio) => (lista.length ? `<div class="tabela-wrap"><table class="tabela tabela-trans">
      <thead><tr><th>Descrição</th><th class="t-cat">Categoria</th><th class="t-conta">Conta</th><th class="t-data">Data</th><th class="t-valor">Valor</th></tr></thead>
      <tbody>${lista.sort((a, b) => b.data.localeCompare(a.data) || a.descricao.localeCompare(b.descricao)).map(linhaTabela).join('')}</tbody>
    </table></div>` : `<div class="vazio-lanc"><p class="sub">${vazio}</p></div>`);

  // Barra de filtros (busca, conta, categoria, pessoal/empresa)
  const filtros = `<div class="filtros-lanc">
    <input type="search" data-f="busca" placeholder="Buscar descrição…" value="${esc(ft.busca)}" aria-label="Buscar">
    <select data-f="conta" aria-label="Conta"><option value="">Todas as contas</option>
      ${cats().map((c) => `<option value="${c.id}" ${ft.conta === c.id ? 'selected' : ''}>${esc(c.banco ? `${c.banco} (${c.nome})` : c.nome)}</option>`).join('')}</select>
    ${tipoAba ? `<select data-f="classe" aria-label="Categoria">${opcoesClasses(tipoAba, classeFiltro, 'Todas as categorias').replace('<option value="">Todas as categorias</option>', `<option value="">Todas as categorias</option><option value="sem" ${classeFiltro === 'sem' ? 'selected' : ''}>Sem categoria</option>`)}</select>` : ''}
    ${aba !== 'transferencias' ? `<div class="seg" role="group" aria-label="Pessoal ou empresa">
      ${[['todos', 'Todos'], ['pessoal', 'Pessoal'], ['empresa', 'Empresa']].map(([v, t]) =>
        `<button data-escopo="${v}" class="${ft.escopo === v ? 'ativo' : ''}" aria-pressed="${ft.escopo === v}">${t}</button>`).join('')}</div>` : ''}
  </div>`;

  let corpo = '';
  if (aba === 'despesas' || aba === 'receitas') {
    const base = aba === 'despesas' ? desp : rec;
    const lista = base.filter(passa);
    const pes = soma(lista.filter((l) => l.escopo !== 'empresa')), emp = soma(lista.filter((l) => l.escopo === 'empresa'));
    corpo = `<section class="card">
      ${filtros}
      ${tabela(lista, base.length ? 'Nada com esse filtro.' : `Nenhuma ${aba === 'despesas' ? 'despesa' : 'receita'} em ${MESES[mes - 1].toLowerCase()}. Importe o extrato ou lance à mão.`)}
      <div class="rodape-trans">
        <span>${lista.length} ${aba === 'despesas' ? (lista.length === 1 ? 'despesa' : 'despesas') : (lista.length === 1 ? 'receita' : 'receitas')}</span>
        <span>Pessoal <b>${fmtBRL(pes)}</b></span><span>Empresa <b>${fmtBRL(emp)}</b></span>
        <span class="total">Total <b class="${aba === 'despesas' ? 'neg' : 'pos'}">${fmtBRL(soma(lista))}</b></span>
      </div>
    </section>`;
  } else if (aba === 'transferencias') {
    const pares = paresTransferencia(transf.filter(passa));
    corpo = `<section class="card">
      ${tituloCard('Transferências entre as suas contas', 'Dinheiro que só mudou de conta (ou pagamento de fatura). Não conta como receita nem despesa.')}
      ${filtros}
      ${pares.length ? `<div class="tabela-wrap"><table class="tabela tabela-trans">
        <thead><tr><th>Descrição</th><th>De → para</th><th class="t-data">Data</th><th class="t-valor">Valor</th></tr></thead>
        <tbody>${pares.map((p) => {
          const l = p.saida || p.entrada;
          return `<tr class="clicavel" data-id="${l.id}" tabindex="0">
            <td class="t-desc"><b>${esc(l.descricao)}</b><small class="t-meta">${fmtDia(p.data)}</small>${!p.saida || !p.entrada ? '<small class="aviso-txt">só uma das pontas foi lançada</small>' : ''}</td>
            <td class="t-rota"><span>${p.saida ? celConta(contaPorId(p.saida.categoria_id)) : '<span class="sub">—</span>'}</span><span class="seta-transf" aria-hidden="true">→</span><span>${p.entrada ? celConta(contaPorId(p.entrada.categoria_id)) : '<span class="sub">—</span>'}</span></td>
            <td class="t-data">${fmtData(p.data)}</td>
            <td class="t-valor">${fmtBRL(p.valor)}</td></tr>`;
        }).join('')}</tbody></table></div>` : '<div class="vazio-lanc"><p class="sub">Nenhuma transferência neste mês.</p></div>'}
      <div class="rodape-trans"><span>${pares.length} ${pares.length === 1 ? 'transferência' : 'transferências'}</span>
        <span class="total">Total movimentado <b>${fmtBRL(pares.reduce((s, p) => s + p.valor, 0))}</b></span></div>
    </section>`;
  } else {
    // Extrato: tudo do mês, dia a dia, com o gráfico de entradas e saídas
    const lista = doMes.filter(passa);
    const entradas = soma(lista.filter((l) => l.destino === 'receita' || l.destino === 'rendimento'));
    const saidas = soma(lista.filter((l) => l.destino === 'despesa'));
    const porDia = new Map();
    for (const l of [...lista].sort((a, b) => b.data.localeCompare(a.data))) {
      if (!porDia.has(l.data)) porDia.set(l.data, []);
      porDia.get(l.data).push(l);
    }
    corpo = `
      <section class="mini-kpis">
        <div class="card"><span>Entradas</span><strong class="pos">${fmtBRL(entradas)}</strong></div>
        <div class="card"><span>Saídas</span><strong class="neg">${fmtBRL(saidas)}</strong></div>
        <div class="card"><span>Transferências</span><strong>${fmtBRL(soma(lista.filter((l) => l.destino === 'transferencia' && sentidoDe(l) === 'saida')))}</strong></div>
        <div class="card"><span>Resultado</span><strong class="${cls(entradas - saidas)}">${fmtBRL(entradas - saidas)}</strong></div>
      </section>
      <section class="card grafico">
        ${tituloCard('Dia a dia', 'Entradas e saídas de cada dia do mês.', 'grafico')}
        <div class="canvas-box pequeno"><canvas id="g-extrato"></canvas></div>
      </section>
      <section class="card">
        ${filtros}
        ${!lista.length ? '<div class="vazio-lanc"><p class="sub">Nenhuma movimentação neste mês.</p></div>'
          : [...porDia.entries()].map(([dia, ls]) => {
            const d = new Date(dia + 'T12:00:00');
            const totalDia = ls.reduce((s, l) => s + (l.destino === 'despesa' ? -l.valor : l.destino === 'receita' || l.destino === 'rendimento' ? l.valor : 0), 0);
            return `<div class="dia"><div class="dia-cab"><span>${DIAS[d.getDay()]}, ${fmtDia(dia)}</span><span class="${cls(totalDia)}">${fmtBRL(totalDia)}</span></div>
              ${ls.map((l) => {
                const entrada = sentidoDe(l) === 'entrada';
                const t = l.destino === 'transferencia';
                const c = contaPorId(l.categoria_id);
                const cl = classePorId(l.classe_id);
                return `<button class="lanc ${t ? 'transf' : ''}" data-id="${l.id}">
                  ${t ? '<span class="ic-cat transf" aria-hidden="true">⇄</span>' : iconeCat(cl)}
                  <span class="lanc-txt"><b>${esc(l.descricao)}</b><small>${esc(rotuloLanc(l))} · ${esc(c?.banco || c?.nome || l.conta || '')}</small></span>
                  <span class="lanc-valor ${t ? '' : entrada ? 'pos' : 'neg'}">${entrada ? '+' : '−'} ${fmtBRL(l.valor)}</span>
                </button>`;
              }).join('')}</div>`;
          }).join('')}
      </section>`;
  }

  main.innerHTML = `
    ${cabecalhoMes(ano, mes, '#/lancamentos', `
      <button class="btn" data-a="importar">${ICON.upload}<span>Importar extrato</span></button>
      <button class="btn primario" data-a="novo">${ICON.mais}<span>Novo</span></button>`, `/${aba}`)}
    <nav class="abas-trans" role="tablist">
      ${Object.entries(ABAS_TRANS).map(([k, nome]) => `<a role="tab" href="#/lancamentos/${ano}/${mes}/${k}" class="${aba === k ? 'ativo' : ''} ${k}" aria-selected="${aba === k}">
        <span>${nome}</span><small>${contagem[k][0]}${contagem[k][1] !== null ? `<span class="ab-total"> · ${fmtBRL(contagem[k][1])}</span>` : ''}</small></a>`).join('')}
    </nav>
    ${corpo}`;

  main.querySelector('[data-a="novo"]').addEventListener('click', () => abrirLancamento(null, { ano, mes }, { destino: aba === 'receitas' ? 'receita' : aba === 'transferencias' ? 'transferencia' : 'despesa' }));
  main.querySelector('[data-a="importar"]').addEventListener('click', () => abrirImportacao({ ano, mes }));
  main.querySelectorAll('[data-id]').forEach((el) => {
    const abrir = () => abrirLancamento(S.data.lancamentos.find((l) => l.id === el.dataset.id), { ano, mes });
    el.addEventListener('click', abrir);
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') abrir(); });
  });
  main.querySelectorAll('[data-escopo]').forEach((b) => b.addEventListener('click', () => { ft.escopo = b.dataset.escopo; render(); }));
  main.querySelectorAll('select[data-f]').forEach((s) => s.addEventListener('change', () => { ft[s.dataset.f] = s.value; render(); }));
  const busca = main.querySelector('[data-f="busca"]');
  busca?.addEventListener('input', () => {
    clearTimeout(renderLancamentos._t);
    renderLancamentos._t = setTimeout(() => {
      ft.busca = busca.value; render();
      const b2 = app.querySelector('[data-f="busca"]');
      if (b2) { b2.focus(); b2.setSelectionRange(b2.value.length, b2.value.length); }
    }, 250);
  });
  // Gráfico do extrato: entradas e saídas por dia
  const canvas = main.querySelector('#g-extrato');
  if (canvas && window.Chart) {
    const dias = new Date(ano, mes, 0).getDate();
    const ent = Array(dias).fill(0), sai = Array(dias).fill(0);
    for (const l of doMes.filter(passa)) {
      const d = Number(l.data.slice(8, 10)) - 1;
      if (l.destino === 'receita' || l.destino === 'rendimento') ent[d] += l.valor;
      else if (l.destino === 'despesa') sai[d] += l.valor;
    }
    S.charts.push(new Chart(canvas, {
      type: 'bar',
      data: {
        labels: Array.from({ length: dias }, (_, i) => pad2(i + 1)),
        datasets: [
          { label: 'Entradas', data: ent, backgroundColor: cssVar('--c-receita'), borderRadius: 4, maxBarThickness: 16 },
          { label: 'Saídas', data: sai, backgroundColor: cssVar('--c-despesa'), borderRadius: 4, maxBarThickness: 16 },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
        plugins: { legend: { labels: { color: cssVar('--muted'), boxWidth: 12, usePointStyle: true } }, tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${fmtBRL(c.parsed.y)}` } } },
        scales: { x: { grid: { display: false }, ticks: { color: cssVar('--muted') } }, y: { grid: { color: cssVar('--border') }, ticks: { color: cssVar('--muted'), callback: (v) => v.toLocaleString('pt-BR') } } },
      },
    }));
  }
}

/* ========================================================== calendário */
// Cores como no Minhas Finanças: verde = receitas, vermelho = despesas na conta,
// azul = compras no cartão, amarelo = transferências / investimento.
const TIPOS_CAL = {
  receita: { nome: 'Receitas', cor: '#10b981' },
  conta: { nome: 'Despesas na conta', cor: '#ef4444' },
  cartao: { nome: 'Compras no cartão', cor: '#3b82f6' },
  transf: { nome: 'Transferências', cor: '#f59e0b' },
};
/** Valor curto para caber no quadradinho do dia: 18.000 / 320,50 */
const valorCurto = (v) => (v >= 1000 ? Math.round(v).toLocaleString('pt-BR') : v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
function tipoCal(l) {
  if (l.destino === 'receita' || l.destino === 'rendimento') return 'receita';
  if (l.destino === 'transferencia' || l.destino === 'investimento') return 'transf';
  return contaPorId(l.categoria_id)?.tipo === 'credito' ? 'cartao' : 'conta';
}

function renderCalendario(main, ano, mes) {
  const hoje = isoHoje();
  const primeiro = new Date(ano, mes - 1, 1);
  const diasMes = new Date(ano, mes, 0).getDate();
  const inicio = primeiro.getDay(); // domingo = 0
  const totalCelulas = Math.ceil((inicio + diasMes) / 7) * 7;
  const agrupar = S.calAgrupar !== false;
  const porDia = new Map();
  for (const l of S.data.lancamentos) {
    if (!porDia.has(l.data)) porDia.set(l.data, []);
    porDia.get(l.data).push(l);
  }
  // Datas da fatura dos cartões (fechamento e vencimento) neste mês
  const marcas = new Map();
  const marcar = (dia, txt) => {
    if (!dia || dia > diasMes) return;
    const k = `${ano}-${pad2(mes)}-${pad2(dia)}`;
    if (!marcas.has(k)) marcas.set(k, []);
    marcas.get(k).push(txt);
  };
  for (const c of cartoesCredito()) {
    marcar(c.dia_fechamento, `Fecha a fatura ${c.banco || c.nome}`);
    marcar(c.dia_vencimento, `Vence a fatura ${c.banco || c.nome}`);
  }
  const doMesIso = `${ano}-${pad2(mes)}`;
  let sel = S.calDia && S.calDia.startsWith(doMesIso) ? S.calDia : hoje.startsWith(doMesIso) ? hoje
    : ([...porDia.keys()].filter((k) => k.startsWith(doMesIso)).sort()[0] || `${doMesIso}-01`);
  S.calDia = sel;

  const celula = (i) => {
    const d = new Date(ano, mes - 1, 1 - inicio + i);
    const iso = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    const fora = d.getMonth() !== mes - 1;
    const ls = porDia.get(iso) || [];
    let barras = '';
    if (agrupar) {
      const tot = {};
      for (const l of ls) { const t = tipoCal(l); tot[t] = (tot[t] || 0) + l.valor; }
      barras = Object.keys(TIPOS_CAL).filter((t) => tot[t]).map((t) =>
        `<span class="cal-barra" style="--cor:${TIPOS_CAL[t].cor}" title="${TIPOS_CAL[t].nome}: ${fmtBRL(tot[t])}">${valorCurto(tot[t])}</span>`).join('');
    } else {
      barras = ls.slice(0, 3).map((l) => `<span class="cal-barra" style="--cor:${TIPOS_CAL[tipoCal(l)].cor}" title="${esc(l.descricao)}: ${fmtBRL(l.valor)}">${esc(l.descricao)}</span>`).join('')
        + (ls.length > 3 ? `<span class="cal-mais">+${ls.length - 3}</span>` : '');
    }
    const mk = (marcas.get(iso) || []).map((t) => `<span class="cal-marca" title="${esc(t)}">${t.startsWith('Vence') ? '⏰' : '🔒'} ${esc(t.replace(/^(Fecha a fatura|Vence a fatura) /, ''))}</span>`).join('');
    const pontos = Object.keys(TIPOS_CAL).filter((t) => ls.some((l) => tipoCal(l) === t)).map((t) => `<i style="background:${TIPOS_CAL[t].cor}"></i>`).join('') + (marcas.has(iso) ? '<i class="marca"></i>' : '');
    return `<button class="cal-dia ${fora ? 'fora' : ''} ${iso === hoje ? 'hoje' : ''} ${iso === sel ? 'sel' : ''}" data-dia="${iso}" ${fora ? 'tabindex="-1"' : ''}>
      <span class="cal-num">${d.getDate()}</span>
      <span class="cal-barras">${mk}${barras}</span>
      <span class="cal-pontos" aria-hidden="true">${pontos}</span>
    </button>`;
  };

  const lsSel = (porDia.get(sel) || []).sort((a, b) => a.descricao.localeCompare(b.descricao));
  const dSel = new Date(sel + 'T12:00:00');
  const entSel = lsSel.filter((l) => tipoCal(l) === 'receita').reduce((s, l) => s + l.valor, 0);
  const saiSel = lsSel.filter((l) => tipoCal(l) === 'conta' || tipoCal(l) === 'cartao').reduce((s, l) => s + l.valor, 0);

  // Resumo do mês: dia que mais gastou, dias sem gasto, média por dia e maior gasto
  const gastoDia = new Map();
  let maiorGasto = null;
  for (const l of S.data.lancamentos) {
    if (l.destino !== 'despesa' || !String(l.data).startsWith(doMesIso)) continue;
    gastoDia.set(l.data, (gastoDia.get(l.data) || 0) + l.valor);
    if (!maiorGasto || l.valor > maiorGasto.valor) maiorGasto = l;
  }
  const hojeOuFim = hoje.startsWith(doMesIso) ? Number(hoje.slice(8, 10)) : diasMes; // no mês atual conta só até hoje
  const diaTop = [...gastoDia.entries()].sort((a, b) => b[1] - a[1])[0];
  const totalGasto = [...gastoDia.values()].reduce((s, v) => s + v, 0);
  const diasSemGasto = Math.max(0, hojeOuFim - [...gastoDia.keys()].filter((k) => Number(k.slice(8, 10)) <= hojeOuFim).length);

  main.innerHTML = `
    ${cabecalhoMes(ano, mes, '#/calendario', `
      <label class="check-linha alternar"><input type="checkbox" data-a="agrupar" ${agrupar ? 'checked' : ''}> Agrupar por dia</label>`)}
    <section class="kpis-linha">
      <div class="kpi-pill card"><span class="kpi-ic" style="--cor:var(--neg)">↑</span><div><small>Dia que mais gastou</small><strong>${diaTop ? `${fmtDia(diaTop[0])} · ${fmtBRL(diaTop[1])}` : '—'}</strong></div></div>
      <div class="kpi-pill card"><span class="kpi-ic" style="--cor:var(--pos)">✓</span><div><small>Dias sem gastos</small><strong>${diasSemGasto} de ${hojeOuFim}</strong></div></div>
      <div class="kpi-pill card"><span class="kpi-ic" style="--cor:#f59e0b">≈</span><div><small>Média por dia</small><strong>${fmtBRL(hojeOuFim ? totalGasto / hojeOuFim : 0)}</strong></div></div>
      <div class="kpi-pill card"><span class="kpi-ic" style="--cor:#818cf8">★</span><div><small>Maior gasto</small><strong>${maiorGasto ? fmtBRL(maiorGasto.valor) : '—'}</strong>${maiorGasto ? `<small class="kpi-sub">${esc(maiorGasto.descricao)}</small>` : ''}</div></div>
    </section>
    <div class="cal-legenda">${Object.values(TIPOS_CAL).map((t) => `<span><i style="background:${t.cor}"></i>${t.nome}</span>`).join('')}
      <span>⏰ vencimento · 🔒 fechamento da fatura</span></div>
    <section class="card cal-card">
      <div class="cal-semana">${['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'].map((d) => `<span>${d}</span>`).join('')}</div>
      <div class="cal-grade">${Array.from({ length: totalCelulas }, (_, i) => celula(i)).join('')}</div>
    </section>
    <section class="card">
      ${tituloCard(`${['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'][dSel.getDay()]}, ${dSel.getDate()} de ${MESES[dSel.getMonth()].toLowerCase()}`,
        lsSel.length ? `${lsSel.length} ${lsSel.length === 1 ? 'movimentação' : 'movimentações'} · entrou ${fmtBRL(entSel)} · saiu ${fmtBRL(saiSel)}` : 'Nada neste dia.', 'calendario')}
      ${(marcas.get(sel) || []).map((t) => `<p class="hint">${t.startsWith('Vence') ? '⏰' : '🔒'} ${esc(t)}</p>`).join('')}
      ${lsSel.map((l) => {
        const entrada = sentidoDe(l) === 'entrada';
        const c = contaPorId(l.categoria_id);
        return `<button class="lanc" data-id="${l.id}">
          <span class="lanc-icone" style="--cor:${TIPOS_CAL[tipoCal(l)].cor}">${tipoCal(l) === 'transf' ? '⇄' : entrada ? '↓' : '↑'}</span>
          <span class="lanc-txt"><b>${esc(l.descricao)}</b><small>${esc(rotuloLanc(l))} · ${esc(c?.banco || c?.nome || l.conta || '')}</small></span>
          <span class="lanc-valor ${entrada ? 'pos' : ''}">${entrada ? '+' : '−'} ${fmtBRL(l.valor)}</span></button>`;
      }).join('')}
    </section>`;

  main.querySelector('[data-a="agrupar"]').addEventListener('change', (e) => { S.calAgrupar = e.target.checked; render(); });
  main.querySelectorAll('[data-dia]').forEach((b) => b.addEventListener('click', () => {
    const iso = b.dataset.dia;
    S.calDia = iso;
    const [a, m] = iso.split('-').map(Number);
    if (a !== ano || m !== mes) location.hash = `#/calendario/${a}/${m}`; else render();
  }));
  main.querySelectorAll('.lanc[data-id]').forEach((b) => b.addEventListener('click', () => {
    abrirLancamento(S.data.lancamentos.find((l) => l.id === b.dataset.id), { ano, mes });
  }));
}

/** Sugere a categoria pelo histórico: a última usada com a mesma descrição. */
function categoriaPorHistorico(descricao) {
  const n = normDesc(descricao);
  if (!n) return null;
  const achado = [...S.data.lancamentos].reverse().find((l) => l.destino === 'despesa' && normDesc(l.descricao) === n);
  return achado?.categoria_id || null;
}

function abrirLancamento(existente, { ano, mes }, { destino: destinoNovo = 'despesa' } = {}) {
  const c = cats().filter((x) => x.ativo !== false || x.id === existente?.categoria_id);
  if (!c.length) { toast('Cadastre um cartão ou categoria em Ajustes primeiro.', 'erro'); location.hash = '#/ajustes'; return; }
  const hoje = new Date();
  const noMes = hoje.getFullYear() === ano && hoje.getMonth() + 1 === mes;
  const dataPadrao = existente?.data || (noMes ? isoHoje() : `${ano}-${pad2(mes)}-01`);
  const descricoes = [...new Set(S.data.lancamentos.map((l) => l.descricao))].slice(-300);

  const dlg = document.createElement('dialog');
  dlg.className = 'editor';
  dlg.innerHTML = `
    <form>
      <header><h2>${existente ? 'Editar lançamento' : 'Novo lançamento'}</h2></header>
      <div class="corpo">
        <div class="seg largo" role="radiogroup" aria-label="Tipo">
          ${Object.entries(DESTINOS).map(([v, t]) => `<label><input type="radio" name="destino" value="${v}" ${(existente?.destino || destinoNovo) === v ? 'checked' : ''}><span>${t}</span></label>`).join('')}
        </div>
        <div class="campos-2">
          <label class="campo"><span>Data</span><input type="date" name="data" value="${dataPadrao}" required></label>
          <label class="campo"><span>Valor</span><input name="valor" inputmode="decimal" autocomplete="off" placeholder="0,00" value="${existente ? esc(String(existente.valor).replace('.', ',')) : ''}" required><small class="calc-preview"></small></label>
        </div>
        <label class="campo"><span>Descrição</span><input name="descricao" list="lista-descricoes" maxlength="200" autocomplete="off" placeholder="Ex.: Mercado, Pix João (salário), Fatura..." value="${esc(existente?.descricao || '')}" required></label>
        <datalist id="lista-descricoes">${descricoes.map((d) => `<option value="${esc(d)}">`).join('')}</datalist>
        <div class="campos-2">
          <label class="campo"><span>Conta / cartão</span>
            <select name="categoria_id">${c.map((x) => `<option value="${x.id}" ${existente?.categoria_id === x.id ? 'selected' : ''}>${esc(x.nome)} (${x.tipo === 'debito' ? 'débito' : 'crédito'})</option>`).join('')}</select>
          </label>
          <label class="campo" data-com-classe><span data-rotulo-classe>Categoria</span>
            <select name="classe_id"></select>
          </label>
          <div class="campo" data-so-transf><span>Nesta conta, o dinheiro</span>
            <div class="seg" role="radiogroup" aria-label="Sentido">
              ${[['saida', 'Saiu'], ['entrada', 'Entrou']].map(([v, t]) => `<label><input type="radio" name="sentido" value="${v}" ${(existente ? sentidoDe(existente) : 'saida') === v ? 'checked' : ''}><span>${t}</span></label>`).join('')}
            </div>
          </div>
        </div>
        <label class="check-linha" data-com-classe><input type="checkbox" name="lembrar"> Criar regra: classificar sempre assim quando a descrição tiver
          <input class="regra-texto" name="texto_regra" value="${esc(regraPadrao(existente?.descricao || ''))}" aria-label="Texto da regra"></label>
        <p class="hint" data-so-transf>Transferência entre as suas contas (ou pagamento da fatura do cartão) fica registrada, mas não conta como receita nem gasto.</p>
        <div class="campos-2" data-so-despesa>
          <div class="campo"><span>Recorrência</span>
            <select name="recorrencia">
              <option value="">Automática${existente && !existente.recorrencia ? ` (${RECORRENCIAS[recorrenciaDe(existente)].toLowerCase()})` : ''}</option>
              ${Object.entries(RECORRENCIAS).map(([v, t]) => `<option value="${v}" ${existente?.recorrencia === v ? 'selected' : ''}>${t}</option>`).join('')}
            </select>
          </div>
          <div class="campo" data-so-parcela><span>Parcela</span>
            <div class="parcela-campos"><input name="parcela" type="number" min="1" max="99" inputmode="numeric" value="${existente?.parcela || ''}" aria-label="Parcela">
              <span>de</span><input name="parcelas" type="number" min="2" max="99" inputmode="numeric" value="${existente?.parcelas || ''}" aria-label="Total de parcelas"></div>
          </div>
        </div>
        <div class="campo" data-nao-transf><span>Este lançamento é</span>
          <div class="seg" role="radiogroup" aria-label="Pessoal ou empresa">
            ${[['pessoal', 'Pessoal'], ['empresa', 'Da empresa']].map(([v, t]) => `<label><input type="radio" name="escopo" value="${v}" ${(existente?.escopo || 'pessoal') === v ? 'checked' : ''}><span>${t}</span></label>`).join('')}
          </div>
        </div>
        ${existente?.origem === 'extrato' ? `<p class="hint">Veio do extrato${existente.conta ? ` (${esc(existente.conta)})` : ''}. Se importar o mesmo extrato de novo, ele não será repetido.</p>` : ''}
      </div>
      <footer>
        ${existente ? '<button type="button" class="btn perigo" data-a="excluir">Excluir</button>' : '<span></span>'}
        <div class="direita">
          <button type="button" class="btn" data-a="cancelar">Cancelar</button>
          ${existente ? '' : '<button type="button" class="btn" data-a="mais">Salvar e lançar outro</button>'}
          <button type="submit" class="btn primario">Salvar</button>
        </div>
      </footer>
    </form>`;
  document.body.appendChild(dlg);
  const form = dlg.querySelector('form');
  const fechar = () => { dlg.close(); dlg.remove(); };
  let tipoAtual = null;
  const atualizarTipo = () => {
    const d = form.destino.value;
    // Categoria: de gasto para despesa, de receita para receita/rendimento, nenhuma para transferência
    const tipo = tipoClasseDe(d);
    dlg.querySelectorAll('[data-com-classe]').forEach((x) => { x.hidden = !tipo; });
    if (tipo && tipo !== tipoAtual) {
      const atual = form.classe_id.value || (tipoAtual === null ? existente?.classe_id : null);
      const valido = atual && tipoDaClasse(classePorId(atual)) === tipo ? atual : null;
      form.classe_id.innerHTML = opcoesClasses(tipo, valido);
      dlg.querySelector('[data-rotulo-classe]').textContent = tipo === 'receita' ? 'Categoria de receita' : 'Categoria de gasto';
    }
    tipoAtual = tipo || tipoAtual;
    dlg.querySelectorAll('[data-so-transf]').forEach((x) => { x.hidden = d !== 'transferencia'; });
    dlg.querySelectorAll('[data-nao-transf]').forEach((x) => { x.hidden = d === 'transferencia'; });
    // Recorrência só para gasto; parcela só quando parcelada (ou quando já tem número de parcela)
    dlg.querySelectorAll('[data-so-despesa]').forEach((x) => { x.hidden = d !== 'despesa'; });
    dlg.querySelector('[data-so-parcela]').hidden = form.recorrencia.value !== 'parcelada' && !(form.recorrencia.value === '' && form.parcelas.value);
  };
  form.addEventListener('change', atualizarTipo);
  atualizarTipo();
  // Escolher a categoria já ajusta o lado (ex.: Funcionários → Empresa)
  form.classe_id.addEventListener('change', () => {
    const lado = classePorId(form.classe_id.value)?.escopo_padrao;
    if (lado) form.querySelector(`[name="escopo"][value="${lado}"]`).checked = true;
  });
  form.valor.addEventListener('input', () => {
    const prev = form.valor.parentElement.querySelector('.calc-preview');
    try { const r = parseExpr(form.valor.value); prev.textContent = r.formula ? `= ${fmtBRL(r.value)}` : ''; form.valor.classList.remove('invalido'); }
    catch (e) { prev.textContent = e.message; form.valor.classList.add('invalido'); }
  });
  // Ao digitar uma descrição conhecida, sugere conta, categoria e lado (pelas regras ou pela última vez)
  form.descricao.addEventListener('change', () => {
    form.texto_regra.value = regraPadrao(form.descricao.value);
    // "PARC 03/10" na descrição já preenche a parcela
    const parc = detectarParcela(form.descricao.value, { cartao: S.data.categorias.find((c) => c.id === form.categoria_id.value)?.tipo === 'credito' });
    if (parc && !form.parcelas.value) { form.recorrencia.value = 'parcelada'; form.parcela.value = parc.parcela; form.parcelas.value = parc.parcelas; atualizarTipo(); }
    if (existente) return;
    const conta = categoriaPorHistorico(form.descricao.value);
    if (conta && form.categoria_id.querySelector(`option[value="${conta}"]`)) form.categoria_id.value = conta;
    const tipo = tipoClasseDe(form.destino.value);
    if (!tipo) return;
    const sug = sugerirClasse(form.descricao.value, tipo, form.escopo.value);
    if (sug.classe_id && form.classe_id.querySelector(`option[value="${sug.classe_id}"]`)) {
      form.classe_id.value = sug.classe_id;
      form.querySelector(`[name="escopo"][value="${sug.escopo}"]`).checked = true;
    }
  });

  async function salvar() {
    let valor;
    try { valor = parseExpr(form.valor.value).value; } catch (e) { toast(e.message, 'erro'); return false; }
    const destino = form.destino.value;
    const l = {
      ...(existente || {}),
      perfil_id: S.perfilId,
      data: form.data.value,
      descricao: form.descricao.value.trim(),
      valor,
      destino,
      categoria_id: form.categoria_id.value || null,
      classe_id: tipoClasseDe(destino) && tipoDaClasse(classePorId(form.classe_id.value)) === tipoClasseDe(destino) ? form.classe_id.value || null : null,
      sentido: destino === 'transferencia' ? form.sentido.value : destino === 'receita' || destino === 'rendimento' ? 'entrada' : 'saida',
      escopo: form.escopo.value,
      origem: existente?.origem || 'manual',
    };
    // Recorrência e parcela (só para gasto)
    const pTot = Number(form.parcelas.value) || null, pAtual = Number(form.parcela.value) || null;
    const ehParcelada = destino === 'despesa' && (form.recorrencia.value === 'parcelada' || (form.recorrencia.value === '' && pTot));
    l.recorrencia = destino === 'despesa' ? form.recorrencia.value || null : null;
    l.parcelas = ehParcelada && pTot && pTot >= 2 ? pTot : null;
    l.parcela = l.parcelas ? Math.min(pAtual || 1, l.parcelas) : null;
    if (!l.data || !l.descricao || !(l.valor > 0)) { toast('Preencha data, descrição e um valor maior que zero.', 'erro'); return false; }
    // 1) Mesmo lançamento já existe?
    const dup = S.data.lancamentos.find((x) => x.id !== l.id && x.data === l.data && Math.abs(x.valor - l.valor) < 0.005 && normDesc(x.descricao) === normDesc(l.descricao));
    if (dup && !confirm(`Já existe um lançamento igual em ${fmtDia(dup.data)}:\n"${dup.descricao}" — ${fmtBRL(dup.valor)}\n\nSalvar mesmo assim? (só se for outro gasto igual)`)) return false;
    // 2) O mês já tinha um total digitado para esse campo?
    const [a, m] = l.data.split('-').map(Number);
    const campo = campoDe(l);
    const jaTem = S.data.lancamentos.some((x) => x.id !== l.id && x.data.startsWith(`${a}-${pad2(m)}`) && campoDe(x) === campo);
    const digitado = totalDigitado(a, m, campo);
    if (!jaTem && digitado !== null && !confirm(`${MESES[m - 1]} de ${a} já tem um total digitado em "${nomeCampo(campo)}" (${fmtBRL(digitado)}).\n\nCom lançamentos, esse campo passa a ser a SOMA dos lançamentos e o total digitado deixa de contar (para não somar duas vezes).\n\nContinuar?`)) return false;
    try {
      const salvo = await S.store.saveLancamento(l);
      const i = S.data.lancamentos.findIndex((x) => x.id === salvo.id);
      if (i >= 0) S.data.lancamentos[i] = salvo; else S.data.lancamentos.push(salvo);
      const texto = normDesc(form.texto_regra.value).trim();
      if (form.lembrar.checked && l.classe_id && texto.length >= 2) {
        const regra = await S.store.saveRegra({ perfil_id: S.perfilId, texto, classe_id: l.classe_id, escopo: l.escopo });
        const j = S.data.regras.findIndex((r) => r.texto === regra.texto);
        if (j >= 0) S.data.regras[j] = regra; else S.data.regras.push(regra);
      }
      toast('Lançamento salvo.');
      return true;
    } catch (e) { toast('Erro ao salvar: ' + e.message, 'erro'); return false; }
  }

  form.addEventListener('submit', async (e) => { e.preventDefault(); if (await salvar()) { fechar(); render(); } });
  dlg.querySelector('[data-a="mais"]')?.addEventListener('click', async () => {
    if (!form.reportValidity()) return;
    if (await salvar()) {
      render();
      form.descricao.value = ''; form.valor.value = '';
      form.valor.parentElement.querySelector('.calc-preview').textContent = '';
      form.descricao.focus();
    }
  });
  dlg.querySelector('[data-a="cancelar"]').addEventListener('click', fechar);
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); fechar(); });
  dlg.querySelector('[data-a="excluir"]')?.addEventListener('click', async () => {
    if (!confirm(`Excluir "${existente.descricao}" (${fmtBRL(existente.valor)})?`)) return;
    try {
      await S.store.deleteLancamento(existente.id);
      S.data.lancamentos = S.data.lancamentos.filter((x) => x.id !== existente.id);
      toast('Lançamento excluído.');
      fechar(); render();
    } catch (e) { toast(e.message, 'erro'); }
  });
  dlg.showModal();
  (existente ? form.valor : form.descricao).focus();
}

/* ------------------------------------------------- importar extrato */
function abrirImportacao({ ano, mes }) {
  const c = cats().filter((x) => x.ativo !== false);
  if (!c.length) { toast('Cadastre um cartão ou categoria em Ajustes primeiro.', 'erro'); location.hash = '#/ajustes'; return; }
  const dlg = document.createElement('dialog');
  dlg.className = 'editor largo';
  const fechar = () => { dlg.close(); dlg.remove(); };
  let lido = null;
  let cfg = { categoria: c[0].id, escopo: 'pessoal', inverter: false };

  function passo1() {
    dlg.innerHTML = `
      <form>
        <header><h2>Importar extrato</h2></header>
        <div class="corpo">
          <p class="sub">Exporte o extrato no site/app do banco em <b>OFX</b> (melhor) ou <b>CSV</b>. Pode ser da conta ou do cartão,
            de uma semana ou do mês inteiro. Movimentações que já foram importadas antes são <b>puladas automaticamente</b>.</p>
          <label class="campo"><span>Arquivo do extrato</span><input type="file" name="arquivo" accept=".ofx,.csv,.txt" required></label>
          <label class="campo"><span>Este extrato é de qual conta/cartão?</span>
            <select name="categoria">${c.map((x) => `<option value="${x.id}" ${cfg.categoria === x.id ? 'selected' : ''}>${esc(x.nome)} (${x.tipo === 'debito' ? 'débito' : 'crédito'})</option>`).join('')}</select>
            <small class="hint">Importe um arquivo por conta ou cartão (ex.: conta da empresa, cartão da empresa, conta pessoal).</small>
          </label>
          <div class="campo"><span>Quando não der para saber, o gasto é</span>
            <div class="seg" role="radiogroup">
              ${[['pessoal', 'Pessoal'], ['empresa', 'Da empresa']].map(([v, t]) => `<label><input type="radio" name="escopo" value="${v}" ${cfg.escopo === v ? 'checked' : ''}><span>${t}</span></label>`).join('')}
            </div>
            <small class="hint">A separação é compra por compra: as regras e a categoria (ex.: Funcionários = empresa) decidem primeiro. Você confere na próxima tela.</small>
          </div>
          <p class="erro-msg" hidden></p>
        </div>
        <footer><span></span><div class="direita">
          <button type="button" class="btn" data-a="cancelar">Cancelar</button>
          <button type="submit" class="btn primario">Ler extrato</button>
        </div></footer>
      </form>`;
    const form = dlg.querySelector('form');
    form.querySelector('[data-a="cancelar"]').addEventListener('click', fechar);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const erro = form.querySelector('.erro-msg');
      try {
        cfg = { ...cfg, categoria: form.categoria.value, escopo: form.escopo.value };
        lido = await lerExtrato(form.arquivo.files[0]);
        if (!lido.linhas.length) throw new Error('Nenhuma movimentação encontrada no arquivo.');
        lido.linhas.forEach((l) => { l.incluir = undefined; });
        passo2();
      } catch (ex) { erro.textContent = ex.message; erro.hidden = false; }
    });
  }

  function passo2() {
    const catPadrao = S.data.categorias.find((x) => x.id === cfg.categoria);
    const chaves = new Set(S.data.lancamentos.filter((l) => l.chave).map((l) => l.chave));
    const linhas = lido.linhas.map((l, i) => {
      const valor = cfg.inverter ? -l.valor : l.valor;
      let status = 'novo';
      if (chaves.has(l.chave)) status = 'ja';
      // Parece repetido: mesmo dia, mesmo valor e MESMO sentido (sentido oposto é o outro lado de uma transferência)
      else if (S.data.lancamentos.some((x) => x.data === l.data && Math.abs(x.valor - Math.abs(valor)) < 0.005
        && sentidoDe(x) === (valor < 0 ? 'saida' : 'entrada')
        && (normDesc(x.descricao).slice(0, 10) === normDesc(l.descricao).slice(0, 10) || x.origem === 'manual'))) status = 'parece';
      const saida = valor < 0;
      // Categoria de gasto e lado: regra → histórico → padrão do arquivo
      // saída procura entre as categorias de gasto; entrada, entre as de receita
      const sug = sugerirClasse(l.descricao, saida ? 'despesa' : 'receita', cfg.escopo);
      const classeId = l.classeEscolhida !== undefined ? l.classeEscolhida : sug.classe_id;
      const ladoClasse = classePorId(classeId)?.escopo_padrao;
      // Transferência entre as próprias contas? (fatura, nome próprio, ou par com outra conta já importada)
      const tipoTransf = detectarTransferencia(l.descricao, prefs().meus_nomes || []);
      const par = !tipoTransf && S.data.lancamentos.find((x) => Math.abs(x.valor - Math.abs(valor)) < 0.005
        && diasEntre(x.data, l.data) <= 3 && sentidoDe(x) === (saida ? 'entrada' : 'saida') && contaDe(x) && contaDe(x) !== catPadrao?.nome);
      const transf = tipoTransf || (par ? 'par' : null);
      const padrao = transf ? 'transferencia'
        : saida ? 'despesa'
        : catPadrao?.tipo === 'credito' ? 'transferencia' // entrada no cartão = pagamento da fatura
        : 'receita';
      return {
        i, ...l, valor: Math.abs(valor), saida, status, transf, par,
        incluir: l.incluir ?? status === 'novo',
        destino: l.destinoEscolhido ?? padrao,
        categoria_id: cfg.categoria,
        classe_id: classeId,
        escopo: l.escopoEscolhido ?? (l.classeEscolhida !== undefined && ladoClasse ? ladoClasse : sug.escopo),
        por: l.classeEscolhida !== undefined ? null : sug.por,
      };
    });
    const datas = linhas.map((l) => l.data).sort();
    const n = (s) => linhas.filter((l) => l.status === s).length;
    // categoria só vale se for do tipo certo (gasto para despesa, receita para receita)
    const classeOk = (l) => (tipoClasseDe(l.destino) && l.classe_id && tipoDaClasse(classePorId(l.classe_id)) === tipoClasseDe(l.destino) ? l.classe_id : null);
    const opcoesClasse = (l) => (tipoClasseDe(l.destino) ? opcoesClasses(tipoClasseDe(l.destino), classeOk(l), '— classificar depois —') : '<option value="">—</option>');
    const selecionadas = linhas.filter((l) => l.incluir && l.status !== 'ja' && l.destino !== 'ignorar');
    const autoClass = selecionadas.filter((l) => classeOk(l)).length;
    const nTransf = selecionadas.filter((l) => l.destino === 'transferencia').length;
    const semCat = selecionadas.filter((l) => l.destino === 'despesa' && !l.classe_id).length;

    dlg.innerHTML = `
      <form>
        <header><h2>Conferir extrato</h2></header>
        <div class="corpo">
          <p class="sub">${esc(lido.formato)} · ${esc(lido.conta)} · ${fmtDia(datas[0])} a ${fmtDia(datas[datas.length - 1])} · ${linhas.length} movimentações</p>
          <div class="status-import">
            <span class="tag pos">${n('novo')} novas</span>
            <span class="tag">${n('ja')} já importadas (serão puladas)</span>
            ${n('parece') ? `<span class="tag aviso">${n('parece')} parecem repetidas (desmarcadas — confira)</span>` : ''}
            ${autoClass ? `<span class="tag pos">${autoClass} já com categoria</span>` : ''}
            ${nTransf ? `<span class="tag">${nTransf} transferências entre contas (não contam)</span>` : ''}
            ${semCat ? `<span class="tag">${semCat} para classificar depois</span>` : ''}
          </div>
          ${!S.data.classes.length ? '<p class="hint">Dica: crie as categorias de gasto (Funcionários, Assinaturas…) em Ajustes ou na tela Classificar. Dá para importar agora e classificar depois.</p>' : ''}
          <label class="check-linha"><input type="checkbox" name="inverter" ${cfg.inverter ? 'checked' : ''}>
            Inverter sinais <small class="sub">(marque se as compras aparecerem como entrada)</small></label>
          <div class="tabela-wrap">
            <table class="tabela import">
              <thead><tr><th></th><th>Data</th><th>Descrição</th><th>Valor</th><th>Tipo</th><th>Categoria</th><th>Pessoal / empresa</th></tr></thead>
              <tbody>
                ${linhas.map((l) => `
                  <tr data-i="${l.i}" class="${l.status}">
                    <td><input type="checkbox" data-c="incluir" ${l.incluir && l.status !== 'ja' ? 'checked' : ''} ${l.status === 'ja' ? 'disabled' : ''} aria-label="Importar"></td>
                    <td>${fmtDia(l.data)}</td>
                    <td class="desc">${esc(l.descricao)}${l.status === 'ja' ? ' <span class="tag">já importada</span>' : l.status === 'parece' ? ' <span class="tag aviso">parece repetida</span>' : ''}</td>
                    <td class="${l.saida ? 'neg' : 'pos'}">${l.saida ? '−' : '+'} ${fmtNum(l.valor)}</td>
                    <td><select data-c="destino" ${l.status === 'ja' ? 'disabled' : ''}>
                      ${[['despesa', 'Despesa'], ['receita', 'Receita'], ['rendimento', 'Rendim./outras'], ['investimento', 'Investimento'], ['transferencia', 'Transferência'], ['ignorar', 'Não importar']]
                        .map(([v, t]) => `<option value="${v}" ${l.destino === v ? 'selected' : ''}>${t}</option>`).join('')}</select>
                      ${l.destino === 'transferencia' && l.transf ? `<span class="tag" title="${l.transf === 'par' ? `Mesmo valor em ${esc(contaDe(l.par))} em ${fmtDia(l.par.data)}` : ''}">${{ fatura: 'fatura', propria: 'conta sua', par: 'par: ' + esc(contaDe(l.par)) }[l.transf]}</span>` : ''}</td>
                    <td><select data-c="classe" ${l.status === 'ja' || !tipoClasseDe(l.destino) ? 'disabled' : ''}>${opcoesClasse(l)}</select>
                      ${!classeOk(l) ? '' : l.por === 'regra' ? '<span class="tag pos" title="Classificado por uma regra">regra</span>' : l.por === 'historico' ? '<span class="tag" title="Igual a um lançamento anterior">anterior</span>' : ''}</td>
                    <td><select data-c="escopo" ${l.status === 'ja' ? 'disabled' : ''}>
                      <option value="pessoal" ${l.escopo === 'pessoal' ? 'selected' : ''}>Pessoal</option>
                      <option value="empresa" ${l.escopo === 'empresa' ? 'selected' : ''}>Empresa</option></select></td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>
          <p class="hint"><b>Transferência</b>: dinheiro passando entre suas contas ou pagamento da fatura do cartão — fica registrado, mas não conta como receita nem gasto.
            <b>Não importar</b>: deixa a linha de fora.</p>
        </div>
        <footer>
          <button type="button" class="btn" data-a="voltar">Voltar</button>
          <div class="direita">
            <button type="button" class="btn" data-a="cancelar">Cancelar</button>
            <button type="submit" class="btn primario" ${selecionadas.length ? '' : 'disabled'}>Importar ${selecionadas.length}</button>
          </div>
        </footer>
      </form>`;

    const form = dlg.querySelector('form');
    const orig = (i) => lido.linhas[i];
    form.querySelectorAll('tr[data-i]').forEach((tr) => {
      const l = orig(Number(tr.dataset.i));
      tr.querySelector('[data-c="incluir"]').addEventListener('change', (e) => { l.incluir = e.target.checked; passo2(); });
      tr.querySelector('[data-c="destino"]').addEventListener('change', (e) => { l.destinoEscolhido = e.target.value; passo2(); });
      tr.querySelector('[data-c="classe"]').addEventListener('change', (e) => { l.classeEscolhida = e.target.value || null; passo2(); });
      tr.querySelector('[data-c="escopo"]').addEventListener('change', (e) => { l.escopoEscolhido = e.target.value; });
    });
    form.inverter.addEventListener('change', (e) => {
      cfg.inverter = e.target.checked;
      lido.linhas.forEach((l) => { delete l.destinoEscolhido; delete l.classeEscolhida; });
      passo2();
    });
    form.querySelector('[data-a="voltar"]').addEventListener('click', passo1);
    form.querySelector('[data-a="cancelar"]').addEventListener('click', fechar);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      // Lê de novo os selects (categoria/escopo mudam sem redesenhar)
      const atuais = linhas.map((l) => ({ ...l, escopo: orig(l.i).escopoEscolhido ?? l.escopo }))
        .filter((l) => l.incluir && l.status !== 'ja' && l.destino !== 'ignorar');
      const nomeConta = S.data.categorias.find((x) => x.id === cfg.categoria)?.nome || lido.conta;
      const ehCartao = S.data.categorias.find((x) => x.id === cfg.categoria)?.tipo === 'credito';
      const novos = atuais.map((l) => {
        // compra parcelada no extrato ("PARC 03/10") já entra marcada
        const parc = l.destino === 'despesa' ? detectarParcela(l.descricao, { cartao: ehCartao }) : null;
        return {
          perfil_id: S.perfilId, data: l.data, descricao: l.descricao.slice(0, 200), valor: Math.round(l.valor * 100) / 100,
          destino: l.destino, categoria_id: l.categoria_id, // a conta/cartão do arquivo, em qualquer tipo
          classe_id: classeOk(l),
          sentido: l.saida ? 'saida' : 'entrada',
          escopo: l.escopo, origem: 'extrato', conta: nomeConta, chave: l.chave,
          recorrencia: parc ? 'parcelada' : null, parcela: parc?.parcela || null, parcelas: parc?.parcelas || null,
        };
      });
      // O outro lado de um par (já importado antes como receita/despesa) também vira transferência
      const paresParaCorrigir = atuais.filter((l) => l.destino === 'transferencia' && l.par && l.par.destino !== 'transferencia').map((l) => l.par.id);
      // Avisa se algum mês já tinha total digitado nesses campos
      const afetados = new Set();
      for (const l of novos) {
        const [a, m] = l.data.split('-').map(Number);
        const campo = campoDe(l);
        const jaTem = S.data.lancamentos.some((x) => x.data.startsWith(`${a}-${pad2(m)}`) && campoDe(x) === campo);
        if (!jaTem && totalDigitado(a, m, campo) !== null) afetados.add(`${MESES_CURTO[m - 1]}/${String(a).slice(2)}: ${nomeCampo(campo)}`);
      }
      if (afetados.size && !confirm(`Estes campos já tinham total digitado e passarão a ser a soma dos lançamentos:\n\n${[...afetados].join('\n')}\n\nContinuar?`)) return;
      const btn = form.querySelector('[type="submit"]');
      btn.disabled = true;
      try {
        const inseridos = await S.store.importarLancamentos(novos);
        S.data.lancamentos.push(...inseridos);
        if (paresParaCorrigir.length) await virarTransferencia([...new Set(paresParaCorrigir)]);
        const pulados = linhas.length - inseridos.length;
        const paraClassificar = semClasse(inseridos).length;
        toast(`${inseridos.length} importados${pulados ? ` · ${pulados} pulados (repetidos ou ignorados)` : ''}${paraClassificar ? ` · ${paraClassificar} para classificar` : ''}.`);
        fechar();
        // Leva direto para classificar o que ficou sem categoria
        const [a, m] = (inseridos[0]?.data || `${ano}-${mes}`).split('-').map(Number);
        if (paraClassificar) location.hash = `#/classificar/${a}/${m}`; else render();
      } catch (ex) {
        toast('Erro ao importar: ' + ex.message, 'erro');
        btn.disabled = false;
      }
    });
  }

  document.body.appendChild(dlg);
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); fechar(); });
  passo1();
  dlg.showModal();
}

/* ===================================================== contas e saldos */
// Modo Controle: o saldo de cada conta vem do saldo inicial + entradas − saídas dos lançamentos
// (inclusive transferências entre as próprias contas). Cartões de crédito não entram no "saldo nas contas".
const SUBTIPOS = { corrente: 'Conta corrente', empresa: 'Conta empresa', investimento: 'Investimento', poupanca: 'Poupança', outra: 'Outra conta' };
const contasBancarias = () => cats().filter((c) => c.tipo === 'debito' && c.ativo !== false);
const cartoesCredito = () => cats().filter((c) => c.tipo === 'credito' && c.ativo !== false);
const isoFim = (ano, mes) => `${ano}-${pad2(mes)}-${pad2(new Date(ano, mes, 0).getDate())}`;
const comSinal = (l) => (sentidoDe(l) === 'entrada' ? l.valor : -l.valor);

/** Saldo da conta no fim do dia `ate` (AAAA-MM-DD). O saldo inicial vale a partir de `saldo_desde`. */
function saldoConta(cat, ate) {
  const desde = cat.saldo_desde || '0000-00-00';
  let s = Number(cat.saldo_inicial || 0);
  for (const l of S.data.lancamentos) {
    if (l.categoria_id === cat.id && l.data >= desde && l.data <= ate) s += comSinal(l);
  }
  return Math.round(s * 100) / 100;
}

/** Movimento de uma conta no mês: receitas, despesas, transferências e saldos. */
function movimentoConta(cat, ano, mes) {
  const pre = `${ano}-${pad2(mes)}`;
  const r = { receitas: 0, despesas: 0, transfEntrada: 0, transfSaida: 0, qtd: 0 };
  for (const l of S.data.lancamentos) {
    if (l.categoria_id !== cat.id || !String(l.data).startsWith(pre)) continue;
    r.qtd += 1;
    if (l.destino === 'transferencia') {
      if (sentidoDe(l) === 'entrada') r.transfEntrada += l.valor; else r.transfSaida += l.valor;
    } else if (sentidoDe(l) === 'entrada') r.receitas += l.valor;
    else r.despesas += l.valor;
  }
  const pa = anterior(ano, mes);
  r.saldoInicio = saldoConta(cat, isoFim(pa.ano, pa.mes));
  r.saldoFim = saldoConta(cat, isoFim(ano, mes));
  return r;
}

/** Totais do mês a partir dos lançamentos (modo Controle). */
function totaisControle(ano, mes) {
  const pre = `${ano}-${pad2(mes)}`;
  const doMes = S.data.lancamentos.filter((l) => String(l.data).startsWith(pre));
  const receitas = doMes.filter((l) => l.destino === 'receita' || l.destino === 'rendimento').reduce((s, l) => s + l.valor, 0);
  const despesas = doMes.filter((l) => l.destino === 'despesa').reduce((s, l) => s + l.valor, 0);
  const saldo = contasBancarias().reduce((s, c) => s + saldoConta(c, isoFim(ano, mes)), 0);
  return { receitas, despesas, balanco: receitas - despesas, saldo, doMes };
}

/** Bolinha colorida da conta (cor do cartão escolhida em Ajustes). */
function avatarConta(cat) {
  const e = ESTILOS[estiloDe(cat)];
  return `<span class="avatar-conta" style="--cv-bg:${e.bg};--cv-tx:${e.tx}">${esc((cat.banco || cat.nome || '?').trim()[0].toUpperCase())}</span>`;
}

/** "↑ 12% vs mês anterior" em forma de etiqueta. */
function chipVariacao(v, ref, menorMelhor = false) {
  if (ref === null || ref === undefined || ref === 0 || v === null || v === undefined) return '<span class="chip-var neutro">— vs mês anterior</span>';
  const p = (v - ref) / Math.abs(ref);
  const bom = menorMelhor ? p <= 0 : p >= 0;
  return `<span class="chip-var ${bom ? 'bom' : 'ruim'}">${p >= 0 ? '↗' : '↘'} ${Math.abs(Math.round(p * 100))}% vs mês anterior</span>`;
}

/* ============================================================== resumo */
function renderResumo(main, ano, mes) {
  const pa = anterior(ano, mes);
  const t = totaisControle(ano, mes);
  const tAnt = totaisControle(pa.ano, pa.mes);
  const hoje = new Date();
  const ehMesAtual = hoje.getFullYear() === ano && hoje.getMonth() + 1 === mes;
  const contas = contasBancarias();
  const cartoes = cartoesCredito();
  const map = indexMeses(efetivos());
  const l = linhaMes(ano, mes, map, cats());
  const lAnt = linhaMes(pa.ano, pa.mes, map, cats());
  const semSaldoInicial = contas.filter((c) => c.saldo_inicial === null || c.saldo_inicial === undefined);
  const pend = semClasse(t.doMes).length;
  const nConf = conferir(`${ano}-${pad2(mes)}`).length;

  const itemLanc = (x) => {
    const entrada = sentidoDe(x) === 'entrada';
    const classe = classePorId(x.classe_id);
    const conta = S.data.categorias.find((c) => c.id === x.categoria_id);
    return `<button class="lanc" data-id="${x.id}">
      ${iconeCat(classe)}
      <span class="lanc-txt"><b>${esc(x.descricao)}</b><small>${esc(classe?.nome || DESTINOS[x.destino])} · ${esc(conta?.banco || conta?.nome || x.conta || '')}</small></span>
      <span class="lanc-lado"><span class="lanc-valor ${entrada ? 'pos' : ''}">${entrada ? '+' : '−'} ${fmtBRL(x.valor)}</span><small>${fmtDia(x.data)}</small></span>
    </button>`;
  };
  const despesas = t.doMes.filter((x) => x.destino === 'despesa').sort((a, b) => b.data.localeCompare(a.data));
  const receitas = t.doMes.filter((x) => x.destino === 'receita' || x.destino === 'rendimento').sort((a, b) => b.data.localeCompare(a.data));

  main.innerHTML = `
    ${cabecalhoMes(ano, mes, '#/mes', `
      <a class="btn" href="#/calendario/${ano}/${mes}">${ICON.calendario}<span>Calendário</span></a>
      <button class="btn primario" data-a="importar-mes">${ICON.upload}<span>Importar extrato</span></button>`)}

    ${pend || nConf ? `<div class="faixa-aviso">${ICON.classificar}
      <span>${[pend ? `${pend} ${pend === 1 ? 'gasto' : 'gastos'} sem categoria` : '', nConf ? `${nConf} ${nConf === 1 ? 'item' : 'itens'} para conferir` : ''].filter(Boolean).join(' · ')}</span>
      <a class="btn" href="#/classificar/${ano}/${mes}">Resolver agora</a></div>` : ''}

    <div class="resumo-topo">
      <section class="card saldo-card">
        ${tituloCard(ehMesAtual ? 'Saldo atual' : `Saldo no fim de ${MESES[mes - 1].toLowerCase()}`, 'Soma do dinheiro nas suas contas.', 'carteira')}
        <div class="saldo-pilha">
          <div class="sp-linha entrada"><span class="sp-icone">↓</span><span>Receitas do mês</span><b>${fmtBRL(t.receitas)}</b></div>
          <div class="sp-saldo"><strong class="${cls(t.saldo)}">${grande(t.saldo)}</strong></div>
          <div class="sp-linha saida"><span class="sp-icone">↑</span><span>Despesas do mês</span><b>${fmtBRL(t.despesas)}</b></div>
        </div>
        ${semSaldoInicial.length && contas.length ? `<p class="hint aviso-txt">Falta o saldo inicial de ${semSaldoInicial.length === 1 ? 'uma conta' : `${semSaldoInicial.length} contas`}. <a href="#/contas/${ano}/${mes}">Definir →</a></p>` : ''}
      </section>

      <section class="visao-geral">
        <h2 class="secao">Visão geral</h2>
        <div class="vg-grade">
          <div class="card vg"><span class="vg-icone azul">${ICON.banco}</span><div><strong>${fmtBRL(t.saldo)}</strong><span>Saldo nas contas</span>${chipVariacao(t.saldo, tAnt.saldo)}</div></div>
          <div class="card vg"><span class="vg-icone verde">+</span><div><strong class="pos">${fmtBRL(t.receitas)}</strong><span>Total recebido</span>${chipVariacao(t.receitas, tAnt.receitas)}</div></div>
          <div class="card vg"><span class="vg-icone vermelho">−</span><div><strong class="neg">${fmtBRL(t.despesas)}</strong><span>Total gasto</span>${chipVariacao(t.despesas, tAnt.despesas, true)}</div></div>
          <div class="card vg"><span class="vg-icone amarelo">⇅</span><div><strong class="${cls(t.balanco)}">${fmtBRL(t.balanco)}</strong><span>Balanço (recebido − gasto)</span>${chipVariacao(t.balanco, tAnt.balanco)}</div></div>
        </div>
      </section>
    </div>

    <div class="resumo-grid">
      <div class="coluna">
        <section class="card">
          ${tituloCard('Resumo por conta', 'O que entrou e saiu de cada conta neste mês.', 'cofre')}
          ${contas.length ? `<div class="tabela-wrap"><table class="tabela tabela-leve">
            <thead><tr><th>Conta</th><th>Receitas</th><th>Despesas</th><th>Saldo</th></tr></thead>
            <tbody>${contas.map((c) => { const m = movimentoConta(c, ano, mes); return `<tr class="clicavel" data-ir="#/contas/${ano}/${mes}/${c.id}">
              <th><span class="conta-nome">${avatarConta(c)}<span>${esc(c.nome)}<small>${esc(SUBTIPOS[c.subtipo] || 'Conta')}</small></span></span></th>
              <td class="pos">${fmtBRL(m.receitas)}</td><td>${fmtBRL(m.despesas)}</td>
              <td><b class="${cls(m.saldoFim)}">${fmtBRL(m.saldoFim)}</b>${m.transfEntrada || m.transfSaida
                ? `<small class="transf-info" title="Transferências entre as suas contas">⇄ +${fmtNum(m.transfEntrada)} / −${fmtNum(m.transfSaida)}</small>` : ''}</td></tr>`; }).join('')}</tbody>
            <tfoot><tr><th>Total</th><td>${fmtBRL(contas.reduce((s, c) => s + movimentoConta(c, ano, mes).receitas, 0))}</td>
              <td>${fmtBRL(contas.reduce((s, c) => s + movimentoConta(c, ano, mes).despesas, 0))}</td><td>${fmtBRL(t.saldo)}</td></tr></tfoot>
          </table></div>` : '<p class="sub">Nenhuma conta cadastrada. <a href="#/ajustes">Cadastrar contas →</a></p>'}
        </section>

        <section class="card">
          ${tituloCard('Cartões de crédito', 'Fatura de cada cartão que vence neste mês.', 'cartoes')}
          ${cartoes.length ? `<div class="tabela-wrap"><table class="tabela tabela-leve">
            <thead><tr><th>Cartão</th><th>Fecha · vence</th><th>Fatura</th><th>Limite livre</th></tr></thead>
            <tbody>${cartoes.map((c) => {
              const f = faturaDoMes(c, ano, mes);
              const fat = valorFatura(c, ano, mes, l);
              const lim = limiteCartao(c);
              const dia = (d) => (d ? `${pad2(d)}/${pad2(mes)}` : '—');
              return `<tr class="clicavel" data-ir="#/cartoes/${ano}/${mes}/${c.id}" data-cartao-ir="${c.id}">
                <th><span class="conta-nome">${avatarConta(c)}<span>${esc(c.banco || c.nome)}<small>${esc(c.banco ? c.nome : '')}${c.titular ? ` · ${esc(c.titular)}` : ''}</small></span></span></th>
                <td>${f ? fmtDia(f.fim) : dia(c.dia_fechamento)} · ${f ? fmtDia(f.venc) : dia(c.dia_vencimento)}</td>
                <td><b>${fmtBRL(fat ?? 0)}</b>${f ? `<small class="tag ${STATUS_FATURA[f.status].cls}">${STATUS_FATURA[f.status].nome}</small>` : delta(fat, lAnt.desp[c.id], 'vs mês ant.', true)}</td>
                <td>${lim ? fmtBRL(lim.disponivel) : c.limite ? fmtBRL(Number(c.limite) - (fat ?? 0)) : '—'}</td></tr>`;
            }).join('')}</tbody>
            <tfoot><tr><th>Total</th><td></td><td>${fmtBRL(cartoes.reduce((s, c) => s + (valorFatura(c, ano, mes, l) ?? 0), 0))}</td><td></td></tr></tfoot>
          </table></div>` : '<p class="sub">Nenhum cartão cadastrado.</p>'}
        </section>
      </div>

      <div class="coluna">
        <section class="card">
          ${tituloCard('Despesas do mês', `${despesas.length} ${despesas.length === 1 ? 'despesa' : 'despesas'} · ${fmtBRL(t.despesas)}`)}
          ${despesas.length ? despesas.slice(0, 6).map(itemLanc).join('') : '<p class="sub">Nenhuma despesa lançada.</p>'}
          ${despesas.length ? `<a class="ver-todas" href="#/lancamentos/${ano}/${mes}/despesas">Ver todas as despesas →</a>` : ''}
        </section>
        <section class="card">
          ${tituloCard('Receitas do mês', `${receitas.length} ${receitas.length === 1 ? 'receita' : 'receitas'} · ${fmtBRL(t.receitas)}`)}
          ${receitas.length ? receitas.slice(0, 6).map(itemLanc).join('') : '<p class="sub">Nenhuma receita lançada.</p>'}
          ${receitas.length ? `<a class="ver-todas" href="#/lancamentos/${ano}/${mes}/receitas">Ver todas as receitas →</a>` : ''}
        </section>
      </div>
    </div>`;

  main.querySelectorAll('tr[data-ir]').forEach((tr) => tr.addEventListener('click', () => {
    if (tr.dataset.cartaoIr) S.cartaoSel = tr.dataset.cartaoIr;
    location.hash = tr.dataset.ir;
  }));
  main.querySelectorAll('.lanc[data-id]').forEach((b) => b.addEventListener('click', () => {
    abrirLancamento(S.data.lancamentos.find((x) => x.id === b.dataset.id), { ano, mes });
  }));
}

/* =============================================================== contas */
function renderContas(main, ano, mes) {
  const contas = contasBancarias();
  const movs = contas.map((c) => ({ c, m: movimentoConta(c, ano, mes) }));
  const soma = (k) => movs.reduce((s, x) => s + x.m[k], 0);
  const pa = anterior(ano, mes);
  const totalAnt = contas.reduce((s, c) => s + saldoConta(c, isoFim(pa.ano, pa.mes)), 0);

  main.innerHTML = `
    ${cabecalhoMes(ano, mes, '#/contas', `<a class="btn" href="#/ajustes">${ICON.mais}<span>Nova conta</span></a>`)}

    <section class="card resumo-cartoes">
      ${tituloCard('Dinheiro nas contas', `Saldo no fim de ${MESES[mes - 1].toLowerCase()}, somando todas as contas (cartões de crédito não entram).`, 'cofre')}
      <div class="resumo-cartoes-nums">
        <div><span>Saldo total</span><strong class="${cls(soma('saldoFim'))}">${grande(soma('saldoFim'))}</strong>${chipVariacao(soma('saldoFim'), totalAnt)}</div>
        <div><span>Entrou no mês</span><strong class="pos">${grande(soma('receitas'))}</strong></div>
        <div><span>Saiu no mês</span><strong>${grande(soma('despesas'))}</strong></div>
      </div>
    </section>

    ${!contas.length ? `<section class="card vazio"><h2>Nenhuma conta cadastrada</h2><p>Cadastre a conta corrente, a conta da empresa, a de investimento…</p>
      <div class="acoes"><a class="btn primario" href="#/ajustes">Cadastrar contas</a></div></section>` : `
    <section class="card">
      ${tituloCard('Contas', 'Toque numa conta para ajustar o tipo e o saldo inicial.')}
      <div class="tabela-wrap"><table class="tabela tabela-leve">
        <thead><tr><th>Conta</th><th>Saldo no início</th><th>Receitas</th><th>Despesas</th><th>Transf. recebidas</th><th>Transf. enviadas</th><th>Saldo no fim</th></tr></thead>
        <tbody>${movs.map(({ c, m }) => `<tr class="clicavel" data-conta="${c.id}" tabindex="0">
          <th><span class="conta-nome">${avatarConta(c)}<span>${esc(c.nome)}<small>${esc(SUBTIPOS[c.subtipo] || 'Conta')}${c.saldo_inicial === null || c.saldo_inicial === undefined ? ' · <span class="aviso-txt">sem saldo inicial</span>' : ''}</small></span></span></th>
          <td>${fmtBRL(m.saldoInicio)}</td>
          <td class="pos">${fmtBRL(m.receitas)}</td><td>${fmtBRL(m.despesas)}</td>
          <td>${fmtBRL(m.transfEntrada)}</td><td>${fmtBRL(m.transfSaida)}</td>
          <td><b class="${cls(m.saldoFim)}">${fmtBRL(m.saldoFim)}</b></td></tr>`).join('')}</tbody>
        <tfoot><tr><th>Total</th><td>${fmtBRL(soma('saldoInicio'))}</td><td>${fmtBRL(soma('receitas'))}</td><td>${fmtBRL(soma('despesas'))}</td>
          <td>${fmtBRL(soma('transfEntrada'))}</td><td>${fmtBRL(soma('transfSaida'))}</td><td>${fmtBRL(soma('saldoFim'))}</td></tr></tfoot>
      </table></div>
      <p class="hint">Transferências entre as suas contas tiram de uma e colocam na outra, sem contar como receita nem despesa.</p>
    </section>`}`;

  main.querySelectorAll('tr[data-conta]').forEach((tr) => {
    const abrir = () => { location.hash = `#/contas/${ano}/${mes}/${tr.dataset.conta}`; };
    tr.addEventListener('click', abrir);
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') abrir(); });
  });
}

/** Ajustar uma conta: tipo e saldo inicial (contas) ou limite e datas da fatura (cartões). */
function abrirConta(cat) {
  const credito = cat.tipo === 'credito';
  const primeiroLanc = S.data.lancamentos.filter((l) => l.categoria_id === cat.id).map((l) => l.data).sort()[0];
  const dlg = document.createElement('dialog');
  dlg.className = 'editor';
  dlg.innerHTML = `
    <form>
      <header><h2>${esc(cat.banco || cat.nome)}</h2></header>
      <div class="corpo">
        <label class="campo"><span>Nome</span><input name="nome" value="${esc(cat.nome)}" required maxlength="60"></label>
        ${credito ? `
          <label class="campo"><span>Limite do cartão</span><input name="limite" inputmode="decimal" placeholder="0,00" value="${cat.limite ? fmtNum(Number(cat.limite)) : ''}"></label>
          <div class="campos-2">
            <label class="campo"><span>Dia do fechamento</span><input name="dia_fechamento" type="number" min="1" max="31" value="${cat.dia_fechamento || ''}"></label>
            <label class="campo"><span>Dia do vencimento</span><input name="dia_vencimento" type="number" min="1" max="31" value="${cat.dia_vencimento || ''}"></label>
          </div>` : `
          <label class="campo"><span>Tipo de conta</span><select name="subtipo">
            ${Object.entries(SUBTIPOS).map(([k, v]) => `<option value="${k}" ${(cat.subtipo || 'corrente') === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
          <div class="campos-2">
            <label class="campo"><span>Saldo inicial</span><input name="saldo_inicial" inputmode="decimal" placeholder="0,00" value="${cat.saldo_inicial !== null && cat.saldo_inicial !== undefined ? fmtNum(Number(cat.saldo_inicial)) : ''}"></label>
            <label class="campo"><span>Na data</span><input name="saldo_desde" type="date" value="${cat.saldo_desde || primeiroLanc || isoHoje()}"></label>
          </div>
          <p class="hint">Quanto havia nesta conta no começo do dia escolhido. A partir daí o site soma as entradas e tira as saídas sozinho.</p>`}
      </div>
      <footer><span></span><div class="direita">
        <button type="button" class="btn" data-a="cancelar">Cancelar</button>
        <button type="submit" class="btn primario">Salvar</button>
      </div></footer>
    </form>`;
  document.body.appendChild(dlg);
  const form = dlg.querySelector('form');
  const fechar = () => { dlg.close(); dlg.remove(); };
  form.querySelector('[data-a="cancelar"]').addEventListener('click', fechar);
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); fechar(); });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const num = (n) => (form[n]?.value.trim() ? parseExpr(form[n].value).value : null);
      const mud = { nome: form.nome.value.trim() || cat.nome };
      if (credito) {
        Object.assign(mud, { limite: num('limite'), dia_fechamento: Number(form.dia_fechamento.value) || null, dia_vencimento: Number(form.dia_vencimento.value) || null });
      } else {
        Object.assign(mud, { subtipo: form.subtipo.value, saldo_inicial: num('saldo_inicial'), saldo_desde: form.saldo_desde.value || null });
      }
      const salvo = await S.store.saveCategoria({ ...cat, ...mud });
      Object.assign(cat, salvo);
      toast('Conta atualizada.');
      fechar();
      render();
    } catch (ex) { toast(ex.message, 'erro'); }
  });
  dlg.showModal();
}

/* ============================================================ cartões */
// Cores dos cartões desenhados (nomes genéricos; o nome do banco é escrito pelo usuário)
const ESTILOS = {
  // Modelos parecidos com cartões de verdade (desenhados, sem logotipo; o nome vem do campo "Banco")
  letreiro: { nome: 'Modelo: preto com o nome grande', bg: 'linear-gradient(135deg,#18212a,#11181f)', tx: '#ffffff', modelo: true, chip: 'prata', cor: '#38bdf8' },
  metal: { nome: 'Modelo: preto metal escovado', bg: 'repeating-linear-gradient(0deg,rgba(255,255,255,.035) 0 1px,transparent 1px 3px),linear-gradient(135deg,#53575d,#2e3034 50%,#1c1e21)', tx: '#f1f5f9', modelo: true, chip: 'prata', cor: '#a1a8b3' },
  'vermelho-liso': { nome: 'Modelo: vermelho liso', bg: 'linear-gradient(135deg,#ec3a2f,#d8211a)', tx: '#ffffff', modelo: true, chip: 'prata', cor: '#ef4444' },
  'dourado-escamas': { nome: 'Modelo: dourado com escamas', bg: 'radial-gradient(circle at 50% 100%,transparent 8px,rgba(255,255,255,.22) 9px,transparent 10.5px) 0 0/18px 11px,linear-gradient(135deg,#dcb873,#bf9248 55%,#a97c35)', tx: '#ffffff', modelo: true, chip: 'prata', cor: '#d4a24c' },
  preto: { nome: 'Preto', bg: 'linear-gradient(135deg,#3a3f47 0%,#16181c 55%,#0b0c0e 100%)', tx: '#f8fafc', cor: '#7c8696' },
  grafite: { nome: 'Grafite', bg: 'linear-gradient(135deg,#64748b,#334155)', tx: '#f8fafc', cor: '#94a3b8' },
  azul: { nome: 'Azul', bg: 'linear-gradient(135deg,#38bdf8,#0284c7 60%,#075985)', tx: '#ffffff', cor: '#0ea5e9' },
  marinho: { nome: 'Azul-marinho', bg: 'linear-gradient(135deg,#1e40af,#172554)', tx: '#f8fafc', cor: '#4f6bed' },
  roxo: { nome: 'Roxo', bg: 'linear-gradient(135deg,#a855f7,#7e22ce 60%,#581c87)', tx: '#ffffff', cor: '#a855f7' },
  vermelho: { nome: 'Vermelho', bg: 'linear-gradient(135deg,#f43f5e,#be123c 60%,#881337)', tx: '#ffffff', cor: '#f43f5e' },
  laranja: { nome: 'Laranja', bg: 'linear-gradient(135deg,#fb923c,#ea580c 60%,#9a3412)', tx: '#ffffff', cor: '#f97316' },
  amarelo: { nome: 'Amarelo', bg: 'linear-gradient(135deg,#fde047,#facc15 55%,#eab308)', tx: '#1f2937', cor: '#eab308' },
  verde: { nome: 'Verde', bg: 'linear-gradient(135deg,#34d399,#059669 60%,#065f46)', tx: '#ffffff', cor: '#10b981' },
  dourado: { nome: 'Dourado', bg: 'linear-gradient(135deg,#fde68a,#d97706 70%,#92400e)', tx: '#1f2937', cor: '#d97706' },
  prata: { nome: 'Prata', bg: 'linear-gradient(135deg,#f1f5f9,#cbd5e1 55%,#94a3b8)', tx: '#1e293b', cor: '#a8b3c2' },
};
const ORDEM_ESTILOS_CREDITO = ['preto', 'azul', 'roxo', 'vermelho', 'laranja', 'verde', 'marinho', 'dourado'];
/** Cor do cartão: a escolhida em Ajustes, ou uma padrão pela ordem. */
function estiloDe(cat) {
  if (cat.estilo && ESTILOS[cat.estilo]) return cat.estilo;
  if (cat.tipo === 'debito') return 'grafite';
  const i = cats().filter((c) => c.tipo === 'credito').findIndex((c) => c.id === cat.id);
  return ORDEM_ESTILOS_CREDITO[Math.max(0, i) % ORDEM_ESTILOS_CREDITO.length];
}

const CHIP = `<svg class="cv-chip" viewBox="0 0 40 30" aria-hidden="true"><rect x="1" y="1" width="38" height="28" rx="5" fill="#e9c46a" stroke="#c99a2e"/>
  <path d="M1 11h12M1 19h12M27 11h12M27 19h12M13 1v28M27 1v28M13 15h14" stroke="#b9862a" stroke-width="1.4" fill="none"/></svg>`;
const CHIP_PRATA = `<svg class="cv-chip" viewBox="0 0 40 30" aria-hidden="true"><defs><linearGradient id="chip-prata" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f1f5f9"/><stop offset=".5" stop-color="#b8bec7"/><stop offset="1" stop-color="#e2e8f0"/></linearGradient></defs>
  <rect x="1" y="1" width="38" height="28" rx="5" fill="url(#chip-prata)" stroke="#8b929c"/>
  <path d="M1 11h12M1 19h12M27 11h12M27 19h12M13 1v28M27 1v28M13 15h14" stroke="#7c838d" stroke-width="1.4" fill="none"/></svg>`;
const SEM_CONTATO = `<svg class="cv-nfc" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
  <path d="M8.5 7.5a6 6 0 0 1 0 9M12 5a9.5 9.5 0 0 1 0 14M15.5 2.5a13 13 0 0 1 0 19"/></svg>`;

/** Cartão desenhado. */
function cartaoVisual(cat, { valor = null, rotulo = 'Fatura do mês', classe = '', atributos = '' } = {}) {
  const k = estiloDe(cat);
  const e = ESTILOS[k];
  // enfeites dos modelos: o nome grande no fundo (preto com letreiro) ou a marca d'água redonda (vermelho)
  const palavras = (cat.banco || cat.nome || '').trim().split(' ').filter(Boolean).slice(0, 3);
  const enfeite = k === 'letreiro' ? `<span class="cv-letreiro" aria-hidden="true">${palavras.map((p) => `<span>${esc(p)}</span>`).join('')}</span>`
    : k === 'vermelho-liso' ? '<span class="cv-marca" aria-hidden="true"></span>' : '';
  return `<div class="cartao-vis modelo-${k} ${classe}" style="--cv-bg:${e.bg};--cv-tx:${e.tx}" ${atributos}>
    ${enfeite}
    <div class="cv-topo"><b class="cv-banco">${esc(cat.banco || cat.nome)}</b><span class="cv-tipo">${cat.tipo === 'credito' ? 'Crédito' : 'Débito'}</span></div>
    <div class="cv-meio">${e.chip === 'prata' ? CHIP_PRATA : CHIP}${SEM_CONTATO}</div>
    <div class="cv-pe">
      <div class="cv-dono"><small>${esc(cat.banco ? cat.nome : 'Titular')}</small><span>${esc(cat.titular || (cat.banco ? '' : '—'))}</span></div>
      ${valor !== undefined ? `<div class="cv-valor"><small>${rotulo}</small><strong>${valor === null ? '—' : grande(valor)}</strong></div>` : ''}
    </div>
  </div>`;
}

/** Título de quadro com subtítulo curto e ilustração (deixa claro o que o quadro mostra). */
function tituloCard(titulo, sub = '', ilustra = '') {
  return `<div class="card-cab">
    <div><h2>${titulo}</h2>${sub ? `<p class="sub">${sub}</p>` : ''}</div>
    ${ilustra && ILUSTRA[ilustra] ? `<div class="ilustra">${ILUSTRA[ilustra]}</div>` : ''}
  </div>`;
}

/* ------------------------------------------------ fatura do cartão (ciclo) */
const isoDe = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
/** Dia d no mês (ano, mes), sem passar do último dia (ex.: dia 31 em fevereiro = 28/29). */
const diaNoMes = (ano, mes, d) => new Date(ano, mes - 1, Math.min(d, new Date(ano, mes, 0).getDate()));
const somaValores = (ls) => ls.reduce((s, l) => s + l.valor, 0);
const STATUS_FATURA = {
  aberta: { nome: 'Aberta', cls: '' },
  fechada: { nome: 'Fechada · a pagar', cls: 'aviso' },
  paga: { nome: 'Paga', cls: 'pos' },
  vencida: { nome: 'Pagamento não encontrado', cls: 'aviso' },
  vazia: { nome: 'Sem compras', cls: '' },
};

/**
 * Fatura do cartão que VENCE no mês (ano, mes), pelo dia de fechamento e vencimento.
 * Compras do dia seguinte ao fechamento anterior até o fechamento. null se o cartão não tem os dois dias.
 */
function faturaDoMes(cat, ano, mes) {
  const F = Number(cat.dia_fechamento), V = Number(cat.dia_vencimento);
  if (!F || !V) return null;
  const venc = diaNoMes(ano, mes, V);
  // fecha antes de vencer: no mesmo mês se o fechamento vem antes do vencimento; senão, no mês anterior
  const fm = V > F ? { ano, mes } : anterior(ano, mes);
  const fech = diaNoMes(fm.ano, fm.mes, F);
  const pf = anterior(fm.ano, fm.mes);
  const de = diaNoMes(pf.ano, pf.mes, F);
  de.setDate(de.getDate() + 1);
  const ini = isoDe(de), fim = isoDe(fech), vencIso = isoDe(venc);
  const doCartao = S.data.lancamentos.filter((l) => l.categoria_id === cat.id && l.data >= ini && l.data <= fim);
  const compras = doCartao.filter((l) => l.destino === 'despesa').sort((a, b) => b.data.localeCompare(a.data));
  const estornos = doCartao.filter((l) => l.destino !== 'despesa' && l.destino !== 'transferencia' && sentidoDe(l) === 'entrada');
  const total = round2(somaValores(compras) - somaValores(estornos));
  // Pagamento: "pagamento recebido" no próprio cartão, ou transferência saindo de outra conta com o mesmo valor
  // (entre o fechamento e uma semana depois do vencimento)
  const ate = new Date(venc); ate.setDate(ate.getDate() + 7);
  const janIni = fim, janFim = isoDe(ate);
  const naJanela = (l) => l.destino === 'transferencia' && l.data > janIni && l.data <= janFim;
  const pagoNoCartao = somaValores(S.data.lancamentos.filter((l) => naJanela(l) && l.categoria_id === cat.id && sentidoDe(l) === 'entrada'));
  const pagoDeConta = S.data.lancamentos.some((l) => naJanela(l) && l.categoria_id !== cat.id && sentidoDe(l) === 'saida'
    && total > 0 && Math.abs(l.valor - total) <= Math.max(1, total * 0.005));
  const pago = total > 0 && (pagoNoCartao >= total - 1 || pagoDeConta);
  const hoje = isoHoje();
  const status = hoje <= fim ? 'aberta' : total <= 0 ? 'vazia' : pago ? 'paga' : hoje <= vencIso ? 'fechada' : 'vencida';
  return { ini, fim, venc: vencIso, compras, total, pago, status, ano, mes };
}

/** A fatura em que caem as compras de hoje (a "aberta"), procurando nos próximos meses. */
function faturaAberta(cat) {
  const h = new Date();
  for (let i = 0; i < 3; i++) {
    const d = new Date(h.getFullYear(), h.getMonth() + i, 1);
    const f = faturaDoMes(cat, d.getFullYear(), d.getMonth() + 1);
    if (!f) return null;
    if (isoHoje() <= f.fim && isoHoje() >= f.ini) return f;
  }
  return null;
}

/** Limite: usado = fatura aberta + faturas fechadas ainda sem pagamento (até 2 anteriores). */
function limiteCartao(cat) {
  const limite = Number(cat.limite) || 0;
  const aberta = faturaAberta(cat);
  if (!limite || !aberta) return null;
  let usado = Math.max(0, aberta.total);
  let { ano, mes } = aberta;
  for (let i = 0; i < 2; i++) {
    ({ ano, mes } = anterior(ano, mes));
    const f = faturaDoMes(cat, ano, mes);
    if (f && !f.pago && f.total > 0) usado += f.total;
  }
  usado = round2(usado);
  return { limite, usado, disponivel: round2(limite - usado), pct: Math.min(100, (usado / limite) * 100), aberta };
}

/** Valor da fatura do mês: pelo ciclo (modo controle, com os dias informados) ou o total do mês. */
function valorFatura(cat, ano, mes, linha) {
  const f = ehControle() && cat.tipo === 'credito' ? faturaDoMes(cat, ano, mes) : null;
  return f ? f.total : linha.desp[cat.id];
}

function barraLimite(lim) {
  if (!lim) return '';
  return `<div class="limite" title="Usado ${fmtBRL(lim.usado)} de ${fmtBRL(lim.limite)}">
    <div class="limite-barra"><span style="width:${lim.pct}%" class="${lim.pct > 90 ? 'alto' : lim.pct > 70 ? 'medio' : ''}"></span></div>
    <div class="limite-leg"><span>Disponível <b>${fmtBRL(lim.disponivel)}</b></span><span>de ${fmtBRL(lim.limite)}</span></div>
  </div>`;
}

function renderCartoes(main, ano, mes) {
  const todas = cats();
  const controle = ehControle();
  const acoes = controle
    ? `<button class="btn primario" data-a="importar-mes">${ICON.upload}<span>Importar extrato</span></button>`
    : `<button class="btn primario" data-a="editar">${ICON.editar}<span>Lançar / editar mês</span></button>`;
  if (!todas.length) {
    main.innerHTML = `${cabecalhoMes(ano, mes, '#/cartoes', '')}
      <section class="card vazio">${tituloCard('Nenhum cartão cadastrado', 'Cadastre seus cartões e contas em Ajustes para vê-los aqui.', 'cartoes')}
        <div class="acoes"><a class="btn primario" href="#/ajustes">Cadastrar cartões</a></div></section>`;
    return;
  }
  const map = indexMeses(efetivos());
  const pa = anterior(ano, mes);
  const l = linhaMes(ano, mes, map, todas);
  const ant = linhaMes(pa.ano, pa.mes, map, todas);
  const creditos = todas.filter((c) => c.tipo === 'credito' && (c.ativo !== false || l.desp[c.id] !== null));
  const debitos = todas.filter((c) => c.tipo === 'debito' && (c.ativo !== false || l.desp[c.id] !== null));
  // Valor de cada cartão no mês: a fatura que vence no mês (se tiver os dias) ou o gasto do mês
  const valor = (c, a = ano, m = mes, linha = l) => (c.tipo === 'credito' ? valorFatura(c, a, m, linha) : linha.desp[c.id]);
  const totCred = creditos.reduce((s, c) => s + (valor(c) ?? 0), 0);
  const totCredAnt = creditos.reduce((s, c) => s + (valor(c, pa.ano, pa.mes, ant) ?? 0), 0);
  const totDeb = debitos.reduce((s, c) => s + (l.desp[c.id] ?? 0), 0);
  const limites = controle ? creditos.map((c) => limiteCartao(c)).filter(Boolean) : [];
  const dispTotal = limites.reduce((s, x) => s + x.disponivel, 0);
  const sel = todas.find((c) => c.id === S.cartaoSel) || creditos[0] || debitos[0];
  S.cartaoSel = sel?.id;

  // Detalhes do cartão escolhido (por fatura quando o cartão tem os dias)
  const fat = controle && sel.tipo === 'credito' ? faturaDoMes(sel, ano, mes) : null;
  const lim = controle && sel.tipo === 'credito' ? limiteCartao(sel) : null;
  const doAno = Array.from({ length: 12 }, (_, i) => {
    const linha = linhaMes(ano, i + 1, map, todas);
    return { mes: i + 1, v: valor(sel, ano, i + 1, linha) };
  });
  const vals = doAno.map((x) => x.v).filter((v) => v !== null && v !== undefined && v !== 0);
  const media = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  const maior = doAno.filter((x) => x.v).sort((a, b) => b.v - a.v)[0];
  const totalAno = vals.reduce((a, b) => a + b, 0);
  const compras = !controle ? []
    : fat ? fat.compras
    : S.data.lancamentos.filter((x) => x.categoria_id === sel.id && x.destino === 'despesa' && String(x.data).startsWith(`${ano}-${pad2(mes)}`))
      .sort((a, b) => b.data.localeCompare(a.data));
  const semDias = controle && sel.tipo === 'credito' && (!sel.dia_fechamento || !sel.dia_vencimento);
  const rotuloMes = (c) => (c.tipo === 'credito' ? `Fatura de ${MESES_CURTO[mes - 1].toLowerCase()}` : `Gastos em ${MESES_CURTO[mes - 1].toLowerCase()}`);

  const infoCartao = (c) => {
    if (!controle || c.tipo !== 'credito') return '';
    const f = faturaDoMes(c, ano, mes);
    const lc = limiteCartao(c);
    if (!f) return '<div class="cartao-info"><span class="sub">Informe fechamento e vencimento para ver a fatura certa.</span></div>';
    const st = STATUS_FATURA[f.status];
    return `<div class="cartao-info">
      <div class="cartao-info-linha"><span class="tag ${st.cls}">${st.nome}</span><span class="sub">vence ${fmtDia(f.venc)}</span></div>
      ${barraLimite(lc)}
    </div>`;
  };
  const grade = (lista) => `<div class="cartoes-grade">${lista.map((c) => `<div class="cartao-item">${cartaoVisual(c, {
    valor: valor(c), rotulo: rotuloMes(c),
    classe: `clicavel ${c.id === sel.id ? 'selecionado' : ''}`, atributos: `data-cartao="${c.id}" tabindex="0" role="button" aria-pressed="${c.id === sel.id}"`,
  })}${infoCartao(c)}</div>`).join('')}</div>`;

  main.innerHTML = `
    ${cabecalhoMes(ano, mes, '#/cartoes', acoes)}

    <section class="card resumo-cartoes">
      ${tituloCard(`Cartões em ${MESES[mes - 1].toLowerCase()}`, controle ? 'Faturas que vencem neste mês e o limite que ainda está livre.' : 'Quanto foi gasto em cada cartão e conta neste mês.', 'cartoes')}
      <div class="resumo-cartoes-nums">
        <div><span>${controle ? 'Faturas que vencem no mês' : 'Total nos cartões de crédito'}</span><strong>${grande(totCred)}</strong>${delta(totCred, totCredAnt, `vs ${MESES_CURTO[pa.mes - 1].toLowerCase()}`, true)}</div>
        ${limites.length ? `<div><span>Limite disponível agora</span><strong>${grande(dispTotal)}</strong><small class="sub">de ${fmtBRL(limites.reduce((s, x) => s + x.limite, 0))}</small></div>`
          : `<div><span>Total no débito / contas</span><strong>${grande(totDeb)}</strong></div>`}
        <div><span>Cartões e contas</span><strong>${creditos.length + debitos.length}</strong></div>
      </div>
    </section>

    ${creditos.length ? `<section><h2 class="secao">Cartões de crédito</h2>${grade(creditos)}</section>` : ''}
    ${debitos.length ? `<section><h2 class="secao">Contas e débito</h2>${grade(debitos)}</section>` : ''}

    <section class="card detalhe-cartao">
      <div class="detalhe-grid">
        <div class="detalhe-vis">${cartaoVisual(sel, { valor: valor(sel), rotulo: sel.tipo === 'credito' ? 'Fatura do mês' : 'Gastos do mês', classe: 'grande' })}
          ${lim ? barraLimite(lim) : ''}</div>
        <div>
          ${tituloCard(esc(sel.banco || sel.nome), `${sel.banco ? esc(sel.nome) + ' · ' : ''}${sel.tipo === 'credito' ? 'cartão de crédito' : 'conta / débito'}${sel.titular ? ' · ' + esc(sel.titular) : ''}`)}
          ${semDias ? `<p class="hint aviso-txt">Informe o dia de <b>fechamento</b> e de <b>vencimento</b> deste cartão para o site separar as compras de cada fatura e calcular o limite disponível. <button class="btn" data-a="editar-cartao">Informar agora</button></p>` : ''}
          <dl class="lista">
            ${fat ? `
              <div><dt>Fatura que vence em ${fmtDia(fat.venc)}</dt><dd>${fmtBRL(fat.total)} <span class="tag ${STATUS_FATURA[fat.status].cls}">${STATUS_FATURA[fat.status].nome}</span></dd></div>
              <div><dt>Compras de</dt><dd>${fmtDia(fat.ini)} a ${fmtDia(fat.fim)}<small>fecha em ${fmtDia(fat.fim)}</small></dd></div>
              ${lim ? `<div><dt>Limite</dt><dd>${fmtBRL(lim.limite)}<small>usado ${fmtBRL(lim.usado)} · livre ${fmtBRL(lim.disponivel)}</small></dd></div>
                <div><dt>Fatura aberta agora</dt><dd>${fmtBRL(lim.aberta.total)}<small>fecha em ${fmtDia(lim.aberta.fim)} · vence ${fmtDia(lim.aberta.venc)}</small></dd></div>` : ''}`
            : `<div><dt>${sel.tipo === 'credito' ? 'Fatura' : 'Gastos'} de ${MESES[mes - 1].toLowerCase()}</dt><dd>${fmtBRL(l.desp[sel.id])}${delta(l.desp[sel.id], ant.desp[sel.id], `vs ${MESES_CURTO[pa.mes - 1].toLowerCase()}`, true)}</dd></div>
              <div><dt>${MESES[pa.mes - 1]}</dt><dd>${fmtBRL(ant.desp[sel.id])}</dd></div>`}
            <div><dt>Média por mês em ${ano}</dt><dd>${fmtBRL(media)}</dd></div>
            <div><dt>Maior do ano</dt><dd>${maior ? `${fmtBRL(maior.v)}<small>${MESES[maior.mes - 1]}</small>` : '—'}</dd></div>
            <div class="destaque"><dt>Total em ${ano}</dt><dd>${fmtBRL(totalAno)}</dd></div>
          </dl>
          ${controle ? `<div class="acoes"><button class="btn" data-a="editar-cartao">${ICON.editar}<span>Limite e datas</span></button></div>` : ''}
        </div>
      </div>
      <h3 class="sub-secao">Últimos 12 meses</h3>
      <div class="canvas-box pequeno"><canvas id="g-cartao"></canvas></div>
      ${controle ? `<h3 class="sub-secao">${fat ? `Compras desta fatura (${fmtDia(fat.ini)} a ${fmtDia(fat.fim)})` : `Compras de ${MESES[mes - 1].toLowerCase()}`}</h3>
        ${compras.length ? compras.map((x) => `<button class="lanc" data-id="${x.id}">
          ${iconeCat(classePorId(x.classe_id))}
          <span class="lanc-txt"><b>${esc(x.descricao)}</b><small>${fmtDia(x.data)} · ${esc(rotuloLanc(x))} · ${LADO[x.escopo] || ''}</small></span>
          <span class="lanc-valor neg">− ${fmtBRL(x.valor)}</span></button>`).join('')
          : '<p class="sub">Nenhuma compra lançada neste período. Importe o extrato do cartão em Transações.</p>'}` : ''}
    </section>`;

  main.querySelectorAll('[data-cartao]').forEach((el) => {
    const escolher = () => { if (ehControle()) { location.hash = `#/cartoes/${ano}/${mes}/${el.dataset.cartao}`; return; } S.cartaoSel = el.dataset.cartao; render(); app.querySelector('.detalhe-cartao')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
    el.addEventListener('click', escolher);
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); escolher(); } });
  });
  main.querySelectorAll('[data-a="editar"]').forEach((b) => b.addEventListener('click', () => abrirEditor(ano, mes)));
  main.querySelectorAll('[data-a="editar-cartao"]').forEach((b) => b.addEventListener('click', () => abrirConta(sel)));
  main.querySelectorAll('.detalhe-cartao .lanc').forEach((b) => b.addEventListener('click', () => {
    abrirLancamento(S.data.lancamentos.find((x) => x.id === b.dataset.id), { ano, mes });
  }));
  // Gráfico dos últimos 12 meses do cartão escolhido
  const canvas = main.querySelector('#g-cartao');
  if (canvas && window.Chart) {
    const meses12 = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(ano, mes - 1 - i, 1);
      const x = linhaMes(d.getFullYear(), d.getMonth() + 1, map, todas);
      meses12.push({ rotulo: `${MESES_CURTO[d.getMonth()]}/${String(d.getFullYear()).slice(2)}`, v: valor(sel, d.getFullYear(), d.getMonth() + 1, x) });
    }
    const cor = corCat(sel);
    S.charts.push(new Chart(canvas, {
      type: 'bar',
      data: { labels: meses12.map((x) => x.rotulo), datasets: [{ label: sel.banco || sel.nome, data: meses12.map((x) => x.v), backgroundColor: meses12.map((_, i) => (i === 11 ? cor : cor + '88')), borderRadius: 6, maxBarThickness: 34 }] },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => fmtBRL(c.parsed.y) } } },
        scales: { x: { grid: { display: false }, ticks: { color: cssVar('--muted') } }, y: { grid: { color: cssVar('--border') }, ticks: { color: cssVar('--muted'), callback: (v) => v.toLocaleString('pt-BR') } } },
      },
    }));
  }
}

/* =========================================================== gráficos */
const PERIODOS_GRAF = { mes: 'Mês', '12m': '12 meses', ano: 'Ano' };
const COR_PESSOAL = '#14b8a6', COR_EMPRESA = '#6366f1';

/** Meses do período escolhido: o mês, os 12 até ele, ou o ano inteiro. */
function mesesDoPeriodo(ano, mes, per) {
  if (per === 'mes') return [{ ano, mes }];
  if (per === 'ano') return Array.from({ length: 12 }, (_, i) => ({ ano, mes: i + 1 }));
  return Array.from({ length: 12 }, (_, i) => { const d = new Date(ano, mes - 12 + i, 1); return { ano: d.getFullYear(), mes: d.getMonth() + 1 }; });
}
const rotuloMesCurto = (p) => `${MESES_CURTO[p.mes - 1]}/${String(p.ano).slice(2)}`;

/** Agrupa valores por categoria principal; acima de 8 fatias, o resto vira "Outras". */
function fatiasPorCategoria(lancs) {
  const m = new Map();
  for (const l of lancs) {
    const c = raizClasse(classePorId(l.classe_id));
    const k = c?.id || '';
    const x = m.get(k) || { nome: c?.nome || 'Sem categoria', cor: c?.cor || '#cbd5e1', v: 0 };
    x.v += l.valor;
    m.set(k, x);
  }
  const lista = [...m.values()].sort((a, b) => b.v - a.v);
  if (lista.length <= 8) return lista;
  const resto = lista.slice(7);
  return [...lista.slice(0, 7), { nome: `Outras (${resto.length})`, cor: '#94a3b8', v: resto.reduce((s, x) => s + x.v, 0) }];
}

/** Lista "Por categoria" dos Gráficos: cada categoria abre as subcategorias e as transações. */
function blocoPorCategoria(lancPer, periodo, per) {
  const tipo = S.grafTipo === 'receita' ? 'receita' : 'despesa';
  const esc0 = S.grafEscopo || 'todos';
  const ehDoTipo = (l) => (tipo === 'receita' ? l.destino === 'receita' || l.destino === 'rendimento' : l.destino === 'despesa');
  const lista = lancPer.filter(ehDoTipo).filter((l) => esc0 === 'todos' || l.escopo === esc0);
  const total = lista.reduce((s, l) => s + l.valor, 0);
  const palavra = (n) => (tipo === 'receita' ? (n === 1 ? 'receita' : 'receitas') : (n === 1 ? 'gasto' : 'gastos'));
  const grupos = new Map();
  for (const l of lista) {
    const k = raizClasse(classePorId(l.classe_id))?.id || '';
    if (!grupos.has(k)) grupos.set(k, []);
    grupos.get(k).push(l);
  }
  const linhas = [...grupos.entries()].map(([id, ls]) => {
    const c = classePorId(id);
    const subs = new Map();
    for (const l of ls) {
      const sc = classePorId(l.classe_id);
      const sk = sc && sc.pai_id ? sc.id : '';
      subs.set(sk, (subs.get(sk) || 0) + l.valor);
    }
    const subLista = [...subs.entries()].filter(() => subs.size > 1 || !subs.has(''))
      .map(([sid, v]) => ({ sub: !!sid, nome: sid ? classePorId(sid).nome : `${c?.nome || ''} (geral)`, cor: sid ? classePorId(sid).cor : c?.cor, v }))
      .sort((a, b) => b.v - a.v);
    return { id, nome: c?.nome || 'Sem categoria', cor: c?.cor || '#cbd5e1', ls, subLista, total: ls.reduce((s, l) => s + l.valor, 0) };
  }).sort((a, b) => (a.id === '') - (b.id === '') || b.total - a.total);
  const maior = Math.max(1, ...linhas.map((x) => x.total));
  const catPorId = new Map(S.data.categorias.map((c) => [c.id, c]));
  const semCat = lista.filter((l) => !l.classe_id).length;
  const temClasses = S.data.classes.some((c) => tipoDaClasse(c) === tipo);
  const ultimo = periodo[periodo.length - 1];

  const tabela = per !== 'mes' && linhas.length ? `
    <details class="ver-numeros"><summary>Ver mês a mês</summary>
      <div class="tabela-wrap"><table class="tabela">
        <thead><tr><th>Categoria</th>${periodo.map((p) => `<th>${rotuloMesCurto(p)}</th>`).join('')}<th>Total</th></tr></thead>
        <tbody>${linhas.map((x) => `<tr><th><span class="dot" style="background:${x.cor}"></span> ${esc(x.nome)}</th>
          ${periodo.map((p) => { const v = x.ls.filter((l) => l.data.startsWith(`${p.ano}-${pad2(p.mes)}`)).reduce((s, l) => s + l.valor, 0); return `<td>${v ? fmtNum(v) : ''}</td>`; }).join('')}
          <td><b>${fmtNum(x.total)}</b></td></tr>`).join('')}</tbody>
      </table></div>
    </details>` : '';

  return `<section class="card por-categoria">
    <div class="card-cab"><div><h2>Por categoria</h2><p class="sub">Toque numa categoria para ver as subcategorias e cada transação.</p></div></div>
    <div class="filtros-lanc">
      <div class="seg" role="group" aria-label="Gastos ou receitas">${Object.entries(TIPOS_CLASSE).map(([k, t]) =>
        `<button data-graf-tipo="${k}" class="${tipo === k ? 'ativo' : ''}" aria-pressed="${tipo === k}">${t}</button>`).join('')}</div>
      <div class="seg" role="group" aria-label="Pessoal ou empresa">${[['todos', 'Tudo'], ['pessoal', 'Pessoal'], ['empresa', 'Empresa']].map(([v, t]) =>
        `<button data-graf-escopo="${v}" class="${esc0 === v ? 'ativo' : ''}" aria-pressed="${esc0 === v}">${t}</button>`).join('')}</div>
      <span class="sub">Total <b>${fmtBRL(total)}</b>${semCat ? ` · <a href="#/classificar/${ultimo.ano}/${ultimo.mes}" data-ir-classificar="${tipo}">${semCat} sem categoria — classificar</a>` : ''}</span>
    </div>
    ${!temClasses ? cardSemClasses(tipo) : ''}
    ${!linhas.length ? `<p class="sub">Nenhum${tipo === 'receita' ? 'a receita' : ' gasto'} no período.</p>` : linhas.map((x) => `
      <details class="cat-item">
        <summary>
          <span class="dot" style="background:${x.cor}"></span>
          <span class="cat-nome">${esc(x.nome)}<small>${x.ls.length} ${palavra(x.ls.length)}${(() => { const n = x.subLista.filter((s) => s.sub).length; return n ? ` · ${n} ${n === 1 ? 'subcategoria' : 'subcategorias'}` : ''; })()}</small></span>
          <span class="cat-barra"><i style="width:${(x.total / maior) * 100}%;background:${x.cor}"></i></span>
          <span class="cat-valor"><b>${fmtBRL(x.total)}</b><small>${total ? Math.round((x.total / total) * 100) : 0}%</small></span>
        </summary>
        ${x.subLista.length ? `<div class="subcats">${x.subLista.map((s) => `<div class="subcat"><span class="dot" style="background:${s.cor}"></span><span>${esc(s.nome)}</span>
          <span class="cat-barra"><i style="width:${(s.v / x.total) * 100}%;background:${s.cor}"></i></span><b>${fmtBRL(s.v)}</b></div>`).join('')}</div>` : ''}
        <div class="cat-lista">
          ${[...x.ls].sort((a, b) => b.data.localeCompare(a.data)).map((l) => `
            <button class="lanc" data-lanc="${l.id}">
              <span class="lanc-txt"><b>${esc(l.descricao)}</b>
                <small>${fmtDia(l.data)} · ${classePorId(l.classe_id)?.pai_id ? esc(classePorId(l.classe_id).nome) + ' · ' : ''}${esc(l.conta || catPorId.get(l.categoria_id)?.nome || '')} · <span class="tag ${l.escopo === 'empresa' ? 'empresa' : ''}">${LADO[l.escopo] || 'Pessoal'}</span></small></span>
              <span class="lanc-valor">${fmtBRL(l.valor)}</span>
            </button>`).join('')}
        </div>
      </details>`).join('')}
    ${tabela}
  </section>`;
}

function bindPorCategoria(main) {
  bindSemClasses(main);
  main.querySelectorAll('[data-graf-tipo]').forEach((b) => b.addEventListener('click', () => { S.grafTipo = b.dataset.grafTipo; render(); }));
  main.querySelectorAll('[data-graf-escopo]').forEach((b) => b.addEventListener('click', () => { S.grafEscopo = b.dataset.grafEscopo; render(); }));
  main.querySelector('[data-ir-classificar]')?.addEventListener('click', (e) => { S.classTipo = e.currentTarget.dataset.irClassificar; });
  main.querySelectorAll('.por-categoria [data-lanc]').forEach((b) => b.addEventListener('click', () => {
    const l = S.data.lancamentos.find((x) => x.id === b.dataset.lanc);
    const [a, m] = l.data.split('-').map(Number);
    abrirLancamento(l, { ano: a, mes: m });
  }));
}

function renderGraficos(main, ano, mes) {
  const per = PERIODOS_GRAF[S.grafPer] ? S.grafPer : '12m';
  const controle = ehControle();
  const periodo = mesesDoPeriodo(ano, mes, per);
  const meses12 = mesesDoPeriodo(ano, mes, per === 'ano' ? 'ano' : '12m'); // gráficos de evolução: 12 meses ou o ano
  const chaves = new Set(periodo.map((p) => `${p.ano}-${pad2(p.mes)}`));
  const lancPer = S.data.lancamentos.filter((l) => chaves.has(String(l.data).slice(0, 7)));
  const map = indexMeses(efetivos());
  const todas = cats();
  // Receita e despesa de um mês (modo controle: pelas transações; organização: pelos totais do mês)
  const resMes = (p) => {
    if (controle) { const t = totaisControle(p.ano, p.mes); return { r: t.receitas, d: t.despesas }; }
    const l = linhaMes(p.ano, p.mes, map, todas);
    return { r: l.receita ?? 0, d: l.totalDesp ?? 0 };
  };
  const evol = meses12.map((p) => ({ ...p, ...resMes(p) }));
  const totR = periodo.reduce((s, p) => s + resMes(p).r, 0);
  const totD = periodo.reduce((s, p) => s + resMes(p).d, 0);
  const nomePer = per === 'mes' ? MESES[mes - 1].toLowerCase() : per === 'ano' ? String(ano) : `${rotuloMesCurto(periodo[0])} a ${rotuloMesCurto(periodo[11])}`;

  const fatiasD = controle ? fatiasPorCategoria(lancPer.filter((l) => l.destino === 'despesa')) : [];
  const fatiasR = controle ? fatiasPorCategoria(lancPer.filter((l) => l.destino === 'receita' || l.destino === 'rendimento')) : [];
  // Gastos por conta/cartão no período
  const porConta = todas.map((c) => ({ c, v: periodo.reduce((s, p) => s + (linhaMes(p.ano, p.mes, map, todas).desp[c.id] ?? 0), 0) }))
    .filter((x) => x.v > 0).sort((a, b) => b.v - a.v);
  // Saldo nas contas no fim de cada mês (só contas com saldo inicial, e só depois da data dele)
  const contasSaldo = controle ? contasBancarias().filter((c) => c.saldo_inicial !== null && c.saldo_inicial !== undefined) : [];
  const temPesEmp = controle && S.data.lancamentos.some((l) => l.destino === 'despesa');

  const legendaRosca = (fatias, total) => `<ul class="leg-rosca">${fatias.map((f) => `<li><i style="background:${f.cor}"></i><span>${esc(f.nome)}</span>
      <b>${fmtBRL(f.v)}</b><small>${total ? Math.round((f.v / total) * 100) : 0}%</small></li>`).join('')}</ul>`;
  const blocoRosca = (id, titulo, sub, fatias, vazio) => {
    const total = fatias.reduce((s, f) => s + f.v, 0);
    return `<section class="card">
      ${tituloCard(titulo, sub)}
      ${fatias.length ? `<div class="graf-rosca"><div class="rosca"><canvas id="${id}"></canvas><div class="rosca-centro"><span>Total</span><strong>${grande(total)}</strong></div></div>
        ${legendaRosca(fatias, total)}</div>` : `<p class="sub">${vazio}</p>`}
    </section>`;
  };

  main.innerHTML = `
    ${cabecalhoMes(ano, mes, '#/graficos', `<div class="seg" role="group" aria-label="Período">${Object.entries(PERIODOS_GRAF).map(([k, t]) =>
      `<button data-per="${k}" class="${per === k ? 'ativo' : ''}" aria-pressed="${per === k}">${t}</button>`).join('')}</div>`)}

    <section class="mini-kpis">
      <div class="card"><span>Receitas · ${esc(nomePer)}</span><strong class="pos">${fmtBRL(totR)}</strong></div>
      <div class="card"><span>Despesas · ${esc(nomePer)}</span><strong class="neg">${fmtBRL(totD)}</strong></div>
      <div class="card"><span>Resultado</span><strong class="${cls(totR - totD)}">${fmtBRL(totR - totD)}</strong></div>
      <div class="card"><span>Gasto / receita</span><strong>${totR ? fmtPct(totD / totR) : '—'}</strong></div>
    </section>

    <section class="card grafico">
      ${tituloCard('Receitas e despesas', `${per === 'ano' ? `Cada mês de ${ano}` : 'Os últimos 12 meses'}. Passe o mouse (ou toque) numa barra para ver os valores.`, 'grafico')}
      <div class="canvas-box"><canvas id="g-evol"></canvas></div>
      <details class="ver-numeros"><summary>Ver os números</summary>
        <div class="tabela-wrap"><table class="tabela">
          <thead><tr><th>Mês</th><th>Receitas</th><th>Despesas</th><th>Resultado</th></tr></thead>
          <tbody>${evol.map((x) => `<tr><th>${rotuloMesCurto(x)}</th><td>${fmtNum(x.r)}</td><td>${fmtNum(x.d)}</td><td class="${cls(x.r - x.d)}">${fmtNum(x.r - x.d)}</td></tr>`).join('')}</tbody>
        </table></div>
      </details>
    </section>

    ${controle ? `<div class="graf-duplo">
      ${blocoRosca('g-desp', 'Despesas por categoria', `Para onde foi o dinheiro · ${esc(nomePer)}`, fatiasD, 'Nenhuma despesa no período.')}
      ${blocoRosca('g-rec', 'Receitas por categoria', `De onde veio o dinheiro · ${esc(nomePer)}`, fatiasR, 'Nenhuma receita no período.')}
    </div>` : ''}

    ${controle ? blocoPorCategoria(lancPer, periodo, per) : ''}

    <div class="graf-duplo">
      ${temPesEmp ? `<section class="card grafico">
        ${tituloCard('Pessoal e empresa', 'Despesas de cada mês, separadas pelo lado.')}
        <div class="canvas-box"><canvas id="g-lado"></canvas></div>
      </section>` : ''}
      <section class="card grafico">
        ${tituloCard('Débito e crédito', 'Quanto saiu direto da conta e quanto foi no cartão, mês a mês.')}
        <div class="canvas-box"><canvas id="g-debcred"></canvas></div>
      </section>
    </div>

    <div class="graf-duplo">
      ${controle ? `<section class="card">
        ${tituloCard('Por recorrência', `Gastos fixos, parcelados e variáveis · ${esc(nomePer)}`)}
        ${blocoRecorrencia(lancPer.filter((l) => l.destino === 'despesa'), 'g-recorrencia')}
      </section>` : ''}
      <section class="card grafico">
        ${tituloCard('Gastos por conta e cartão', `De onde saiu o dinheiro · ${esc(nomePer)}`)}
        ${porConta.length ? `<div class="canvas-box" style="height:${Math.max(160, porConta.length * 44 + 40)}px"><canvas id="g-contas"></canvas></div>` : '<p class="sub">Nenhum gasto no período.</p>'}
      </section>
    </div>

    ${contasSaldo.length ? `<section class="card grafico">
      ${tituloCard('Saldo nas contas', 'Quanto havia em cada conta no fim de cada mês (contas com saldo inicial informado).', 'cofre')}
      <div class="canvas-box"><canvas id="g-saldo"></canvas></div>
    </section>` : controle ? `<section class="card"><p class="sub">Para ver a evolução do saldo, informe o saldo inicial das contas na tela <a href="#/contas/${ano}/${mes}">Contas</a>.</p></section>` : ''}

    ${!controle ? `<section class="card grafico">
      ${tituloCard('Investimento por mês', 'Quanto foi guardado em cada mês.', 'cofrinho')}
      <div class="canvas-box pequeno"><canvas id="g-invest"></canvas></div>
    </section>` : ''}`;

  main.querySelectorAll('[data-per]').forEach((b) => b.addEventListener('click', () => { S.grafPer = b.dataset.per; render(); }));
  if (controle) bindPorCategoria(main);
  if (!window.Chart) return;

  // Estilo comum: grade discreta, um só eixo, valores em reais no tooltip
  const muted = cssVar('--muted'), borda = cssVar('--border'), sup = cssVar('--surface');
  const eixoY = { grid: { color: borda }, border: { display: false }, ticks: { color: muted, callback: (v) => v.toLocaleString('pt-BR') } };
  const eixoX = { grid: { display: false }, ticks: { color: muted } };
  const legenda = { labels: { color: muted, boxWidth: 10, boxHeight: 10, usePointStyle: true, pointStyle: 'rectRounded' } };
  const tip = { callbacks: { label: (c) => `${c.dataset.label ? c.dataset.label + ': ' : ''}${fmtBRL(c.parsed.y ?? c.parsed.x ?? c.parsed)}` } };
  const barra = { borderRadius: 4, borderSkipped: 'start', maxBarThickness: 28, borderColor: sup, borderWidth: { left: 1, right: 1 } };
  const novo = (id, cfg) => { const el = main.querySelector('#' + id); if (el) S.charts.push(new Chart(el, cfg)); };

  novo('g-evol', {
    type: 'bar',
    data: {
      labels: evol.map(rotuloMesCurto),
      datasets: [
        { label: 'Receitas', data: evol.map((x) => x.r), backgroundColor: cssVar('--c-receita'), ...barra },
        { label: 'Despesas', data: evol.map((x) => x.d), backgroundColor: cssVar('--c-despesa'), ...barra },
        { type: 'line', label: 'Resultado', data: evol.map((x) => x.r - x.d), borderColor: cssVar('--c-saldo'), backgroundColor: cssVar('--c-saldo'),
          borderWidth: 2, pointRadius: 4, pointHoverRadius: 6, pointBackgroundColor: sup, tension: 0.3 },
      ],
    },
    options: { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
      plugins: { legend: legenda, tooltip: tip }, scales: { x: eixoX, y: eixoY } },
  });

  const rosca = (id, fatias) => novo(id, {
    type: 'doughnut',
    data: { labels: fatias.map((f) => f.nome), datasets: [{ data: fatias.map((f) => f.v), backgroundColor: fatias.map((f) => f.cor), borderWidth: 2, borderColor: sup, hoverOffset: 4 }] },
    options: { responsive: true, maintainAspectRatio: false, cutout: '68%', plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${c.label}: ${fmtBRL(c.parsed)}` } } } },
  });
  rosca('g-desp', fatiasD);
  rosca('g-rec', fatiasR);

  if (temPesEmp) {
    const lado = (p, e) => S.data.lancamentos.filter((l) => l.destino === 'despesa' && String(l.data).startsWith(`${p.ano}-${pad2(p.mes)}`) && (e ? l.escopo === 'empresa' : l.escopo !== 'empresa')).reduce((s, l) => s + l.valor, 0);
    novo('g-lado', {
      type: 'bar',
      data: {
        labels: meses12.map(rotuloMesCurto),
        datasets: [
          { label: 'Pessoal', data: meses12.map((p) => lado(p, false)), backgroundColor: COR_PESSOAL, ...barra, borderWidth: { top: 2 }, borderSkipped: false, borderRadius: 4 },
          { label: 'Empresa', data: meses12.map((p) => lado(p, true)), backgroundColor: COR_EMPRESA, ...barra, borderWidth: { top: 2 }, borderSkipped: false, borderRadius: 4 },
        ],
      },
      options: { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
        plugins: { legend: legenda, tooltip: tip }, scales: { x: { ...eixoX, stacked: true }, y: { ...eixoY, stacked: true } } },
    });
  }

  const corConta = (c) => corCat(c);
  // Débito × crédito por mês (vale nos dois modos: vem dos totais do mês)
  {
    const dc = meses12.map((p) => { const x = linhaMes(p.ano, p.mes, map, todas); return { deb: x.debito ?? 0, cred: x.credito ?? 0 }; });
    novo('g-debcred', {
      type: 'bar',
      data: { labels: meses12.map(rotuloMesCurto), datasets: [
        { label: 'Débito / conta', data: dc.map((x) => x.deb), backgroundColor: '#2dd4bf', ...barra },
        { label: 'Crédito / cartão', data: dc.map((x) => x.cred), backgroundColor: '#818cf8', ...barra },
      ] },
      options: { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
        plugins: { legend: legenda, tooltip: tip }, scales: { x: eixoX, y: eixoY } },
    });
  }
  if (controle) roscaRecorrencia(main, 'g-recorrencia', lancPer.filter((l) => l.destino === 'despesa'));
  novo('g-contas', {
    type: 'bar',
    data: { labels: porConta.map((x) => x.c.banco ? `${x.c.banco} · ${x.c.nome}` : x.c.nome), datasets: [{ data: porConta.map((x) => x.v), backgroundColor: porConta.map((x) => corConta(x.c)), borderRadius: 4, borderSkipped: 'start', maxBarThickness: 22 }] },
    options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => fmtBRL(c.parsed.x) } } },
      scales: { x: { ...eixoY, grid: { color: borda } }, y: { grid: { display: false }, ticks: { color: muted } } } },
  });

  if (contasSaldo.length) {
    const fimDe = (p) => isoFim(p.ano, p.mes);
    const valorSaldo = (c, p) => (fimDe(p) < (c.saldo_desde || '0000-00-00') ? null : saldoConta(c, fimDe(p)));
    const series = contasSaldo.map((c) => ({ label: c.banco ? `${c.banco} · ${c.nome}` : c.nome, data: meses12.map((p) => valorSaldo(c, p)),
      borderColor: corConta(c), backgroundColor: corConta(c), borderWidth: 2, pointRadius: 3, pointHoverRadius: 6, tension: 0.25, spanGaps: false }));
    novo('g-saldo', {
      type: 'line',
      data: { labels: meses12.map(rotuloMesCurto), datasets: series },
      options: { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
        plugins: { legend: legenda, tooltip: tip }, scales: { x: eixoX, y: eixoY } },
    });
  }

  if (!controle) {
    novo('g-invest', {
      type: 'bar',
      data: { labels: meses12.map(rotuloMesCurto), datasets: [{ label: 'Investimento', data: meses12.map((p) => linhaMes(p.ano, p.mes, map, todas).investimento ?? 0), backgroundColor: cssVar('--accent'), ...barra }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: tip }, scales: { x: eixoX, y: eixoY } },
    });
  }
}

/* ================================================= ícones de categoria */
// Ícone redondo e colorido para cada categoria, escolhido pelo nome (sem precisar configurar)
const ICONES_CAT = [
  [/mercad|hortifr|supermerc|compra/, '<circle cx="9" cy="20" r="1.4"/><circle cx="18" cy="20" r="1.4"/><path d="M2 3h3l2.6 12.2a2 2 0 0 0 2 1.6h8.7a2 2 0 0 0 2-1.5L22 7H6"/>'],
  [/aliment|restaur|lanche|comida|refei|ifood|padar/, '<path d="M7 2v20M4 2v6a3 3 0 0 0 6 0V2M17 2c-1.7 1.3-3 3.8-3 7h3v13"/>'],
  [/combust|posto|transport|uber|carro|ve[ií]cul|estacion|ped[aá]gio/, '<path d="M5 17h14M6 17l1.5-6h9L18 17M4 17v3h3v-3M17 17v3h3v-3"/><circle cx="7.5" cy="14" r=".6"/><circle cx="16.5" cy="14" r=".6"/>'],
  [/sa[uú]de|farm[aá]c|m[eé]dic|hospital|dent/, '<path d="M20.8 5.6a5.5 5.5 0 0 0-7.8 0L12 6.7l-1-1.1a5.5 5.5 0 1 0-7.8 7.8L12 22l8.8-8.6a5.5 5.5 0 0 0 0-7.8z"/>'],
  [/educa|escola|curso|faculd|livro/, '<path d="M2 7l10-4 10 4-10 4L2 7z"/><path d="M6 9v5c0 1.7 2.7 3 6 3s6-1.3 6-3V9"/>'],
  [/lazer|jogo|divers|viage|cinema/, '<circle cx="12" cy="12" r="9"/><path d="M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01"/>'],
  [/assinat|stream|netflix|spotify/, '<rect x="2" y="5" width="20" height="14" rx="3"/><path d="M10 9l5 3-5 3V9z"/>'],
  [/telef|internet|celular/, '<path d="M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M2 9a15 15 0 0 1 20 0"/><circle cx="12" cy="19.5" r=".8"/>'],
  [/luz|[aá]gua|g[aá]s|energia/, '<path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z"/>'],
  [/aluguel|casa|moradia|condom/, '<path d="M3 11l9-8 9 8M5 9.5V21h14V9.5"/>'],
  [/funcion|sal[aá]rio|pr[oó]-?labore|retirada/, '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>'],
  [/imposto|taxa|tarifa|simples|das\b/, '<path d="M6 2h12v20l-3-2-3 2-3-2-3 2V2z"/><path d="M9 7h6M9 11h6M9 15h4"/>'],
  [/fornecedor|estoque|mercadoria/, '<path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8M12 13v8"/>'],
  [/venda|cliente|servi[cç]o/, '<path d="M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L2 12V2h10l8.6 8.6a2 2 0 0 1 0 2.8z"/><circle cx="7" cy="7" r="1.5"/>'],
  [/rendim|invest|aplica/, '<path d="M3 17l6-6 4 4 8-8"/><path d="M14 7h7v7"/>'],
  [/manuten|reparo|conserto/, '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4 2.6-2.6z"/>'],
  [/fatura|cart[aã]o|pagament/, '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/>'],
  [/reembols|estorno/, '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>'],
];
const ICONE_OUTROS = '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>';
/** Bolinha colorida com o ícone da categoria (ou "?" para sem categoria). */
function iconeCat(c, extra = '') {
  if (!c) return `<span class="ic-cat sem ${extra}" aria-hidden="true">?</span>`;
  const n = normDesc(nomeClasse(c));
  const d = (ICONES_CAT.find(([re]) => re.test(n)) || [null, ICONE_OUTROS])[1];
  return `<span class="ic-cat ${extra}" style="--cor:${c.cor}" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg></span>`;
}

/* ============================================ blocos usados nas páginas */
/** Ranking de categorias (principal): barra, valor e % do total. */
function blocoRanking(lancs, vazio = 'Nenhum gasto no período.') {
  const total = lancs.reduce((s, l) => s + l.valor, 0);
  const m = new Map();
  for (const l of lancs) {
    const c = raizClasse(classePorId(l.classe_id));
    const k = c?.id || '';
    const x = m.get(k) || { c, v: 0, n: 0 };
    x.v += l.valor; x.n += 1; m.set(k, x);
  }
  const lista = [...m.values()].sort((a, b) => b.v - a.v);
  const maior = Math.max(1, ...lista.map((x) => x.v));
  if (!lista.length) return `<p class="sub">${vazio}</p>`;
  return `<ol class="ranking">${lista.map((x, i) => `<li>
      <span class="ranking-pos">${i + 1}</span>${iconeCat(x.c)}
      <div class="ranking-txt"><b>${esc(x.c?.nome || 'Sem categoria')}</b><small>${x.n} ${x.n === 1 ? 'compra' : 'compras'}</small>
        <span class="ranking-barra"><i style="width:${(x.v / maior) * 100}%;background:${x.c?.cor || '#94a3b8'}"></i></span></div>
      <div class="ranking-val"><b>${fmtBRL(x.v)}</b><small>${total ? Math.round((x.v / total) * 100) : 0}%</small></div>
    </li>`).join('')}</ol>`;
}

/** Fixa × parcelada × variável: rosca + legenda. */
function dadosRecorrencia(lancs) {
  const t = { fixa: 0, parcelada: 0, variavel: 0 };
  for (const l of lancs) t[recorrenciaDe(l)] += l.valor;
  return Object.entries(t).map(([k, v]) => ({ k, nome: RECORRENCIAS[k], cor: COR_RECORRENCIA[k], v }));
}
function blocoRecorrencia(lancs, id) {
  const d = dadosRecorrencia(lancs);
  const total = d.reduce((s, x) => s + x.v, 0);
  if (!total) return '<p class="sub">Nenhum gasto no período.</p>';
  return `<div class="graf-rosca">
    <div class="rosca pequena"><canvas id="${id}"></canvas><div class="rosca-centro"><span>Total</span><strong>${grande(total)}</strong></div></div>
    <ul class="leg-rosca">${d.map((x) => `<li><i style="background:${x.cor}"></i><span>${x.nome}</span><b>${fmtBRL(x.v)}</b><small>${Math.round((x.v / total) * 100)}%</small></li>`).join('')}</ul>
  </div>`;
}
function roscaRecorrencia(main, id, lancs) {
  const el = main.querySelector('#' + id);
  if (!el || !window.Chart) return;
  const d = dadosRecorrencia(lancs);
  S.charts.push(new Chart(el, {
    type: 'doughnut',
    data: { labels: d.map((x) => x.nome), datasets: [{ data: d.map((x) => x.v), backgroundColor: d.map((x) => x.cor), borderWidth: 2, borderColor: cssVar('--surface'), hoverOffset: 4 }] },
    options: { responsive: true, maintainAspectRatio: false, cutout: '70%', plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${c.label}: ${fmtBRL(c.parsed)}` } } } },
  }));
}

/** Linha de transação no estilo extrato: ícone, descrição, categoria, etiquetas e valor. */
function linhaExtrato(l, { saldo = null, mostrarConta = false } = {}) {
  const entrada = sentidoDe(l) === 'entrada';
  const t = l.destino === 'transferencia';
  const c = classePorId(l.classe_id);
  const conta = mostrarConta ? S.data.categorias.find((x) => x.id === l.categoria_id) : null;
  const rec = l.destino === 'despesa' ? recorrenciaDe(l) : null;
  return `<button class="ext-linha" data-lanc="${l.id}">
    ${t ? '<span class="ic-cat transf" aria-hidden="true">⇄</span>' : iconeCat(c)}
    <span class="ext-txt"><b>${esc(l.descricao)}</b>
      <small>${fmtDia(l.data)} · ${esc(rotuloLanc(l))}${conta ? ` · ${esc(conta.banco || conta.nome)}` : ''}
        ${l.parcelas ? `<span class="tag parcela">${textoParcela(l)}</span>` : rec === 'fixa' ? '<span class="tag fixa">fixa</span>' : ''}
        ${l.escopo === 'empresa' && !t ? '<span class="tag empresa">Empresa</span>' : ''}</small></span>
    <span class="ext-valor"><b class="${t ? '' : entrada ? 'pos' : 'neg'}">${entrada ? '+' : '−'} ${fmtBRL(l.valor)}</b>${saldo !== null ? `<small>saldo ${fmtBRL(saldo)}</small>` : ''}</span>
  </button>`;
}
function bindExtrato(main, ano, mes) {
  main.querySelectorAll('[data-lanc]').forEach((b) => b.addEventListener('click', () => {
    const l = S.data.lancamentos.find((x) => x.id === b.dataset.lanc);
    if (l) abrirLancamento(l, { ano, mes });
  }));
}

/* ======================================================= página do cartão */
function renderCartao(main, ano, mes, id) {
  const cat = S.data.categorias.find((c) => c.id === id);
  if (!cat) { location.hash = `#/cartoes/${ano}/${mes}`; return; }
  const fat = faturaDoMes(cat, ano, mes);
  const lim = limiteCartao(cat);
  const pre = `${ano}-${pad2(mes)}`;
  // Compras desta fatura (pelo ciclo) ou do mês (se o cartão não tem os dias)
  const compras = fat ? fat.compras : S.data.lancamentos.filter((l) => l.categoria_id === id && l.destino === 'despesa' && String(l.data).startsWith(pre)).sort((a, b) => b.data.localeCompare(a.data));
  const total = fat ? fat.total : compras.reduce((s, l) => s + l.valor, 0);
  const pa = anterior(ano, mes);
  const fatAnt = faturaDoMes(cat, pa.ano, pa.mes);
  const totalAnt = fatAnt ? fatAnt.total : S.data.lancamentos.filter((l) => l.categoria_id === id && l.destino === 'despesa' && String(l.data).startsWith(`${pa.ano}-${pad2(pa.mes)}`)).reduce((s, l) => s + l.valor, 0);
  // Parcelas: o que continua nas próximas faturas e o que está terminando
  const parceladas = compras.filter((l) => l.parcelas);
  const continuam = parceladas.filter((l) => l.parcela < l.parcelas);
  const terminando = parceladas.map((l) => ({ l, faltam: l.parcelas - l.parcela })).sort((a, b) => a.faltam - b.faltam || b.l.valor - a.l.valor);
  const compromissoFuturo = continuam.reduce((s, l) => s + l.valor * (l.parcelas - l.parcela), 0);
  const fixas = compras.filter((l) => recorrenciaDe(l) === 'fixa');
  const previstaProxima = continuam.reduce((s, l) => s + l.valor, 0) + fixas.reduce((s, l) => s + l.valor, 0);
  const px = seguinte(ano, mes);
  const mesDaParcela = (faltam) => { const d = new Date(ano, mes - 1 + faltam, 1); return `${MESES_CURTO[d.getMonth()].toLowerCase()}/${String(d.getFullYear()).slice(2)}`; };
  const st = fat ? STATUS_FATURA[fat.status] : null;
  const ext = S.extCartao || (S.extCartao = { busca: '', tudo: false });
  const todasDoCartao = S.data.lancamentos.filter((l) => l.categoria_id === id && l.destino !== 'transferencia').sort((a, b) => b.data.localeCompare(a.data));
  const listaExt = (ext.tudo ? todasDoCartao : compras).filter((l) => !ext.busca || normDesc(l.descricao).includes(normDesc(ext.busca)));

  main.innerHTML = `
    ${cabecalhoMes(ano, mes, '#/cartoes', `
      <a class="btn" href="#/cartoes/${ano}/${mes}">‹ <span>Todos os cartões</span></a>
      <button class="btn" data-a="editar-cartao">${ICON.editar}<span>Limite e datas</span></button>
      <button class="btn primario" data-a="importar-mes">${ICON.upload}<span>Importar extrato</span></button>`, `/${id}`)}

    <div class="painel-3">
      <section class="card cartao-topo">
        ${cartaoVisual(cat, { valor: total, rotulo: `Fatura de ${MESES_CURTO[mes - 1].toLowerCase()}`, classe: 'grande' })}
        ${lim ? barraLimite(lim) : '<p class="sub">Informe o limite em "Limite e datas" para ver quanto ainda está livre.</p>'}
      </section>

      <section class="card">
        ${tituloCard(`Fatura de ${MESES[mes - 1].toLowerCase()}`, fat ? `Compras de ${fmtDia(fat.ini)} a ${fmtDia(fat.fim)}` : 'Informe fechamento e vencimento para separar as faturas certinho.')}
        <div class="kpi-grande"><strong>${grande(total)}</strong>${st ? `<span class="tag ${st.cls}">${st.nome}</span>` : ''}</div>
        ${chipVariacao(total, totalAnt, true)}
        <dl class="lista">
          ${fat ? `<div><dt>Fecha em</dt><dd>${fmtDia(fat.fim)}</dd></div><div><dt>Vence em</dt><dd>${fmtDia(fat.venc)}</dd></div>` : ''}
          <div><dt>Compras</dt><dd>${compras.length}</dd></div>
          ${lim ? `<div><dt>Limite disponível</dt><dd class="pos">${fmtBRL(lim.disponivel)}</dd></div>` : ''}
        </dl>
      </section>

      <section class="card">
        ${tituloCard('Próximos meses', `Parcelas que continuam e gastos fixos deste cartão.`, 'calendario')}
        <dl class="lista">
          <div class="destaque"><dt>Prevista para ${MESES[px.mes - 1].toLowerCase()}</dt><dd>${fmtBRL(previstaProxima)}</dd></div>
          <div><dt>Parcelas que continuam</dt><dd>${fmtBRL(continuam.reduce((s, l) => s + l.valor, 0))}<small>${continuam.length} ${continuam.length === 1 ? 'compra' : 'compras'}</small></dd></div>
          <div><dt>Gastos fixos</dt><dd>${fmtBRL(fixas.reduce((s, l) => s + l.valor, 0))}<small>${fixas.length} ${fixas.length === 1 ? 'item' : 'itens'}</small></dd></div>
          <div><dt>Total ainda a pagar em parcelas</dt><dd>${fmtBRL(compromissoFuturo)}</dd></div>
        </dl>
      </section>
    </div>

    <div class="painel-3">
      <section class="card">
        ${tituloCard('Ranking de categorias', 'Onde foi gasto nesta fatura.')}
        ${blocoRanking(compras, 'Nenhuma compra nesta fatura.')}
      </section>
      <section class="card">
        ${tituloCard('Por recorrência', 'Fixas (repetem todo mês), parceladas e variáveis.')}
        ${blocoRecorrencia(compras, 'g-rec-cartao')}
      </section>
      <section class="card">
        ${tituloCard('Parcelas terminando', 'Quanto falta de cada compra parcelada.')}
        ${terminando.length ? `<ul class="parcelas">${terminando.slice(0, 8).map(({ l, faltam }) => `<li>
            ${iconeCat(classePorId(l.classe_id))}
            <span class="parc-txt"><b>${esc(l.descricao)}</b><small>${faltam === 0 ? '<span class="tag pos">última parcela</span>' : `termina em ${mesDaParcela(faltam)} · faltam ${faltam}`}</small>
              <span class="parc-barra"><i style="width:${(l.parcela / l.parcelas) * 100}%"></i></span></span>
            <span class="parc-val"><b>${fmtBRL(l.valor)}</b><small>${textoParcela(l)}</small></span>
          </li>`).join('')}</ul>` : '<p class="sub">Nenhuma compra parcelada nesta fatura. Parcelas aparecem sozinhas quando o extrato traz "PARC 03/10", ou marque no lançamento.</p>'}
      </section>
    </div>

    <section class="card">
      <div class="card-cab"><div><h2>Extrato ${ext.tudo ? 'completo do cartão' : 'da fatura'}</h2><p class="sub">${listaExt.length} ${listaExt.length === 1 ? 'lançamento' : 'lançamentos'} · ${fmtBRL(listaExt.filter((l) => l.destino === 'despesa').reduce((s, l) => s + l.valor, 0))} em compras</p></div></div>
      <div class="filtros-lanc">
        <input type="search" data-ext="busca" placeholder="Buscar compra…" value="${esc(ext.busca)}" aria-label="Buscar">
        <div class="seg" role="group" aria-label="Período"><button data-ext-tudo="0" class="${!ext.tudo ? 'ativo' : ''}">Esta fatura</button><button data-ext-tudo="1" class="${ext.tudo ? 'ativo' : ''}">Tudo do cartão</button></div>
      </div>
      <div class="extrato">${listaExt.length ? listaExt.map((l) => linhaExtrato(l)).join('') : '<p class="sub">Nada encontrado.</p>'}</div>
    </section>

    <section class="card grafico">
      ${tituloCard('Últimas 12 faturas', 'Valor de cada fatura do cartão.', 'grafico')}
      <div class="canvas-box pequeno"><canvas id="g-faturas"></canvas></div>
    </section>`;

  main.querySelector('[data-a="editar-cartao"]').addEventListener('click', () => abrirConta(cat));
  main.querySelectorAll('[data-ext-tudo]').forEach((b) => b.addEventListener('click', () => { ext.tudo = b.dataset.extTudo === '1'; render(); }));
  const busca = main.querySelector('[data-ext="busca"]');
  busca.addEventListener('input', () => {
    clearTimeout(renderCartao._t);
    renderCartao._t = setTimeout(() => { ext.busca = busca.value; render(); const b2 = app.querySelector('[data-ext="busca"]'); if (b2) { b2.focus(); b2.setSelectionRange(b2.value.length, b2.value.length); } }, 250);
  });
  bindExtrato(main, ano, mes);
  roscaRecorrencia(main, 'g-rec-cartao', compras);
  const canvas = main.querySelector('#g-faturas');
  if (canvas && window.Chart) {
    const meses = Array.from({ length: 12 }, (_, i) => { const d = new Date(ano, mes - 12 + i, 1); return { ano: d.getFullYear(), mes: d.getMonth() + 1 }; });
    const vals = meses.map((p) => { const f = faturaDoMes(cat, p.ano, p.mes); return f ? f.total : S.data.lancamentos.filter((l) => l.categoria_id === id && l.destino === 'despesa' && String(l.data).startsWith(`${p.ano}-${pad2(p.mes)}`)).reduce((s, l) => s + l.valor, 0); });
    const cor = corCat(cat);
    S.charts.push(new Chart(canvas, {
      type: 'bar',
      data: { labels: meses.map((p) => `${MESES_CURTO[p.mes - 1]}/${String(p.ano).slice(2)}`), datasets: [{ label: 'Fatura', data: vals, backgroundColor: meses.map((_, i) => (i === 11 ? cor : cor + '99')), borderRadius: 6, maxBarThickness: 34 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => fmtBRL(c.parsed.y) } } },
        scales: { x: { grid: { display: false }, ticks: { color: cssVar('--muted') } }, y: { grid: { color: cssVar('--border') }, border: { display: false }, ticks: { color: cssVar('--muted'), callback: (v) => v.toLocaleString('pt-BR') } } } },
    }));
  }
}

/* ======================================================== página da conta */
function renderConta(main, ano, mes, id) {
  const cat = S.data.categorias.find((c) => c.id === id);
  if (!cat) { location.hash = `#/contas/${ano}/${mes}`; return; }
  const pre = `${ano}-${pad2(mes)}`;
  const m = movimentoConta(cat, ano, mes);
  const doMes = S.data.lancamentos.filter((l) => l.categoria_id === id && String(l.data).startsWith(pre))
    .sort((a, b) => a.data.localeCompare(b.data) || (sentidoDe(a) === 'entrada' ? -1 : 1));
  // Saldo linha a linha (como no extrato do banco), do saldo do início do mês
  let corrente = m.saldoInicio;
  const comSaldo = doMes.map((l) => { corrente = Math.round((corrente + comSinal(l)) * 100) / 100; return { l, saldo: corrente }; });
  const despesas = doMes.filter((l) => l.destino === 'despesa');
  const ultimas = [...despesas].sort((a, b) => b.data.localeCompare(a.data)).slice(0, 6);
  const temSaldo = cat.saldo_inicial !== null && cat.saldo_inicial !== undefined;
  const pa = anterior(ano, mes);
  const mAnt = movimentoConta(cat, pa.ano, pa.mes);
  const fc = S.extConta || (S.extConta = { busca: '' });
  const listaExt = comSaldo.filter(({ l }) => !fc.busca || normDesc(l.descricao).includes(normDesc(fc.busca))).reverse();

  main.innerHTML = `
    ${cabecalhoMes(ano, mes, '#/contas', `
      <a class="btn" href="#/contas/${ano}/${mes}">‹ <span>Todas as contas</span></a>
      <button class="btn" data-a="editar-conta">${ICON.editar}<span>Saldo inicial</span></button>
      <button class="btn primario" data-a="importar-mes">${ICON.upload}<span>Importar extrato</span></button>`, `/${id}`)}

    <section class="conta-cab card">
      <div class="conta-ident">${avatarConta(cat)}<div><h2>${esc(cat.banco || cat.nome)}</h2><p class="sub">${esc(cat.banco ? cat.nome : '')}${cat.subtipo ? ` · ${esc(SUBTIPOS[cat.subtipo] || '')}` : ''}</p></div></div>
      <div class="kpis-linha">
        <div class="kpi-pill"><span class="kpi-ic" style="--cor:var(--accent)">${ICON.banco}</span><div><small>Saldo ${ano === new Date().getFullYear() && mes === new Date().getMonth() + 1 ? 'atual' : `no fim de ${MESES_CURTO[mes - 1].toLowerCase()}`}</small><strong class="${cls(m.saldoFim)}">${temSaldo ? fmtBRL(m.saldoFim) : '—'}</strong></div></div>
        <div class="kpi-pill"><span class="kpi-ic" style="--cor:var(--pos)">↓</span><div><small>Entradas consolidadas</small><strong class="pos">${fmtBRL(m.receitas + m.transfEntrada)}</strong></div></div>
        <div class="kpi-pill"><span class="kpi-ic" style="--cor:var(--neg)">↑</span><div><small>Saídas consolidadas</small><strong class="neg">${fmtBRL(m.despesas + m.transfSaida)}</strong></div></div>
        <div class="kpi-pill"><span class="kpi-ic" style="--cor:#f59e0b">=</span><div><small>Resultado do mês</small><strong class="${cls(m.receitas - m.despesas)}">${fmtBRL(m.receitas - m.despesas)}</strong>${chipVariacao(m.receitas - m.despesas, mAnt.receitas - mAnt.despesas)}</div></div>
      </div>
      ${!temSaldo ? '<p class="hint aviso-txt">Informe o saldo inicial (botão acima) para o site calcular o saldo da conta dia a dia.</p>' : ''}
    </section>

    <div class="painel-3">
      <section class="card">
        ${tituloCard('Despesas por categoria', `Saídas de ${MESES[mes - 1].toLowerCase()} nesta conta.`)}
        ${blocoRanking(despesas, 'Nenhuma despesa nesta conta no mês.')}
      </section>
      <section class="card">
        ${tituloCard('Últimas despesas')}
        <div class="extrato compacto">${ultimas.length ? ultimas.map((l) => linhaExtrato(l)).join('') : '<p class="sub">Nenhuma despesa no mês.</p>'}</div>
      </section>
      <section class="card">
        ${tituloCard('Resumo do mês', 'Como o saldo andou.')}
        <dl class="lista">
          <div><dt>Saldo no início</dt><dd>${temSaldo ? fmtBRL(m.saldoInicio) : '—'}</dd></div>
          <div><dt>Receitas</dt><dd class="pos">+ ${fmtBRL(m.receitas)}</dd></div>
          <div><dt>Despesas</dt><dd class="neg">− ${fmtBRL(m.despesas)}</dd></div>
          <div><dt>Transferências recebidas</dt><dd>+ ${fmtBRL(m.transfEntrada)}</dd></div>
          <div><dt>Transferências enviadas</dt><dd>− ${fmtBRL(m.transfSaida)}</dd></div>
          <div class="destaque"><dt>Saldo no fim</dt><dd class="${cls(m.saldoFim)}">${temSaldo ? fmtBRL(m.saldoFim) : '—'}</dd></div>
        </dl>
      </section>
    </div>

    <section class="card">
      <div class="card-cab"><div><h2>Extrato de ${MESES[mes - 1].toLowerCase()}</h2><p class="sub">Tudo o que passou nesta conta, com o saldo depois de cada movimentação.</p></div></div>
      <div class="filtros-lanc"><input type="search" data-ext="busca" placeholder="Buscar no extrato…" value="${esc(fc.busca)}" aria-label="Buscar"></div>
      <div class="extrato">${listaExt.length ? listaExt.map(({ l, saldo }) => linhaExtrato(l, { saldo: temSaldo ? saldo : null })).join('') : '<p class="sub">Nenhuma movimentação neste mês.</p>'}</div>
    </section>`;

  main.querySelector('[data-a="editar-conta"]').addEventListener('click', () => abrirConta(cat));
  const busca = main.querySelector('[data-ext="busca"]');
  busca.addEventListener('input', () => {
    clearTimeout(renderConta._t);
    renderConta._t = setTimeout(() => { fc.busca = busca.value; render(); const b2 = app.querySelector('[data-ext="busca"]'); if (b2) { b2.focus(); b2.setSelectionRange(b2.value.length, b2.value.length); } }, 250);
  });
  bindExtrato(main, ano, mes);
}

/* ========================================================= classificar */
function cardSemClasses(tipo = 'despesa') {
  return tipo === 'receita'
    ? `<section class="card destaque-acao">
    <h2>Crie as categorias de receita</h2>
    <p class="sub">Dizem <b>de onde veio</b> o dinheiro: Vendas / clientes, Salário, Rendimentos… Comece com as sugeridas e ajuste depois em Ajustes.</p>
    <div class="acoes"><button class="btn primario" data-a="sugeridas" data-tipo="receita">Criar categorias de receita sugeridas</button><a class="btn" href="#/ajustes">Criar as minhas</a></div>
  </section>`
    : `<section class="card destaque-acao">
    <h2>Crie as categorias de gasto</h2>
    <p class="sub">Categorias dizem <b>com o quê</b> o dinheiro foi gasto (Funcionários, Assinaturas, Telefone…), independente da conta.
      Comece com as sugeridas e ajuste depois em Ajustes.</p>
    <div class="acoes"><button class="btn primario" data-a="sugeridas" data-tipo="despesa">Criar categorias sugeridas</button><a class="btn" href="#/ajustes">Criar as minhas</a></div>
  </section>`;
}
function bindSemClasses(main) {
  main.querySelectorAll('[data-a="sugeridas"]').forEach((b) => b.addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    try { await criarClassesSugeridas(b.dataset.tipo || 'despesa'); toast('Categorias criadas.'); render(); } catch (ex) { toast(ex.message, 'erro'); b.disabled = false; }
  }));
}

function renderClassificar(main, ano, mes) {
  const prefixo = `${ano}-${pad2(mes)}`;
  // Duas filas: gastos sem categoria e receitas sem categoria
  const tipo = S.classTipo === 'receita' ? 'receita' : 'despesa';
  const pendentesDe = tipo === 'receita' ? receitasSemClasse : semClasse;
  const nomeItem = (n) => (tipo === 'receita' ? (n === 1 ? 'receita' : 'receitas') : (n === 1 ? 'gasto' : 'gastos'));
  const despesasMes = S.data.lancamentos.filter((l) => String(l.data).startsWith(prefixo) && l.destino === (tipo === 'receita' ? 'receita' : 'despesa'));
  const pend = pendentesDe(despesasMes);
  const feitos = despesasMes.length - pend.length;
  const pct = despesasMes.length ? Math.round((feitos / despesasMes.length) * 100) : 0;
  const pendOutroTipo = (tipo === 'receita' ? semClasse : receitasSemClasse)(S.data.lancamentos.filter((l) => String(l.data).startsWith(prefixo))).length;
  const outros = new Map();
  for (const l of pendentesDe(S.data.lancamentos)) {
    const k = l.data.slice(0, 7);
    if (k !== prefixo) outros.set(k, (outros.get(k) || 0) + 1);
  }
  // Agrupa compras parecidas (mesma descrição sem números): um clique classifica o grupo todo
  // Agrupa pelas palavras que identificam a loja/pessoa ("mercadolivre", "joao silva"), ignorando "PIX ENVIADO", datas e códigos
  const mapa = new Map();
  for (const l of pend) {
    const b = regraPadrao(l.descricao) || normDesc(l.descricao) || 'sem descricao';
    if (!mapa.has(b)) mapa.set(b, []);
    mapa.get(b).push(l);
  }
  const problemas = conferir(prefixo);
  const grupos = [...mapa.entries()]
    .map(([base, ls]) => ({ base, ls, total: ls.reduce((s, l) => s + l.valor, 0) }))
    .sort((a, b) => b.total - a.total);
  const cl = arvoreClasses(tipo);
  const catPorId = new Map(S.data.categorias.map((c) => [c.id, c]));

  main.innerHTML = `
    ${cabecalhoMes(ano, mes, '#/classificar', `
      <div class="seg" role="group" aria-label="Gastos ou receitas">${Object.entries(TIPOS_CLASSE).map(([k, t]) => `<button data-tipo-classe="${k}" class="${tipo === k ? 'ativo' : ''}" aria-pressed="${tipo === k}">${t}</button>`).join('')}</div>
      <button class="btn" data-a="aplicar-regras" title="Usa as regras salvas nos lançamentos ainda sem categoria">Aplicar regras</button>
      <a class="btn" href="#/graficos/${ano}/${mes}">${ICON.grafico}<span>Ver gráficos</span></a>`)}

    ${!cl.length ? cardSemClasses(tipo) : ''}

    ${blocoConferencia(problemas)}
    ${pendOutroTipo ? `<p class="hint">Também há ${pendOutroTipo} ${tipo === 'receita' ? (pendOutroTipo === 1 ? 'gasto' : 'gastos') : (pendOutroTipo === 1 ? 'receita' : 'receitas')} sem categoria neste mês. <a href="#" data-tipo-classe="${tipo === 'receita' ? 'despesa' : 'receita'}">Ver →</a></p>` : ''}

    <section class="card progresso-card">
      <div class="progresso-topo">
        <div><strong>${feitos} de ${despesasMes.length}</strong> ${nomeItem(despesasMes.length)} de ${MESES[mes - 1].toLowerCase()} ${tipo === 'receita' ? 'classificadas' : 'classificados'}</div>
        <span class="pct">${pct}%</span>
      </div>
      <div class="progresso grande"><span style="width:${pct}%"></span></div>
      ${outros.size ? `<p class="hint">Outros meses com ${nomeItem(2)} sem categoria:
        ${[...outros.entries()].sort().map(([k, n]) => { const [a, m] = k.split('-').map(Number); return `<a href="#/classificar/${a}/${m}">${MESES_CURTO[m - 1]}/${String(a).slice(2)} (${n})</a>`; }).join(' · ')}</p>` : ''}
    </section>

    ${!despesasMes.length ? `
      <section class="card vazio">
        <h2>${tipo === 'receita' ? 'Nenhuma receita lançada' : 'Nenhum gasto lançado'} em ${MESES[mes - 1].toLowerCase()}</h2>
        <p>Importe os extratos das contas e cartões na tela Transações e volte aqui para classificar.</p>
        <div class="acoes"><a class="btn primario" href="#/lancamentos/${ano}/${mes}">Ir para Transações</a></div>
      </section>`
    : !pend.length ? `
      <section class="card vazio pronto">
        <h2>Tudo classificado ✓</h2>
        <p>${tipo === 'receita' ? 'Todas as receitas' : 'Todos os gastos'} de ${MESES[mes - 1].toLowerCase()} têm categoria.</p>
        <div class="acoes"><a class="btn primario" href="#/graficos/${ano}/${mes}">Ver quanto foi para cada categoria</a></div>
      </section>`
    : `<div class="grupos">${grupos.map((g, gi) => `
      <section class="card grupo" data-g="${gi}">
        <div class="grupo-cab">
          <div class="grupo-txt">
            <b>${esc(g.ls[0].descricao)}</b>
            <span class="sub">${g.ls.length > 1 ? `${g.ls.length} lançamentos · ` : ''}<strong>${fmtBRL(g.total)}</strong> ·
              ${[...new Set(g.ls.map((l) => fmtDia(l.data)))].slice(0, 4).join(', ')}${g.ls.length > 4 ? '…' : ''} ·
              ${[...new Set(g.ls.map((l) => l.conta || catPorId.get(l.categoria_id)?.nome).filter(Boolean))].map(esc).join(', ')}</span>
          </div>
          <div class="seg" role="radiogroup" aria-label="Pessoal ou empresa">
            ${[['', 'Pela categoria'], ['pessoal', 'Pessoal'], ['empresa', 'Empresa']].map(([v, t]) =>
              `<label><input type="radio" name="lado-${gi}" value="${v}" ${v === '' ? 'checked' : ''}><span>${t}</span></label>`).join('')}
          </div>
        </div>
        <div class="chips">
          ${cl.map((c) => `<button type="button" class="chip ${c.nivel ? 'sub' : ''}" data-classe="${c.id}" style="--cor:${c.cor}" title="${esc(nomeClasse(c))}"><i></i>${c.nivel ? '↳ ' : ''}${esc(c.nome)}${c.escopo_padrao ? `<small>${LADO[c.escopo_padrao]}</small>` : ''}</button>`).join('')}
        </div>
        <div class="grupo-pe">
          <label class="check-linha"><input type="checkbox" data-lembrar checked> Lembrar: sempre que a descrição tiver
            <input class="regra-texto" data-texto value="${esc(g.base)}" aria-label="Texto da regra"></label>
          ${g.ls.length > 1 ? `<details><summary>Escolher quais (${g.ls.length})</summary>
            <div class="grupo-itens">${g.ls.map((l) => `<label class="check-linha"><input type="checkbox" data-id="${l.id}" checked>
              ${fmtDia(l.data)} · ${esc(l.descricao)} · <b>${fmtBRL(l.valor)}</b></label>`).join('')}</div></details>` : ''}
        </div>
      </section>`).join('')}</div>`}`;

  bindSemClasses(main);
  bindConferencia(main, problemas);
  main.querySelectorAll('[data-tipo-classe]').forEach((b) => b.addEventListener('click', (e) => { e.preventDefault(); S.classTipo = b.dataset.tipoClasse; render(); }));
  main.querySelector('[data-a="aplicar-regras"]').addEventListener('click', async () => {
    // só regras de categorias do tipo certo (gasto para despesa, receita para receita)
    const regrasTipo = S.data.regras.filter((r) => classePorId(r.classe_id) && tipoDaClasse(classePorId(r.classe_id)) === tipo);
    const alvo = pendentesDe(S.data.lancamentos).map((l) => ({ l, r: regraPara(l.descricao, regrasTipo) })).filter((x) => x.r);
    if (!alvo.length) { toast(`Nenhum${tipo === 'receita' ? 'a receita' : ' gasto'} sem categoria combina com as regras salvas.`); return; }
    try {
      for (const { l, r } of alvo) await classificar([l.id], r.classe_id, r.escopo || null, null);
      toast(`${alvo.length} ${nomeItem(alvo.length)} classificados pelas regras.`);
      render();
    } catch (e) { toast(e.message, 'erro'); }
  });
  main.querySelectorAll('.grupo').forEach((card) => {
    const g = grupos[Number(card.dataset.g)];
    card.querySelectorAll('[data-classe]').forEach((b) => b.addEventListener('click', async () => {
      const marcados = card.querySelectorAll('[data-id]').length
        ? [...card.querySelectorAll('[data-id]:checked')].map((x) => x.dataset.id)
        : g.ls.map((l) => l.id);
      if (!marcados.length) { toast('Marque pelo menos um lançamento.', 'erro'); return; }
      const lado = card.querySelector(`input[name="lado-${card.dataset.g}"]:checked`).value || null;
      const lembrar = card.querySelector('[data-lembrar]').checked;
      const texto = normDesc(card.querySelector('[data-texto]').value).trim();
      card.classList.add('saindo');
      try {
        await classificar(marcados, b.dataset.classe, lado, lembrar ? texto : null);
        const c = classePorId(b.dataset.classe);
        toast(`${marcados.length} → ${nomeClasse(c)}${lado ? ` · ${LADO[lado]}` : c?.escopo_padrao ? ` · ${LADO[c.escopo_padrao]}` : ''}${lembrar ? ' · regra salva' : ''}`);
        render();
      } catch (e) { card.classList.remove('saindo'); toast(e.message, 'erro'); }
    }));
  });
}

/* ========================================================== categorias */
/* ---------------------------------------------------------- filtro */
const FILTRO_KEY = 'financas-filtro-v1';
const PRESETS = {
  tudo: 'Todo o período',
  ano: 'Este ano',
  anoant: 'Ano passado',
  '12m': 'Últimos 12 meses',
  '6m': 'Últimos 6 meses',
  '3m': 'Últimos 3 meses',
  personalizado: 'Personalizado',
};
function lerFiltro() {
  try { return JSON.parse(localStorage.getItem(FILTRO_KEY)) || { preset: 'tudo' }; } catch { return { preset: 'tudo' }; }
}
function salvarFiltro() {
  try { localStorage.setItem(FILTRO_KEY, JSON.stringify(S.filtro)); } catch { /* sem armazenamento: filtro vale só nesta visita */ }
}
const ymTexto = (n) => `${MESES_CURTO[(n % 100) - 1]}/${String(Math.floor(n / 100)).slice(2)}`;
const ymInput = (n) => `${Math.floor(n / 100)}-${String(n % 100).padStart(2, '0')}`;
const ymDeInput = (s) => { const [a, m] = String(s || '').split('-').map(Number); return a && m ? a * 100 + m : null; };

/** Intervalo {de, ate} (AAAAMM) do filtro, ou null para todo o período. */
function intervalo(f) {
  const d = new Date();
  const a = d.getFullYear(), m = d.getMonth() + 1;
  const ultimos = (n) => {
    const x = new Date(a, m - n, 1);
    return { de: x.getFullYear() * 100 + x.getMonth() + 1, ate: a * 100 + m };
  };
  switch (f.preset) {
    case 'ano': return { de: a * 100 + 1, ate: a * 100 + 12 };
    case 'anoant': return { de: (a - 1) * 100 + 1, ate: (a - 1) * 100 + 12 };
    case '12m': return ultimos(12);
    case '6m': return ultimos(6);
    case '3m': return ultimos(3);
    case 'personalizado': return { de: ymDeInput(f.de) ?? 0, ate: ymDeInput(f.ate) ?? 999912 };
    default: return null;
  }
}

function filtroHTML(f, todasCats) {
  const iv = intervalo(f);
  const sel = f.cats ? todasCats.filter((c) => f.cats.includes(c.id)) : todasCats;
  const ativo = f.preset !== 'tudo' || !!f.cats;
  return `
  <section class="card filtro">
    <label class="campo"><span>Período</span>
      <select name="preset">${Object.entries(PRESETS).map(([k, v]) => `<option value="${k}" ${f.preset === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
    </label>
    <label class="campo"><span>De</span><input type="month" name="de" value="${iv && iv.de ? ymInput(iv.de) : ''}"></label>
    <label class="campo"><span>Até</span><input type="month" name="ate" value="${iv && iv.ate < 999912 ? ymInput(iv.ate) : ''}"></label>
    <details class="filtro-cats">
      <summary class="btn">Despesas: ${sel.length === todasCats.length ? 'todas' : `${sel.length} de ${todasCats.length}`}</summary>
      <div class="filtro-cats-lista">
        ${todasCats.map((c) => `<label><input type="checkbox" value="${c.id}" ${sel.includes(c) ? 'checked' : ''}> ${esc(c.nome)} <small>(${c.tipo === 'debito' ? 'débito' : 'crédito'})</small></label>`).join('')}
      </div>
    </details>
    ${ativo ? '<button class="btn" data-a="limpar-filtro">Limpar filtro</button>' : ''}
  </section>`;
}

function bindFiltro(main, todasCats) {
  const box = main.querySelector('.filtro');
  if (!box) return;
  const aplicar = () => { salvarFiltro(); render(); };
  box.querySelector('[name="preset"]').addEventListener('change', (e) => {
    const iv = intervalo(S.filtro);
    S.filtro = { ...S.filtro, preset: e.target.value };
    if (e.target.value === 'personalizado' && iv) { S.filtro.de = ymInput(iv.de); S.filtro.ate = iv.ate < 999912 ? ymInput(iv.ate) : ''; }
    aplicar();
  });
  box.querySelectorAll('input[type="month"]').forEach((inp) => inp.addEventListener('change', () => {
    S.filtro = {
      ...S.filtro,
      preset: 'personalizado',
      de: box.querySelector('[name="de"]').value,
      ate: box.querySelector('[name="ate"]').value,
    };
    aplicar();
  }));
  box.querySelectorAll('.filtro-cats input').forEach((chk) => chk.addEventListener('change', () => {
    const marcados = [...box.querySelectorAll('.filtro-cats input:checked')].map((x) => x.value);
    S.filtro = { ...S.filtro, cats: marcados.length === todasCats.length ? null : marcados, catsAberto: true };
    aplicar();
  }));
  if (S.filtro.catsAberto) { box.querySelector('.filtro-cats').open = true; S.filtro.catsAberto = false; }
  box.querySelector('[data-a="limpar-filtro"]')?.addEventListener('click', () => { S.filtro = { preset: 'tudo' }; aplicar(); });
}

/* ========================================================== visão geral */
function renderGeral(main) {
  const f = S.filtro;
  const todasCats = cats();
  const c = f.cats ? todasCats.filter((x) => f.cats.includes(x.id)) : todasCats;
  const map = indexMeses(efetivos());
  const iv = intervalo(f);
  const dentro = (r) => !iv || (r.ano * 100 + r.mes >= iv.de && r.ano * 100 + r.mes <= iv.ate);
  const porAno = anosComDados(efetivos())
    .map((ano) => ({ ano, linhas: linhasDoAno(ano, map, c).filter(dentro) }))
    .filter((a) => a.linhas.some((l) => l.temDados));
  const todas = porAno.flatMap((a) => a.linhas);
  const st = estatisticas(todas, c, prefs());

  if (!st.mesesComDados && !efetivos().some(mesTemDados)) {
    main.innerHTML = `
      <section class="vazio card">
        <h1>Bem-vindo às Finanças Marques</h1>
        <p>Ainda não há meses lançados. Importe a sua planilha <b>FINANÇAS GERAIS.xlsx</b> para trazer todo o histórico, ou lance o primeiro mês.</p>
        <div class="acoes">
          <a class="btn primario" href="#/ajustes">Importar planilha</a>
          <button class="btn" data-acao="primeiro">Lançar primeiro mês</button>
        </div>
      </section>`;
    main.querySelector('[data-acao="primeiro"]').addEventListener('click', () => abrirEditor(anoAtual(), new Date().getMonth() + 1));
    return;
  }

  const comDados = todas.filter((r) => r.temDados);
  const creditos = st.porCategoria.filter((p) => p.cat.tipo === 'credito' && p.meses);
  const filtrado = !!iv || !!f.cats;
  const ym = (r) => r.ano * 100 + r.mes;
  const periodo = !comDados.length ? '' : !iv ? 'Todos os anos'
    : `${ymTexto(ym(comDados[0]))} a ${ymTexto(ym(comDados[comDados.length - 1]))}`;
  const cabecalho = `
    ${cabecalhoSimples('Todos os anos', `<span class="sub">${periodo}${periodo ? ' · ' : ''}${st.mesesComDados} ${st.mesesComDados === 1 ? 'mês' : 'meses'}${f.cats ? ' · filtrado' : ''}</span>`)}
    ${filtroHTML(f, todasCats)}`;

  if (!comDados.length) {
    main.innerHTML = `${cabecalho}<section class="card vazio"><p>Nenhum mês lançado neste período.</p></section>`;
    bindFiltro(main, todasCats);
    return;
  }

  main.innerHTML = `
    ${cabecalho}

    <section class="kpis">
      ${kpi('Receita total', st.receitaTotal)}
      ${kpi('Gasto total', st.gastoTotal)}
      ${kpi('Saldo total (receita − despesas)', st.saldoTotal, true)}
      ${kpi('Último saldo informado', st.ultimoSaldo)}
    </section>

    <section class="planilha info-esq">
    ${blocoInfo(filtrado ? 'Informações gerais (filtro)' : 'Informações gerais (todos os anos)', [
      ['', [
        ['Gasto total', st.gastoTotal],
        ['Gasto crédito total', st.creditoTotal],
        ['Receita total', st.receitaTotal],
        ['Saldo total', st.saldoTotal, true],
        ['Média de receita por mês', st.mediaReceita],
        ['Média de despesas por mês', st.mediaDespesas],
        ['Média de gasto no débito', st.mediaDebito],
      ]],
      ['Informações crédito', [
        ...creditos.map((p) => [`Média de gasto ${p.cat.nome}`, p.media]),
        ['Média de gasto no crédito', st.mediaCredito],
      ]],
      ['Informações investimentos', [
        ['Total investido', st.totalInvestido],
        ['Média de investimento por mês', st.mediaInvestimento],
        ['Total de rendimento', st.totalRendimento],
      ]],
      ['Saldo financeiro (invest. + débito)', [
        ['Último saldo informado', st.ultimoSaldo],
        ['Resultado acumulado', st.resultadoAcumulado, true],
        ['Meses com saldo negativo', st.mesesNegativos, false, 'int'],
      ]],
    ])}
    <div class="coluna">
    <section>
      <h2 class="secao">Ano a ano</h2>
      <div class="anos-grade">
        ${[...porAno].reverse().map(({ ano, linhas }) => {
          const s = estatisticas(linhas, c, prefs());
          const maior = Math.max(s.receitaTotal, s.gastoTotal) || 1;
          return `<a class="card ano-card" href="#/ano/${ano}">
            <div class="ano-card-topo"><b>${ano}</b><span class="sub">${s.mesesComDados} ${s.mesesComDados === 1 ? 'mês' : 'meses'}</span></div>
            <div class="ano-sobra"><span>Sobra</span><strong class="${cls(s.saldoTotal)}">${grande(s.saldoTotal)}</strong></div>
            <div class="ano-barras" aria-hidden="true">
              <div><span>Receita</span><i style="width:${(s.receitaTotal / maior) * 100}%;background:var(--c-receita)"></i><b>${fmtBRL(s.receitaTotal)}</b></div>
              <div><span>Gastos</span><i style="width:${(s.gastoTotal / maior) * 100}%;background:var(--c-despesa)"></i><b>${fmtBRL(s.gastoTotal)}</b></div>
            </div>
            <dl class="lista compacta">
              <div><dt>Investido</dt><dd>${fmtBRL(s.totalInvestido)}</dd></div>
              <div><dt>Resultado do saldo</dt><dd class="${cls(s.resultadoAcumulado)}">${fmtBRL(s.resultadoAcumulado)}</dd></div>
            </dl>
            <span class="ano-ver">Ver o ano →</span>
          </a>`;
        }).join('')}
      </div>
    </section>
    <section class="card grafico">
      ${tituloCard('Receita × despesas por mês', 'Todos os meses lançados, do primeiro ao último.', 'grafico')}
      <div class="canvas-box"><canvas id="g-geral"></canvas></div>
    </section>
    </div>
    </section>`;

  bindFiltro(main, todasCats);
  // Gráfico: do primeiro ao último mês com dados
  const ini = todas.indexOf(comDados[0]);
  const fim = todas.indexOf(comDados[comDados.length - 1]);
  grafico(main.querySelector('#g-geral'), todas.slice(ini, fim + 1));
}

function kpi(label, v, colorir = false) {
  return `<div class="card kpi"><span>${label}</span><strong class="${colorir ? cls(v) : ''}">${fmtBRL(v)}</strong></div>`;
}

/** Bloco único com todas as informações, como a coluna de resumo da planilha. */
function blocoInfo(titulo, secoes) {
  return `<aside class="card info">
    <h2>${esc(titulo)}</h2>
    ${secoes.filter(([, linhas]) => linhas.length).map(([sub, linhas]) => `
      ${sub ? `<h3>${esc(sub)}</h3>` : ''}
      <dl>${linhas.map(([k, v, colorir, tipo]) => `<div><dt>${esc(k)}</dt><dd class="${colorir ? cls(v) : ''}">${tipo === 'int' ? v : fmtBRL(v)}</dd></div>`).join('')}</dl>
    `).join('')}
  </aside>`;
}

/* ================================================================ ano */
/** Cabeçalho do ano: seletor de ano + abas Resumo / Planilha. */
function cabecalhoAno(ano, aba, st) {
  const anos = [...new Set([...anosComDados(efetivos()), anoAtual(), ano, ano - 1, ano + 1])].sort((a, b) => a - b);
  const sufixo = aba === 'planilha' ? '/planilha' : '';
  return `
    <div class="barra-pagina">
      <div class="barra-esq seletor-ano">
        <a class="btn icone discreto" href="#/ano/${ano - 1}${sufixo}" aria-label="Ano anterior">‹</a>
        <a class="btn icone discreto" href="#/ano/${ano + 1}${sufixo}" aria-label="Próximo ano">›</a>
        <select class="titulo-mes" aria-label="Ano">${anos.map((a) => `<option ${a === ano ? 'selected' : ''}>${a}</option>`).join('')}</select>
      </div>
      <div class="barra-dir">
        <div class="abas" role="tablist">
          <a role="tab" href="#/ano/${ano}" class="${aba === 'resumo' ? 'ativo' : ''}" aria-selected="${aba === 'resumo'}">Resumo</a>
          <a role="tab" href="#/ano/${ano}/planilha" class="${aba === 'planilha' ? 'ativo' : ''}" aria-selected="${aba === 'planilha'}">Planilha</a>
        </div>
      </div>
    </div>`;
}

function bindCabecalhoAno(main, aba) {
  main.querySelector('.seletor-ano select').addEventListener('change', (e) => {
    location.hash = `#/ano/${e.target.value}${aba === 'planilha' ? '/planilha' : ''}`;
  });
}

function renderAno(main, ano, aba) {
  if (aba === 'planilha') renderAnoPlanilha(main, ano);
  else renderAnoResumo(main, ano);
}

function renderAnoResumo(main, ano) {
  const c = cats();
  const map = indexMeses(efetivos());
  const linhas = linhasDoAno(ano, map, c);
  const st = estatisticas(linhas, c, prefs());
  const linhasAnt = linhasDoAno(ano - 1, map, c);
  const stAnt = estatisticas(linhasAnt, c, prefs());
  const p = prefs();

  if (!st.mesesComDados) {
    main.innerHTML = `${cabecalhoAno(ano, 'resumo', st)}
      <section class="card vazio">
        <h2>Nenhum mês lançado em ${ano}</h2>
        <p>Comece pelo mês atual na tela <b>Mês</b>, ou abra a aba <b>Planilha</b> e toque em qualquer mês para lançar.</p>
        <div class="acoes"><a class="btn primario" href="#/mes">Ir para o mês</a><a class="btn" href="#/ano/${ano}/planilha">Abrir planilha de ${ano}</a></div>
      </section>`;
    bindCabecalhoAno(main, 'resumo');
    return;
  }

  const com = linhas.filter((l) => l.temDados);
  const pega = (k, maior) => com.filter((l) => l[k] !== null).sort((a, b) => (maior ? b[k] - a[k] : a[k] - b[k]))[0];
  const melhor = pega('saldoMes', true), pior = pega('saldoMes', false);
  const maisGasto = pega('totalDesp', true), maisReceita = pega('receita', true);
  const nomeMes = (l) => (l ? MESES[l.mes - 1] : '—');
  const temAnt = stAnt.mesesComDados > 0;
  const vsAnt = `vs ${ano - 1}`;

  // Para onde foi a receita do ano
  const receita = st.receitaTotal;
  const sobra = st.saldoTotal;
  const base = Math.max(receita, st.gastoTotal) || 1;
  const partes = [
    ...st.porCategoria.filter((x) => x.total > 0).map((x) => ({ nome: x.cat.nome, valor: x.total, cor: corCat(x.cat) })),
    ...(sobra > 0 ? [{ nome: 'Sobra', valor: sobra, cor: 'var(--sobra)' }] : []),
  ];
  const pctReceita = (v) => (receita > 0 ? ` <small>${Math.round((v / receita) * 100)}%</small>` : '');

  const metaAno = receita * p.pct_investir;
  const pctMeta = metaAno > 0 ? Math.min(100, (st.totalInvestido / metaAno) * 100) : 0;
  const maxGastar = st.maximoGastar;

  main.innerHTML = `${cabecalhoAno(ano, 'resumo', st)}
    <div class="mes-grid">
      <section class="card hero">
        <div class="hero-cab">
          <div>
            <span class="rotulo">Sobra de ${ano} (receita − despesas)</span>
            <strong class="valor-grande ${cls(sobra)}">${grande(sobra)}</strong>
            <p class="sub">${receita > 0
              ? sobra >= 0 ? `<span class="pos">${Math.round((sobra / receita) * 100)}% da receita</span> ficou com você`
                : `<span class="neg">gastou ${fmtBRL(-sobra)} além da receita</span>`
              : 'sem receita lançada'}
              ${temAnt ? delta(sobra, stAnt.saldoTotal, vsAnt) : ''}</p>
          </div>
          <div class="hero-lado">
            <div><span>Receita do ano</span><strong>${fmtBRL(receita)}</strong>${temAnt ? delta(receita, stAnt.receitaTotal, vsAnt) : ''}</div>
            <div><span>Despesas do ano</span><strong>${fmtBRL(st.gastoTotal)}</strong>${temAnt ? delta(st.gastoTotal, stAnt.gastoTotal, vsAnt, true) : ''}</div>
          </div>
          <div class="ilustra hero-ilustra">${ILUSTRA.carteira}</div>
        </div>
        <div class="barra-empilhada" role="img" aria-label="Divisão da receita do ano">
          ${partes.map((x) => `<span style="width:${(x.valor / base) * 100}%;background:${x.cor}" title="${esc(x.nome)}: ${fmtBRL(x.valor)}"></span>`).join('')}
        </div>
        <ul class="legenda">
          ${partes.map((x) => `<li><span class="dot" style="background:${x.cor}"></span><span>${esc(x.nome)}</span><b>${fmtBRL(x.valor)}${pctReceita(x.valor)}</b></li>`).join('')}
        </ul>
      </section>

      <section class="card">
        ${tituloCard('Médias por mês', 'Contam só os meses lançados.', 'calendario')}
        <dl class="lista">
          <div><dt>Receita</dt><dd>${fmtBRL(st.mediaReceita)}</dd></div>
          <div><dt>Despesas</dt><dd>${fmtBRL(st.mediaDespesas)}</dd></div>
          <div><dt>No débito</dt><dd>${fmtBRL(st.mediaDebito)}</dd></div>
          <div><dt>No crédito</dt><dd>${fmtBRL(st.mediaCredito)}</dd></div>
          <div><dt>Investimento</dt><dd>${fmtBRL(st.mediaInvestimento)}</dd></div>
        </dl>
        <p class="hint">Contam só os meses lançados (${st.mesesComDados}).</p>
      </section>

      <section class="card grafico largo">
        ${tituloCard(`Mês a mês em ${ano}`, 'Receita, despesas e sobra de cada mês.')}
        <div class="canvas-box"><canvas id="g-ano"></canvas></div>
      </section>

      <section class="card">
        ${tituloCard('Cartões e contas no ano', 'Quanto foi gasto em cada um.', 'cartoes')}
        ${st.porCategoria.filter((x) => x.meses).map((x) => `
          <div class="linha-cat">
            <span class="dot" style="background:${corCat(x.cat)}"></span>
            <div class="nome">${esc(x.cat.nome)}<small>${x.cat.tipo === 'debito' ? 'débito' : 'crédito'} · média ${fmtBRL(x.media)}/mês</small></div>
            <div class="val"><strong>${fmtBRL(x.total)}</strong><span class="delta">${st.gastoTotal ? Math.round((x.total / st.gastoTotal) * 100) : 0}% das despesas</span></div>
          </div>`).join('')}
        <div class="linha-total"><span>Crédito ${fmtBRL(st.creditoTotal)} · Débito ${fmtBRL(st.debitoTotal)}</span></div>
      </section>

      <section class="card">
        ${tituloCard('Destaques do ano', 'Os melhores e os piores meses.', 'grafico')}
        <dl class="lista">
          <div><dt>Melhor mês (maior sobra)</dt><dd>${nomeMes(melhor)}<small class="pos">${melhor ? fmtBRL(melhor.saldoMes) : ''}</small></dd></div>
          <div><dt>Pior mês (menor sobra)</dt><dd>${nomeMes(pior)}<small class="${cls(pior?.saldoMes)}">${pior ? fmtBRL(pior.saldoMes) : ''}</small></dd></div>
          <div><dt>Mês com mais despesas</dt><dd>${nomeMes(maisGasto)}<small>${maisGasto ? fmtBRL(maisGasto.totalDesp) : ''}</small></dd></div>
          <div><dt>Mês com mais receita</dt><dd>${nomeMes(maisReceita)}<small>${maisReceita ? fmtBRL(maisReceita.receita) : ''}</small></dd></div>
          <div><dt>Meses com saldo negativo</dt><dd>${st.mesesNegativos}</dd></div>
        </dl>
      </section>

      <section class="card">
        ${tituloCard('Investimentos', 'Total guardado e a meta do ano.', 'cofrinho')}
        <dl class="lista">
          <div><dt>Total investido</dt><dd>${fmtBRL(st.totalInvestido)}</dd></div>
          <div><dt>Meta do ano (${fmtPct(p.pct_investir)} da receita)</dt><dd>${fmtBRL(metaAno)}</dd></div>
        </dl>
        <div class="progresso"><span style="width:${pctMeta}%"></span></div>
        <dl class="lista">
          <div><dt>Rendimento / outras entradas</dt><dd>${fmtBRL(st.totalRendimento)}</dd></div>
          <div><dt>Reserva esperada (${p.meses_reserva}× receita média)</dt><dd>${fmtBRL(st.reservaEsperada)}</dd></div>
        </dl>
      </section>

      <section class="card">
        ${tituloCard('Metas', 'A média do ano comparada às metas.', 'alvo')}
        <dl class="lista">
          <div><dt>Máximo para gastar por mês (${fmtPct(p.pct_max_gasto)})</dt><dd>${fmtBRL(maxGastar)}</dd></div>
          <div><dt>Despesa média por mês</dt><dd class="${st.mediaDespesas > maxGastar ? 'neg' : 'pos'}">${fmtBRL(st.mediaDespesas)}</dd></div>
          <div><dt>Investir por mês (${fmtPct(p.pct_investir)})</dt><dd>${fmtBRL(st.investirEsperado)}</dd></div>
          <div><dt>Investimento médio por mês</dt><dd class="${st.mediaInvestimento >= st.investirEsperado ? 'pos' : 'neg'}">${fmtBRL(st.mediaInvestimento)}</dd></div>
        </dl>
      </section>

      <!-- Saldo financeiro + evolução no mesmo quadro, ocupando duas colunas (o gráfico precisa de largura) -->
      <section class="card grafico span-2">
        ${tituloCard('Saldo financeiro', 'Como o dinheiro guardado evoluiu no ano (saldo no dia 1º de cada mês).', 'cofre')}
        <div class="saldo-evolucao">
          <dl class="lista">
            <div><dt>Saldo no início do ano</dt><dd>${fmtBRL(st.saldoInicio)}</dd></div>
            <div><dt>Último saldo informado</dt><dd>${fmtBRL(st.ultimoSaldo)}</dd></div>
            <div class="destaque"><dt>Resultado acumulado</dt><dd class="${cls(st.resultadoAcumulado)}">${fmtBRL(st.resultadoAcumulado)}</dd></div>
            <div><dt>Média do resultado por mês</dt><dd class="${cls(st.mediaResultado)}">${fmtBRL(st.mediaResultado)}</dd></div>
          </dl>
          <div class="canvas-box pequeno"><canvas id="g-saldo"></canvas></div>
        </div>
      </section>

      ${temAnt ? `
      <section class="card largo">
        ${tituloCard(`Comparado a ${ano - 1}`, 'Este ano contra o anterior.', 'grafico')}
        <div class="comparativo">
          ${[
            ['Receita', st.receitaTotal, stAnt.receitaTotal, false],
            ['Despesas', st.gastoTotal, stAnt.gastoTotal, true],
            ['Sobra', st.saldoTotal, stAnt.saldoTotal, false],
            ['Investido', st.totalInvestido, stAnt.totalInvestido, false],
            ['Despesa média/mês', st.mediaDespesas, stAnt.mediaDespesas, true],
          ].map(([k, a, b, menor]) => `<div><span>${k}</span><strong>${fmtBRL(a)}</strong><small>${ano - 1}: ${fmtBRL(b)}</small>${delta(a, b, '', menor)}</div>`).join('')}
        </div>
      </section>` : ''}
    </div>`;

  bindCabecalhoAno(main, 'resumo');
  grafico(main.querySelector('#g-ano'), linhas);
  graficoSaldo(main.querySelector('#g-saldo'), linhas);
}

function graficoSaldo(canvas, linhas) {
  if (!window.Chart || !canvas) return;
  const text = cssVar('--muted');
  S.charts.push(new Chart(canvas, {
    type: 'line',
    data: {
      labels: linhas.map((r) => MESES_CURTO[r.mes - 1]),
      datasets: [{
        label: 'Saldo inicial', data: linhas.map((r) => r.saldoIni), spanGaps: true, tension: 0.3,
        borderColor: cssVar('--accent'), backgroundColor: cssVar('--accent'), pointRadius: 3,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => fmtBRL(c.parsed.y) } } },
      scales: {
        x: { grid: { display: false }, ticks: { color: text } },
        y: { grid: { color: cssVar('--border') }, ticks: { color: text, callback: (v) => v.toLocaleString('pt-BR') } },
      },
    },
  }));
}

function renderAnoPlanilha(main, ano) {
  const c = cats();
  const map = indexMeses(efetivos());
  const linhas = linhasDoAno(ano, map, c);
  // Mostra categorias ativas + inativas que têm valor neste ano
  const colunas = c.filter((cat) => cat.ativo !== false || linhas.some((l) => l.desp[cat.id] !== null));
  const st = estatisticas(linhas, c, prefs());

  const td = (v, colorir = false, calc = false) =>
    `<td class="${calc ? 'calc ' : ''}${colorir ? cls(v) : ''}">${v === null || v === undefined ? '' : fmtNum(v)}</td>`;
  const tdF = (v, f) => `<td${f ? ` title="=${esc(f.replace(/\./g, ','))}"` : ''}>${v === null || v === undefined ? '' : fmtNum(v)}${f ? '<i class="fx">fx</i>' : ''}</td>`;
  const tot = (k) => linhas.reduce((s, l) => s + (l[k] ?? 0), 0);

  main.innerHTML = `
    ${cabecalhoAno(ano, 'planilha', st)}

    ${st.mesesComDados ? `
    <section class="kpis">
      ${kpi(`Receita ${ano}`, st.receitaTotal)}
      ${kpi(`Gasto ${ano}`, st.gastoTotal)}
      ${kpi('Saldo do ano (receita − despesas)', st.saldoTotal, true)}
      ${kpi('Último saldo informado', st.ultimoSaldo)}
    </section>` : ''}

    <section class="planilha ${st.mesesComDados ? 'info-dir' : ''}">
    <div class="coluna">
    <section class="card">
      <div class="tabela-wrap">
        <table class="tabela ano">
          <thead><tr>
            <th>Mês</th><th>Receita total</th>
            ${colunas.map((cat) => `<th>${esc(cat.nome)}</th>`).join('')}
            <th class="calc">Total despesas</th><th class="calc">Saldo mês</th>
            <th>Investimento</th><th>Rendimento / outras</th><th>Saldo inicial</th>
            <th class="calc">Saldo final</th><th class="calc">Resultado saldo</th>
          </tr></thead>
          <tbody>
            ${linhas.map((l) => {
              const f = l.rec?.formulas || {};
              return `<tr class="clicavel ${l.temDados ? '' : 'vazio'}" data-mes="${l.mes}" tabindex="0">
                <th>${MESES[l.mes - 1]}${l.rec?.observacao ? ` <i class="nota" title="${esc(l.rec.observacao)}">●</i>` : ''}</th>
                ${tdF(l.receita, f.receita)}
                ${colunas.map((cat) => tdF(l.desp[cat.id], f['cat:' + cat.id])).join('')}
                ${td(l.totalDesp, false, true)}${td(l.saldoMes, true, true)}
                ${tdF(l.investimento, f.investimento)}${tdF(l.rendimento, f.rendimento)}${tdF(l.saldoIni, f.saldo_inicial)}
                ${td(l.saldoFin, false, true)}${td(l.resultado, true, true)}
              </tr>`;
            }).join('')}
          </tbody>
          <tfoot><tr>
            <th>Total</th><td>${fmtNum(tot('receita'))}</td>
            ${colunas.map((cat) => `<td>${fmtNum(linhas.reduce((s, l) => s + (l.desp[cat.id] ?? 0), 0))}</td>`).join('')}
            <td class="calc">${fmtNum(st.gastoTotal)}</td><td class="calc ${cls(st.saldoTotal)}">${fmtNum(st.saldoTotal)}</td>
            <td>${fmtNum(st.totalInvestido)}</td><td>${fmtNum(st.totalRendimento)}</td><td></td><td class="calc"></td>
            <td class="calc ${cls(st.resultadoAcumulado)}">${fmtNum(st.resultadoAcumulado)}</td>
          </tr></tfoot>
        </table>
      </div>
    </section>

    ${st.mesesComDados ? `
    <section class="card grafico">
      <h2>Receita × despesas em ${ano}</h2>
      <div class="canvas-box"><canvas id="g-ano"></canvas></div>
    </section>` : ''}
    </div>

    ${st.mesesComDados ? blocoInfo(`Informações gerais ${ano}`, [
      ['', [
        ['Gasto total', st.gastoTotal],
        ['Receita total', st.receitaTotal],
        ['Saldo total', st.saldoTotal, true],
        ['Média de receita por mês', st.mediaReceita],
        ['Média de despesas por mês', st.mediaDespesas],
        ['Média de gasto no crédito', st.mediaCredito],
        ['Média de gasto no débito', st.mediaDebito],
      ]],
      ['Informações crédito', [
        ...st.porCategoria.filter((p) => p.cat.tipo === 'credito' && p.meses).map((p) => [`Média de gasto ${p.cat.nome}`, p.media]),
        ['Total gasto no crédito', st.creditoTotal],
      ]],
      ['Informações investimentos', [
        ['Total investido', st.totalInvestido],
        ['Média de investimento por mês', st.mediaInvestimento],
        ['Total de rendimento', st.totalRendimento],
      ]],
      ['Organização finanças', [
        [`Dinheiro esperado investir (${fmtPct(prefs().pct_investir)})`, st.investirEsperado],
        [`Reserva esperada (${prefs().meses_reserva}× receita)`, st.reservaEsperada],
        [`Dinheiro máximo para gastar (${fmtPct(prefs().pct_max_gasto)})`, st.maximoGastar],
      ]],
      ['Saldo financeiro (invest. + débito)', [
        ['Saldo no início do ano', st.saldoInicio],
        ['Último saldo informado', st.ultimoSaldo],
        ['Resultado acumulado no ano', st.resultadoAcumulado, true],
        ['Média do resultado por mês', st.mediaResultado, true],
        ['Meses com saldo negativo', st.mesesNegativos, false, 'int'],
      ]],
    ]) : ''}
    </section>`;

  bindCabecalhoAno(main, 'planilha');
  main.querySelectorAll('tr[data-mes]').forEach((tr) => {
    const abrir = () => abrirEditor(ano, Number(tr.dataset.mes));
    tr.addEventListener('click', abrir);
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') abrir(); });
  });
  if (st.mesesComDados) grafico(main.querySelector('#g-ano'), linhas);
}

/* ============================================================ editor */
async function garantirCategorias() {
  if (S.data.categorias.length) return;
  const padrao = [
    { nome: 'Débito', tipo: 'debito', ordem: 1, ativo: true },
    { nome: 'Cartão de crédito', tipo: 'credito', ordem: 2, ativo: true },
  ];
  for (const c of padrao) S.data.categorias.push(await S.store.saveCategoria({ ...c, perfil_id: S.perfilId }));
}

async function abrirEditor(ano, mes) {
  try { await garantirCategorias(); } catch (e) { toast(e.message, 'erro'); return; }
  const rec = S.data.meses.find((m) => m.ano === ano && m.mes === mes) || { ano, mes, despesas: {}, formulas: {} };
  const f = rec.formulas || {};
  // Mês "efetivo": inclui as somas dos lançamentos (campos em ef.auto vêm dos lançamentos)
  const ef = efetivos().find((m) => m.ano === ano && m.mes === mes) || { despesas: {}, auto: {} };
  const autoVal = (name) => (ef.auto?.[name] ? (name.startsWith('cat:') ? ef.despesas[name.slice(4)] : ef[name]) : undefined);
  const c = cats().filter((cat) => cat.ativo !== false || (rec.despesas?.[cat.id] ?? null) !== null || ef.auto?.['cat:' + cat.id]);
  const prox = efetivos().find((m) => (mes === 12 ? m.ano === ano + 1 && m.mes === 1 : m.ano === ano && m.mes === mes + 1));

  const campo = (name, label, value, formula, hint = '') => {
    const n = ef.auto?.[name];
    if (n) {
      return `
      <label class="campo auto">
        <span>${esc(label)}</span>
        <input name="${esc(name)}" value="${esc(fmtNum(autoVal(name)))}" disabled>
        <small class="hint">${ICON.lista} Soma de ${n} ${n === 1 ? 'lançamento' : 'lançamentos'}. Para mudar, use a tela
          <a href="#/lancamentos/${ano}/${mes}" data-fechar>Transações</a>.</small>
      </label>`;
    }
    return `
    <label class="campo">
      <span>${esc(label)}</span>
      <input name="${esc(name)}" inputmode="decimal" autocomplete="off" placeholder="0,00" value="${esc(toInputText(value, formula))}">
      <small class="calc-preview"></small>
      ${hint ? `<small class="hint">${hint}</small>` : ''}
    </label>`;
  };

  const dlg = document.createElement('dialog');
  dlg.className = 'editor';
  dlg.innerHTML = `
    <form method="dialog">
      <header>
        <button type="button" class="btn icone" data-nav="-1" aria-label="Mês anterior">‹</button>
        <h2>${MESES[mes - 1]} de ${ano}</h2>
        <button type="button" class="btn icone" data-nav="1" aria-label="Próximo mês">›</button>
      </header>
      <div class="corpo">
        <p class="dica">Pode digitar contas, ex.: <code>=1598,4-38,9</code></p>
        <fieldset><legend>Receita</legend>
          ${campo('receita', 'Receita total do mês', rec.receita, f.receita)}
        </fieldset>
        <fieldset><legend>Despesas</legend>
          ${c.map((cat) => campo('cat:' + cat.id, `${cat.nome} (${cat.tipo === 'debito' ? 'débito' : 'crédito'})`, rec.despesas?.[cat.id], f['cat:' + cat.id])).join('')}
          <a class="link-peq" href="#/ajustes">+ adicionar cartão/categoria</a>
        </fieldset>
        <fieldset><legend>Investimento e saldo</legend>
          ${campo('investimento', 'Investimento feito no mês', rec.investimento, f.investimento)}
          ${campo('rendimento', 'Rendimento / outras entradas', rec.rendimento, f.rendimento, 'Rendimento do investimento ou dinheiro de outra fonte (fora a receita). Pode somar várias: =9,50+120. Anote a origem em Observação.')}
          ${campo('saldo_inicial', 'Saldo inicial (1º dia do mês)', rec.saldo_inicial, f.saldo_inicial, 'Quanto você tinha no total (investimento + débito) no 1º dia do mês. O saldo final deste mês vem do saldo inicial do mês seguinte.')}
        </fieldset>
        <label class="campo"><span>Observação</span><textarea name="observacao" rows="2">${esc(rec.observacao || '')}</textarea></label>
        <div class="resumo-mes"></div>
      </div>
      <footer>
        ${mesTemDados(rec) ? '<button type="button" class="btn perigo" data-acao="limpar">Limpar mês</button>' : '<span></span>'}
        <div class="direita">
          <button type="button" class="btn" data-acao="cancelar">Cancelar</button>
          <button type="submit" class="btn primario">Salvar</button>
        </div>
      </footer>
    </form>`;
  document.body.appendChild(dlg);
  const form = dlg.querySelector('form');
  const fechar = () => { dlg.close(); dlg.remove(); };

  function ler() {
    const out = { perfil_id: S.perfilId, ano, mes, despesas: {}, formulas: {}, observacao: form.observacao.value.trim() || null };
    let erro = null;
    // Campos travados (vindos dos lançamentos) não são salvos no mês
    form.querySelectorAll('input[name]:not([disabled])').forEach((inp) => {
      const prev = inp.parentElement.querySelector('.calc-preview');
      try {
        const { value, formula } = parseExpr(inp.value);
        inp.classList.remove('invalido');
        prev.textContent = formula ? `= ${fmtBRL(value)}` : '';
        if (inp.name.startsWith('cat:')) {
          if (value !== null) out.despesas[inp.name.slice(4)] = value;
        } else out[inp.name] = value;
        if (formula) out.formulas[inp.name] = formula;
      } catch (e) {
        inp.classList.add('invalido');
        prev.textContent = e.message;
        erro = erro || e.message;
      }
    });
    return { out, erro };
  }

  function atualizarResumo() {
    const { out } = ler();
    const vals = Object.values(out.despesas);
    for (const [campo] of Object.entries(ef.auto || {})) if (campo.startsWith('cat:')) vals.push(autoVal(campo));
    const total = vals.length ? vals.reduce((a, b) => a + b, 0) : null;
    const receita = autoVal('receita') ?? out.receita;
    const saldo = total === null ? null : (receita ?? 0) - total;
    const fin = prox?.saldo_inicial ?? null;
    const res = out.saldo_inicial !== null && out.saldo_inicial !== undefined && fin !== null ? fin - out.saldo_inicial : null;
    dlg.querySelector('.resumo-mes').innerHTML = `
      <div><span>Total despesas</span><strong>${fmtBRL(total)}</strong></div>
      <div><span>Saldo do mês</span><strong class="${cls(saldo)}">${fmtBRL(saldo)}</strong></div>
      <div><span>Resultado saldo</span><strong class="${cls(res)}">${res === null ? '—' : fmtBRL(res)}</strong></div>`;
  }

  form.addEventListener('input', atualizarResumo);
  atualizarResumo();

  async function salvar() {
    const { out, erro } = ler();
    if (erro) { toast('Corrija os campos em vermelho.', 'erro'); return false; }
    const btn = form.querySelector('[type="submit"]');
    btn.disabled = true;
    try {
      if (!mesTemDados(out) && !out.observacao) {
        if (mesTemDados(rec) || rec.observacao) await S.store.deleteMes(S.perfilId, ano, mes);
        S.data.meses = S.data.meses.filter((m) => !(m.ano === ano && m.mes === mes));
      } else {
        const salvo = await S.store.saveMes(out);
        const i = S.data.meses.findIndex((m) => m.ano === ano && m.mes === mes);
        if (i >= 0) S.data.meses[i] = salvo; else S.data.meses.push(salvo);
      }
      toast(`${MESES[mes - 1]} de ${ano} salvo.`);
      return true;
    } catch (e) {
      toast('Erro ao salvar: ' + e.message, 'erro');
      return false;
    } finally {
      btn.disabled = false;
    }
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (await salvar()) {
      fechar();
      const r = rota();
      const destino = r.view === 'mes' ? `#/mes/${ano}/${mes}`
        : r.view === 'ano' ? `#/ano/${ano}${r.aba === 'planilha' ? '/planilha' : ''}` : location.hash;
      if (destino !== location.hash) location.hash = destino; else render();
    }
  });
  dlg.querySelector('[data-acao="cancelar"]').addEventListener('click', fechar);
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); fechar(); });
  dlg.querySelectorAll('a.link-peq, a[data-fechar]').forEach((a) => a.addEventListener('click', fechar));
  dlg.querySelectorAll('[data-nav]').forEach((b) => b.addEventListener('click', async () => {
    const d = Number(b.dataset.nav);
    const alvo = new Date(ano, mes - 1 + d, 1);
    fechar();
    abrirEditor(alvo.getFullYear(), alvo.getMonth() + 1);
  }));
  dlg.querySelector('[data-acao="limpar"]')?.addEventListener('click', async () => {
    if (!confirm(`Apagar todos os valores de ${MESES[mes - 1]} de ${ano}?`)) return;
    try {
      await S.store.deleteMes(S.perfilId, ano, mes);
      S.data.meses = S.data.meses.filter((m) => !(m.ano === ano && m.mes === mes));
      toast('Mês apagado.');
      fechar();
      render();
    } catch (e) { toast(e.message, 'erro'); }
  });
  dlg.showModal();
  if (!mesTemDados(rec)) form.querySelector('input[name="receita"]').focus();
}

/* ============================================================== ajuda */
const GLOSSARIO = [
  ['Receita', 'Todo o dinheiro que entrou no mês: salário, pró-labore, faturamento, vendas. Se vier de vários lugares, some com =: =2500+800.'],
  ['Débito / conta', 'Gastos pagos direto da conta: Pix, boleto, débito, transferências. Pode ter mais de uma categoria de débito (ex.: "Débito pessoal", "Funcionários").'],
  ['Crédito (cartões)', 'O valor da fatura de cada cartão no mês. Cada cartão é uma categoria: "Crédito Iogo", "Cartão empresa"...'],
  ['Total de despesas', 'Débito + todos os cartões. Calculado sozinho.'],
  ['Sobra do mês (saldo do mês)', 'Receita − despesas. Verde: sobrou dinheiro. Vermelho: gastou mais do que entrou.'],
  ['Investimento', 'Quanto foi guardado/investido no mês.'],
  ['Rendimento / outras entradas', 'Rendimento dos investimentos ou dinheiro extra que não é receita (reembolso, venda de algo). Anote a origem em Observação.'],
  ['Saldo inicial', 'Quanto havia no total (conta + investimentos) no dia 1º do mês. É o número que mostra se o patrimônio cresceu.'],
  ['Saldo final', 'É o saldo inicial do mês seguinte, puxado sozinho. Por isso ele só aparece depois que o mês seguinte é lançado.'],
  ['Resultado do saldo', 'Saldo final − saldo inicial. Mostra quanto o dinheiro guardado cresceu (verde) ou diminuiu (vermelho) no mês.'],
  ['Médias', 'Contam só os meses lançados. Um mês em branco não puxa a média para baixo.'],
  ['Transferência entre contas', 'Dinheiro passando de uma conta sua para outra (ex.: Santander pessoal → Santander Empresas) ou pagamento da fatura do cartão. Fica registrado, mas não conta como receita nem gasto.'],
  ['Regra automática', 'Se a descrição tem um texto (ex.: "joao silva", "mercadolivre"), o gasto já entra com a categoria certa. Criada ao classificar com "Lembrar" marcado.'],
  ['Organização (15% / 6× / 70%)', 'Metas a partir da receita média: investir 15%, ter reserva de 6 meses de receita e gastar no máximo 70%. Os percentuais mudam em Ajustes.'],
];

function renderAjuda(main) {
  main.innerHTML = `
    ${cabecalhoSimples('Ajuda')}

    <div class="ajuda-grid">
      <section class="card">
        <h2>Rotina de cada mês (5 minutos)</h2>
        <ol class="passos">
          <li><b>No início do mês</b>, abra a tela <b>Mês</b> e vá para o mês que terminou (setas ‹ ›).</li>
          <li>Toque em <b>Lançar</b> (ou <b>Editar mês</b>) e preencha a <b>receita</b> do mês.</li>
          <li>Preencha os gastos: o total do <b>débito</b> e a <b>fatura de cada cartão</b>.</li>
          <li>Preencha o <b>investimento</b> e o <b>rendimento / outras entradas</b>, se houver.</li>
          <li>Lance também o mês novo só com o <b>saldo inicial</b> (quanto há na conta + investimentos no dia 1º). Isso fecha o saldo final do mês anterior.</li>
          <li>Pronto: confira a <b>sobra</b> e os alertas na tela Mês.</li>
        </ol>
        <p class="hint">Dá para digitar contas nos campos: <code>=1598,40-38,90</code> ou <code>=120+80,50</code>. O site guarda a conta e mostra o resultado.</p>
      </section>

      <section class="card">
        <h2>Para que serve cada tela</h2>
        <dl class="lista telas">
          <div><dt>${ICON.mes} Mês</dt><dd>O resumo de um mês: quanto sobrou, para onde foi o dinheiro, cada cartão e a comparação com o mês anterior. É a tela do dia a dia.</dd></div>
          ${ehControle() ? `<div><dt>${ICON.lista} Transações</dt><dd>Abas Despesas, Receitas, Transferências (de uma conta para outra) e Extrato (tudo do mês, dia a dia). Também é onde se importa o extrato do banco.</dd></div>
          <div><dt>${ICON.calendario} Calendário</dt><dd>O mês em forma de calendário: receitas em verde, despesas na conta em vermelho, compras no cartão em azul, transferências em amarelo e os dias de fechamento/vencimento da fatura. Toque num dia para ver o que aconteceu.</dd></div>
          <div><dt>${ICON.classificar} Classificar</dt><dd>Os gastos sem categoria, agrupados por descrição. Um clique na categoria classifica o grupo e cria a regra para os próximos meses.</dd></div>
          <div><dt>${ICON.grafico} Gráficos</dt><dd>Receitas e despesas mês a mês, pessoal × empresa, saldo das contas e, em <b>Por categoria</b>, quanto foi para cada categoria de gasto (Funcionários, Assinaturas…) e de onde veio cada receita (Vendas, Salário…). Toque numa categoria para ver as subcategorias e cada transação. <b>Classificar</b> é só onde se dá a categoria às transações novas.</dd></div>
          <div><dt>${ICON.cartao} Cartões</dt><dd>A fatura que vence no mês (pelas datas de fechamento e vencimento de cada cartão), se já foi paga e quanto do limite ainda está livre.</dd></div>` : ''}
          <div><dt>${ICON.ano} Ano · Resumo</dt><dd>O ano inteiro: total que entrou e saiu, divisão por cartão/categoria, melhores e piores meses, investimentos e evolução do saldo.</dd></div>
          <div><dt>${ICON.ano} Ano · Planilha</dt><dd>Igual à aba do ano no Excel: um mês por linha e as informações gerais ao lado. Toque num mês para editar.</dd></div>
          <div><dt>${ICON.geral} Todos os anos</dt><dd>Soma de todos os anos, com filtro por período e por cartão/categoria.</dd></div>
          <div><dt>${ICON.ajustes} Ajustes</dt><dd>Cartões e categorias, metas (15%/6×/70%), importar a planilha do Excel e backup.</dd></div>
        </dl>
      </section>

      ${ehControle() ? `<section class="card largo destaque-acao">
        <h2>Rotina com extratos (todo dia 1º)</h2>
        <ol class="passos">
          <li>No app/site de cada banco, baixe o extrato do mês que terminou em <b>OFX</b> (ou CSV): conta da empresa, cartão da empresa, conta pessoal, cartão pessoal…</li>
          <li>Em <b>Transações → Importar extrato</b>, importe <b>um arquivo por vez</b>, escolhendo de qual conta/cartão ele é.
            O site já marca como <b>Transferência</b> (não conta) o pagamento da fatura, o dinheiro entre as suas contas e os nomes cadastrados em Ajustes.</li>
          <li><b>Cartão de crédito:</b> se o extrato da conta trouxer só o pagamento da fatura, importe também o extrato/fatura do cartão
            (as compras de verdade). Se não tiver, a Conferência oferece contar o pagamento como um gasto "Fatura do cartão".</li>
          <li>Abra <b>Classificar</b>. Primeiro, a <b>Conferência</b> mostra o que parece errado (transferência contada como receita,
            fatura contada duas vezes, repetidos) — corrija com um clique. Depois, os gastos parecidos vêm juntos (ex.: todos os Pix para o mesmo funcionário):
            clique na categoria e deixe "Lembrar" marcado para os próximos meses virem classificados sozinhos.</li>
          <li>Se um gasto da empresa saiu da conta pessoal (ou o contrário), troque o lado para <b>Empresa</b>/<b>Pessoal</b> antes de clicar.</li>
          <li>Veja o resultado em <b>Gráficos → Por categoria</b> (quanto foi para cada coisa) e na <b>Visão do mês</b>.</li>
        </ol>
        <p class="hint">No primeiro mês dá mais trabalho (criar as regras). Do segundo em diante, a maior parte já chega classificada.</p>
      </section>

      <section class="card">
        <h2>Lançamentos e extratos (sem repetir nada)</h2>
        <p class="sub">Há duas formas de lançar — use a que for mais prática:</p>
        <ol class="passos">
          <li><b>Só o total do mês</b>, na tela Mês (como na planilha).</li>
          <li><b>Gasto por gasto</b>, na tela Transações: à mão (ex.: toda semana) ou <b>importando o extrato</b> do banco/cartão (arquivo OFX ou CSV).</li>
        </ol>
        <p class="sub">Como o site evita contar duas vezes:</p>
        <ul class="passos">
          <li>Quando um campo do mês tem lançamentos, o valor do mês é <b>a soma deles</b> e o campo fica travado na tela Mês.</li>
          <li>Ao importar, cada movimentação do banco tem uma identidade. <b>Importar o mesmo extrato de novo, ou um que repete dias, pula o que já entrou.</b></li>
          <li>Ao lançar à mão algo com mesma data, valor e descrição de um lançamento existente, o site <b>avisa antes de salvar</b>.</li>
          <li>Na importação, o que parece repetido de um lançamento manual vem <b>desmarcado</b> para você conferir.</li>
          <li>Pagamento da fatura do cartão e dinheiro entre as suas contas entram como <b>Transferência</b> (não contam como gasto nem receita).</li>
        </ul>
      </section>` : ''}

      <section class="card">
        <h2>Configurar uma conta nova</h2>
        <ol class="passos">
          <li>A pessoa cria a conta em <b>Criar conta</b> e confirma pelo e-mail. A conta precisa estar <b>liberada</b> (convite pelo e-mail).</li>
          <li>Em <b>Ajustes → Cartões e categorias</b>, cadastre o que a pessoa usa. Exemplos:
            <ul>
              <li><b>Crédito:</b> um item para cada cartão ("Cartão pessoal", "Cartão empresa").</li>
              <li><b>Débito:</b> "Débito pessoal" e, para empresa, "Funcionários", "Fornecedores", "Impostos"...</li>
            </ul>
            Pessoal e empresa ficam juntos; use nomes que deixem claro de onde é cada gasto.</li>
          <li>Ajuste as <b>metas</b> (15% investir, 6× reserva, 70% máximo de gasto) se precisar.</li>
          <li>Se a pessoa já tem a planilha do Excel, use <b>Importar planilha</b>. Senão, lance os meses pela tela <b>Mês</b>.</li>
        </ol>
      </section>

      <section class="card">
        <h2>Dicas</h2>
        <ul class="passos">
          <li><b>Celular e iPad:</b> abra o site no navegador → Compartilhar → <b>Adicionar à Tela de Início</b>. Fica como um app.</li>
          <li><b>Mês em branco</b> não entra nas médias. Lance só o que já fechou.</li>
          <li><b>Cartão que deixou de usar:</b> em Ajustes use <b>Arquivar</b>. O histórico continua contando.</li>
          <li><b>Backup:</b> em Ajustes → Baixar backup, de vez em quando.</li>
          <li>Os dados ficam salvos na nuvem: o que você lança no computador aparece no celular.</li>
        </ul>
      </section>

      <section class="card largo">
        <h2>O que significa cada número</h2>
        <dl class="glossario">
          ${GLOSSARIO.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}
        </dl>
      </section>
    </div>`;
}

/* ============================================================ ajustes */
function renderAjustes(main) {
  const c = cats();
  const usada = (id) => S.data.lancamentos.some((l) => l.categoria_id === id) || S.data.meses.some((m) => m.despesas && m.despesas[id] !== undefined && m.despesas[id] !== null);
  const p = prefs();
  main.innerHTML = `
    ${cabecalhoSimples('Ajustes', '<a class="btn" href="#/ajuda">Ajuda</a>')}

    ${escolhaModo('Modo de uso')}

    <section class="card">
      <h2>Contas e cartões</h2>
      <p class="sub"><b>De onde sai o dinheiro.</b> Um item para cada conta ou cartão (ex.: "Conta empresa", "Cartão empresa", "Conta pessoal", "Cartão Nubank").
        <b>Crédito</b> para cartões, <b>Débito</b> para o que sai direto da conta (Pix, boleto, débito). Também viram as colunas da planilha do ano.</p>
      <div class="lista-cat">
        ${c.map((cat, i) => `
          <div class="cat ${cat.ativo === false ? 'inativa' : ''}" data-id="${cat.id}">
            <input name="nome" value="${esc(cat.nome)}" aria-label="Nome">
            <select name="tipo" aria-label="Tipo">
              <option value="debito" ${cat.tipo === 'debito' ? 'selected' : ''}>Débito</option>
              <option value="credito" ${cat.tipo === 'credito' ? 'selected' : ''}>Crédito</option>
            </select>
            <div class="cat-acoes">
              <button class="btn icone" data-a="up" ${i === 0 ? 'disabled' : ''} aria-label="Subir">↑</button>
              <button class="btn icone" data-a="down" ${i === c.length - 1 ? 'disabled' : ''} aria-label="Descer">↓</button>
              ${usada(cat.id)
                ? `<button class="btn" data-a="ativo">${cat.ativo === false ? 'Reativar' : 'Arquivar'}</button>`
                : '<button class="btn perigo" data-a="del">Excluir</button>'}
            </div>
            <details class="aparencia">
              <summary>Aparência do cartão</summary>
              <div class="aparencia-grid">
                <div class="aparencia-campos">
                  <label class="campo"><span>Banco / nome no cartão</span><input name="banco" maxlength="40" placeholder="Ex.: Mercado Pago, Santander" value="${esc(cat.banco || '')}"></label>
                  <label class="campo"><span>Titular</span><input name="titular" maxlength="40" placeholder="Ex.: Iogo, Ivoney" value="${esc(cat.titular || '')}"></label>
                  <div class="campo"><span>Modelo do cartão</span>
                    <div class="cores modelos">${Object.entries(ESTILOS).filter(([, e]) => e.modelo).map(([k, e]) => `<button type="button" class="cor-op modelo ${estiloDe(cat) === k ? 'ativo' : ''}" data-estilo="${k}"
                      style="--cv-bg:${e.bg}" title="${e.nome}" aria-label="${e.nome}" aria-pressed="${estiloDe(cat) === k}"></button>`).join('')}</div>
                  </div>
                  <div class="campo"><span>Ou só uma cor</span>
                    <div class="cores">${Object.entries(ESTILOS).filter(([, e]) => !e.modelo).map(([k, e]) => `<button type="button" class="cor-op ${estiloDe(cat) === k ? 'ativo' : ''}" data-estilo="${k}"
                      style="--cv-bg:${e.bg}" title="${e.nome}" aria-label="${e.nome}" aria-pressed="${estiloDe(cat) === k}"></button>`).join('')}</div>
                  </div>
                </div>
                ${cartaoVisual(cat, { valor: 1234.56, rotulo: 'Exemplo', classe: 'previa' })}
              </div>
            </details>
          </div>`).join('') || '<p class="sub">Nenhuma conta ou cartão ainda.</p>'}
      </div>
      <form class="nova-cat">
        <input name="nome" placeholder="Nova conta ou cartão (ex.: Cartão empresa)" required>
        <select name="tipo"><option value="credito">Crédito</option><option value="debito">Débito</option></select>
        <button class="btn primario">Adicionar</button>
      </form>
    </section>

    ${ehControle() ? `<section class="card" id="classes">
      <h2>Categorias</h2>
      <p class="sub"><b>Gastos</b>: com o que o dinheiro foi gasto (Funcionários, Assinaturas…). <b>Receitas</b>: de onde ele veio (Vendas, Salário…).
        Valem para qualquer conta. O <b>lado padrão</b> decide sozinho se é pessoal ou da empresa ao classificar ("Depende" mantém o do lançamento).
        Para criar uma <b>subcategoria</b> (ex.: Mercado › Hortifruti), escolha a categoria principal em "Dentro de".</p>
      ${['despesa', 'receita'].map((tipo) => {
        const arvore = arvoreClasses(tipo, { todas: true });
        const raizes = arvore.filter((c) => !c.nivel);
        const opcoesPai = (cl) => `<option value="">— principal —</option>${raizes.filter((r) => r.id !== cl?.id).map((r) => `<option value="${r.id}" ${cl?.pai_id === r.id ? 'selected' : ''}>${esc(r.nome)}</option>`).join('')}`;
        return `<h3 class="sub-secao">${tipo === 'receita' ? 'Categorias de receita' : 'Categorias de gasto'}</h3>
        ${!arvore.length ? `<div class="acoes"><button class="btn primario" data-a="sugeridas" data-tipo="${tipo}">Criar ${tipo === 'receita' ? 'categorias de receita' : 'categorias de gasto'} sugeridas</button></div>` : ''}
        <div class="lista-cat">
          ${arvore.map((cl) => {
            const usos = S.data.lancamentos.filter((l) => l.classe_id === cl.id).length;
            const temFilhas = S.data.classes.some((x) => x.pai_id === cl.id);
            return `
            <div class="cat classe ${cl.nivel ? 'subclasse' : ''} ${cl.ativo === false ? 'inativa' : ''}" data-classe-id="${cl.id}">
              <input type="color" name="cor" value="${esc(cl.cor)}" aria-label="Cor">
              <input name="nome" value="${esc(cl.nome)}" aria-label="Nome">
              <select name="pai_id" aria-label="Dentro de" title="Dentro de" ${temFilhas ? 'disabled' : ''}>${opcoesPai(cl)}</select>
              <select name="escopo_padrao" aria-label="Lado padrão">
                <option value="" ${!cl.escopo_padrao ? 'selected' : ''}>Depende</option>
                <option value="pessoal" ${cl.escopo_padrao === 'pessoal' ? 'selected' : ''}>Pessoal</option>
                <option value="empresa" ${cl.escopo_padrao === 'empresa' ? 'selected' : ''}>Empresa</option>
              </select>
              <div class="cat-acoes">
                <span class="sub">${usos} ${usos === 1 ? 'uso' : 'usos'}</span>
                ${usos ? `<button class="btn" data-a="arquivar">${cl.ativo === false ? 'Reativar' : 'Arquivar'}</button>` : '<button class="btn perigo" data-a="excluir">Excluir</button>'}
              </div>
            </div>`;
          }).join('')}
        </div>
        <form class="nova-classe" data-tipo="${tipo}">
          <input type="color" name="cor" value="${tipo === 'receita' ? '#10b981' : '#0d9488'}" aria-label="Cor">
          <input name="nome" placeholder="${tipo === 'receita' ? 'Nova categoria de receita (ex.: Comissões)' : 'Nova categoria (ex.: Contador, Frete)'}" required>
          <select name="pai_id" aria-label="Dentro de">${opcoesPai(null)}</select>
          <select name="escopo_padrao" aria-label="Lado padrão"><option value="">Depende</option><option value="pessoal">Pessoal</option><option value="empresa">Empresa</option></select>
          <button class="btn primario">Adicionar</button>
        </form>`;
      }).join('')}
    </section>

    <section class="card" id="regras">
      <h2>Regras automáticas</h2>
      <p class="sub">Quando a descrição de um gasto contém o texto, ele já entra com essa categoria (e lado). As regras são criadas na tela
        <a href="#/classificar">Classificar</a>; aqui dá para ajustar o texto (ex.: deixar só "joao silva") ou apagar.</p>
      ${!S.data.regras.length ? '<p class="sub"><i>Nenhuma regra ainda.</i></p>' : `
      <div class="lista-regras">
        ${[...S.data.regras].sort((a, b) => (classePorId(a.classe_id)?.nome || '').localeCompare(classePorId(b.classe_id)?.nome || '') || a.texto.localeCompare(b.texto)).map((r) => `
          <div class="regra" data-regra-id="${r.id}">
            <span class="sub">contém</span>
            <input name="texto" value="${esc(r.texto)}" aria-label="Texto">
            <span class="sub">→</span>
            <select name="classe_id" aria-label="Categoria">${Object.entries(TIPOS_CLASSE).map(([t, nomeT]) => `<optgroup label="${nomeT}">${arvoreClasses(t, { todas: true }).map((cl) => `<option value="${cl.id}" ${cl.id === r.classe_id ? 'selected' : ''}>${cl.nivel ? '↳ ' : ''}${esc(cl.nome)}</option>`).join('')}</optgroup>`).join('')}</select>
            <select name="escopo" aria-label="Lado">
              <option value="" ${!r.escopo ? 'selected' : ''}>Lado da categoria</option>
              <option value="pessoal" ${r.escopo === 'pessoal' ? 'selected' : ''}>Pessoal</option>
              <option value="empresa" ${r.escopo === 'empresa' ? 'selected' : ''}>Empresa</option>
            </select>
            <button class="btn icone perigo" data-a="apagar-regra" aria-label="Apagar regra">×</button>
          </div>`).join('')}
      </div>`}
    </section>

    <section class="card" id="minhas-contas">
      <h2>Transferências entre as suas contas</h2>
      <p class="sub">Escreva <b>um por linha</b> os nomes que aparecem no extrato quando o dinheiro vai de uma conta sua para outra:
        o nome do titular, o nome da empresa, o CNPJ… Ex.: "IVONEY MARQUES", "MARQUES COMERCIO LTDA".
        Pix/TED com esses nomes entram como <b>transferência</b> (não contam como receita nem gasto).
        O site também reconhece sozinho pagamento de fatura e o mesmo valor saindo de uma conta e entrando em outra.</p>
      <form class="meus-nomes">
        <textarea name="nomes" rows="3" placeholder="IVONEY MARQUES&#10;MARQUES COMERCIO LTDA">${esc((p.meus_nomes || []).join('\n'))}</textarea>
        <div class="acoes"><button class="btn primario">Salvar nomes</button></div>
      </form>
    </section>

    ` : ''}

    <section class="card">
      <h2>Metas</h2>
      <p class="sub">Calculadas sobre a receita: quanto investir, quantos meses de reserva ter e o máximo para gastar. Aparecem nas telas Mês e Ano.</p>
      <form class="prefs">
        <label class="campo"><span>% esperado para investir</span><input name="pct_investir" inputmode="decimal" value="${fmtNum(p.pct_investir * 100)}"></label>
        <label class="campo"><span>Reserva esperada (meses de receita)</span><input name="meses_reserva" inputmode="decimal" value="${fmtNum(p.meses_reserva)}"></label>
        <label class="campo"><span>% máximo para gastar</span><input name="pct_max_gasto" inputmode="decimal" value="${fmtNum(p.pct_max_gasto * 100)}"></label>
        <button class="btn primario">Salvar</button>
      </form>
    </section>

    <section class="card">
      <h2>Importar planilha do Excel</h2>
      <p class="sub">Selecione o arquivo <b>FINANÇAS GERAIS.xlsx</b>. As abas de ano (2026, 2027…) são lidas aqui no navegador; meses que já existirem no site serão substituídos.</p>
      <label class="btn arquivo">Escolher planilha…<input type="file" accept=".xlsx,.xls" data-a="xlsx" hidden></label>
      <div class="import-preview"></div>
    </section>

    <section class="card">
      <h2>Aparência</h2>
      <p class="sub">Claro, escuro ou automático (segue o celular/computador). Vale só para este aparelho.</p>
      <div class="acoes">${seletorTema()}</div>
    </section>

    <section class="card">
      <h2>Backup</h2>
      <p class="sub">Baixe uma cópia de todos os dados (JSON) ou restaure um backup.</p>
      <div class="acoes">
        <button class="btn" data-a="exportar">Baixar backup</button>
        <label class="btn arquivo">Restaurar backup…<input type="file" accept=".json" data-a="restaurar" hidden></label>
      </div>
    </section>

    ${S.store.mode === 'supabase' ? '<section class="card"><h2>Conta</h2><button class="btn perigo" data-a="sair">Sair</button></section>' : ''}`;

  // --- contas e cartões
  main.querySelectorAll('.cat[data-id]').forEach((row) => {
    const cat = S.data.categorias.find((x) => x.id === row.dataset.id);
    const salvarCat = async (mud) => {
      try {
        const salvo = await S.store.saveCategoria({ ...cat, ...mud });
        Object.assign(cat, salvo);
      } catch (e) { toast(e.message, 'erro'); }
    };
    row.querySelector('[name="nome"]').addEventListener('change', async (e) => {
      const nome = e.target.value.trim();
      if (!nome) { e.target.value = cat.nome; return; }
      await salvarCat({ nome });
      toast('Nome atualizado.');
    });
    row.querySelector('[name="tipo"]').addEventListener('change', async (e) => { await salvarCat({ tipo: e.target.value }); toast('Tipo atualizado.'); });
    // Aparência do cartão (banco, titular, cor) — atualiza só a prévia, sem redesenhar a tela
    const atualizarPrevia = () => {
      const prev = row.querySelector('.previa');
      if (prev) prev.outerHTML = cartaoVisual(cat, { valor: 1234.56, rotulo: 'Exemplo', classe: 'previa' });
    };
    for (const campo of ['banco', 'titular']) {
      row.querySelector(`[name="${campo}"]`).addEventListener('change', async (e) => {
        await salvarCat({ [campo]: e.target.value.trim() || null });
        atualizarPrevia();
        toast('Cartão atualizado.');
      });
    }
    row.querySelectorAll('[data-estilo]').forEach((b) => b.addEventListener('click', async () => {
      await salvarCat({ estilo: b.dataset.estilo });
      row.querySelectorAll('[data-estilo]').forEach((x) => { x.classList.toggle('ativo', x === b); x.setAttribute('aria-pressed', String(x === b)); });
      atualizarPrevia();
    }));
    row.querySelectorAll('[data-a]').forEach((b) => b.addEventListener('click', async () => {
      const a = b.dataset.a;
      if (a === 'up' || a === 'down') {
        const lista = cats();
        const i = lista.findIndex((x) => x.id === cat.id);
        const j = a === 'up' ? i - 1 : i + 1;
        [lista[i], lista[j]] = [lista[j], lista[i]];
        for (let k = 0; k < lista.length; k++) {
          if (lista[k].ordem !== k + 1) {
            const s = await S.store.saveCategoria({ ...lista[k], ordem: k + 1 });
            Object.assign(S.data.categorias.find((x) => x.id === lista[k].id), s);
          }
        }
      } else if (a === 'ativo') {
        await salvarCat({ ativo: cat.ativo === false });
      } else if (a === 'del') {
        if (!confirm(`Excluir "${cat.nome}"?`)) return;
        try {
          await S.store.deleteCategoria(cat.id);
          S.data.categorias = S.data.categorias.filter((x) => x.id !== cat.id);
        } catch (e) { toast(e.message, 'erro'); }
      }
      render();
    }));
  });
  main.querySelector('.nova-cat').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      const nova = await S.store.saveCategoria({ perfil_id: S.perfilId, nome: f.nome.value.trim(), tipo: f.tipo.value, ordem: S.data.categorias.length + 1, ativo: true });
      S.data.categorias.push(nova);
      toast('Conta/cartão adicionado.');
      render();
    } catch (ex) { toast(ex.message, 'erro'); }
  });

  // --- categorias de gasto
  bindSemClasses(main);
  main.querySelectorAll('[data-classe-id]').forEach((row) => {
    const cl = S.data.classes.find((x) => x.id === row.dataset.classeId);
    const salvar = async (mud, msg) => {
      try { Object.assign(cl, await S.store.saveClasse({ ...cl, ...mud })); if (msg) toast(msg); } catch (e) { toast(e.message, 'erro'); }
    };
    row.querySelector('[name="nome"]').addEventListener('change', (e) => {
      const nome = e.target.value.trim();
      if (!nome) { e.target.value = cl.nome; return; }
      salvar({ nome }, 'Nome atualizado.');
    });
    row.querySelector('[name="cor"]').addEventListener('change', (e) => salvar({ cor: e.target.value }, 'Cor atualizada.'));
    row.querySelector('[name="escopo_padrao"]').addEventListener('change', (e) => salvar({ escopo_padrao: e.target.value || null }, 'Lado padrão atualizado.'));
    row.querySelector('[name="pai_id"]').addEventListener('change', async (e) => { await salvar({ pai_id: e.target.value || null }, e.target.value ? 'Agora é subcategoria.' : 'Agora é categoria principal.'); render(); });
    row.querySelector('[data-a="arquivar"]')?.addEventListener('click', async () => { await salvar({ ativo: cl.ativo === false }); render(); });
    row.querySelector('[data-a="excluir"]')?.addEventListener('click', async () => {
      if (!confirm(`Excluir a categoria "${cl.nome}"? As regras dela também serão apagadas.`)) return;
      try {
        await S.store.deleteClasse(cl.id);
        S.data.classes = S.data.classes.filter((x) => x.id !== cl.id);
        S.data.classes.forEach((x) => { if (x.pai_id === cl.id) x.pai_id = null; }); // subcategorias viram principais
        S.data.regras = S.data.regras.filter((r) => r.classe_id !== cl.id);
        render();
      } catch (e) { toast(e.message, 'erro'); }
    });
  });
  main.querySelectorAll('.nova-classe').forEach((form) => form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      S.data.classes.push(await S.store.saveClasse({
        perfil_id: S.perfilId, nome: f.nome.value.trim(), cor: f.cor.value, escopo_padrao: f.escopo_padrao.value || null,
        tipo: f.dataset.tipo, pai_id: f.pai_id.value || null,
        ordem: S.data.classes.length + 1, ativo: true,
      }));
      toast('Categoria adicionada.');
      render();
    } catch (ex) { toast(ex.message, 'erro'); }
  }));

  // --- regras
  main.querySelectorAll('[data-regra-id]').forEach((row) => {
    const r = S.data.regras.find((x) => x.id === row.dataset.regraId);
    const atualizar = async () => {
      const texto = normDesc(row.querySelector('[name="texto"]').value).trim();
      if (texto.length < 2) { toast('O texto precisa ter pelo menos 2 letras.', 'erro'); return; }
      try {
        // Mudar o texto cria uma regra nova e apaga a antiga
        const nova = await S.store.saveRegra({ perfil_id: S.perfilId, texto, classe_id: row.querySelector('[name="classe_id"]').value, escopo: row.querySelector('[name="escopo"]').value || null });
        if (nova.id !== r.id) { await S.store.deleteRegra(r.id); S.data.regras = S.data.regras.filter((x) => x.id !== r.id); }
        const i = S.data.regras.findIndex((x) => x.id === nova.id);
        if (i >= 0) S.data.regras[i] = nova; else S.data.regras.push(nova);
        toast('Regra atualizada.');
        render();
      } catch (e) { toast(e.message, 'erro'); }
    };
    row.querySelectorAll('input, select').forEach((x) => x.addEventListener('change', atualizar));
    row.querySelector('[data-a="apagar-regra"]').addEventListener('click', async () => {
      try {
        await S.store.deleteRegra(r.id);
        S.data.regras = S.data.regras.filter((x) => x.id !== r.id);
        toast('Regra apagada.');
        render();
      } catch (e) { toast(e.message, 'erro'); }
    });
  });

  // --- preferências
  main.querySelector('.prefs').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      const v = (n) => parseExpr(f[n].value).value;
      const novo = { pct_investir: v('pct_investir') / 100, meses_reserva: v('meses_reserva'), pct_max_gasto: v('pct_max_gasto') / 100 };
      if (Object.values(novo).some((x) => x === null || Number.isNaN(x))) throw new Error('Preencha os três campos.');
      S.data.prefs[S.perfilId] = await S.store.savePrefs(S.perfilId, { ...prefs(), ...novo });
      toast('Preferências salvas.');
    } catch (ex) { toast(ex.message, 'erro'); }
  });
  main.querySelector('.meus-nomes')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const nomes = [...new Set(e.target.nomes.value.split('\n').map((x) => x.trim()).filter((x) => x.length >= 4))].slice(0, 30);
    try {
      S.data.prefs[S.perfilId] = await S.store.savePrefs(S.perfilId, { ...prefs(), meus_nomes: nomes });
      toast(`${nomes.length} ${nomes.length === 1 ? 'nome salvo' : 'nomes salvos'}.`);
    } catch (ex) { toast(ex.message, 'erro'); }
  });

  // --- importar planilha
  main.querySelector('[data-a="xlsx"]').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const box = main.querySelector('.import-preview');
    box.innerHTML = '<p class="sub">Lendo planilha…</p>';
    try {
      const lido = await lerPlanilha(file);
      if (!lido.meses.length) { box.innerHTML = '<p class="sub">Nenhum mês com dados encontrado nas abas de ano.</p>'; return; }
      const anos = [...new Set(lido.meses.map((m) => m.ano))];
      const existentes = lido.meses.filter((m) => S.data.meses.some((x) => x.ano === m.ano && x.mes === m.mes)).length;
      box.innerHTML = `
        <div class="import-ok">
          <p><b>${lido.meses.length} meses</b> encontrados (${anos.join(', ')}) · categorias: ${lido.categorias.map((x) => esc(x.nome)).join(', ')}</p>
          ${existentes ? `<p class="aviso-inline">${existentes} desses meses já existem no site e serão substituídos.</p>` : ''}
          <button class="btn primario" data-a="confirmar">Importar</button>
        </div>`;
      box.querySelector('[data-a="confirmar"]').addEventListener('click', async (ev) => {
        ev.target.disabled = true;
        try {
          await importar(lido);
          toast(`${lido.meses.length} meses importados.`);
          location.hash = '#/geral';
          render();
        } catch (ex) {
          toast('Erro ao importar: ' + ex.message, 'erro');
          ev.target.disabled = false;
        }
      });
    } catch (ex) {
      box.innerHTML = `<p class="erro-msg">${esc(ex.message)}</p>`;
    }
    e.target.value = '';
  });

  // --- backup
  main.querySelector('[data-a="exportar"]').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({ versao: 2, exportado_em: new Date().toISOString(), ...S.data }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `financas-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
  main.querySelector('[data-a="restaurar"]').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!Array.isArray(data.meses) || !Array.isArray(data.categorias)) throw new Error('Arquivo de backup inválido.');
      if (!confirm(`Substituir TODOS os dados atuais pelo backup (${data.meses.length} meses)?`)) return;
      await S.store.replaceAll(data);
      await carregar();
      toast('Backup restaurado.');
      render();
    } catch (ex) { toast(ex.message, 'erro'); }
    e.target.value = '';
  });

  main.querySelector('[data-a="sair"]')?.addEventListener('click', async () => {
    await S.store.signOut();
    S.user = null;
    S.data = dadosVazios();
    S.perfilId = null;
    render();
  });
}

async function importar(lido) {
  // Reaproveita categorias com o mesmo nome; cria as que faltam.
  const porNome = new Map(S.data.categorias.map((c) => [c.nome.toLowerCase(), c]));
  let ordem = S.data.categorias.length;
  for (const nc of lido.categorias) {
    if (porNome.has(nc.nome.toLowerCase())) continue;
    const salvo = await S.store.saveCategoria({ ...nc, perfil_id: S.perfilId, ordem: ++ordem, ativo: true });
    S.data.categorias.push(salvo);
    porNome.set(salvo.nome.toLowerCase(), salvo);
  }
  for (const m of lido.meses) {
    const rec = {
      perfil_id: S.perfilId, ano: m.ano, mes: m.mes,
      receita: m.receita ?? null, investimento: m.investimento ?? null, rendimento: m.rendimento ?? null, saldo_inicial: m.saldo_inicial ?? null,
      despesas: {}, formulas: { ...m.formulas }, observacao: null,
    };
    for (const [nome, { value, formula }] of Object.entries(m.despesasPorNome)) {
      const cat = porNome.get(nome.toLowerCase());
      rec.despesas[cat.id] = round2(value);
      if (formula) rec.formulas['cat:' + cat.id] = formula;
    }
    const antigo = S.data.meses.find((x) => x.ano === m.ano && x.mes === m.mes);
    if (antigo?.observacao) rec.observacao = antigo.observacao;
    const salvo = await S.store.saveMes(rec);
    const i = S.data.meses.findIndex((x) => x.ano === m.ano && x.mes === m.mes);
    if (i >= 0) S.data.meses[i] = salvo; else S.data.meses.push(salvo);
  }
}

/* ============================================================== ícones */
const svg = (d) => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICON = {
  menu: svg('<path d="M4 6h16M4 12h16M4 18h16"/>'),
  mes: svg('<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/><path d="M8.5 14.5l2.2 2.2 4.8-4.8"/>'),
  geral: svg('<path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 5-6"/>'),
  grafico: svg('<path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 5-6"/>'),
  ano: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18"/>'),
  ajustes: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  mais: svg('<path d="M12 5v14M5 12h14"/>'),
  banco: svg('<path d="M3 10h18L12 4 3 10z"/><path d="M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20h18"/>'),
  cartao: svg('<rect x="2" y="5" width="20" height="14" rx="2.5"/><path d="M2 10h20M6 15h4"/>'),
  editar: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>'),
  classificar: svg('<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.5"/>'),
  categorias: svg('<path d="M21.2 15.9A10 10 0 1 1 8 2.8"/><path d="M22 12A10 10 0 0 0 12 2v10z"/>'),
  calendario: svg('<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/><circle cx="8" cy="14" r="1"/><circle cx="12" cy="14" r="1"/><circle cx="16" cy="14" r="1"/>'),
  lista: svg('<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r="1"/><circle cx="3.5" cy="12" r="1"/><circle cx="3.5" cy="18" r="1"/>'),
  upload: svg('<path d="M12 15V3M7 8l5-5 5 5"/><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>'),
  ajuda: svg('<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6"/><path d="M12 17h.01"/>'),
};

boot();
