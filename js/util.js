// Utilidades: formatação e avaliação de expressões (ex.: "=1598,4-38,9")

const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const dec = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function fmtBRL(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return brl.format(v);
}

export function fmtNum(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return '';
  return dec.format(v);
}

export function fmtPct(v) {
  return `${(v * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export const round2 = (v) => Math.round(v * 100) / 100;

/** Normaliza números no formato brasileiro ("1.598,40") para o formato JS ("1598.40"). */
function normalize(s) {
  s = s.replace(/R\$/gi, '').replace(/\s+/g, '');
  if (s.includes(',')) {
    s = s.replace(/\.(?=\d{3}(?:\D|$))/g, ''); // pontos de milhar
    s = s.replace(/,/g, '.');
  }
  return s;
}

/**
 * Avalia o texto digitado num campo de valor.
 * Aceita número simples ("1892,59") ou conta ("=1598,4-38,9", "140,94+109,56").
 * Retorna { value, formula } — formula só é preenchida quando há uma conta.
 * Lança Error com mensagem amigável se o texto for inválido.
 */
export function parseExpr(input) {
  if (input === null || input === undefined) return { value: null, formula: null };
  let raw = String(input).trim();
  if (!raw) return { value: null, formula: null };
  if (raw.startsWith('=')) raw = raw.slice(1);
  const s = normalize(raw);
  if (!/^[0-9+\-*/().]+$/.test(s)) throw new Error('Use apenas números e + - * / ( )');

  let i = 0;
  const peek = () => s[i];
  function number() {
    const m = /^\d*\.?\d+|^\d+\.?/.exec(s.slice(i));
    if (!m) throw new Error('Expressão inválida');
    i += m[0].length;
    return parseFloat(m[0]);
  }
  function factor() {
    if (peek() === '-') { i++; return -factor(); }
    if (peek() === '+') { i++; return factor(); }
    if (peek() === '(') {
      i++;
      const v = expr();
      if (peek() !== ')') throw new Error('Parêntese não fechado');
      i++;
      return v;
    }
    return number();
  }
  function term() {
    let v = factor();
    while (peek() === '*' || peek() === '/') {
      const op = s[i++];
      const r = factor();
      if (op === '/' && r === 0) throw new Error('Divisão por zero');
      v = op === '*' ? v * r : v / r;
    }
    return v;
  }
  function expr() {
    let v = term();
    while (peek() === '+' || peek() === '-') {
      const op = s[i++];
      const r = term();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  }
  const value = expr();
  if (i !== s.length || !Number.isFinite(value)) throw new Error('Expressão inválida');
  const isFormula = /[+\-*/()]/.test(s.replace(/^-/, ''));
  return { value: round2(value), formula: isFormula ? s : null };
}

/** Texto para exibir num campo de edição: a conta original (se houver) ou o número. */
export function toInputText(value, formula) {
  if (formula) return '=' + formula.replace(/\./g, ',');
  if (value === null || value === undefined) return '';
  return String(value).replace('.', ',');
}

export function uid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}
