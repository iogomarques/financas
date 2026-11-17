// Camada de dados. Dois modos:
//  - "supabase": dados na nuvem, sincronizados entre computador, celular e iPad (com login).
//  - "local":    dados só neste navegador (testes: abrir o site com ?local).
//
// Formato em memória (igual nos dois modos):
//   { perfis:      [{id, nome, tipo, cor, ordem}],
//     categorias:  [{id, perfil_id, nome, tipo: 'debito'|'credito', ordem, ativo}]      ← contas e cartões (de onde saiu)
//     classes:     [{id, perfil_id, nome, cor, ordem, ativo, escopo_padrao}]           ← categorias de gasto (com o quê)
//     regras:      [{id, perfil_id, texto, classe_id, escopo}]                         ← classificação automática
//     meses:       [{perfil_id, ano, mes, receita, investimento, rendimento, saldo_inicial, despesas, formulas, observacao}],
//     lancamentos: [{id, perfil_id, data, descricao, valor, destino, categoria_id, classe_id, escopo, origem, conta, chave}],
//     prefs:       { [perfil_id]: {pct_investir, meses_reserva, pct_max_gasto} } }
import { uid } from './util.js?v=20261117082410';

const SUPABASE_JS = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.4/+esm';

// meus_nomes: nomes que identificam as próprias contas (Pix/TED com eles = transferência entre contas)
export const PREFS_PADRAO = { pct_investir: 0.15, meses_reserva: 6, pct_max_gasto: 0.7, meus_nomes: [], modo: null };

export async function createStore() {
  const cfg = window.FIN_CONFIG || {};
  if (cfg.SUPABASE_URL && cfg.SUPABASE_KEY) return supabaseStore(cfg);
  return localStore();
}

/** Converte backups/dados antigos para o formato atual. */
export function normalizarDados(data) {
  const lista = (x) => (Array.isArray(x) ? x : []);
  const d = {
    perfis: lista(data.perfis),
    categorias: lista(data.categorias),
    classes: lista(data.classes),
    regras: lista(data.regras),
    meses: lista(data.meses),
    lancamentos: lista(data.lancamentos),
    prefs: data.prefs && typeof data.prefs === 'object' ? data.prefs : {},
  };
  if (!d.perfis.length && (d.categorias.length || d.meses.length)) {
    const p = { id: uid(), nome: 'Pessoal', tipo: 'pessoal', cor: '#0f766e', ordem: 1 };
    d.perfis = [p];
    d.categorias = d.categorias.map((c) => ({ ...c, perfil_id: c.perfil_id || p.id }));
    d.meses = d.meses.map((m) => ({ ...m, perfil_id: m.perfil_id || p.id }));
    if ('pct_investir' in d.prefs) d.prefs = { [p.id]: { ...PREFS_PADRAO, ...d.prefs } };
  }
  return d;
}

/* ---------------------------------------------------------------- local */
function localStore() {
  const KEY = 'financas-local-v1';
  const read = () => {
    try { return normalizarDados(JSON.parse(localStorage.getItem(KEY)) || {}); } catch { return normalizarDados({}); }
  };
  const write = (db) => {
    try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) { console.error(e); }
  };
  const user = { email: 'Modo local (só neste dispositivo)' };
  const mesmoMes = (m, perfilId, ano, mes) => m.perfil_id === perfilId && m.ano === ano && m.mes === mes;
  /** Insere ou substitui um item (por id) numa lista do banco local. */
  const upsert = (lista, item) => {
    const db = read();
    if (!item.id) item = { ...item, id: uid() };
    const i = db[lista].findIndex((x) => x.id === item.id);
    if (i >= 0) db[lista][i] = item; else db[lista].push(item);
    write(db);
    return item;
  };
  const remove = (lista, id) => {
    const db = read();
    db[lista] = db[lista].filter((x) => x.id !== id);
    write(db);
    return db;
  };

  return {
    mode: 'local',
    async getUser() { return user; },
    async autorizado() { return true; },
    onAuthChange() {},
    async signIn() { return user; },
    async signUp() { return user; },
    async resetPassword() {},
    async signOut() {},
    async load() { const db = read(); write(db); return db; },

    async savePerfil(p) { return upsert('perfis', p); },
    async deletePerfil(id) {
      const db = read();
      db.perfis = db.perfis.filter((p) => p.id !== id);
      for (const k of ['categorias', 'classes', 'regras', 'meses', 'lancamentos']) db[k] = db[k].filter((x) => x.perfil_id !== id);
      delete db.prefs[id];
      write(db);
    },
    async saveMes(rec) {
      const db = read();
      const i = db.meses.findIndex((m) => mesmoMes(m, rec.perfil_id, rec.ano, rec.mes));
      if (i >= 0) db.meses[i] = rec; else db.meses.push(rec);
      write(db);
      return rec;
    },
    async deleteMes(perfilId, ano, mes) {
      const db = read();
      db.meses = db.meses.filter((m) => !mesmoMes(m, perfilId, ano, mes));
      write(db);
    },
    async saveCategoria(cat) { return upsert('categorias', cat); },
    async deleteCategoria(id) { remove('categorias', id); },
    async savePrefs(perfilId, p) {
      const db = read();
      db.prefs[perfilId] = { ...PREFS_PADRAO, ...db.prefs[perfilId], ...p };
      write(db);
      return db.prefs[perfilId];
    },

    async saveLancamento(l) { return upsert('lancamentos', l); },
    async deleteLancamento(id) { remove('lancamentos', id); },
    /** Insere vários; os que já existem (mesma chave) são ignorados. Devolve só os novos. */
    async importarLancamentos(lista) {
      const db = read();
      const chaves = new Set(db.lancamentos.filter((x) => x.chave).map((x) => `${x.perfil_id}|${x.chave}`));
      const novos = [];
      for (const l of lista) {
        if (l.chave && chaves.has(`${l.perfil_id}|${l.chave}`)) continue;
        const n = { ...l, id: uid() };
        db.lancamentos.push(n);
        novos.push(n);
        if (l.chave) chaves.add(`${l.perfil_id}|${l.chave}`);
      }
      write(db);
      return novos;
    },
    /** Muda os mesmos campos (ex.: categoria e lado) em vários lançamentos de uma vez. */
    async atualizarLancamentos(ids, mudanca) {
      const db = read();
      const alvo = new Set(ids);
      const out = [];
      db.lancamentos = db.lancamentos.map((l) => {
        if (!alvo.has(l.id)) return l;
        const n = { ...l, ...mudanca };
        out.push(n);
        return n;
      });
      write(db);
      return out;
    },

    async saveClasse(c) { return upsert('classes', c); },
    async deleteClasse(id) {
      const db = read();
      db.classes = db.classes.filter((x) => x.id !== id);
      db.regras = db.regras.filter((r) => r.classe_id !== id);
      db.lancamentos = db.lancamentos.map((l) => (l.classe_id === id ? { ...l, classe_id: null } : l));
      write(db);
    },
    /** Regra por texto: se já existe uma com o mesmo texto, é substituída. */
    async saveRegra(r) {
      const db = read();
      const i = db.regras.findIndex((x) => x.perfil_id === r.perfil_id && x.texto === r.texto);
      const salvo = { ...(i >= 0 ? db.regras[i] : { id: uid() }), ...r };
      if (i >= 0) db.regras[i] = salvo; else db.regras.push(salvo);
      write(db);
      return salvo;
    },
    async deleteRegra(id) { remove('regras', id); },

    async replaceAll(data) { write(normalizarDados(data)); },
  };
}

/* ------------------------------------------------------------- supabase */
async function supabaseStore(cfg) {
  const { createClient } = await import(SUPABASE_JS);
  const sb = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true },
  });
  const check = ({ data, error }) => {
    if (error) throw new Error(error.message);
    return data;
  };
  const PERFIL_COLS = 'id, nome, tipo, cor, ordem';
  const CAT_COLS = 'id, perfil_id, nome, tipo, ordem, ativo, banco, estilo, titular, subtipo, saldo_inicial, saldo_desde, limite, dia_fechamento, dia_vencimento';
  const CLASSE_COLS = 'id, perfil_id, nome, cor, ordem, ativo, escopo_padrao';
  const REGRA_COLS = 'id, perfil_id, texto, classe_id, escopo';
  const MES_COLS = 'perfil_id, ano, mes, receita, investimento, rendimento, saldo_inicial, despesas, formulas, observacao';
  const PREF_COLS = 'perfil_id, pct_investir, meses_reserva, pct_max_gasto, meus_nomes, modo';
  const LANC_COLS = 'id, perfil_id, data, descricao, valor, destino, categoria_id, classe_id, escopo, origem, conta, chave, sentido';

  const comId = (row, x) => (x.id ? { ...row, id: x.id } : row);
  const limpaLanc = (l) => comId({
    perfil_id: l.perfil_id, data: l.data, descricao: String(l.descricao).slice(0, 200), valor: l.valor,
    destino: l.destino, categoria_id: l.categoria_id || null,
    classe_id: l.classe_id || null,
    sentido: l.sentido || (['receita', 'rendimento'].includes(l.destino) ? 'entrada' : 'saida'),
    escopo: l.escopo || 'pessoal', origem: l.origem || 'manual', conta: l.conta || null, chave: l.chave || null,
  }, l);
  const numLanc = (l) => ({ ...l, valor: Number(l.valor) });
  const limpaMes = (r) => ({
    perfil_id: r.perfil_id, ano: r.ano, mes: r.mes,
    receita: r.receita ?? null, investimento: r.investimento ?? null, rendimento: r.rendimento ?? null,
    saldo_inicial: r.saldo_inicial ?? null, despesas: r.despesas || {}, formulas: r.formulas || {},
    observacao: r.observacao || null,
  });
  const limpaCat = (c) => comId({
    perfil_id: c.perfil_id, nome: c.nome, tipo: c.tipo, ordem: c.ordem ?? 0, ativo: c.ativo ?? true,
    banco: c.banco || null, estilo: c.estilo || null, titular: c.titular || null,
    subtipo: c.subtipo || null, saldo_inicial: c.saldo_inicial ?? null, saldo_desde: c.saldo_desde || null,
    limite: c.limite ?? null, dia_fechamento: c.dia_fechamento || null, dia_vencimento: c.dia_vencimento || null,
  }, c);
  const limpaClasse = (c) => comId({
    perfil_id: c.perfil_id, nome: c.nome, cor: c.cor || '#64748b', ordem: c.ordem ?? 0,
    ativo: c.ativo ?? true, escopo_padrao: c.escopo_padrao || null,
  }, c);
  const limpaRegra = (r) => comId({ perfil_id: r.perfil_id, texto: r.texto, classe_id: r.classe_id, escopo: r.escopo || null }, r);
  const limpaPerfil = (p) => comId({ nome: p.nome, tipo: p.tipo || 'pessoal', cor: p.cor || '#0f766e', ordem: p.ordem ?? 0 }, p);

  return {
    mode: 'supabase',
    async getUser() {
      const { data } = await sb.auth.getSession();
      return data.session?.user || null;
    },
    onAuthChange(cb) {
      sb.auth.onAuthStateChange((_ev, session) => cb(session?.user || null));
    },
    async signIn(email, password) {
      return check(await sb.auth.signInWithPassword({ email, password })).user;
    },
    async signUp(email, password) {
      return check(await sb.auth.signUp({ email, password, options: { emailRedirectTo: location.origin + location.pathname } })).user;
    },
    async resetPassword(email) {
      check(await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname }));
    },
    async signOut() { await sb.auth.signOut(); },

    // Acesso liberado (conta autorizada ou e-mail convidado).
    // O projeto Supabase é dividido com outro app, por isso essa trava extra.
    async autorizado() {
      return !!check(await sb.rpc('fin_acesso'));
    },

    async load() {
      const [perfis, cats, classes, regras, meses, prefs] = await Promise.all([
        sb.from('fin_perfis').select(PERFIL_COLS).order('ordem'),
        sb.from('fin_categorias').select(CAT_COLS).order('ordem'),
        sb.from('fin_classes').select(CLASSE_COLS).order('ordem'),
        sb.from('fin_regras').select(REGRA_COLS),
        sb.from('fin_meses').select(MES_COLS).order('ano').order('mes'),
        sb.from('fin_preferencias').select(PREF_COLS),
      ]);
      const prefsPorPerfil = {};
      for (const p of check(prefs)) {
        const { perfil_id: id, ...resto } = p;
        prefsPorPerfil[id] = { ...PREFS_PADRAO, ...resto };
      }
      // Lançamentos podem passar de 1000 linhas (limite por consulta): busca em páginas.
      const lancamentos = [];
      for (let de = 0; ; de += 1000) {
        const pagina = check(await sb.from('fin_lancamentos').select(LANC_COLS).order('data').order('id').range(de, de + 999));
        lancamentos.push(...pagina.map(numLanc));
        if (pagina.length < 1000) break;
      }
      return {
        perfis: check(perfis), categorias: check(cats), classes: check(classes), regras: check(regras),
        meses: check(meses), lancamentos, prefs: prefsPorPerfil,
      };
    },

    async savePerfil(p) {
      return check(await sb.from('fin_perfis').upsert(limpaPerfil(p)).select(PERFIL_COLS).single());
    },
    async deletePerfil(id) {
      // Apaga em cascata tudo do perfil.
      check(await sb.from('fin_perfis').delete().eq('id', id));
    },
    async saveMes(rec) {
      return check(await sb.from('fin_meses').upsert(limpaMes(rec), { onConflict: 'user_id,perfil_id,ano,mes' }).select(MES_COLS).single());
    },
    async deleteMes(perfilId, ano, mes) {
      check(await sb.from('fin_meses').delete().eq('perfil_id', perfilId).eq('ano', ano).eq('mes', mes));
    },
    async saveCategoria(cat) {
      return check(await sb.from('fin_categorias').upsert(limpaCat(cat)).select(CAT_COLS).single());
    },
    async deleteCategoria(id) {
      check(await sb.from('fin_categorias').delete().eq('id', id));
    },
    async savePrefs(perfilId, p) {
      const row = {
        perfil_id: perfilId, pct_investir: p.pct_investir, meses_reserva: p.meses_reserva, pct_max_gasto: p.pct_max_gasto,
        meus_nomes: Array.isArray(p.meus_nomes) ? p.meus_nomes : [],
        modo: p.modo === 'controle' || p.modo === 'organizacao' ? p.modo : null,
      };
      const salvo = check(await sb.from('fin_preferencias').upsert(row, { onConflict: 'user_id,perfil_id' }).select(PREF_COLS).single());
      const { perfil_id: _id, ...resto } = salvo;
      return { ...PREFS_PADRAO, ...resto };
    },

    async saveLancamento(l) {
      return numLanc(check(await sb.from('fin_lancamentos').upsert(limpaLanc(l)).select(LANC_COLS).single()));
    },
    async deleteLancamento(id) {
      check(await sb.from('fin_lancamentos').delete().eq('id', id));
    },
    /** Insere vários; os que já existem (mesma chave) são ignorados pelo banco. Devolve só os novos. */
    async importarLancamentos(lista) {
      const novos = [];
      for (let i = 0; i < lista.length; i += 500) {
        const parte = lista.slice(i, i + 500).map(limpaLanc);
        const r = check(await sb.from('fin_lancamentos')
          .upsert(parte, { onConflict: 'user_id,perfil_id,chave', ignoreDuplicates: true })
          .select(LANC_COLS));
        novos.push(...r.map(numLanc));
      }
      return novos;
    },
    /** Muda os mesmos campos (ex.: categoria e lado) em vários lançamentos de uma vez. */
    async atualizarLancamentos(ids, mudanca) {
      const out = [];
      for (let i = 0; i < ids.length; i += 200) {
        const r = check(await sb.from('fin_lancamentos').update(mudanca).in('id', ids.slice(i, i + 200)).select(LANC_COLS));
        out.push(...r.map(numLanc));
      }
      return out;
    },

    async saveClasse(c) {
      return check(await sb.from('fin_classes').upsert(limpaClasse(c)).select(CLASSE_COLS).single());
    },
    async deleteClasse(id) {
      // Regras da categoria são apagadas; lançamentos ficam sem categoria.
      check(await sb.from('fin_classes').delete().eq('id', id));
    },
    async saveRegra(r) {
      return check(await sb.from('fin_regras').upsert(limpaRegra(r), { onConflict: 'user_id,perfil_id,texto' }).select(REGRA_COLS).single());
    },
    async deleteRegra(id) {
      check(await sb.from('fin_regras').delete().eq('id', id));
    },

    async replaceAll(data) {
      // Restauração de backup: substitui tudo do usuário logado (apagar perfis apaga o resto em cascata).
      const d = normalizarDados(data);
      check(await sb.from('fin_perfis').delete().not('id', 'is', null));
      if (d.perfis.length) check(await sb.from('fin_perfis').insert(d.perfis.map(limpaPerfil)));
      if (d.categorias.length) check(await sb.from('fin_categorias').insert(d.categorias.map(limpaCat)));
      if (d.classes.length) check(await sb.from('fin_classes').insert(d.classes.map(limpaClasse)));
      if (d.regras.length) check(await sb.from('fin_regras').insert(d.regras.map(limpaRegra)));
      if (d.meses.length) check(await sb.from('fin_meses').insert(d.meses.map(limpaMes)));
      for (let i = 0; i < d.lancamentos.length; i += 500) {
        check(await sb.from('fin_lancamentos').insert(d.lancamentos.slice(i, i + 500).map(limpaLanc)));
      }
      for (const [perfilId, p] of Object.entries(d.prefs)) await this.savePrefs(perfilId, { ...PREFS_PADRAO, ...p });
    },
  };
}
