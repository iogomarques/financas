// Cálculos — mesma lógica da planilha FINANÇAS GERAIS.
//
// Por mês:
//   TOTAL DESPESAS  = soma das categorias (vazio se nenhuma foi preenchida)
//   SALDO MÊS       = RECEITA − TOTAL DESPESAS
//   SALDO FINAL     = SALDO INICIAL do mês seguinte (inclusive janeiro do ano seguinte)
//   RESULTADO SALDO = SALDO FINAL − SALDO INICIAL (só quando os dois existem)
//
// Médias contam apenas os meses que têm o valor preenchido (como COUNT/AVERAGE no Excel),
// por isso meses sem dados não puxam as médias para baixo.

export const MESES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
export const MESES_CURTO = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const key = (ano, mes) => ano * 100 + mes;
const sum = (a) => a.reduce((x, y) => x + y, 0);
const avg = (a) => (a.length ? sum(a) / a.length : 0);

export function indexMeses(meses) {
  const map = new Map();
  for (const m of meses) map.set(key(m.ano, m.mes), m);
  return map;
}

export function mesTemDados(rec) {
  if (!rec) return false;
  if (['receita', 'investimento', 'rendimento', 'saldo_inicial'].some((k) => num(rec[k]) !== null)) return true;
  return Object.values(rec.despesas || {}).some((v) => num(v) !== null);
}

export function linhaMes(ano, mes, map, cats) {
  const rec = map.get(key(ano, mes)) || null;
  const next = map.get(mes === 12 ? key(ano + 1, 1) : key(ano, mes + 1));
  const desp = {};
  let total = 0, deb = 0, cred = 0, anyDesp = false, anyDeb = false, anyCred = false;
  for (const c of cats) {
    const v = num(rec?.despesas?.[c.id]);
    desp[c.id] = v;
    if (v === null) continue;
    anyDesp = true;
    total += v;
    if (c.tipo === 'debito') { deb += v; anyDeb = true; } else { cred += v; anyCred = true; }
  }
  const receita = num(rec?.receita);
  const totalDesp = anyDesp ? total : null;
  const saldoIni = num(rec?.saldo_inicial);
  const saldoFin = num(next?.saldo_inicial);
  return {
    ano, mes, rec,
    receita,
    desp,
    totalDesp,
    debito: anyDeb ? deb : null,
    credito: anyCred ? cred : null,
    saldoMes: totalDesp === null ? null : (receita ?? 0) - totalDesp,
    investimento: num(rec?.investimento),
    rendimento: num(rec?.rendimento),
    saldoIni,
    saldoFin,
    resultado: saldoIni === null || saldoFin === null ? null : saldoFin - saldoIni,
    temDados: mesTemDados(rec),
  };
}

export function linhasDoAno(ano, map, cats) {
  const rows = [];
  for (let mes = 1; mes <= 12; mes++) rows.push(linhaMes(ano, mes, map, cats));
  return rows;
}

export function estatisticas(rows, cats, prefs) {
  const vals = (k) => rows.map((r) => r[k]).filter((v) => v !== null);
  const saldosIni = vals('saldoIni');
  const resultados = vals('resultado');
  const mediaReceita = avg(vals('receita'));
  const porCategoria = cats.map((c) => {
    const v = rows.map((r) => r.desp[c.id]).filter((x) => x !== null && x !== undefined);
    return { cat: c, total: sum(v), media: avg(v), meses: v.length };
  });
  return {
    mesesComDados: rows.filter((r) => r.temDados).length,
    receitaTotal: sum(vals('receita')),
    gastoTotal: sum(vals('totalDesp')),
    debitoTotal: sum(vals('debito')),
    creditoTotal: sum(vals('credito')),
    saldoTotal: sum(vals('saldoMes')),
    mediaReceita,
    mediaDespesas: avg(vals('totalDesp')),
    mediaDebito: avg(vals('debito')),
    mediaCredito: avg(vals('credito')),
    porCategoria,
    totalInvestido: sum(vals('investimento')),
    mediaInvestimento: avg(vals('investimento')),
    totalRendimento: sum(vals('rendimento')),
    saldoInicio: saldosIni.length ? saldosIni[0] : null,
    ultimoSaldo: saldosIni.length ? saldosIni[saldosIni.length - 1] : null,
    resultadoAcumulado: sum(resultados),
    mediaResultado: avg(resultados),
    mesesNegativos: resultados.filter((v) => v < 0).length,
    investirEsperado: mediaReceita * (prefs?.pct_investir ?? 0.15),
    reservaEsperada: mediaReceita * (prefs?.meses_reserva ?? 6),
    maximoGastar: mediaReceita * (prefs?.pct_max_gasto ?? 0.7),
  };
}

/**
 * Junta os lançamentos individuais aos meses.
 * Para cada campo (receita, rendimento, investimento, cada categoria) que tiver lançamentos
 * no mês, o valor do mês passa a ser A SOMA DOS LANÇAMENTOS — o valor digitado no mês é
 * ignorado nesse campo. Assim nunca se soma duas vezes o mesmo dinheiro.
 * Cada mês devolvido traz `auto`: { campo: quantidade de lançamentos }.
 */
export function aplicarLancamentos(meses, lancamentos) {
  const out = new Map();
  for (const m of meses) out.set(key(m.ano, m.mes), { ...m, despesas: { ...(m.despesas || {}) }, auto: {} });
  const somas = new Map();
  for (const l of lancamentos || []) {
    const [a, mm] = String(l.data).split('-').map(Number);
    const k = key(a, mm);
    if (!somas.has(k)) somas.set(k, { ano: a, mes: mm, campos: {} });
    const campo = l.destino === 'despesa' ? 'cat:' + l.categoria_id : l.destino;
    const s = somas.get(k).campos;
    s[campo] = s[campo] || { total: 0, n: 0 };
    s[campo].total += Number(l.valor);
    s[campo].n += 1;
  }
  for (const [k, { ano, mes, campos }] of somas) {
    if (!out.has(k)) out.set(k, { ano, mes, receita: null, investimento: null, rendimento: null, saldo_inicial: null, despesas: {}, formulas: {}, auto: {} });
    const rec = out.get(k);
    for (const [campo, { total, n }] of Object.entries(campos)) {
      const v = Math.round(total * 100) / 100;
      if (campo.startsWith('cat:')) rec.despesas[campo.slice(4)] = v;
      else rec[campo] = v;
      rec.auto[campo] = n;
    }
  }
  return [...out.values()];
}

/** Anos que têm algum dado lançado, em ordem. */
export function anosComDados(meses) {
  return [...new Set(meses.filter(mesTemDados).map((m) => m.ano))].sort((a, b) => a - b);
}
