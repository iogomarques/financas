// Categorias de gasto ("com o quê foi gasto") e regras de classificação automática.
//
// Separação pessoal × empresa é por LANÇAMENTO (não por conta): a mesma conta pode ter os dois.
// Ordem para decidir o lado de um lançamento:
//   1. lado escolhido na regra  →  2. lado padrão da categoria  →  3. o que já estava no lançamento
import { normDesc } from './extrato.js?v=20261117001941';

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
  ['Compras', '#8b5cf6', null],
  ['Outros', '#94a3b8', null],
];

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
  let melhor = null;
  for (const r of regras) {
    if (!r.texto) continue;
    if ((b.includes(r.texto) || n.includes(r.texto)) && (!melhor || r.texto.length > melhor.texto.length)) melhor = r;
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
    for (let i = lancamentos.length - 1; i >= 0; i--) {
      const l = lancamentos[i];
      if (l.classe_id && textoBase(l.descricao) === base) return { classe_id: l.classe_id, escopo: l.escopo || lado(l.classe_id), por: 'historico' };
    }
  }
  return { classe_id: null, escopo: escopoPadrao, por: null };
}
