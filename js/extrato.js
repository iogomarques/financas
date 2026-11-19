// Leitura de extratos bancários / de cartão no próprio navegador (o arquivo não sai do computador).
// Formatos: OFX (Itaú, Bradesco, Santander, BB, Caixa, Nubank, Inter...) e CSV.
//
// Cada movimentação recebe uma "chave" (identidade). O banco de dados recusa duas
// movimentações com a mesma chave, então importar o mesmo extrato duas vezes — ou um
// extrato que repete dias de uma importação anterior — nunca duplica nada.
//   OFX e PDF: chave = data + valor + descrição + nº da conta + nº da ocorrência no arquivo.
//     O FITID do OFX não é usado: o Santander manda "000000" para quase tudo, e usar a mesma regra
//     do PDF faz o mesmo mês importado em PDF e depois em OFX (ou o contrário) não duplicar.
//   CSV com coluna de identificador: chave = identificador
//   CSV sem identificador: igual ao OFX/PDF
//     (o nº da ocorrência permite duas compras iguais no mesmo dia sem perder nenhuma)

/** Normaliza descrição para comparar: minúsculas, sem acento, sem espaços extras. */
export function normDesc(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

async function lerTexto(file) {
  const buf = await file.arrayBuffer();
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('windows-1252').decode(buf); // OFX de bancos brasileiros costuma vir assim
  }
}

/** "1.234,56" / "-1234.56" / "R$ -12,00" → número */
function numero(s) {
  let t = String(s ?? '').replace(/R\$/gi, '').replace(/\s/g, '');
  if (!t) return NaN;
  let neg = false;
  if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1); }
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  const v = parseFloat(t);
  return neg ? -v : v;
}

/** "14/11/2026", "14/11/26", "2026-11-14", "20261114..." → "2026-11-14" */
function dataISO(s) {
  const t = String(s || '').trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{4})(\d{2})(\d{2})/.exec(t);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(t);
  if (m) {
    const ano = m[3].length === 2 ? '20' + m[3] : m[3];
    return `${ano}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  return null;
}

function chavesPorOcorrencia(linhas, conta) {
  const cont = new Map();
  for (const l of linhas) {
    if (l.chave) continue;
    const base = `${l.data}|${l.valor.toFixed(2)}|${normDesc(l.descricao).slice(0, 80)}|${conta}`;
    const n = (cont.get(base) || 0) + 1;
    cont.set(base, n);
    l.chave = `h:${base}|${n}`;
  }
  return linhas;
}

/* --------------------------------------------------------------- OFX */
function lerOFX(texto) {
  const tag = (bloco, nome) => {
    const m = new RegExp(`<${nome}>([^<\\r\\n]*)`, 'i').exec(bloco);
    return m ? m[1].trim() : '';
  };
  // só os dígitos, sem zeros à esquerda: o mesmo número que o PDF mostra (ex.: "000012345678" = "01.234567-8")
  const conta = tag(texto, 'ACCTID').replace(/\D/g, '').replace(/^0+/, '') || 'ofx';
  const cartao = /<CCSTMTRS>/i.test(texto);
  const linhas = [];
  const partes = texto.split(/<STMTTRN>/i).slice(1);
  for (const p of partes) {
    const bloco = p.split(/<\/STMTTRN>/i)[0];
    const data = dataISO(tag(bloco, 'DTPOSTED'));
    const valor = numero(tag(bloco, 'TRNAMT'));
    // Santander e outros às vezes repetem espaços no meio do texto ("PIX ENVIADO        FULANO")
    const memo = tag(bloco, 'MEMO').replace(/\s{2,}/g, ' ');
    const nome = tag(bloco, 'NAME').replace(/\s{2,}/g, ' ');
    const descricao = [nome, memo].filter(Boolean).filter((x, i, a) => a.indexOf(x) === i).join(' — ') || 'Sem descrição';
    const fitid = tag(bloco, 'FITID');
    if (!data || !Number.isFinite(valor) || valor === 0) continue;
    linhas.push({ data, valor, descricao, fitid });
  }
  // Identidade por data + valor + descrição (ver o comentário no topo): igual para OFX e PDF
  for (const l of linhas) { l.chave = null; delete l.fitid; }
  const saldo = numero(tag(texto, 'BALAMT'));
  return {
    formato: cartao ? 'OFX (cartão)' : 'OFX (conta)', conta, cartao, linhas: chavesPorOcorrencia(linhas, conta),
    saldoBanco: Number.isFinite(saldo) ? { valor: saldo, data: dataISO(tag(texto, 'DTASOF')) } : null,
  };
}

/* --------------------------------------------------------------- CSV */
function dividirCSV(linha, sep) {
  const out = [];
  let atual = '', aspas = false;
  for (let i = 0; i < linha.length; i++) {
    const ch = linha[i];
    if (ch === '"') {
      if (aspas && linha[i + 1] === '"') { atual += '"'; i++; } else aspas = !aspas;
    } else if (ch === sep && !aspas) { out.push(atual); atual = ''; } else atual += ch;
  }
  out.push(atual);
  return out.map((x) => x.trim());
}

function lerCSV(texto, nomeArquivo) {
  const linhasTxt = texto.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  if (linhasTxt.length < 2) throw new Error('O arquivo CSV está vazio.');
  // Acha a linha de cabeçalho (alguns bancos colocam linhas de título antes)
  let iCab = linhasTxt.findIndex((l) => /data|date/i.test(l) && /valor|amount|quantia|debito|débito|credito|crédito/i.test(l));
  if (iCab < 0) iCab = 0;
  const cab = linhasTxt[iCab];
  const sep = (cab.match(/;/g) || []).length >= (cab.match(/,/g) || []).length ? ';' : (cab.includes('\t') ? '\t' : ',');
  const nomes = dividirCSV(cab, sep).map(normDesc);
  const col = (re) => nomes.findIndex((n) => re.test(n));
  const cData = col(/^(data|date|dt)\b|data/);
  const cDesc = col(/descri|hist|title|titulo|lancamento|memo|estabelecimento|detalhe/);
  const cValor = col(/^valor|amount|quantia|^valor/);
  const cDeb = col(/^debito|saida/);
  const cCred = col(/^credito|entrada/);
  const cId = col(/identificador|^id$|fitid|documento|codigo/);
  if (cData < 0 || (cValor < 0 && cDeb < 0 && cCred < 0)) {
    throw new Error('Não encontrei as colunas de data e valor neste CSV. Se o banco tiver, prefira o arquivo OFX.');
  }
  const conta = String(nomeArquivo || 'csv').replace(/\.[^.]+$/, '');
  const linhas = [];
  for (const l of linhasTxt.slice(iCab + 1)) {
    const c = dividirCSV(l, sep);
    const data = dataISO(c[cData]);
    let valor;
    if (cValor >= 0) valor = numero(c[cValor]);
    else valor = (Number.isFinite(numero(c[cCred])) ? numero(c[cCred]) : 0) - (Number.isFinite(numero(c[cDeb])) ? Math.abs(numero(c[cDeb])) : 0);
    if (!data || !Number.isFinite(valor) || valor === 0) continue;
    const descricao = (cDesc >= 0 ? c[cDesc] : '') || 'Sem descrição';
    const id = cId >= 0 ? c[cId] : '';
    linhas.push({ data, valor, descricao, chave: id ? `csv:${id}` : null });
  }
  return { formato: 'CSV', conta, cartao: false, linhas: chavesPorOcorrencia(linhas, conta) };
}

/**
 * Lê o arquivo do extrato.
 * Devolve { formato, conta, cartao, linhas: [{data, valor (negativo = saída), descricao, chave, parcela?, parcelas?, portador?}],
 *           conferencia?: {ok, texto}, cartaoInfo?: {diaFechamento, diaVencimento, limite} }.
 */
export async function lerExtrato(file) {
  // PDF (extrato da conta ou fatura do cartão): leitor próprio, carregado só quando precisa
  const inicio = new Uint8Array(await file.slice(0, 5).arrayBuffer());
  if (/\.pdf$/i.test(file.name) || String.fromCharCode(...inicio) === '%PDF-') {
    const { lerPDF } = await import('./pdf-extrato.js?v=20261119195141');
    const r = await lerPDF(file);
    chavesPorOcorrencia(r.linhas, r.conta);
    return r;
  }
  const texto = await lerTexto(file);
  if (/<OFX>|OFXHEADER/i.test(texto)) return lerOFX(texto);
  if (/\.(csv|txt)$/i.test(file.name) || texto.includes(';') || texto.includes(',')) return lerCSV(texto, file.name);
  throw new Error('Formato não reconhecido. Use o PDF, OFX ou CSV exportado pelo banco.');
}
