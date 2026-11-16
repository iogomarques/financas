// Importa a planilha FINANÇAS GERAIS.xlsx direto no navegador (o arquivo não é enviado a lugar nenhum).
// Lê cada aba com nome de ano (2026, 2027...), linhas 2–13 = Jan–Dez.
// As colunas entre "RECEITA TOTAL" e "TOTAL DESPESAS" viram categorias de despesa.

const SHEETJS = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';

function loadSheetJS() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = SHEETJS;
    s.onload = () => resolve(window.XLSX);
    s.onerror = () => reject(new Error('Não foi possível carregar o leitor de Excel. Verifique a internet.'));
    document.head.appendChild(s);
  });
}

const norm = (h) => String(h ?? '').toUpperCase().replace(/:/g, '').replace(/\s+/g, ' ').trim();

function nomeCategoria(header) {
  let n = norm(header).replace(/^DESPESAS?\s+/, '');
  n = n.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());
  return n.replace(/\bDebito\b/g, 'Débito').replace(/\bCredito\b/g, 'Crédito');
}

function tipoCategoria(header) {
  return /D[EÉ]BITO/.test(norm(header)) ? 'debito' : 'credito';
}

function celula(ws, XLSX, r, c) {
  const cell = ws[XLSX.utils.encode_cell({ r, c })];
  if (!cell || cell.v === '' || cell.v === null || cell.v === undefined) return { value: null, formula: null };
  const value = typeof cell.v === 'number' ? Math.round(cell.v * 100) / 100 : Number(String(cell.v).replace(',', '.'));
  if (!Number.isFinite(value)) return { value: null, formula: null };
  // Guarda a conta original só quando é aritmética pura (ex.: =1598.4-38.9), não referência a outras células.
  const f = cell.f && /^[0-9+\-*/().\s]+$/.test(cell.f) && /[+\-*/]/.test(cell.f.replace(/^-/, '')) ? cell.f.replace(/\s+/g, '') : null;
  return { value, formula: f };
}

/**
 * Lê o arquivo e devolve { categorias: [{nome, tipo}], meses: [{ano, mes, ..., despesasPorNome}] }.
 */
export async function lerPlanilha(file) {
  const XLSX = await loadSheetJS();
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array', cellFormula: true });
  const categorias = new Map();
  const meses = [];

  for (const nome of wb.SheetNames) {
    if (!/^\d{4}$/.test(nome.trim())) continue;
    const ano = Number(nome.trim());
    const ws = wb.Sheets[nome];
    if (!ws['!ref']) continue;
    const range = XLSX.utils.decode_range(ws['!ref']);
    const headers = [];
    for (let c = 0; c <= Math.min(range.e.c, 30); c++) {
      const cell = ws[XLSX.utils.encode_cell({ r: 0, c })];
      headers.push(norm(cell?.v));
    }
    const col = (pred) => headers.findIndex(pred);
    const cReceita = col((h) => h.startsWith('RECEITA'));
    const cTotal = col((h) => h === 'TOTAL DESPESAS');
    const cInvest = col((h) => h.startsWith('INVESTIMENTO'));
    const cRend = col((h) => h.startsWith('RENDIMENTO'));
    const cSaldoIni = col((h) => h === 'SALDO INICIAL');
    if (cReceita < 0 || cTotal < 0) continue;

    const catCols = [];
    for (let c = cReceita + 1; c < cTotal; c++) {
      if (!headers[c]) continue;
      const nomeCat = nomeCategoria(headers[c]);
      if (!categorias.has(nomeCat)) categorias.set(nomeCat, { nome: nomeCat, tipo: tipoCategoria(headers[c]) });
      catCols.push({ c, nome: nomeCat });
    }

    for (let r = 1; r <= 12; r++) {
      const mes = r; // linha 2 = janeiro ... linha 13 = dezembro
      const rec = { ano, mes, despesasPorNome: {}, formulas: {} };
      let tem = false;
      const pega = (c, campo) => {
        if (c < 0) return;
        const { value, formula } = celula(ws, XLSX, r, c);
        rec[campo] = value;
        if (formula) rec.formulas[campo] = formula;
        if (value !== null) tem = true;
      };
      pega(cReceita, 'receita');
      pega(cInvest, 'investimento');
      pega(cRend, 'rendimento');
      pega(cSaldoIni, 'saldo_inicial');
      for (const { c, nome: nomeCat } of catCols) {
        const { value, formula } = celula(ws, XLSX, r, c);
        if (value === null) continue;
        rec.despesasPorNome[nomeCat] = { value, formula };
        tem = true;
      }
      if (tem) meses.push(rec);
    }
  }
  return { categorias: [...categorias.values()], meses };
}
