import { createStore, PREFS_PADRAO } from './store.js?v=20261117003319';
import { MESES, MESES_CURTO, indexMeses, linhaMes, linhasDoAno, estatisticas, anosComDados, mesTemDados, aplicarLancamentos } from './calc.js?v=20261117003319';
import { fmtBRL, fmtNum, fmtPct, esc, parseExpr, toInputText, round2 } from './util.js?v=20261117003319';
import { lerPlanilha } from './importer.js?v=20261117003319';
import { lerExtrato, normDesc } from './extrato.js?v=20261117003319';
import { CLASSES_SUGERIDAS, textoBase, regraPara, sugerir, regraPadrao, detectarTransferencia, palavrasChave, mesmaLoja } from './classes.js?v=20261117003319';

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

/* tema: '' = automático (segue o aparelho), 'light' ou 'dark' */
function temaAtual() { try { return localStorage.getItem('financas-tema') || ''; } catch { return ''; } }
function definirTema(t) {
  try { if (t) localStorage.setItem('financas-tema', t); else localStorage.removeItem('financas-tema'); } catch { /* sem armazenamento */ }
  if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  render();
}
function seletorTema() {
  const t = temaAtual();
  return `<div class="tema" role="group" aria-label="Tema">
    ${[['light', 'Claro'], ['', 'Auto'], ['dark', 'Escuro']].map(([v, n]) =>
      `<button type="button" data-tema="${v}" class="${t === v ? 'ativo' : ''}" aria-pressed="${t === v}">${n}</button>`).join('')}
  </div>`;
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
async function criarClassesSugeridas() {
  const existentes = new Set(S.data.classes.map((c) => normDesc(c.nome)));
  let ordem = S.data.classes.length;
  for (const [nome, cor, escopo_padrao] of CLASSES_SUGERIDAS) {
    if (existentes.has(normDesc(nome))) continue;
    S.data.classes.push(await S.store.saveClasse({ perfil_id: S.perfilId, nome, cor, escopo_padrao, ordem: ++ordem, ativo: true }));
  }
}

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
  if (h[0] === 'lancamentos' || h[0] === 'classificar') {
    if (ano && mes >= 1 && mes <= 12) return { view: h[0], ano, mes };
    return { view: h[0], ...mesPadrao() };
  }
  if (h[0] === 'categorias') {
    if (ano && !h[2]) return { view: 'categorias', ano, mes: null };
    if (ano && mes >= 1 && mes <= 12) return { view: 'categorias', ano, mes };
    return { view: 'categorias', ...mesPadrao() };
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
  if (r.view === 'mes') renderMes(main, r.ano, r.mes);
  else if (r.view === 'lancamentos') renderLancamentos(main, r.ano, r.mes);
  else if (r.view === 'classificar') renderClassificar(main, r.ano, r.mes);
  else if (r.view === 'categorias') renderCategorias(main, r.ano, r.mes);
  else if (r.view === 'geral') renderGeral(main);
  else if (r.view === 'ano') renderAno(main, r.ano, r.aba);
  else if (r.view === 'ajuda') renderAjuda(main);
  else renderAjustes(main);
  bindShell();
  // No celular a faixa de meses rola: centraliza o mês aberto
  const faixa = app.querySelector('.faixa-meses');
  const ativo = faixa?.querySelector('.ativo');
  if (faixa && ativo && faixa.scrollWidth > faixa.clientWidth) {
    faixa.scrollLeft = ativo.offsetLeft - faixa.clientWidth / 2 + ativo.clientWidth / 2;
  }
}

function shell(r) {
  const item = (href, view, label, icon, extra = '', classe = '') =>
    `<a href="${href}" class="${r.view === view ? 'ativo' : ''} ${classe}" ${r.view === view ? 'aria-current="page"' : ''}>${icon}<span>${label}</span>${extra}</a>`;
  const ano = r.ano || anoAtual();
  // Telas por mês mantêm o mês aberto ao trocar de tela
  const sufixoMes = r.ano && r.mes ? `/${r.ano}/${r.mes}` : '';
  // Contador do menu: gastos sem categoria + itens para conferir
  const pendentes = S.user && S.autorizado !== false ? semClasse(S.data.lancamentos).length + conferir().length : 0;
  const email = S.user?.email || '';
  const marca = '<div class="marca"><img src="icons/icon.svg" alt="" width="30" height="30"><span>Finanças Marques</span></div>';
  return `
  <div class="layout">
    <aside class="lateral">
      ${marca}
      <nav class="nav" aria-label="Menu">
        <span class="nav-titulo">Mês a mês</span>
        ${item(`#/mes${sufixoMes}`, 'mes', 'Visão do mês', ICON.mes)}
        ${item(`#/lancamentos${sufixoMes}`, 'lancamentos', 'Lançamentos', ICON.lista)}
        ${item(`#/classificar${sufixoMes}`, 'classificar', 'Classificar', ICON.classificar, pendentes ? `<b class="badge">${pendentes > 99 ? '99+' : pendentes}</b>` : '')}
        ${item(`#/categorias${sufixoMes}`, 'categorias', 'Categorias', ICON.categorias)}
        <span class="nav-titulo nav-sep">Análise</span>
        ${item(`#/ano/${ano}`, 'ano', 'Ano', ICON.ano)}
        ${item('#/geral', 'geral', 'Todos os anos', ICON.geral, '', 'so-desktop')}
        <span class="nav-titulo nav-sep">Configurar</span>
        ${item('#/ajustes', 'ajustes', 'Ajustes', ICON.ajustes)}
        ${item('#/ajuda', 'ajuda', 'Ajuda', ICON.ajuda, '', 'so-desktop')}
      </nav>
      ${seletorTema()}
      <div class="lateral-pe">
        <span class="avatar">${esc((email[0] || '?').toUpperCase())}</span>
        <div><b>${esc(email.split('@')[0] || 'Conta')}</b><small>${S.store.mode === 'local' ? 'modo local' : esc(email)}</small></div>
      </div>
    </aside>
    <div class="conteudo">
      <header class="topo">
        ${marca}
        <button class="btn primario lancar" data-acao="lancar">${ICON.mais}<span>Lançar mês</span></button>
      </header>
      ${S.store.mode === 'local' ? '<div class="aviso">Modo local: os dados ficam só neste navegador.</div>' : ''}
      <main></main>
    </div>
  </div>`;
}

function bindShell() {
  app.querySelectorAll('[data-tema]').forEach((b) => b.addEventListener('click', () => definirTema(b.dataset.tema)));
  app.querySelector('[data-acao="lancar"]')?.addEventListener('click', () => {
    const d = new Date();
    const r = rota();
    if (r.view === 'mes') { abrirEditor(r.ano, r.mes); return; }
    // Sugere o último mês lançado + 1, ou o mês atual
    const ultimos = efetivos().filter(mesTemDados).sort((a, b) => b.ano - a.ano || b.mes - a.mes);
    let ano = d.getFullYear(), mes = d.getMonth() + 1;
    if (r.view === 'ano' && r.ano !== ano) { ano = r.ano; mes = 1; }
    if (ultimos.length && r.view !== 'ano') {
      const u = ultimos[0];
      const proximo = u.mes === 12 ? { ano: u.ano + 1, mes: 1 } : { ano: u.ano, mes: u.mes + 1 };
      if (proximo.ano * 100 + proximo.mes <= ano * 100 + mes) ({ ano, mes } = proximo);
    }
    abrirEditor(ano, mes);
  });
}

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
const corCat = (cat) => PALETA[Math.max(0, cats().findIndex((c) => c.id === cat.id)) % PALETA.length];
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
    ${cabecalhoMes(ano, mes, '#/mes', `
      <a class="btn" href="#/lancamentos/${ano}/${mes}">${ICON.lista}<span>Lançamentos</span></a>
      ${l.temDados ? `<button class="btn primario" data-a="editar">${ICON.editar}<span>Editar mês</span></button>` : ''}`)}
    <p class="sub descricao">O resumo do mês: quanto sobrou, para onde foi o dinheiro e como foi em relação ao mês anterior.
      <a href="#/ajuda">Como usar</a></p>`;

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
        <p class="sub">Três passos para começar. Dúvidas sobre algum termo? Veja a <a href="#/ajuda">Ajuda</a>.</p>
        <ol class="checklist">
          ${passo(temCats, 'Cadastrar cartões e categorias', 'Um item para cada cartão de crédito e para os gastos no débito (pessoais e da empresa).', '<a class="btn" href="#/ajustes">Abrir Ajustes</a>')}
          ${passo(false, 'Trazer o histórico (opcional)', 'Se existir a planilha FINANÇAS GERAIS.xlsx, importe em Ajustes e todos os meses aparecem aqui.', '<a class="btn" href="#/ajustes">Importar planilha</a>')}
          ${passo(false, `Lançar ${MESES[mes - 1].toLowerCase()} de ${ano}`, 'Receita, débito, fatura de cada cartão, investimento e o saldo do dia 1º.', '<button class="btn primario" data-a="editar">Lançar este mês</button>')}
        </ol>
      </section>`;
    main.querySelectorAll('[data-a="editar"]').forEach((b) => b.addEventListener('click', () => abrirEditor(ano, mes)));
    return;
  }

  if (!l.temDados) {
    main.innerHTML = `${topo}
      <section class="card vazio">
        <h2>${MESES[mes - 1]} de ${ano} ainda não foi lançado</h2>
        <p>Lance a receita, os gastos no débito e nos cartões, o investimento e o saldo do dia 1º.</p>
        <div class="acoes"><button class="btn primario" data-a="editar">Lançar ${MESES[mes - 1]}</button></div>
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
        </div>
        <div class="barra-empilhada" role="img" aria-label="Divisão da receita">
          ${partes.map((x) => `<span style="width:${(x.valor / base) * 100}%;background:${x.cor}" title="${esc(x.nome)}: ${fmtBRL(x.valor)}"></span>`).join('')}
        </div>
        <ul class="legenda">
          ${partes.map((x) => `<li><span class="dot" style="background:${x.cor}"></span><span>${esc(x.nome)}</span><b>${fmtBRL(x.valor)}${pctReceita(x.valor)}</b></li>`).join('')}
        </ul>
      </section>

      <section class="card">
        <h2>Saldo financeiro</h2>
        <dl class="lista">
          <div><dt>Saldo inicial (1º de ${MESES_CURTO[mes - 1].toLowerCase()})</dt><dd>${fmtBRL(l.saldoIni)}</dd></div>
          <div><dt>Saldo final (1º de ${MESES_CURTO[prox.mes - 1].toLowerCase()})</dt><dd>${fmtBRL(l.saldoFin)}</dd></div>
          <div class="destaque"><dt>Resultado do saldo</dt><dd class="${cls(l.resultado)}">${fmtBRL(l.resultado)}</dd></div>
        </dl>
        ${l.saldoFin === null ? `<p class="hint">O saldo final aparece quando você lançar o saldo de 1º de ${MESES[prox.mes - 1].toLowerCase()}.</p>` : ''}
      </section>

      ${creditos.length ? `
      <section class="card">
        <h2>Cartões de crédito</h2>
        ${creditos.map(linhaCat).join('')}
        <div class="linha-total"><span>Total no crédito</span><strong>${fmtBRL(l.credito)}</strong></div>
      </section>` : ''}

      ${debitos.length ? `
      <section class="card">
        <h2>Débito / conta</h2>
        ${debitos.map(linhaCat).join('')}
        <div class="linha-total"><span>Total no débito</span><strong>${fmtBRL(l.debito)}</strong></div>
      </section>` : ''}

      <section class="card">
        <h2>Investimento</h2>
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
        <h2>Comparado à média de ${ano}</h2>
        <dl class="lista">
          <div><dt>Receita</dt><dd>${fmtBRL(l.receita)} ${delta(l.receita, st.mediaReceita, 'vs média')}</dd></div>
          <div><dt>Despesas</dt><dd>${fmtBRL(l.totalDesp)} ${delta(l.totalDesp, st.mediaDespesas, 'vs média', true)}</dd></div>
          <div><dt>Máximo para gastar (${fmtPct(p.pct_max_gasto)})</dt><dd>${fmtBRL(receita * p.pct_max_gasto)}</dd></div>
        </dl>
        ${l.totalDesp !== null && receita > 0 && l.totalDesp > receita * p.pct_max_gasto
          ? `<p class="hint neg">Despesas acima do máximo de ${fmtPct(p.pct_max_gasto)} da receita.</p>`
          : receita > 0 ? `<p class="hint pos">Despesas dentro do máximo de ${fmtPct(p.pct_max_gasto)} da receita.</p>` : ''}
      </section>

      ${(() => {
        // Gastos por categoria de gasto + pessoal × empresa (vem dos lançamentos)
        const gastos = S.data.lancamentos.filter((x) => x.destino === 'despesa' && String(x.data).startsWith(`${ano}-${pad2(mes)}`));
        if (!gastos.length) return '';
        const tot = gastos.reduce((s, x) => s + x.valor, 0);
        const emp = gastos.filter((x) => x.escopo === 'empresa').reduce((s, x) => s + x.valor, 0);
        const porClasse = new Map();
        for (const x of gastos) porClasse.set(x.classe_id || '', (porClasse.get(x.classe_id || '') || 0) + x.valor);
        const top = [...porClasse.entries()].filter(([id]) => id).sort((a, b) => b[1] - a[1]).slice(0, 6);
        const pend = semClasse(gastos).length;
        const pctEmp = tot ? (emp / tot) * 100 : 0;
        return `<section class="card">
          <h2>Gastos por categoria</h2>
          <div class="divisao" title="Pessoal × empresa">
            <div class="divisao-barra"><span style="width:${100 - pctEmp}%"></span><span class="emp" style="width:${pctEmp}%"></span></div>
            <div class="divisao-leg"><span>Pessoal <b>${fmtBRL(tot - emp)}</b></span><span>Empresa <b>${fmtBRL(emp)}</b></span></div>
          </div>
          ${top.map(([id, v]) => { const c = classePorId(id); return `<div class="linha-cat"><span class="dot" style="background:${c?.cor}"></span>
            <div class="nome">${esc(c?.nome || '')}</div><div class="val"><strong>${fmtBRL(v)}</strong><span class="delta">${Math.round((v / tot) * 100)}%</span></div></div>`; }).join('')}
          ${pend ? `<p class="hint aviso-txt">${pend} ${pend === 1 ? 'gasto' : 'gastos'} sem categoria. <a href="#/classificar/${ano}/${mes}">Classificar agora →</a></p>` : ''}
          ${(() => { const n = conferir(`${ano}-${pad2(mes)}`).length; return n ? `<p class="hint aviso-txt">${n} ${n === 1 ? 'item' : 'itens'} para conferir (transferências, fatura, repetidos). <a href="#/classificar/${ano}/${mes}">Conferir →</a></p>` : ''; })()}
          <div class="linha-total"><a href="#/categorias/${ano}/${mes}">Ver todas as categorias →</a></div>
        </section>`;
      })()}

      ${(() => {
        const doMes = S.data.lancamentos.filter((x) => String(x.data).startsWith(`${ano}-${pad2(mes)}`))
          .sort((a, b) => b.data.localeCompare(a.data)).slice(0, 6);
        if (!doMes.length) return '';
        const catPorId = new Map(S.data.categorias.map((x) => [x.id, x]));
        return `<section class="card">
          <h2>Últimos lançamentos</h2>
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
        <h2>Últimos 6 meses</h2>
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

/** Cabeçalho comum das telas por mês: setas, nome do mês e a faixa com os 12 meses. */
function cabecalhoMes(ano, mes, base, acoes = '') {
  const pa = anterior(ano, mes), px = seguinte(ano, mes);
  const map = indexMeses(efetivos());
  const hoje = new Date();
  const ehHoje = hoje.getFullYear() === ano && hoje.getMonth() + 1 === mes;
  return `
    <div class="mes-topo">
      <a class="btn icone" href="${base}/${pa.ano}/${pa.mes}" aria-label="Mês anterior">‹</a>
      <a class="btn icone" href="${base}/${px.ano}/${px.mes}" aria-label="Próximo mês">›</a>
      <h1>${MESES[mes - 1]} <span>${ano}</span></h1>
      ${ehHoje ? '' : `<a class="btn fantasma" href="${base}/${hoje.getFullYear()}/${hoje.getMonth() + 1}">Mês atual</a>`}
      <div class="mes-acoes">${acoes}</div>
    </div>
    <nav class="faixa-meses" aria-label="Meses de ${ano}">
      ${MESES_CURTO.map((m, i) => {
        const tem = mesTemDados(map.get(ano * 100 + i + 1));
        return `<a href="${base}/${ano}/${i + 1}" class="${i + 1 === mes ? 'ativo' : ''} ${tem ? 'com-dados' : ''}"
          title="${MESES[i]} de ${ano}: ${tem ? 'lançado' : 'sem lançamentos'}" ${i + 1 === mes ? 'aria-current="date"' : ''}>
          <span>${m}</span><i aria-hidden="true"></i></a>`;
      }).join('')}
    </nav>`;
}

function renderLancamentos(main, ano, mes) {
  const prefixo = `${ano}-${pad2(mes)}`;
  const doMes = S.data.lancamentos.filter((l) => String(l.data).startsWith(prefixo));
  const fl = S.filtroLanc || (S.filtroLanc = { escopo: 'todos', cat: '', busca: '' });
  const catPorId = new Map(S.data.categorias.map((c) => [c.id, c]));
  const lista = doMes
    .filter((l) => fl.escopo === 'todos' || l.escopo === fl.escopo)
    .filter((l) => !fl.cat || (fl.cat.startsWith('d:') ? l.destino === fl.cat.slice(2)
      : fl.cat.startsWith('c:') ? (l.destino === 'despesa' && (l.classe_id || '') === fl.cat.slice(2)) : l.categoria_id === fl.cat))
    .filter((l) => !fl.busca || normDesc(l.descricao).includes(normDesc(fl.busca)))
    .sort((a, b) => a.data.localeCompare(b.data) || a.descricao.localeCompare(b.descricao));
  const soma = (arr, f) => arr.filter(f).reduce((s, l) => s + l.valor, 0);
  const entradas = soma(doMes, (l) => l.destino === 'receita' || l.destino === 'rendimento');
  const saidas = soma(doMes, (l) => l.destino === 'despesa');
  const pessoal = soma(doMes, (l) => l.destino === 'despesa' && l.escopo === 'pessoal');
  const empresa = soma(doMes, (l) => l.destino === 'despesa' && l.escopo === 'empresa');

  const porDia = new Map();
  for (const l of lista) { if (!porDia.has(l.data)) porDia.set(l.data, []); porDia.get(l.data).push(l); }

  const linha = (l) => {
    const cat = catPorId.get(l.categoria_id);
    const classe = classePorId(l.classe_id);
    const transf = l.destino === 'transferencia';
    const entrada = sentidoDe(l) === 'entrada';
    const cor = transf ? 'var(--muted)' : classe ? classe.cor : cat ? corCat(cat) : entrada ? 'var(--pos)' : 'var(--c-saldo)';
    const rotuloClasse = l.destino !== 'despesa' ? DESTINOS[l.destino]
      : classe ? esc(classe.nome) : '<span class="tag aviso">sem categoria</span>';
    const nomeConta = cat?.nome || l.conta;
    return `<button class="lanc ${transf ? 'transf' : ''}" data-id="${l.id}">
      <span class="lanc-icone" style="--cor:${cor}">${transf ? '⇄' : entrada ? '↓' : l.destino === 'investimento' ? '◆' : '↑'}</span>
      <span class="lanc-txt"><b>${esc(l.descricao)}</b>
        <small>${rotuloClasse}${nomeConta ? ` · ${esc(nomeConta)}` : ''}${transf ? ' · não conta' : ` · <span class="tag ${l.escopo === 'empresa' ? 'empresa' : ''}">${LADO[l.escopo] || 'Pessoal'}</span>`}${l.origem === 'extrato' ? ' · <span class="tag">extrato</span>' : ''}</small></span>
      <span class="lanc-valor ${transf ? '' : entrada ? 'pos' : l.destino === 'despesa' ? 'neg' : ''}">${entrada ? '+' : '−'} ${fmtBRL(l.valor)}</span>
    </button>`;
  };

  main.innerHTML = `
    ${cabecalhoMes(ano, mes, '#/lancamentos', `
      <button class="btn" data-a="importar">${ICON.upload}<span>Importar extrato</span></button>
      <button class="btn primario" data-a="novo">${ICON.mais}<span>Novo lançamento</span></button>`)}
    <p class="sub descricao">Cada gasto ou entrada, um por um. Use para lançar aos poucos (por semana) ou importar o extrato do banco —
      movimentações já importadas são puladas automaticamente. <a href="#/ajuda">Como funciona</a></p>

    <section class="mini-kpis">
      <div class="card"><span>Entradas</span><strong class="pos">${fmtBRL(entradas)}</strong></div>
      <div class="card"><span>Saídas</span><strong class="neg">${fmtBRL(saidas)}</strong></div>
      <div class="card"><span>Pessoal</span><strong>${fmtBRL(pessoal)}</strong></div>
      <div class="card"><span>Empresa</span><strong>${fmtBRL(empresa)}</strong></div>
    </section>

    <section class="card">
      <div class="filtros-lanc">
        <div class="seg" role="group" aria-label="Pessoal ou empresa">
          ${[['todos', 'Todos'], ['pessoal', 'Pessoal'], ['empresa', 'Empresa']].map(([v, t]) =>
            `<button data-escopo="${v}" class="${fl.escopo === v ? 'ativo' : ''}" aria-pressed="${fl.escopo === v}">${t}</button>`).join('')}
        </div>
        <select data-f="cat" aria-label="Categoria">
          <option value="">Tudo</option>
          <optgroup label="Categoria de gasto">
            <option value="c:" ${fl.cat === 'c:' ? 'selected' : ''}>Sem categoria</option>
            ${classes().map((c) => `<option value="c:${c.id}" ${fl.cat === 'c:' + c.id ? 'selected' : ''}>${esc(c.nome)}</option>`).join('')}
          </optgroup>
          <optgroup label="Conta / cartão">
            ${cats().map((c) => `<option value="${c.id}" ${fl.cat === c.id ? 'selected' : ''}>${esc(c.nome)}</option>`).join('')}
          </optgroup>
          <optgroup label="Entradas">
            ${['receita', 'rendimento', 'investimento', 'transferencia'].map((d) => `<option value="d:${d}" ${fl.cat === 'd:' + d ? 'selected' : ''}>${DESTINOS[d]}</option>`).join('')}
          </optgroup>
        </select>
        <input type="search" data-f="busca" placeholder="Buscar descrição…" value="${esc(fl.busca)}" aria-label="Buscar">
        <span class="contagem">${lista.length} de ${doMes.length}</span>
      </div>
      ${!doMes.length ? `
        <div class="vazio-lanc">
          <p><b>Nenhum lançamento em ${MESES[mes - 1].toLowerCase()}.</b></p>
          <p class="sub">Lançamentos são opcionais: dá para lançar só os totais na tela <a href="#/mes/${ano}/${mes}">Mês</a>.
            Use esta tela se quiser registrar gasto por gasto ou importar o extrato.</p>
        </div>`
        : !lista.length ? '<p class="sub">Nenhum lançamento com esse filtro.</p>'
        : [...porDia.entries()].map(([dia, ls]) => {
          const d = new Date(dia + 'T12:00:00');
          const totalDia = ls.reduce((s, l) => s + (l.destino === 'despesa' ? -l.valor : l.destino === 'investimento' || l.destino === 'transferencia' ? 0 : l.valor), 0);
          return `<div class="dia"><div class="dia-cab"><span>${DIAS[d.getDay()]}, ${fmtDia(dia)}</span><span class="${cls(totalDia)}">${fmtBRL(totalDia)}</span></div>
            ${ls.map(linha).join('')}</div>`;
        }).join('')}
    </section>`;

  main.querySelector('[data-a="novo"]').addEventListener('click', () => abrirLancamento(null, { ano, mes }));
  main.querySelector('[data-a="importar"]').addEventListener('click', () => abrirImportacao({ ano, mes }));
  main.querySelectorAll('.lanc').forEach((b) => b.addEventListener('click', () => {
    abrirLancamento(S.data.lancamentos.find((l) => l.id === b.dataset.id), { ano, mes });
  }));
  main.querySelectorAll('[data-escopo]').forEach((b) => b.addEventListener('click', () => { fl.escopo = b.dataset.escopo; render(); }));
  main.querySelector('[data-f="cat"]').addEventListener('change', (e) => { fl.cat = e.target.value; render(); });
  const busca = main.querySelector('[data-f="busca"]');
  busca.addEventListener('input', () => {
    clearTimeout(renderLancamentos._t);
    renderLancamentos._t = setTimeout(() => {
      fl.busca = busca.value; render();
      const b2 = app.querySelector('[data-f="busca"]');
      if (b2) { b2.focus(); b2.setSelectionRange(b2.value.length, b2.value.length); }
    }, 250);
  });
}

/** Sugere a categoria pelo histórico: a última usada com a mesma descrição. */
function categoriaPorHistorico(descricao) {
  const n = normDesc(descricao);
  if (!n) return null;
  const achado = [...S.data.lancamentos].reverse().find((l) => l.destino === 'despesa' && normDesc(l.descricao) === n);
  return achado?.categoria_id || null;
}

function abrirLancamento(existente, { ano, mes }) {
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
          ${Object.entries(DESTINOS).map(([v, t]) => `<label><input type="radio" name="destino" value="${v}" ${(existente?.destino || 'despesa') === v ? 'checked' : ''}><span>${t}</span></label>`).join('')}
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
          <label class="campo" data-so-despesa><span>Categoria de gasto</span>
            <select name="classe_id"><option value="">— sem categoria —</option>
              ${classes().filter((x) => x.ativo !== false || x.id === existente?.classe_id).map((x) => `<option value="${x.id}" ${existente?.classe_id === x.id ? 'selected' : ''}>${esc(x.nome)}</option>`).join('')}</select>
          </label>
          <div class="campo" data-so-transf><span>Nesta conta, o dinheiro</span>
            <div class="seg" role="radiogroup" aria-label="Sentido">
              ${[['saida', 'Saiu'], ['entrada', 'Entrou']].map(([v, t]) => `<label><input type="radio" name="sentido" value="${v}" ${(existente ? sentidoDe(existente) : 'saida') === v ? 'checked' : ''}><span>${t}</span></label>`).join('')}
            </div>
          </div>
        </div>
        <label class="check-linha" data-so-despesa><input type="checkbox" name="lembrar"> Criar regra: classificar sempre assim quando a descrição tiver
          <input class="regra-texto" name="texto_regra" value="${esc(regraPadrao(existente?.descricao || ''))}" aria-label="Texto da regra"></label>
        <p class="hint" data-so-transf>Transferência entre as suas contas (ou pagamento da fatura do cartão) fica registrada, mas não conta como receita nem gasto.</p>
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
  const atualizarTipo = () => {
    const d = form.destino.value;
    dlg.querySelectorAll('[data-so-despesa]').forEach((x) => { x.hidden = d !== 'despesa'; });
    dlg.querySelectorAll('[data-so-transf]').forEach((x) => { x.hidden = d !== 'transferencia'; });
    dlg.querySelectorAll('[data-nao-transf]').forEach((x) => { x.hidden = d === 'transferencia'; });
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
    if (existente) return;
    const conta = categoriaPorHistorico(form.descricao.value);
    if (conta && form.categoria_id.querySelector(`option[value="${conta}"]`)) form.categoria_id.value = conta;
    const sug = sugerir(form.descricao.value, { regras: S.data.regras, classes: S.data.classes, lancamentos: S.data.lancamentos, escopoPadrao: form.escopo.value });
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
      classe_id: destino === 'despesa' ? form.classe_id.value || null : null,
      sentido: destino === 'transferencia' ? form.sentido.value : destino === 'receita' || destino === 'rendimento' ? 'entrada' : 'saida',
      escopo: form.escopo.value,
      origem: existente?.origem || 'manual',
    };
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
      const sug = sugerir(l.descricao, { regras: S.data.regras, classes: S.data.classes, lancamentos: S.data.lancamentos, escopoPadrao: cfg.escopo });
      const classeId = l.classeEscolhida !== undefined ? l.classeEscolhida : saida ? sug.classe_id : null;
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
        escopo: l.escopoEscolhido ?? (l.classeEscolhida !== undefined && ladoClasse ? ladoClasse : saida ? sug.escopo : cfg.escopo),
        por: l.classeEscolhida !== undefined ? null : saida ? sug.por : null,
      };
    });
    const datas = linhas.map((l) => l.data).sort();
    const n = (s) => linhas.filter((l) => l.status === s).length;
    const opcoesClasse = (sel) => `<option value="">— classificar depois —</option>` +
      classes().filter((x) => x.ativo !== false || x.id === sel).map((x) => `<option value="${x.id}" ${sel === x.id ? 'selected' : ''}>${esc(x.nome)}</option>`).join('');
    const selecionadas = linhas.filter((l) => l.incluir && l.status !== 'ja' && l.destino !== 'ignorar');
    const autoClass = selecionadas.filter((l) => l.destino === 'despesa' && l.classe_id).length;
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
              <thead><tr><th></th><th>Data</th><th>Descrição</th><th>Valor</th><th>Tipo</th><th>Categoria de gasto</th><th>Pessoal / empresa</th></tr></thead>
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
                    <td><select data-c="classe" ${l.status === 'ja' || l.destino !== 'despesa' ? 'disabled' : ''}>${opcoesClasse(l.classe_id)}</select>
                      ${l.por === 'regra' ? '<span class="tag pos" title="Classificado por uma regra">regra</span>' : l.por === 'historico' ? '<span class="tag" title="Igual a um lançamento anterior">anterior</span>' : ''}</td>
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
      const novos = atuais.map((l) => ({
        perfil_id: S.perfilId, data: l.data, descricao: l.descricao.slice(0, 200), valor: Math.round(l.valor * 100) / 100,
        destino: l.destino, categoria_id: l.categoria_id, // a conta/cartão do arquivo, em qualquer tipo
        classe_id: l.destino === 'despesa' ? l.classe_id || null : null,
        sentido: l.saida ? 'saida' : 'entrada',
        escopo: l.escopo, origem: 'extrato', conta: nomeConta, chave: l.chave,
      }));
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

/* ========================================================= classificar */
function cardSemClasses() {
  return `<section class="card destaque-acao">
    <h2>Crie as categorias de gasto</h2>
    <p class="sub">Categorias dizem <b>com o quê</b> o dinheiro foi gasto (Funcionários, Assinaturas, Telefone…), independente da conta.
      Comece com as sugeridas e ajuste depois em Ajustes.</p>
    <div class="acoes"><button class="btn primario" data-a="sugeridas">Criar categorias sugeridas</button><a class="btn" href="#/ajustes">Criar as minhas</a></div>
  </section>`;
}
function bindSemClasses(main) {
  main.querySelector('[data-a="sugeridas"]')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    try { await criarClassesSugeridas(); toast('Categorias criadas.'); render(); } catch (ex) { toast(ex.message, 'erro'); e.target.disabled = false; }
  });
}

function renderClassificar(main, ano, mes) {
  const prefixo = `${ano}-${pad2(mes)}`;
  const despesasMes = S.data.lancamentos.filter((l) => String(l.data).startsWith(prefixo) && l.destino === 'despesa');
  const pend = semClasse(despesasMes);
  const feitos = despesasMes.length - pend.length;
  const pct = despesasMes.length ? Math.round((feitos / despesasMes.length) * 100) : 0;
  const outros = new Map();
  for (const l of semClasse(S.data.lancamentos)) {
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
  const cl = classes().filter((c) => c.ativo !== false);
  const catPorId = new Map(S.data.categorias.map((c) => [c.id, c]));

  main.innerHTML = `
    ${cabecalhoMes(ano, mes, '#/classificar', `
      <button class="btn" data-a="aplicar-regras" title="Usa as regras salvas nos lançamentos ainda sem categoria">Aplicar regras</button>
      <a class="btn" href="#/categorias/${ano}/${mes}">Ver categorias</a>`)}
    <p class="sub descricao">Primeiro confira o que o site achou de estranho (transferências entre suas contas, fatura contada duas vezes, repetidos).
      Depois classifique: os gastos parecidos vêm juntos, um clique na categoria classifica o grupo e, com "lembrar", os próximos meses já vêm classificados.</p>

    ${!cl.length ? cardSemClasses() : ''}

    ${blocoConferencia(problemas)}

    <section class="card progresso-card">
      <div class="progresso-topo">
        <div><strong>${feitos} de ${despesasMes.length}</strong> gastos de ${MESES[mes - 1].toLowerCase()} classificados</div>
        <span class="pct">${pct}%</span>
      </div>
      <div class="progresso grande"><span style="width:${pct}%"></span></div>
      ${outros.size ? `<p class="hint">Outros meses com gastos sem categoria:
        ${[...outros.entries()].sort().map(([k, n]) => { const [a, m] = k.split('-').map(Number); return `<a href="#/classificar/${a}/${m}">${MESES_CURTO[m - 1]}/${String(a).slice(2)} (${n})</a>`; }).join(' · ')}</p>` : ''}
    </section>

    ${!despesasMes.length ? `
      <section class="card vazio">
        <h2>Nenhum gasto lançado em ${MESES[mes - 1].toLowerCase()}</h2>
        <p>Importe os extratos das contas e cartões na tela Lançamentos e volte aqui para classificar.</p>
        <div class="acoes"><a class="btn primario" href="#/lancamentos/${ano}/${mes}">Ir para Lançamentos</a></div>
      </section>`
    : !pend.length ? `
      <section class="card vazio pronto">
        <h2>Tudo classificado ✓</h2>
        <p>Todos os gastos de ${MESES[mes - 1].toLowerCase()} têm categoria.</p>
        <div class="acoes"><a class="btn primario" href="#/categorias/${ano}/${mes}">Ver quanto foi para cada categoria</a></div>
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
          ${cl.map((c) => `<button type="button" class="chip" data-classe="${c.id}" style="--cor:${c.cor}"><i></i>${esc(c.nome)}${c.escopo_padrao ? `<small>${LADO[c.escopo_padrao]}</small>` : ''}</button>`).join('')}
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
  main.querySelector('[data-a="aplicar-regras"]').addEventListener('click', async () => {
    const alvo = semClasse(S.data.lancamentos).map((l) => ({ l, r: regraPara(l.descricao, S.data.regras) })).filter((x) => x.r);
    if (!alvo.length) { toast('Nenhum gasto sem categoria combina com as regras salvas.'); return; }
    try {
      for (const { l, r } of alvo) await classificar([l.id], r.classe_id, r.escopo || null, null);
      toast(`${alvo.length} gastos classificados pelas regras.`);
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
        toast(`${marcados.length} → ${c?.nome}${lado ? ` · ${LADO[lado]}` : c?.escopo_padrao ? ` · ${LADO[c.escopo_padrao]}` : ''}${lembrar ? ' · regra salva' : ''}`);
        render();
      } catch (e) { card.classList.remove('saindo'); toast(e.message, 'erro'); }
    }));
  });
}

/* ========================================================== categorias */
function renderCategorias(main, ano, mes) {
  const porAno = !mes;
  const fc = S.filtroCat || (S.filtroCat = { escopo: 'todos', conta: '' });
  const prefixo = porAno ? `${ano}-` : `${ano}-${pad2(mes)}`;
  const doPeriodo = S.data.lancamentos.filter((l) => l.destino === 'despesa' && String(l.data).startsWith(prefixo));
  const despesas = doPeriodo
    .filter((l) => fc.escopo === 'todos' || l.escopo === fc.escopo)
    .filter((l) => !fc.conta || l.categoria_id === fc.conta);
  const total = despesas.reduce((s, l) => s + l.valor, 0);
  const soma = (f) => doPeriodo.filter((l) => !fc.conta || l.categoria_id === fc.conta).filter(f).reduce((s, l) => s + l.valor, 0);
  const pessoal = soma((l) => l.escopo === 'pessoal');
  const empresa = soma((l) => l.escopo === 'empresa');
  const semCat = semClasse(despesas);

  const grupos = new Map();
  for (const l of despesas) {
    const k = l.classe_id || '';
    if (!grupos.has(k)) grupos.set(k, []);
    grupos.get(k).push(l);
  }
  const linhas = [...grupos.entries()].map(([id, ls]) => {
    const c = classePorId(id);
    return { id, nome: c?.nome || 'Sem categoria', cor: c?.cor || '#cbd5e1', ls, total: ls.reduce((s, l) => s + l.valor, 0) };
  }).sort((a, b) => (a.id === '') - (b.id === '') || b.total - a.total);
  const maior = Math.max(1, ...linhas.map((x) => x.total));
  const catPorId = new Map(S.data.categorias.map((c) => [c.id, c]));

  const cab = porAno
    ? `<div class="mes-topo">
        <a class="btn icone" href="#/categorias/${ano - 1}" aria-label="Ano anterior">‹</a>
        <a class="btn icone" href="#/categorias/${ano + 1}" aria-label="Próximo ano">›</a>
        <h1>Categorias <span>${ano}</span></h1>
        <div class="mes-acoes"><div class="abas"><a href="#/categorias/${ano}/${new Date().getMonth() + 1}">Mês</a><a class="ativo" href="#/categorias/${ano}">Ano inteiro</a></div></div>
      </div>`
    : cabecalhoMes(ano, mes, '#/categorias', `<div class="abas"><a class="ativo" href="#/categorias/${ano}/${mes}">Mês</a><a href="#/categorias/${ano}">Ano inteiro</a></div>`);

  // Tabela categoria × mês (só no ano)
  const tabelaAno = porAno && linhas.length ? `
    <section class="card largo">
      <h2>Mês a mês</h2>
      <div class="tabela-wrap"><table class="tabela">
        <thead><tr><th>Categoria</th>${MESES_CURTO.map((m) => `<th>${m}</th>`).join('')}<th>Total</th></tr></thead>
        <tbody>${linhas.map((x) => `<tr><th><span class="dot" style="background:${x.cor}"></span> ${esc(x.nome)}</th>
          ${MESES_CURTO.map((_, i) => { const v = x.ls.filter((l) => Number(l.data.slice(5, 7)) === i + 1).reduce((s, l) => s + l.valor, 0); return `<td>${v ? fmtNum(v) : ''}</td>`; }).join('')}
          <td><b>${fmtNum(x.total)}</b></td></tr>`).join('')}</tbody>
        <tfoot><tr><th>Total</th>${MESES_CURTO.map((_, i) => { const v = despesas.filter((l) => Number(l.data.slice(5, 7)) === i + 1).reduce((s, l) => s + l.valor, 0); return `<td>${v ? fmtNum(v) : ''}</td>`; }).join('')}<td>${fmtNum(total)}</td></tr></tfoot>
      </table></div>
    </section>` : '';

  main.innerHTML = `
    ${cab}
    <p class="sub descricao">Quanto foi gasto com cada coisa${porAno ? ' no ano' : ' no mês'}, juntando todas as contas e cartões. Toque numa categoria para ver as compras.</p>

    <section class="mini-kpis">
      <div class="card"><span>Gastos ${fc.escopo !== 'todos' ? `(${LADO[fc.escopo].toLowerCase()})` : ''}</span><strong>${fmtBRL(total)}</strong></div>
      <div class="card"><span>Pessoal</span><strong>${fmtBRL(pessoal)}</strong></div>
      <div class="card"><span>Empresa</span><strong>${fmtBRL(empresa)}</strong></div>
      <div class="card"><span>Sem categoria</span><strong class="${semCat.length ? 'neg' : ''}">${semCat.length}</strong>
        ${semCat.length && !porAno ? `<a href="#/classificar/${ano}/${mes}">Classificar →</a>` : ''}</div>
    </section>

    <section class="card filtros-lanc">
      <div class="seg" role="group" aria-label="Pessoal ou empresa">
        ${[['todos', 'Tudo'], ['pessoal', 'Pessoal'], ['empresa', 'Empresa']].map(([v, t]) =>
          `<button data-escopo="${v}" class="${fc.escopo === v ? 'ativo' : ''}" aria-pressed="${fc.escopo === v}">${t}</button>`).join('')}
      </div>
      <select data-f="conta" aria-label="Conta ou cartão">
        <option value="">Todas as contas e cartões</option>
        ${cats().map((c) => `<option value="${c.id}" ${fc.conta === c.id ? 'selected' : ''}>${esc(c.nome)}</option>`).join('')}
      </select>
    </section>

    ${!S.data.classes.length ? cardSemClasses() : ''}

    ${!despesas.length ? `<section class="card vazio"><h2>Nenhum gasto ${porAno ? `em ${ano}` : `em ${MESES[mes - 1].toLowerCase()}`}</h2>
      <p>As categorias usam os gastos da tela Lançamentos (lançados à mão ou importados do extrato).</p>
      <div class="acoes"><a class="btn primario" href="#/lancamentos/${ano}/${mes || new Date().getMonth() + 1}">Ir para Lançamentos</a></div></section>`
    : `<div class="cat-grid">
      <section class="card">
        <h2>Divisão</h2>
        <div class="rosca"><canvas id="g-rosca"></canvas><div class="rosca-centro"><span>Total</span><strong>${grande(total)}</strong></div></div>
      </section>
      <section class="card">
        <h2>Por categoria</h2>
        ${linhas.map((x) => `
          <details class="cat-item">
            <summary>
              <span class="dot" style="background:${x.cor}"></span>
              <span class="cat-nome">${esc(x.nome)}<small>${x.ls.length} ${x.ls.length === 1 ? 'gasto' : 'gastos'}</small></span>
              <span class="cat-barra"><i style="width:${(x.total / maior) * 100}%;background:${x.cor}"></i></span>
              <span class="cat-valor"><b>${fmtBRL(x.total)}</b><small>${total ? Math.round((x.total / total) * 100) : 0}%</small></span>
            </summary>
            <div class="cat-lista">
              ${[...x.ls].sort((a, b) => b.data.localeCompare(a.data)).map((l) => `
                <button class="lanc" data-id="${l.id}">
                  <span class="lanc-txt"><b>${esc(l.descricao)}</b>
                    <small>${fmtDia(l.data)} · ${esc(l.conta || catPorId.get(l.categoria_id)?.nome || '')} · <span class="tag ${l.escopo === 'empresa' ? 'empresa' : ''}">${LADO[l.escopo]}</span></small></span>
                  <span class="lanc-valor">${fmtBRL(l.valor)}</span>
                </button>`).join('')}
            </div>
          </details>`).join('')}
      </section>
    </div>`}
    ${tabelaAno}`;

  bindSemClasses(main);
  main.querySelectorAll('[data-escopo]').forEach((b) => b.addEventListener('click', () => { fc.escopo = b.dataset.escopo; render(); }));
  main.querySelector('[data-f="conta"]').addEventListener('change', (e) => { fc.conta = e.target.value; render(); });
  main.querySelectorAll('.cat-lista .lanc').forEach((b) => b.addEventListener('click', () => {
    const l = S.data.lancamentos.find((x) => x.id === b.dataset.id);
    const [a, m] = l.data.split('-').map(Number);
    abrirLancamento(l, { ano: a, mes: m });
  }));
  const canvas = main.querySelector('#g-rosca');
  if (canvas && window.Chart) {
    S.charts.push(new Chart(canvas, {
      type: 'doughnut',
      data: { labels: linhas.map((x) => x.nome), datasets: [{ data: linhas.map((x) => x.total), backgroundColor: linhas.map((x) => x.cor), borderWidth: 2, borderColor: cssVar('--surface') }] },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: '68%',
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${c.label}: ${fmtBRL(c.parsed)}` } } },
      },
    }));
  }
}

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
    <div class="titulo">
      <div><h1>Todos os anos</h1><p class="sub">A soma de todos os anos lançados. Use o filtro para ver um período ou só alguns cartões. · ${periodo}${periodo ? ' · ' : ''}${st.mesesComDados} ${st.mesesComDados === 1 ? 'mês lançado' : 'meses lançados'}${f.cats ? ' · despesas filtradas' : ''}</p></div>
    </div>
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
    <section class="card">
      <h2>Por ano</h2>
      <div class="tabela-wrap">
        <table class="tabela">
          <thead><tr>
            <th>Ano</th><th>Gasto total</th><th>Gasto crédito</th><th>Receita total</th><th>Saldo total</th>
            <th>Média receita/mês</th><th>Média despesas/mês</th><th>Total investido</th><th>Rendimento</th><th>Resultado saldo</th>
          </tr></thead>
          <tbody>
            ${porAno.map(({ ano, linhas }) => {
              const s = estatisticas(linhas, c, prefs());
              return `<tr class="clicavel" data-ano="${ano}">
                <th><a href="#/ano/${ano}">${ano}</a></th>
                <td>${fmtBRL(s.gastoTotal)}</td><td>${fmtBRL(s.creditoTotal)}</td><td>${fmtBRL(s.receitaTotal)}</td>
                <td>${money(s.saldoTotal)}</td><td>${fmtBRL(s.mediaReceita)}</td><td>${fmtBRL(s.mediaDespesas)}</td>
                <td>${fmtBRL(s.totalInvestido)}</td><td>${fmtBRL(s.totalRendimento)}</td><td>${money(s.resultadoAcumulado)}</td>
              </tr>`;
            }).join('')}
          </tbody>
          <tfoot><tr>
            <th>Total / média</th>
            <td>${fmtBRL(st.gastoTotal)}</td><td>${fmtBRL(st.creditoTotal)}</td><td>${fmtBRL(st.receitaTotal)}</td>
            <td>${money(st.saldoTotal)}</td><td>${fmtBRL(st.mediaReceita)}</td><td>${fmtBRL(st.mediaDespesas)}</td>
            <td>${fmtBRL(st.totalInvestido)}</td><td>${fmtBRL(st.totalRendimento)}</td><td>${money(st.resultadoAcumulado)}</td>
          </tr></tfoot>
        </table>
      </div>
    </section>
    <section class="card grafico">
      <h2>Receita × despesas por mês</h2>
      <div class="canvas-box"><canvas id="g-geral"></canvas></div>
    </section>
    </div>
    </section>`;

  bindFiltro(main, todasCats);
  main.querySelectorAll('tr[data-ano]').forEach((tr) => tr.addEventListener('click', () => (location.hash = `#/ano/${tr.dataset.ano}`)));
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
    <div class="titulo">
      <div class="seletor-ano">
        <a class="btn icone" href="#/ano/${ano - 1}${sufixo}" aria-label="Ano anterior">‹</a>
        <select aria-label="Ano">${anos.map((a) => `<option ${a === ano ? 'selected' : ''}>${a}</option>`).join('')}</select>
        <a class="btn icone" href="#/ano/${ano + 1}${sufixo}" aria-label="Próximo ano">›</a>
      </div>
      <div class="abas" role="tablist">
        <a role="tab" href="#/ano/${ano}" class="${aba === 'resumo' ? 'ativo' : ''}" aria-selected="${aba === 'resumo'}">Resumo do ano</a>
        <a role="tab" href="#/ano/${ano}/planilha" class="${aba === 'planilha' ? 'ativo' : ''}" aria-selected="${aba === 'planilha'}">Planilha (mês a mês)</a>
      </div>
    </div>
    <p class="sub descricao">${aba === 'resumo'
      ? 'O ano inteiro em um só lugar: quanto entrou, quanto saiu, para onde foi o dinheiro e como o saldo evoluiu.'
      : 'Igual à aba do ano na planilha: um mês por linha, com as informações gerais ao lado. Toque num mês para lançar ou editar.'}
      ${st.mesesComDados ? ` · ${st.mesesComDados} de 12 meses lançados` : ''}</p>`;
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
        </div>
        <div class="barra-empilhada" role="img" aria-label="Divisão da receita do ano">
          ${partes.map((x) => `<span style="width:${(x.valor / base) * 100}%;background:${x.cor}" title="${esc(x.nome)}: ${fmtBRL(x.valor)}"></span>`).join('')}
        </div>
        <ul class="legenda">
          ${partes.map((x) => `<li><span class="dot" style="background:${x.cor}"></span><span>${esc(x.nome)}</span><b>${fmtBRL(x.valor)}${pctReceita(x.valor)}</b></li>`).join('')}
        </ul>
      </section>

      <section class="card">
        <h2>Médias por mês</h2>
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
        <h2>Mês a mês em ${ano}</h2>
        <div class="canvas-box"><canvas id="g-ano"></canvas></div>
      </section>

      <section class="card">
        <h2>Cartões e categorias no ano</h2>
        ${st.porCategoria.filter((x) => x.meses).map((x) => `
          <div class="linha-cat">
            <span class="dot" style="background:${corCat(x.cat)}"></span>
            <div class="nome">${esc(x.cat.nome)}<small>${x.cat.tipo === 'debito' ? 'débito' : 'crédito'} · média ${fmtBRL(x.media)}/mês</small></div>
            <div class="val"><strong>${fmtBRL(x.total)}</strong><span class="delta">${st.gastoTotal ? Math.round((x.total / st.gastoTotal) * 100) : 0}% das despesas</span></div>
          </div>`).join('')}
        <div class="linha-total"><span>Crédito ${fmtBRL(st.creditoTotal)} · Débito ${fmtBRL(st.debitoTotal)}</span></div>
      </section>

      <section class="card">
        <h2>Destaques do ano</h2>
        <dl class="lista">
          <div><dt>Melhor mês (maior sobra)</dt><dd>${nomeMes(melhor)}<small class="pos">${melhor ? fmtBRL(melhor.saldoMes) : ''}</small></dd></div>
          <div><dt>Pior mês (menor sobra)</dt><dd>${nomeMes(pior)}<small class="${cls(pior?.saldoMes)}">${pior ? fmtBRL(pior.saldoMes) : ''}</small></dd></div>
          <div><dt>Mês com mais despesas</dt><dd>${nomeMes(maisGasto)}<small>${maisGasto ? fmtBRL(maisGasto.totalDesp) : ''}</small></dd></div>
          <div><dt>Mês com mais receita</dt><dd>${nomeMes(maisReceita)}<small>${maisReceita ? fmtBRL(maisReceita.receita) : ''}</small></dd></div>
          <div><dt>Meses com saldo negativo</dt><dd>${st.mesesNegativos}</dd></div>
        </dl>
      </section>

      <section class="card">
        <h2>Investimentos</h2>
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
        <h2>Saldo financeiro</h2>
        <dl class="lista">
          <div><dt>Saldo no início do ano</dt><dd>${fmtBRL(st.saldoInicio)}</dd></div>
          <div><dt>Último saldo informado</dt><dd>${fmtBRL(st.ultimoSaldo)}</dd></div>
          <div class="destaque"><dt>Resultado acumulado</dt><dd class="${cls(st.resultadoAcumulado)}">${fmtBRL(st.resultadoAcumulado)}</dd></div>
          <div><dt>Média do resultado por mês</dt><dd class="${cls(st.mediaResultado)}">${fmtBRL(st.mediaResultado)}</dd></div>
        </dl>
      </section>

      <section class="card">
        <h2>Organização</h2>
        <dl class="lista">
          <div><dt>Máximo para gastar por mês (${fmtPct(p.pct_max_gasto)})</dt><dd>${fmtBRL(maxGastar)}</dd></div>
          <div><dt>Despesa média por mês</dt><dd class="${st.mediaDespesas > maxGastar ? 'neg' : 'pos'}">${fmtBRL(st.mediaDespesas)}</dd></div>
          <div><dt>Investir por mês (${fmtPct(p.pct_investir)})</dt><dd>${fmtBRL(st.investirEsperado)}</dd></div>
          <div><dt>Investimento médio por mês</dt><dd class="${st.mediaInvestimento >= st.investirEsperado ? 'pos' : 'neg'}">${fmtBRL(st.mediaInvestimento)}</dd></div>
        </dl>
      </section>

      <section class="card grafico">
        <h2>Evolução do saldo (dia 1º de cada mês)</h2>
        <div class="canvas-box pequeno"><canvas id="g-saldo"></canvas></div>
      </section>

      ${temAnt ? `
      <section class="card largo">
        <h2>Comparado a ${ano - 1}</h2>
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
          <a href="#/lancamentos/${ano}/${mes}" data-fechar>Lançamentos</a>.</small>
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
    <div class="titulo"><div><h1>Ajuda</h1><p class="sub">Como usar o Finanças Marques, passo a passo.</p></div></div>

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
          <div><dt>${ICON.lista} Lançamentos</dt><dd>Cada gasto ou entrada, um por um, com data e se é pessoal ou da empresa. Também é onde se importa o extrato do banco.</dd></div>
          <div><dt>${ICON.classificar} Classificar</dt><dd>Os gastos sem categoria, agrupados por descrição. Um clique na categoria classifica o grupo e cria a regra para os próximos meses.</dd></div>
          <div><dt>${ICON.categorias} Categorias</dt><dd>Quanto foi para cada categoria (Funcionários, Assinaturas…) no mês ou no ano, de todas as contas juntas, com filtro pessoal/empresa.</dd></div>
          <div><dt>${ICON.ano} Ano · Resumo</dt><dd>O ano inteiro: total que entrou e saiu, divisão por cartão/categoria, melhores e piores meses, investimentos e evolução do saldo.</dd></div>
          <div><dt>${ICON.ano} Ano · Planilha</dt><dd>Igual à aba do ano no Excel: um mês por linha e as informações gerais ao lado. Toque num mês para editar.</dd></div>
          <div><dt>${ICON.geral} Todos os anos</dt><dd>Soma de todos os anos, com filtro por período e por cartão/categoria.</dd></div>
          <div><dt>${ICON.ajustes} Ajustes</dt><dd>Cartões e categorias, metas (15%/6×/70%), importar a planilha do Excel e backup.</dd></div>
        </dl>
      </section>

      <section class="card largo destaque-acao">
        <h2>Rotina com extratos (todo dia 1º)</h2>
        <ol class="passos">
          <li>No app/site de cada banco, baixe o extrato do mês que terminou em <b>OFX</b> (ou CSV): conta da empresa, cartão da empresa, conta pessoal, cartão pessoal…</li>
          <li>Em <b>Lançamentos → Importar extrato</b>, importe <b>um arquivo por vez</b>, escolhendo de qual conta/cartão ele é.
            O site já marca como <b>Transferência</b> (não conta) o pagamento da fatura, o dinheiro entre as suas contas e os nomes cadastrados em Ajustes.</li>
          <li><b>Cartão de crédito:</b> se o extrato da conta trouxer só o pagamento da fatura, importe também o extrato/fatura do cartão
            (as compras de verdade). Se não tiver, a Conferência oferece contar o pagamento como um gasto "Fatura do cartão".</li>
          <li>Abra <b>Classificar</b>. Primeiro, a <b>Conferência</b> mostra o que parece errado (transferência contada como receita,
            fatura contada duas vezes, repetidos) — corrija com um clique. Depois, os gastos parecidos vêm juntos (ex.: todos os Pix para o mesmo funcionário):
            clique na categoria e deixe "Lembrar" marcado para os próximos meses virem classificados sozinhos.</li>
          <li>Se um gasto da empresa saiu da conta pessoal (ou o contrário), troque o lado para <b>Empresa</b>/<b>Pessoal</b> antes de clicar.</li>
          <li>Veja o resultado em <b>Categorias</b> (quanto foi para cada coisa) e na <b>Visão do mês</b>.</li>
        </ol>
        <p class="hint">No primeiro mês dá mais trabalho (criar as regras). Do segundo em diante, a maior parte já chega classificada.</p>
      </section>

      <section class="card">
        <h2>Lançamentos e extratos (sem repetir nada)</h2>
        <p class="sub">Há duas formas de lançar — use a que for mais prática:</p>
        <ol class="passos">
          <li><b>Só o total do mês</b>, na tela Mês (como na planilha).</li>
          <li><b>Gasto por gasto</b>, na tela Lançamentos: à mão (ex.: toda semana) ou <b>importando o extrato</b> do banco/cartão (arquivo OFX ou CSV).</li>
        </ol>
        <p class="sub">Como o site evita contar duas vezes:</p>
        <ul class="passos">
          <li>Quando um campo do mês tem lançamentos, o valor do mês é <b>a soma deles</b> e o campo fica travado na tela Mês.</li>
          <li>Ao importar, cada movimentação do banco tem uma identidade. <b>Importar o mesmo extrato de novo, ou um que repete dias, pula o que já entrou.</b></li>
          <li>Ao lançar à mão algo com mesma data, valor e descrição de um lançamento existente, o site <b>avisa antes de salvar</b>.</li>
          <li>Na importação, o que parece repetido de um lançamento manual vem <b>desmarcado</b> para você conferir.</li>
          <li>Pagamento da fatura do cartão e transferência entre contas: marque como <b>Ignorar</b> (não é gasto).</li>
        </ul>
      </section>

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
    <div class="titulo"><div><h1>Ajustes</h1><p class="sub">Configure o que o site usa nos cálculos. Conta: ${esc(S.user.email || '')}</p>
      <p class="sub"><a href="#/ajuda">Ajuda (como usar)</a> · <a href="#/geral">Todos os anos</a></p></div></div>

    <section class="card">
      <h2>1. Contas e cartões</h2>
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
          </div>`).join('') || '<p class="sub">Nenhuma categoria ainda.</p>'}
      </div>
      <form class="nova-cat">
        <input name="nome" placeholder="Nova conta ou cartão (ex.: Cartão empresa)" required>
        <select name="tipo"><option value="credito">Crédito</option><option value="debito">Débito</option></select>
        <button class="btn primario">Adicionar</button>
      </form>
    </section>

    <section class="card" id="classes">
      <h2>2. Categorias de gasto</h2>
      <p class="sub"><b>Com o que foi gasto</b>, de qualquer conta: Funcionários, Assinaturas, Telefone… O <b>lado padrão</b> decide sozinho se o gasto é
        pessoal ou da empresa ao classificar (ex.: Funcionários = Empresa). "Depende" mantém o que estiver no lançamento.</p>
      ${!S.data.classes.length ? '<div class="acoes"><button class="btn primario" data-a="sugeridas">Criar categorias sugeridas</button></div>' : ''}
      <div class="lista-cat">
        ${classes().map((cl) => {
          const usos = S.data.lancamentos.filter((l) => l.classe_id === cl.id).length;
          return `
          <div class="cat classe ${cl.ativo === false ? 'inativa' : ''}" data-classe-id="${cl.id}">
            <input type="color" name="cor" value="${esc(cl.cor)}" aria-label="Cor">
            <input name="nome" value="${esc(cl.nome)}" aria-label="Nome">
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
      <form class="nova-classe">
        <input type="color" name="cor" value="#0d9488" aria-label="Cor">
        <input name="nome" placeholder="Nova categoria (ex.: Contador, Frete)" required>
        <select name="escopo_padrao"><option value="">Depende</option><option value="pessoal">Pessoal</option><option value="empresa">Empresa</option></select>
        <button class="btn primario">Adicionar</button>
      </form>
    </section>

    <section class="card" id="regras">
      <h2>3. Regras automáticas</h2>
      <p class="sub">Quando a descrição de um gasto contém o texto, ele já entra com essa categoria (e lado). As regras são criadas na tela
        <a href="#/classificar">Classificar</a>; aqui dá para ajustar o texto (ex.: deixar só "joao silva") ou apagar.</p>
      ${!S.data.regras.length ? '<p class="sub"><i>Nenhuma regra ainda.</i></p>' : `
      <div class="lista-regras">
        ${[...S.data.regras].sort((a, b) => (classePorId(a.classe_id)?.nome || '').localeCompare(classePorId(b.classe_id)?.nome || '') || a.texto.localeCompare(b.texto)).map((r) => `
          <div class="regra" data-regra-id="${r.id}">
            <span class="sub">contém</span>
            <input name="texto" value="${esc(r.texto)}" aria-label="Texto">
            <span class="sub">→</span>
            <select name="classe_id" aria-label="Categoria">${classes().map((cl) => `<option value="${cl.id}" ${cl.id === r.classe_id ? 'selected' : ''}>${esc(cl.nome)}</option>`).join('')}</select>
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

    <section class="card">
      <h2>4. Metas</h2>
      <p class="sub">Calculadas sobre a receita: quanto investir, quantos meses de reserva ter e o máximo para gastar. Aparecem nas telas Mês e Ano.</p>
      <form class="prefs">
        <label class="campo"><span>% esperado para investir</span><input name="pct_investir" inputmode="decimal" value="${fmtNum(p.pct_investir * 100)}"></label>
        <label class="campo"><span>Reserva esperada (meses de receita)</span><input name="meses_reserva" inputmode="decimal" value="${fmtNum(p.meses_reserva)}"></label>
        <label class="campo"><span>% máximo para gastar</span><input name="pct_max_gasto" inputmode="decimal" value="${fmtNum(p.pct_max_gasto * 100)}"></label>
        <button class="btn primario">Salvar</button>
      </form>
    </section>

    <section class="card">
      <h2>5. Importar planilha do Excel</h2>
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
      <h2>6. Backup</h2>
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
    row.querySelector('[data-a="arquivar"]')?.addEventListener('click', async () => { await salvar({ ativo: cl.ativo === false }); render(); });
    row.querySelector('[data-a="excluir"]')?.addEventListener('click', async () => {
      if (!confirm(`Excluir a categoria "${cl.nome}"? As regras dela também serão apagadas.`)) return;
      try {
        await S.store.deleteClasse(cl.id);
        S.data.classes = S.data.classes.filter((x) => x.id !== cl.id);
        S.data.regras = S.data.regras.filter((r) => r.classe_id !== cl.id);
        render();
      } catch (e) { toast(e.message, 'erro'); }
    });
  });
  main.querySelector('.nova-classe').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      S.data.classes.push(await S.store.saveClasse({
        perfil_id: S.perfilId, nome: f.nome.value.trim(), cor: f.cor.value, escopo_padrao: f.escopo_padrao.value || null,
        ordem: S.data.classes.length + 1, ativo: true,
      }));
      toast('Categoria adicionada.');
      render();
    } catch (ex) { toast(ex.message, 'erro'); }
  });

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
  main.querySelector('.meus-nomes').addEventListener('submit', async (e) => {
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
  mes: svg('<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/><path d="M8.5 14.5l2.2 2.2 4.8-4.8"/>'),
  geral: svg('<path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 5-6"/>'),
  ano: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18"/>'),
  ajustes: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  mais: svg('<path d="M12 5v14M5 12h14"/>'),
  editar: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>'),
  classificar: svg('<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.5"/>'),
  categorias: svg('<path d="M21.2 15.9A10 10 0 1 1 8 2.8"/><path d="M22 12A10 10 0 0 0 12 2v10z"/>'),
  lista: svg('<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r="1"/><circle cx="3.5" cy="12" r="1"/><circle cx="3.5" cy="18" r="1"/>'),
  upload: svg('<path d="M12 15V3M7 8l5-5 5 5"/><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>'),
  ajuda: svg('<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6"/><path d="M12 17h.01"/>'),
};

boot();
