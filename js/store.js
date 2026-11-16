// Camada de dados. Dois modos:
//  - "supabase": dados na nuvem, sincronizados entre computador, celular e iPad (com login).
//  - "local":    dados só neste navegador (testes: abrir o site com ?local).
//
// Formato em memória (igual nos dois modos):
//   { perfis: [{id, nome, tipo: 'pessoal'|'empresa', cor, ordem}],
//     categorias: [{id, perfil_id, nome, tipo: 'debito'|'credito', ordem, ativo}],
//     meses: [{perfil_id, ano, mes, receita, investimento, rendimento, saldo_inicial, despesas, formulas, observacao}],
//     prefs: { [perfil_id]: {pct_investir, meses_reserva, pct_max_gasto} } }
import { uid } from './util.js?v=20261116134933';

const SUPABASE_JS = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.4/+esm';

export const PREFS_PADRAO = { pct_investir: 0.15, meses_reserva: 6, pct_max_gasto: 0.7 };

export async function createStore() {
  const cfg = window.FIN_CONFIG || {};
  if (cfg.SUPABASE_URL && cfg.SUPABASE_KEY) return supabaseStore(cfg);
  return localStore();
}

/** Converte backups/dados antigos (sem perfis) para o formato com perfis. */
export function normalizarDados(data) {
  const d = {
    perfis: Array.isArray(data.perfis) ? data.perfis : [],
    categorias: Array.isArray(data.categorias) ? data.categorias : [],
    meses: Array.isArray(data.meses) ? data.meses : [],
    prefs: data.prefs && typeof data.prefs === 'object' ? data.prefs : {},
  };
  if (!d.perfis.length && (d.categorias.length || d.meses.length)) {
    const p = { id: uid(), nome: 'Pessoal', tipo: 'pessoal', cor: '#0f766e', ordem: 1 };
    d.perfis = [p];
    d.categorias = d.categorias.map((c) => ({ ...c, perfil_id: c.perfil_id || p.id }));
    d.meses = d.meses.map((m) => ({ ...m, perfil_id: m.perfil_id || p.id }));
    // prefs antigas eram um objeto único
    if ('pct_investir' in d.prefs) d.prefs = { [p.id]: { ...PREFS_PADRAO, ...d.prefs } };
  }
  return d;
}

/* ---------------------------------------------------------------- local */
function localStore() {
  const KEY = 'financas-local-v1';
  const read = () => {
    try {
      return normalizarDados(JSON.parse(localStorage.getItem(KEY)) || {});
    } catch {
      return normalizarDados({});
    }
  };
  const write = (db) => {
    try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) { console.error(e); }
  };
  const user = { email: 'Modo local (só neste dispositivo)' };
  const mesmoMes = (m, perfilId, ano, mes) => m.perfil_id === perfilId && m.ano === ano && m.mes === mes;

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
    async savePerfil(p) {
      const db = read();
      if (!p.id) p = { ...p, id: uid() };
      const i = db.perfis.findIndex((x) => x.id === p.id);
      if (i >= 0) db.perfis[i] = p; else db.perfis.push(p);
      write(db);
      return p;
    },
    async deletePerfil(id) {
      const db = read();
      db.perfis = db.perfis.filter((p) => p.id !== id);
      db.categorias = db.categorias.filter((c) => c.perfil_id !== id);
      db.meses = db.meses.filter((m) => m.perfil_id !== id);
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
    async saveCategoria(cat) {
      const db = read();
      if (!cat.id) cat = { ...cat, id: uid() };
      const i = db.categorias.findIndex((c) => c.id === cat.id);
      if (i >= 0) db.categorias[i] = cat; else db.categorias.push(cat);
      write(db);
      return cat;
    },
    async deleteCategoria(id) {
      const db = read();
      db.categorias = db.categorias.filter((c) => c.id !== id);
      write(db);
    },
    async savePrefs(perfilId, p) {
      const db = read();
      db.prefs[perfilId] = { ...PREFS_PADRAO, ...db.prefs[perfilId], ...p };
      write(db);
      return db.prefs[perfilId];
    },
    async replaceAll(data) {
      write(normalizarDados(data));
    },
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
  const CAT_COLS = 'id, perfil_id, nome, tipo, ordem, ativo';
  const MES_COLS = 'perfil_id, ano, mes, receita, investimento, rendimento, saldo_inicial, despesas, formulas, observacao';
  const PREF_COLS = 'perfil_id, pct_investir, meses_reserva, pct_max_gasto';
  const limpaMes = (r) => ({
    perfil_id: r.perfil_id,
    ano: r.ano, mes: r.mes,
    receita: r.receita ?? null,
    investimento: r.investimento ?? null,
    rendimento: r.rendimento ?? null,
    saldo_inicial: r.saldo_inicial ?? null,
    despesas: r.despesas || {},
    formulas: r.formulas || {},
    observacao: r.observacao || null,
  });
  const limpaCat = (c) => {
    const row = { perfil_id: c.perfil_id, nome: c.nome, tipo: c.tipo, ordem: c.ordem ?? 0, ativo: c.ativo ?? true };
    if (c.id) row.id = c.id;
    return row;
  };
  const limpaPerfil = (p) => {
    const row = { nome: p.nome, tipo: p.tipo || 'pessoal', cor: p.cor || '#0f766e', ordem: p.ordem ?? 0 };
    if (p.id) row.id = p.id;
    return row;
  };

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
      const [perfis, cats, meses, prefs] = await Promise.all([
        sb.from('fin_perfis').select(PERFIL_COLS).order('ordem'),
        sb.from('fin_categorias').select(CAT_COLS).order('ordem'),
        sb.from('fin_meses').select(MES_COLS).order('ano').order('mes'),
        sb.from('fin_preferencias').select(PREF_COLS),
      ]);
      const prefsPorPerfil = {};
      for (const p of check(prefs)) {
        const { perfil_id: id, ...resto } = p;
        prefsPorPerfil[id] = { ...PREFS_PADRAO, ...resto };
      }
      return { perfis: check(perfis), categorias: check(cats), meses: check(meses), prefs: prefsPorPerfil };
    },
    async savePerfil(p) {
      return check(await sb.from('fin_perfis').upsert(limpaPerfil(p)).select(PERFIL_COLS).single());
    },
    async deletePerfil(id) {
      // Apaga em cascata as categorias, meses e preferências do perfil.
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
      const row = { perfil_id: perfilId, pct_investir: p.pct_investir, meses_reserva: p.meses_reserva, pct_max_gasto: p.pct_max_gasto };
      const salvo = check(await sb.from('fin_preferencias').upsert(row, { onConflict: 'user_id,perfil_id' }).select(PREF_COLS).single());
      const { perfil_id: _id, ...resto } = salvo;
      return { ...PREFS_PADRAO, ...resto };
    },
    async replaceAll(data) {
      // Restauração de backup: substitui tudo do usuário logado.
      // Apagar os perfis apaga em cascata categorias, meses e preferências.
      const d = normalizarDados(data);
      check(await sb.from('fin_perfis').delete().not('id', 'is', null));
      if (d.perfis.length) check(await sb.from('fin_perfis').insert(d.perfis.map(limpaPerfil)));
      if (d.categorias.length) check(await sb.from('fin_categorias').insert(d.categorias.map(limpaCat)));
      if (d.meses.length) check(await sb.from('fin_meses').insert(d.meses.map(limpaMes)));
      for (const [perfilId, p] of Object.entries(d.prefs)) await this.savePrefs(perfilId, { ...PREFS_PADRAO, ...p });
    },
  };
}
