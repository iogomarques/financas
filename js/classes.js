// Categorias de gasto ("com o quê foi gasto") e regras de classificação automática.
//
// Separação pessoal × empresa é por LANÇAMENTO (não por conta): a mesma conta pode ter os dois.
// Ordem para decidir o lado de um lançamento:
//   1. lado escolhido na regra  →  2. lado padrão da categoria  →  3. o que já estava no lançamento
import { normDesc } from './extrato.js?v=20261119200940';

/** Sugestões para começar: [nome, cor, lado padrão ('empresa' | 'pessoal' | null = depende)] */
export const CLASSES_SUGERIDAS = [
  ['Funcionários', '#0ea5e9', 'empresa'],
  ['Fornecedores', '#6366f1', 'empresa'],
  ['Impostos e taxas', '#ef4444', 'empresa'],
  ['Pró-labore / retirada', '#0f766e', 'empresa'],
  ['Aluguel', '#a855f7', null],
  ['Luz, água e gás', '#f59e0b', null],
  ['Telefone e internet', '#14b8a6', null],
  ['Assinaturas', '#ec4899', null],
  ['Combustível', '#f97316', null],
  ['Manutenção e serviços', '#78716c', null],
  ['Tarifas bancárias', '#64748b', null],
  ['Mercado', '#22c55e', 'pessoal'],
  ['Restaurantes e lanches', '#84cc16', 'pessoal'],
  ['Saúde e farmácia', '#06b6d4', 'pessoal'],
  ['Educação', '#3b82f6', 'pessoal'],
  ['Lazer', '#d946ef', 'pessoal'],
  ['Família', '#f472b6', 'pessoal'], // Pix e ajuda para a família
  ['Compras', '#8b5cf6', null],
  ['Fatura do cartão (sem detalhe)', '#475569', null],
  ['Outros', '#94a3b8', null],
];

// Palavras genéricas dos extratos que não dizem nada sobre QUEM recebeu ou ONDE foi a compra
const GENERICAS = new Set(`
  pix enviado enviada recebido recebida transf transferencia transferencias ted doc tev pagamento pagto pgto pag
  compra compras cartao credito debito deb cred automatico aut boleto titulo conta corrente cc mov movimentacao
  de da do das dos para em com por no na nos nas e a o ao aos qr code qrcode agendado agendamento
  ltda me eireli sa s.a epp mei cia
  saque deposito dep tarifa estorno parcela parc via app internet banking
`.split(/\s+/).filter(Boolean));

/**
 * Palavras que identificam a compra/pessoa, sem as genéricas:
 * "PIX ENVIADO 05/11 JOAO SILVA" → ["joao", "silva"]; "COMPRA CARTAO MERCADOLIVRE*XYZ" → ["mercadolivre", "xyz"]
 */
export function palavrasChave(descricao) {
  return textoBase(descricao).split(' ').filter((p) => p.length >= 3 && !GENERICAS.has(p));
}

// Primeiras palavras comuns demais para identificar sozinhas (precisam da segunda palavra)
const COMUNS = new Set('mercado supermercado posto farmacia drogaria padaria restaurante lanchonete loja lojas auto casa comercial distribuidora banco clinica'.split(' '));

/**
 * Duas descrições são da mesma loja/pessoa?
 * "mercadolivre xyz" ≈ "mercado livre abc"; "joao silva" ≈ "joao silva"; "posto shell" ≠ "posto ipiranga"
 */
export function mesmaLoja(a, b) {
  if (!a.length || !b.length) return false;
  const juntoA = a[0] + (a[1] || ''), juntoB = b[0] + (b[1] || '');
  if (a[0] === juntoB || b[0] === juntoA) return true;            // "mercadolivre" × "mercado livre"
  if (a[0] !== b[0]) return false;
  if (a[1] && b[1] && a[1] === b[1]) return true;                  // duas primeiras palavras iguais
  return a[0].length >= 6 && !COMUNS.has(a[0]);                    // uma palavra distinta basta (ex.: "netflix")
}

/** Texto sugerido para uma regra nova: as 2–3 primeiras palavras que identificam (ex.: "joao silva"). */
export function regraPadrao(descricao) {
  const p = palavrasChave(descricao);
  if (!p.length) return textoBase(descricao).slice(0, 60);
  // Uma palavra distinta basta ("mercadolivre", "netflix"); senão, as duas primeiras ("joao silva", "posto shell")
  if (p[0].length >= 6 && !COMUNS.has(p[0])) return p[0];
  return p.slice(0, 2).join(' ');
}

/**
 * Detecta movimentações que NÃO são receita nem despesa:
 *  - 'fatura': pagamento da fatura do cartão (as compras entram pelo extrato do cartão)
 *  - 'propria': transferência para/da própria conta (nomes cadastrados em Ajustes, ou "mesma titularidade")
 */
export function detectarTransferencia(descricao, meusNomes = []) {
  const n = normDesc(descricao);
  // rendimento da aplicação automática ("REMUNERACAO APLICACAO AUTOMATICA") é receita, não transferência
  if (/remuneracao|rendimento|juros sobre/.test(n)) return null;
  // pagamento da fatura do cartão: "PAGAMENTO CARTAO CREDITO", "DEBITO AUT. FAT.CARTAO MASTER CARD"
  if (/(pagamento|pagto|pgto|pag)\.? ?(de )?(fatura|cartao)|fatura (do )?cartao|pagamento cartao de credito|pag fat|deb(ito)?\.? ?aut\.? ?(fatura|fat\.? ?cartao)|fat\.? ?cartao/.test(n)) return 'fatura';
  if (/mesma titularidade|entre contas|transf(erencia)? (entre )?(contas )?propria|aplicacao automatica|resgate automatico/.test(n)) return 'propria';
  for (const nome of meusNomes) {
    const m = normDesc(nome).trim();
    if (m.length >= 4 && n.includes(m)) return 'propria';
  }
  return null;
}

/**
 * "Base" estável da descrição: minúsculas, sem acento, sem números nem símbolos.
 * "PIX ENVIADO 12/11 JOÃO SILVA *123" → "pix enviado joao silva"
 * Usada para agrupar compras parecidas e como texto das regras.
 */
export function textoBase(descricao) {
  return normDesc(descricao)
    .replace(/[0-9]+/g, ' ')
    .replace(/[^a-z\s&.-]/g, ' ')
    .replace(/(^|\s)[.\-&]+(?=\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

/** Regra que vale para a descrição (a de texto mais longo/específico vence). */
export function regraPara(descricao, regras) {
  const n = normDesc(descricao);
  const b = textoBase(descricao);
  const semEspaco = b.replace(/ /g, '');
  let melhor = null;
  for (const r of regras) {
    if (!r.texto) continue;
    // Também compara sem espaços: regra "mercadolivre" pega "MERCADO LIVRE" e vice-versa
    const bate = b.includes(r.texto) || n.includes(r.texto) || semEspaco.includes(r.texto.replace(/ /g, ''));
    if (bate && (!melhor || r.texto.length > melhor.texto.length)) melhor = r;
  }
  return melhor;
}

/**
 * Sugere categoria e lado para um lançamento novo.
 * Usa as regras; sem regra, olha o histórico (último lançamento com a mesma base já classificado).
 * Devolve { classe_id, escopo, por: 'regra' | 'historico' | null }.
 */
export function sugerir(descricao, { regras, classes, lancamentos, escopoPadrao }) {
  const r = regraPara(descricao, regras);
  const lado = (classeId, ladoRegra) => ladoRegra || classes.find((c) => c.id === classeId)?.escopo_padrao || escopoPadrao;
  if (r) return { classe_id: r.classe_id, escopo: lado(r.classe_id, r.escopo), por: 'regra' };
  const base = textoBase(descricao);
  if (base) {
    // 1) mesma descrição (sem números) já classificada antes
    for (let i = lancamentos.length - 1; i >= 0; i--) {
      const l = lancamentos[i];
      if (l.classe_id && textoBase(l.descricao) === base) return { classe_id: l.classe_id, escopo: l.escopo || lado(l.classe_id), por: 'historico' };
    }
    // 2) parecida: mesma primeira palavra que identifica (ex.: "mercadolivre", "shell", "joao silva")
    const chave = palavrasChave(descricao);
    if (chave.length && chave[0].length >= 4) {
      for (let i = lancamentos.length - 1; i >= 0; i--) {
        const l = lancamentos[i];
        if (!l.classe_id) continue;
        if (mesmaLoja(chave, palavrasChave(l.descricao))) {
          return { classe_id: l.classe_id, escopo: l.escopo || lado(l.classe_id), por: 'parecido' };
        }
      }
    }
  }
  return { classe_id: null, escopo: escopoPadrao, por: null };
}
