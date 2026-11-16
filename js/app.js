import { createStore, PREFS_PADRAO } from './store.js';
import { MESES, MESES_CURTO, indexMeses, linhasDoAno, estatisticas, anosComDados, mesTemDados } from './calc.js';
import { fmtBRL, fmtNum, fmtPct, esc, parseExpr, toInputText, round2 } from './util.js';
import { lerPlanilha } from './importer.js';

const app = document.getElementById('app');
const S = {
  store: null,
  user: null,
  data: { categorias: [], meses: [], prefs: { ...PREFS_PADRAO } },
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
const cats = () => [...S.data.categorias].sort((a, b) => (a.ordem ?? 0) - (b.ordem ?? 0) || a.nome.localeCompare(b.nome));
const anoAtual = () => new Date().getFullYear();

function rota() {
  const h = location.hash.replace(/^#\/?/, '').split('/');
  if (h[0] === 'ano') return { view: 'ano', ano: Number(h[1]) || anoAtual() };
  if (h[0] === 'ajustes') return { view: 'ajustes' };
  return { view: 'geral' };
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
    if (!S.autorizado) { S.data = { categorias: [], meses: [], prefs: { ...PREFS_PADRAO } }; return; }
    S.data = await S.store.load();
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
  if (r.view === 'geral') renderGeral(main);
  else if (r.view === 'ano') renderAno(main, r.ano);
  else renderAjustes(main);
  bindShell();
}

function shell(r) {
  const item = (href, view, label, icon) =>
    `<a href="${href}" class="${r.view === view ? 'ativo' : ''}">${icon}<span>${label}</span></a>`;
  const ano = r.view === 'ano' ? r.ano : anoAtual();
  return `
  <header class="topo">
    <div class="marca"><img src="icons/icon.svg" alt="" width="28" height="28"><span>Finanças</span></div>
    <nav class="nav">
      ${item('#/geral', 'geral', 'Visão geral', ICON.geral)}
      ${item(`#/ano/${ano}`, 'ano', 'Anos', ICON.ano)}
      ${item('#/ajustes', 'ajustes', 'Ajustes', ICON.ajustes)}
    </nav>
    <button class="btn primario lancar" data-acao="lancar">${ICON.mais}<span>Lançar mês</span></button>
  </header>
  ${S.store.mode === 'local' ? '<div class="aviso">Modo local: os dados ficam só neste navegador. Conecte o Supabase para acessar de qualquer dispositivo.</div>' : ''}
  <main></main>`;
}

function bindShell() {
  app.querySelector('[data-acao="lancar"]')?.addEventListener('click', () => {
    const d = new Date();
    const r = rota();
    // Sugere o último mês lançado + 1, ou o mês atual
    const ultimos = S.data.meses.filter(mesTemDados).sort((a, b) => b.ano - a.ano || b.mes - a.mes);
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
      <div class="marca grande"><img src="icons/icon.svg" alt="" width="40" height="40"><span>Finanças Gerais</span></div>
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
      <div class="marca grande"><img src="icons/icon.svg" alt="" width="40" height="40"><span>Finanças Gerais</span></div>
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
function todasAsLinhas() {
  const map = indexMeses(S.data.meses);
  const anos = anosComDados(S.data.meses);
  const porAno = anos.map((ano) => ({ ano, linhas: linhasDoAno(ano, map, cats()) }));
  return { anos, porAno, todas: porAno.flatMap((a) => a.linhas) };
}

function renderGeral(main) {
  const { porAno, todas } = todasAsLinhas();
  const c = cats();
  const st = estatisticas(todas, c, S.data.prefs);

  if (!st.mesesComDados) {
    main.innerHTML = `
      <section class="vazio card">
        <h1>Bem-vindo às suas finanças</h1>
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
  main.innerHTML = `
    <div class="titulo">
      <div><h1>Visão geral</h1><p class="sub">Todos os anos · ${st.mesesComDados} ${st.mesesComDados === 1 ? 'mês lançado' : 'meses lançados'}</p></div>
    </div>

    <section class="kpis">
      ${kpi('Receita total', st.receitaTotal)}
      ${kpi('Gasto total', st.gastoTotal)}
      ${kpi('Saldo total (receita − despesas)', st.saldoTotal, true)}
      ${kpi('Último saldo informado', st.ultimoSaldo)}
    </section>

    <section class="planilha info-esq">
    ${blocoInfo('Informações gerais (todos os anos)', [
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
        ['Resultado acumulado (todos)', st.resultadoAcumulado, true],
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
              const s = estatisticas(linhas, c, S.data.prefs);
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
function renderAno(main, ano) {
  const c = cats();
  const map = indexMeses(S.data.meses);
  const linhas = linhasDoAno(ano, map, c);
  // Mostra categorias ativas + inativas que têm valor neste ano
  const colunas = c.filter((cat) => cat.ativo !== false || linhas.some((l) => l.desp[cat.id] !== null));
  const st = estatisticas(linhas, c, S.data.prefs);
  const anos = [...new Set([...anosComDados(S.data.meses), anoAtual(), ano])].sort((a, b) => a - b);

  const td = (v, colorir = false, calc = false) =>
    `<td class="${calc ? 'calc ' : ''}${colorir ? cls(v) : ''}">${v === null || v === undefined ? '' : fmtNum(v)}</td>`;
  const tdF = (v, f) => `<td${f ? ` title="=${esc(f.replace(/\./g, ','))}"` : ''}>${v === null || v === undefined ? '' : fmtNum(v)}${f ? '<i class="fx">fx</i>' : ''}</td>`;
  const tot = (k) => linhas.reduce((s, l) => s + (l[k] ?? 0), 0);

  main.innerHTML = `
    <div class="titulo">
      <div class="seletor-ano">
        <a class="btn icone" href="#/ano/${ano - 1}" aria-label="Ano anterior">‹</a>
        <select aria-label="Ano">${[...new Set([...anos, ano - 1, ano + 1])].sort().map((a) => `<option ${a === ano ? 'selected' : ''}>${a}</option>`).join('')}</select>
        <a class="btn icone" href="#/ano/${ano + 1}" aria-label="Próximo ano">›</a>
      </div>
      <p class="sub">${st.mesesComDados ? `${st.mesesComDados} ${st.mesesComDados === 1 ? 'mês lançado' : 'meses lançados'} · toque num mês para editar` : 'Nenhum mês lançado neste ano · toque num mês para lançar'}</p>
    </div>

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
            <th>Investimento</th><th>Rendimento</th><th>Saldo inicial</th>
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
        [`Dinheiro esperado investir (${fmtPct(S.data.prefs.pct_investir)})`, st.investirEsperado],
        [`Reserva esperada (${S.data.prefs.meses_reserva}× receita)`, st.reservaEsperada],
        [`Dinheiro máximo para gastar (${fmtPct(S.data.prefs.pct_max_gasto)})`, st.maximoGastar],
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

  main.querySelector('select').addEventListener('change', (e) => (location.hash = `#/ano/${e.target.value}`));
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
  for (const c of padrao) S.data.categorias.push(await S.store.saveCategoria(c));
}

async function abrirEditor(ano, mes) {
  try { await garantirCategorias(); } catch (e) { toast(e.message, 'erro'); return; }
  const rec = S.data.meses.find((m) => m.ano === ano && m.mes === mes) || { ano, mes, despesas: {}, formulas: {} };
  const f = rec.formulas || {};
  const c = cats().filter((cat) => cat.ativo !== false || (rec.despesas?.[cat.id] ?? null) !== null);
  const prox = S.data.meses.find((m) => (mes === 12 ? m.ano === ano + 1 && m.mes === 1 : m.ano === ano && m.mes === mes + 1));

  const campo = (name, label, value, formula, hint = '') => `
    <label class="campo">
      <span>${esc(label)}</span>
      <input name="${esc(name)}" inputmode="decimal" autocomplete="off" placeholder="0,00" value="${esc(toInputText(value, formula))}">
      <small class="calc-preview"></small>
      ${hint ? `<small class="hint">${hint}</small>` : ''}
    </label>`;

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
          ${campo('rendimento', 'Rendimento', rec.rendimento, f.rendimento)}
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
    const out = { ano, mes, despesas: {}, formulas: {}, observacao: form.observacao.value.trim() || null };
    let erro = null;
    form.querySelectorAll('input[name]').forEach((inp) => {
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
    const total = vals.length ? vals.reduce((a, b) => a + b, 0) : null;
    const saldo = total === null ? null : (out.receita ?? 0) - total;
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
        if (mesTemDados(rec) || rec.observacao) await S.store.deleteMes(ano, mes);
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
      if (rota().view !== 'ano' || rota().ano !== ano) location.hash = `#/ano/${ano}`;
      else render();
    }
  });
  dlg.querySelector('[data-acao="cancelar"]').addEventListener('click', fechar);
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); fechar(); });
  dlg.querySelector('a.link-peq').addEventListener('click', fechar);
  dlg.querySelectorAll('[data-nav]').forEach((b) => b.addEventListener('click', async () => {
    const d = Number(b.dataset.nav);
    const alvo = new Date(ano, mes - 1 + d, 1);
    fechar();
    abrirEditor(alvo.getFullYear(), alvo.getMonth() + 1);
  }));
  dlg.querySelector('[data-acao="limpar"]')?.addEventListener('click', async () => {
    if (!confirm(`Apagar todos os valores de ${MESES[mes - 1]} de ${ano}?`)) return;
    try {
      await S.store.deleteMes(ano, mes);
      S.data.meses = S.data.meses.filter((m) => !(m.ano === ano && m.mes === mes));
      toast('Mês apagado.');
      fechar();
      render();
    } catch (e) { toast(e.message, 'erro'); }
  });
  dlg.showModal();
  if (!mesTemDados(rec)) form.querySelector('input[name="receita"]').focus();
}

/* ============================================================ ajustes */
function renderAjustes(main) {
  const c = cats();
  const usada = (id) => S.data.meses.some((m) => m.despesas && m.despesas[id] !== undefined && m.despesas[id] !== null);
  const p = S.data.prefs;
  main.innerHTML = `
    <div class="titulo"><div><h1>Ajustes</h1><p class="sub">${esc(S.user.email || '')}</p></div></div>

    <section class="card">
      <h2>Cartões e categorias de despesa</h2>
      <p class="sub">Cada categoria vira uma coluna do ano. "Débito" entra na média de débito; "Crédito" entra no total e na média de crédito.</p>
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
        <input name="nome" placeholder="Novo cartão ou categoria (ex.: Crédito Nubank)" required>
        <select name="tipo"><option value="credito">Crédito</option><option value="debito">Débito</option></select>
        <button class="btn primario">Adicionar</button>
      </form>
    </section>

    <section class="card">
      <h2>Organização das finanças</h2>
      <p class="sub">Usado no painel "Organização finanças" de cada ano (base: média de receita por mês).</p>
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
      <h2>Backup</h2>
      <p class="sub">Baixe uma cópia de todos os dados (JSON) ou restaure um backup.</p>
      <div class="acoes">
        <button class="btn" data-a="exportar">Baixar backup</button>
        <label class="btn arquivo">Restaurar backup…<input type="file" accept=".json" data-a="restaurar" hidden></label>
      </div>
    </section>

    ${S.store.mode === 'supabase' ? '<section class="card"><h2>Conta</h2><button class="btn perigo" data-a="sair">Sair</button></section>' : ''}`;

  // --- categorias
  main.querySelectorAll('.cat').forEach((row) => {
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
      const nova = await S.store.saveCategoria({ nome: f.nome.value.trim(), tipo: f.tipo.value, ordem: S.data.categorias.length + 1, ativo: true });
      S.data.categorias.push(nova);
      toast('Categoria adicionada.');
      render();
    } catch (ex) { toast(ex.message, 'erro'); }
  });

  // --- preferências
  main.querySelector('.prefs').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      const v = (n) => parseExpr(f[n].value).value;
      const novo = { pct_investir: v('pct_investir') / 100, meses_reserva: v('meses_reserva'), pct_max_gasto: v('pct_max_gasto') / 100 };
      if (Object.values(novo).some((x) => x === null || Number.isNaN(x))) throw new Error('Preencha os três campos.');
      S.data.prefs = { ...S.data.prefs, ...(await S.store.savePrefs(novo)) };
      toast('Preferências salvas.');
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
    const blob = new Blob([JSON.stringify({ versao: 1, exportado_em: new Date().toISOString(), ...S.data }, null, 2)], { type: 'application/json' });
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
    S.data = { categorias: [], meses: [], prefs: { ...PREFS_PADRAO } };
    render();
  });
}

async function importar(lido) {
  // Reaproveita categorias com o mesmo nome; cria as que faltam.
  const porNome = new Map(S.data.categorias.map((c) => [c.nome.toLowerCase(), c]));
  let ordem = S.data.categorias.length;
  for (const nc of lido.categorias) {
    if (porNome.has(nc.nome.toLowerCase())) continue;
    const salvo = await S.store.saveCategoria({ ...nc, ordem: ++ordem, ativo: true });
    S.data.categorias.push(salvo);
    porNome.set(salvo.nome.toLowerCase(), salvo);
  }
  for (const m of lido.meses) {
    const rec = {
      ano: m.ano, mes: m.mes,
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
  geral: svg('<path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 5-6"/>'),
  ano: svg('<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/>'),
  ajustes: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  mais: svg('<path d="M12 5v14M5 12h14"/>'),
};

boot();
