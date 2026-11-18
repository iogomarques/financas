// Leitura de extratos e faturas em PDF, no próprio navegador (o arquivo não sai do computador).
// Usa o pdf.js só para tirar o texto de cada página, com a posição de cada pedaço.
//
// Formatos conhecidos (Santander):
//  • Conta PF "Extrato Consolidado Inteligente": data só na 1ª linha do dia, valor "35,00-", saldo no fim do dia.
//  • Conta PJ "Aplicativo Santander Empresas": data completa em cada linha, descrição acima/abaixo do valor.
//  • Conta PJ "Internet Banking Empresarial": linhas "Saldo do dia Cc", valor "- R$ 150,00".
//  • Fatura do cartão (Elite Mastercard): duas colunas, um bloco por cartão (titular + adicionais),
//    seções "Pagamento e Demais Créditos", "Parcelamentos" e "Despesas", e "VALOR TOTAL" por cartão.
// O leitor de conta não depende do banco: acha a tabela pelo cabeçalho (Data / Histórico ou Descrição /
// Valor ou Movimento / Saldo) e confere a sequência de saldos para garantir que nenhuma linha ficou de fora.

const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
let carregando = null;
function carregarPdfJs() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  if (!carregando) {
    carregando = new Promise((ok, erro) => {
      const s = document.createElement('script');
      s.src = PDFJS + 'pdf.min.js';
      s.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.js'; ok(window.pdfjsLib); };
      s.onerror = () => { carregando = null; erro(new Error('Não consegui carregar o leitor de PDF. Confira a internet e tente de novo.')); };
      document.head.appendChild(s);
    });
  }
  return carregando;
}

/** Texto de cada página em linhas; cada linha tem "blocos" (pedaços juntos) com a posição x. */
async function linhasDoPDF(buf) {
  const pdfjs = await carregarPdfJs();
  const doc = await pdfjs.getDocument({ data: buf }).promise;
  const linhas = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const pg = await doc.getPage(p);
    const vp = pg.getViewport({ scale: 1 });
    const tc = await pg.getTextContent();
    const itens = tc.items.filter((i) => i.str.trim()).map((i) => ({ x: i.transform[4], y: vp.height - i.transform[5], w: i.width, s: i.str }));
    const porY = [];
    for (const it of itens) {
      let l = porY.find((x) => Math.abs(x.y - it.y) <= 2);
      if (!l) { l = { y: it.y, itens: [] }; porY.push(l); }
      l.itens.push(it);
    }
    porY.sort((a, b) => a.y - b.y);
    for (const l of porY) {
      l.itens.sort((a, b) => a.x - b.x);
      const blocos = [];
      for (const it of l.itens) {
        const b = blocos[blocos.length - 1];
        const gap = b ? it.x - (b.x + b.w) : 99;
        if (b && gap < 3) { b.s += (gap > 1 ? ' ' : '') + it.s; b.w = it.x + it.w - b.x; } else blocos.push({ ...it });
      }
      blocos.forEach((b) => { b.s = b.s.replace(/\s+/g, ' ').trim(); });
      linhas.push({ pagina: p, y: Math.round(l.y), largura: vp.width, blocos, texto: blocos.map((b) => b.s).join(' ') });
    }
  }
  return linhas;
}

/** "1.234,56" · "35,00-" · "-291,03" · "- R$ 150,00" · "R$ 7.955,80" → número (ou NaN). */
function valorBR(s) {
  let t = String(s || '').replace(/R\$/gi, '').replace(/\s/g, '');
  if (!/^-?\d{1,3}(\.\d{3})*,\d{2}-?$|^-?\d+,\d{2}-?$/.test(t)) return NaN;
  let neg = false;
  if (t.endsWith('-')) { neg = true; t = t.slice(0, -1); }
  if (t.startsWith('-')) { neg = !neg; t = t.slice(1); }
  const v = parseFloat(t.replace(/\./g, '').replace(',', '.'));
  return neg ? -v : v;
}
const MESES_NOME = ['janeiro', 'fevereiro', 'marco', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const pad2 = (n) => String(n).padStart(2, '0');
const contaDigitos = (s) => String(s || '').replace(/\D/g, '').replace(/^0+/, '');

/* =========================================================== conta corrente */
const CAB_DATA = /^data$/i;
const CAB_DESC = /^(hist[oó]rico|descri[cç][aã]o)/i;
const CAB_VALOR = /^(valor|movimento)/i;
const CAB_SALDO = /^saldo/i;
const FIM_TABELA = /^(saldos por per[ií]odo|d[eé]bito autom[aá]tico em conta|compras com cart[aã]o de d[eé]bito|comprovantes de pagamento|lan[cç]amentos pendentes|investimentos|pacote de servi|saldo de contamax|saldo dispon[ií]vel$|posi[cç][aã]o em)/i;
const LINHA_SALDO = /^saldo (em|anterior|do dia|inicial|final)/i;

function lerConta(linhas) {
  const textoTodo = linhas.map((l) => l.texto).join('\n');
  // Mês/ano de referência (para datas só com dia/mês) e número da conta
  let ref = null;
  const mRef = new RegExp(`(${MESES_NOME.join('|')})\\s*/\\s*(\\d{4})`).exec(semAcento(textoTodo));
  if (mRef) ref = { mes: MESES_NOME.indexOf(mRef[1]) + 1, ano: Number(mRef[2]) };
  const mPer = /per[ií]odos?:?\s*(\d{2})\/(\d{2})\/(\d{4})\s*a\s*(\d{2})\/(\d{2})\/(\d{4})/i.exec(textoTodo);
  if (!ref && mPer) ref = { mes: Number(mPer[5]), ano: Number(mPer[6]) };
  const mConta = /conta:?\s*([\d][\d.\-]{5,})/i.exec(textoTodo) || /\b\d{4}\s+(\d{2}\.\d{6}-\d)\b/.exec(textoTodo);
  const conta = mConta ? contaDigitos(mConta[1]) : 'pdf';

  const dataISO = (s) => {
    let m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(s);
    if (m) return `${m[3]}-${m[2]}-${m[1]}`;
    m = /^(\d{2})\/(\d{2})(?!\/)/.exec(s);
    if (!m) return null;
    let ano = ref?.ano || new Date().getFullYear();
    if (ref && Number(m[2]) > ref.mes + 1) ano -= 1; // ex.: dezembro aparecendo no extrato de janeiro
    return `${ano}-${m[2]}-${m[1]}`;
  };

  // Colunas sem cabeçalho legível (ex.: PF do Santander, cabeçalho em fonte que não vira texto):
  // deduz pelas próprias linhas "dd/mm  DESCRIÇÃO ... valor [saldo]".
  const ehData = (s) => /^\d{2}\/\d{2}(\/\d{4})?$/.test(s);
  function deduzirColunas() {
    // só a 1ª tabela: para quando a data volta (depois vêm "Débito Automático", "Comprovantes"…)
    const linhasMov = [];
    let ult = null;
    for (const l of linhas) {
      if (!(l.blocos.length >= 3 && ehData(l.blocos[0].s) && Number.isFinite(valorBR(l.blocos[l.blocos.length - 1].s)))) continue;
      const d = l.blocos[0].s.split('/').slice(0, 2).reverse().join('');
      if (ult && d < ult) break;
      ult = d; linhasMov.push(l);
    }
    if (linhasMov.length < 3) return null;
    const xs = (arr) => arr.sort((a, b) => a - b);
    const xDesc = xs(linhasMov.map((l) => l.blocos[1].x))[Math.floor(linhasMov.length / 2)];
    const comDois = linhasMov.filter((l) => l.blocos.filter((b) => Number.isFinite(valorBR(b.s))).length >= 2);
    const numeros = (l) => l.blocos.filter((b) => Number.isFinite(valorBR(b.s)));
    const xValor = Math.min(...(comDois.length ? comDois : linhasMov).map((l) => numeros(l)[0].x));
    const xSaldo = comDois.length ? Math.min(...comDois.map((l) => numeros(l)[numeros(l).length - 1].x)) : undefined;
    return { xDesc, xValor: xValor + 50, xDoc: undefined, xSaldo, deduzido: true };
  }

  // Percorre as linhas: acha o cabeçalho da tabela, separa âncoras (linhas com valor) e pedaços de descrição
  let col = null; let encerrado = false; let ultimaDataVista = null; let direcao = 0;
  // Se a primeira linha de movimentação aparece ANTES de qualquer cabeçalho legível, o cabeçalho
  // que existir é de outra tabela (ex.: "Débito Automático" no fim do PF): usa as colunas deduzidas.
  const ehCab = (l) => l.blocos.find((x) => CAB_DATA.test(x.s)) && l.blocos.find((x) => CAB_DESC.test(x.s)) && l.blocos.find((x) => CAB_VALOR.test(x.s));
  const iCab = linhas.findIndex(ehCab);
  const iMov = linhas.findIndex((l) => l.blocos.length >= 3 && ehData(l.blocos[0].s) && Number.isFinite(valorBR(l.blocos[l.blocos.length - 1].s)));
  const usarDeduzidas = iCab < 0 || (iMov >= 0 && iMov < iCab);
  if (usarDeduzidas) col = deduzirColunas();
  const itens = []; // { tipo: 'mov' | 'saldo' | 'desc', pagina, y, ... }
  for (const l of linhas) {
    const b = l.blocos;
    const cab = ehCab(l);
    if (cab) {
      if (encerrado || usarDeduzidas) continue;
      const xDesc = b.find((x) => CAB_DESC.test(x.s)).x;
      const xValor = b.find((x) => CAB_VALOR.test(x.s)).x;
      const xDoc = b.find((x) => /documento/i.test(x.s))?.x;
      const xSaldo = b.find((x) => CAB_SALDO.test(x.s) && x.x > xValor)?.x;
      col = { xDesc, xValor, xDoc, xSaldo };
      continue;
    }
    if (!col || encerrado) continue;
    const textoLinha = l.texto.trim();
    // fim da tabela só depois da 1ª movimentação (o resumo do topo repete esses títulos, ex.: "Compras com Cartão de Débito")
    if ((FIM_TABELA.test(textoLinha) || /^se voc[eê] n[aã]o tem limite/i.test(textoLinha)) && itens.some((i) => i.tipo === 'mov' && i.data)) { encerrado = true; continue; }
    if (/^(extrato_|balp_|p[aá]gina\s*:?\s*\d|\d+\/\d+$)/i.test(textoLinha)) continue; // rodapé / nº de página
    const fimDesc = col.xDoc ? col.xDoc - 3 : col.xValor - 60;
    // Data: só um bloco que seja data, à esquerda da descrição. O resto até a coluna de valor é descrição.
    const naData = b.filter((x) => x.x < col.xDesc - 3 && ehData(x.s.split(' ')[0]) && x.s.split(' ').length === 1);
    const naDesc = b.filter((x) => !naData.includes(x) && x.x < fimDesc && x.x >= (naData[0] ? naData[0].x + 20 : 0) && !(col.deduzido && x.x < col.xDesc - 6));
    const naValor = b.filter((x) => x.x >= col.xValor - 60 && (!col.xSaldo || x.x < col.xSaldo - 5));
    const naSaldo = col.xSaldo ? b.filter((x) => x.x >= col.xSaldo - 5) : [];
    const data = naData.map((x) => dataISO(x.s)).find(Boolean) || null;
    // Tabela que volta no tempo (ex.: "Débito Automático" repetindo as contas do mês) = acabou o extrato
    if (data && ultimaDataVista) {
      const dir = Math.sign(data.localeCompare(ultimaDataVista));
      if (dir && !direcao) direcao = dir;
      else if (dir && direcao && dir !== direcao) { encerrado = true; continue; }
    }
    if (data) ultimaDataVista = data;
    // sem coluna de documento conhecida: tira o "-" e o nº do documento que ficam no meio
    const desc = naDesc.filter((x) => !(col.deduzido && (/^-$/.test(x.s) || /^\d{5,}$/.test(x.s)))).map((x) => x.s).join(' ').trim();
    const valor = naValor.map((x) => valorBR(x.s)).find((v) => Number.isFinite(v));
    const saldo = naSaldo.map((x) => valorBR(x.s)).find((v) => Number.isFinite(v));
    if (LINHA_SALDO.test(desc)) {
      // "SALDO EM 31/05" / "Saldo do dia Cc": ponto de conferência, não é movimentação
      const v = Number.isFinite(saldo) ? saldo : valor;
      if (Number.isFinite(v)) itens.push({ tipo: 'saldo', pagina: l.pagina, y: l.y, data, saldo: v });
      continue;
    }
    if (Number.isFinite(valor) && valor !== 0) {
      itens.push({ tipo: 'mov', pagina: l.pagina, y: l.y, data, valor, saldo: Number.isFinite(saldo) ? saldo : null, partes: desc ? [{ y: l.y, s: desc }] : [] });
    } else if (Number.isFinite(valor) && valor === 0) {
      continue;
    } else if (desc) {
      itens.push({ tipo: 'desc', pagina: l.pagina, y: l.y, s: desc });
    }
  }
  // Cada pedaço de descrição: primeiro a movimentação logo ACIMA (até 12pt — a descrição continua para baixo,
  // como no PF); se não houver, a mais próxima na mesma página (no PJ a descrição fica acima e abaixo do valor)
  const movs = itens.filter((i) => i.tipo === 'mov');
  for (const d of itens.filter((i) => i.tipo === 'desc')) {
    const mesmaPg = movs.filter((m) => m.pagina === d.pagina);
    const acima = mesmaPg.filter((m) => m.y < d.y && d.y - m.y <= 12).sort((a, b) => b.y - a.y)[0];
    let alvo = acima;
    if (!alvo) {
      let melhor = null;
      for (const m of mesmaPg) {
        const dist = Math.abs(m.y - d.y);
        if (dist > 16) continue;
        if (!melhor || dist < melhor.dist || (dist === melhor.dist && m.y < melhor.m.y)) melhor = { m, dist };
      }
      alvo = melhor?.m;
    }
    if (alvo) alvo.partes.push({ y: d.y, s: d.s });
  }
  // Datas: quando só a 1ª linha do dia tem data, as seguintes herdam
  let ultima = null;
  const seq = itens.filter((i) => i.tipo !== 'desc');
  for (const i of seq) { if (i.data) ultima = i.data; else i.data = ultima; }
  // Ordem cronológica (há extratos do mais novo para o mais antigo)
  const datas = seq.map((i) => i.data).filter(Boolean);
  if (datas.length > 1 && datas[0] > datas[datas.length - 1]) seq.reverse();

  // Conferência pela sequência de saldos
  let corrente = null; let pontos = 0; let divergencias = 0; let primeiroSaldo = null;
  for (const i of seq) {
    if (i.tipo === 'mov' && corrente !== null) corrente = Math.round((corrente + i.valor) * 100) / 100;
    if (i.saldo !== null && i.saldo !== undefined) {
      if (corrente !== null) { pontos++; if (Math.abs(corrente - i.saldo) > 0.01) divergencias++; }
      if (primeiroSaldo === null) primeiroSaldo = i;
      corrente = i.saldo;
    }
  }
  const linhasOut = seq.filter((i) => i.tipo === 'mov' && i.data).map((m) => ({
    data: m.data,
    valor: m.valor,
    descricao: m.partes.sort((a, b) => a.y - b.y).map((p) => p.s).join(' ').replace(/\s+/g, ' ').trim() || 'Sem descrição',
    chave: null,
  }));
  const ultimoSaldo = [...seq].reverse().find((i) => i.saldo !== null && i.saldo !== undefined);
  return {
    formato: 'PDF (conta)', conta, cartao: false, linhas: linhasOut,
    saldoBanco: ultimoSaldo ? { valor: ultimoSaldo.saldo, data: ultimoSaldo.data } : null,
    conferencia: pontos
      ? { ok: divergencias === 0, texto: divergencias === 0 ? `Saldos conferidos em ${pontos} pontos do extrato: tudo bate.` : `${divergencias} de ${pontos} saldos do extrato não bateram com as movimentações lidas — confira se faltou alguma linha.` }
      : null,
  };
}

/* ========================================================= fatura de cartão */
const RE_CARTAO = /^(@\s*)?([A-ZÀ-Ú][A-ZÀ-Ú .]+?)\s*-\s*\d{4}\s*X{4}\s*X{4}\s*(\d{4})$/i;
function lerFatura(linhas) {
  const textoTodo = linhas.map((l) => l.texto).join('\n');
  const venc = /vencimento[\s\S]{0,80}?(\d{2})\/(\d{2})\/(\d{4})/i.exec(textoTodo);
  const ate = /realizados at[eé] (\d{2})\/(\d{2})/i.exec(textoTodo);
  if (!venc) throw new Error('Não achei o vencimento nesta fatura.');
  const anoV = Number(venc[3]), mesV = Number(venc[2]);
  let fech = ate ? { dia: Number(ate[1]), mes: Number(ate[2]) } : { dia: Number(venc[1]), mes: mesV };
  const anoF = fech.mes > mesV ? anoV - 1 : anoV;
  const fechamento = new Date(anoF, fech.mes - 1, fech.dia);
  const inicio = new Date(anoF, fech.mes - 2, fech.dia + 1);
  const iso = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  // o valor fica uma ou duas linhas abaixo do rótulo "Seu Limite é:"
  const limite = /seu limite [eé]:?[\s\S]{0,200}?R\$\s*([\d.,]+)/i.exec(textoTodo);
  const titular = /(\d{4})\s*X{4}\s*X{4}\s*(\d{4})/i.exec(textoTodo);

  // Lê coluna esquerda e depois a direita de cada página do detalhamento
  const inicioDet = linhas.find((l) => /detalhamento da fatura/i.test(l.texto));
  const fluxo = [];
  for (const p of [...new Set(linhas.map((l) => l.pagina))]) {
    if (inicioDet && p < inicioDet.pagina) continue;
    const doPg = linhas.filter((l) => l.pagina === p);
    const meio = (doPg[0]?.largura || 595) / 2 - 12;
    for (const lado of ['esq', 'dir']) {
      for (const l of doPg) {
        const bl = l.blocos.filter((b) => (lado === 'esq' ? b.x < meio : b.x >= meio));
        if (bl.length) fluxo.push({ pagina: p, y: l.y, blocos: bl, texto: bl.map((b) => b.s).join(' ') });
      }
    }
  }
  let cartao = null; let secao = null;
  const out = []; const totaisCartao = {}; const lidosCartao = {};
  for (const l of fluxo) {
    const t = l.texto.trim();
    const mc = RE_CARTAO.exec(t);
    if (mc) {
      const nome = mc[2].trim();
      cartao = { nome, final: mc[3], curto: nome.split(' ')[0].charAt(0) + nome.split(' ')[0].slice(1).toLowerCase() };
      secao = null; continue;
    }
    if (/^pagamento e demais cr[eé]ditos/i.test(t)) { secao = 'creditos'; continue; }
    if (/^parcelamentos$/i.test(t)) { secao = 'parcelados'; continue; }
    if (/^despesas$/i.test(t)) { secao = 'despesas'; continue; }
    if (/^compra data descri/i.test(t)) continue;
    if (/^resumo da fatura/i.test(t)) { secao = null; cartao = null; continue; }
    if (!cartao || !secao) continue;
    if (/^valor total/i.test(t)) {
      const v = l.blocos.map((b) => valorBR(b.s)).find((x) => Number.isFinite(x));
      if (Number.isFinite(v)) totaisCartao[cartao.final] = (totaisCartao[cartao.final] || 0) + v;
      continue;
    }
    // Linha de compra: "dd/mm DESCRIÇÃO" [parcela "pp/tt"] valor R$ [valor US$]
    const iDesc = l.blocos.findIndex((b) => /^\d{2}\/\d{2}\s+\S/.test(b.s));
    if (iDesc < 0) continue;
    const md = /^(\d{2})\/(\d{2})\s+(.+)$/.exec(l.blocos[iDesc].s);
    const resto = l.blocos.slice(iDesc + 1);
    let parcela = null; let parcelas = null;
    const iParc = resto.findIndex((b) => /^\d{2}\/\d{2}$/.test(b.s));
    if (iParc >= 0) { parcela = Number(resto[iParc].s.slice(0, 2)); parcelas = Number(resto[iParc].s.slice(3)); }
    const valores = resto.map((b) => valorBR(b.s)).filter((v) => Number.isFinite(v));
    if (!valores.length) continue;
    const valorPdf = valores[0];
    if (valorPdf === 0) continue; // ex.: "ANUIDADE DIFERENCIADA 0,00"
    // "VALOR TOTAL" de cada cartão soma só compras (o pagamento da fatura fica fora)
    if (secao !== 'creditos') lidosCartao[cartao.final] = (lidosCartao[cartao.final] || 0) + valorPdf;
    // Data: a da compra; parcelas entram no mês desta fatura (data da compra + (parcela-1) meses, dentro do ciclo)
    const dia = Number(md[1]), mes = Number(md[2]);
    let anoC = anoF;
    if (mes > fechamento.getMonth() + 1 || (mes === fechamento.getMonth() + 1 && dia > fechamento.getDate())) anoC -= 1;
    let d = new Date(anoC, mes - 1, dia);
    if (parcela && parcela > 1) d = new Date(anoC, mes - 1 + (parcela - 1), dia);
    if (d > fechamento) d = new Date(fechamento);
    if (d < inicio) d = new Date(inicio);
    out.push({
      data: iso(d),
      valor: -valorPdf, // compra = saída do cartão; pagamento (valor negativo na fatura) = entrada
      descricao: md[3].replace(/\s+/g, ' ').trim(),
      parcela: parcela && parcelas && parcelas >= 2 && parcela <= parcelas ? parcela : null,
      parcelas: parcela && parcelas && parcelas >= 2 && parcela <= parcelas ? parcelas : null,
      portador: `${cartao.curto} ${cartao.final}`,
      chave: null,
    });
  }
  const totalFatura = /saldo desta fatura\s*([\d.,]+)/i.exec(textoTodo) || /total a pagar[\s\S]{0,40}?R\$\s*([\d.,]+)/i.exec(textoTodo);
  const compras = Math.round(out.filter((l) => l.valor < 0).reduce((s, l) => s - l.valor, 0) * 100) / 100;
  const despesasBrasil = /total despesas\/d[eé]bitos no brasil\s*([\d.,]+)/i.exec(textoTodo);
  const exterior = /total despesas\/d[eé]bitos no exterior\s*([\d.,]+)/i.exec(textoTodo);
  const esperado = despesasBrasil ? valorBR(despesasBrasil[1]) + (exterior ? valorBR(exterior[1]) : 0) : null;
  const porCartaoOk = Object.keys(totaisCartao).every((f) => Math.abs((lidosCartao[f] || 0) - totaisCartao[f]) < 0.01);
  const ok = esperado !== null ? Math.abs(esperado - compras) < 0.01 && porCartaoOk : porCartaoOk;
  const cartoes = [...new Set(out.map((l) => l.portador))];
  return {
    formato: 'PDF (fatura do cartão)', conta: titular ? `cartao${titular[2]}` : 'cartao', cartao: true, linhas: out,
    conferencia: {
      ok,
      texto: ok
        ? `Compras lidas: ${compras.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })} = total da fatura${esperado !== null ? '' : ' por cartão'}. Cartões: ${cartoes.join(', ')}.`
        : `As compras lidas (${compras.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}) não batem com o total da fatura${esperado !== null ? ` (${esperado.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })})` : ''} — confira antes de importar.`,
    },
    cartaoInfo: {
      diaFechamento: fechamento.getDate(),
      diaVencimento: Number(venc[1]),
      limite: limite ? valorBR(limite[1]) : null,
      vencimento: `${anoV}-${pad2(mesV)}-${venc[1]}`,
      total: totalFatura ? valorBR(totalFatura[1]) : null,
    },
  };
}

/** Lê um PDF de extrato ou fatura. Mesmo formato de saída de lerExtrato (extrato.js). */
export async function lerPDF(file) {
  const linhas = await linhasDoPDF(await file.arrayBuffer());
  if (!linhas.length) throw new Error('Este PDF não tem texto (parece uma foto/scan). Baixe o extrato pelo banco em PDF ou OFX.');
  const texto = linhas.map((l) => l.texto).join('\n');
  const r = /detalhamento da fatura|resumo da fatura/i.test(texto) ? lerFatura(linhas) : lerConta(linhas);
  if (!r.linhas.length) throw new Error('Não encontrei movimentações neste PDF. Se for de outro banco, mande um exemplo para ajustarmos o leitor.');
  return r;
}
