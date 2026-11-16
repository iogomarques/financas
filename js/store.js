// Camada de dados. Dois modos:
//  - "supabase": dados na nuvem, sincronizados entre computador, celular e iPad (com login).
//  - "local":    dados só neste navegador (usado enquanto o Supabase não está configurado).
import { uid } from './util.js?v=20261116132048';

const SUPABASE_JS = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.4/+esm';

export const PREFS_PADRAO = { pct_investir: 0.15, meses_reserva: 6, pct_max_gasto: 0.7 };

export async function createStore() {
  const cfg = window.FIN_CONFIG || {};
  if (cfg.SUPABASE_URL && cfg.SUPABASE_KEY) return supabaseStore(cfg);
  return localStore();
}

/* ---------------------------------------------------------------- local */
function localStore() {
  const KEY = 'financas-local-v1';
  const read = () => {
    try {
      return JSON.parse(localStorage.getItem(KEY)) || { categorias: [], meses: [], prefs: { ...PREFS_PADRAO } };
    } catch {
      return { categorias: [], meses: [], prefs: { ...PREFS_PADRAO } };
    }
  };
  const write = (db) => {
    try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) { console.error(e); }
  };
  const user = { email: 'Modo local (só neste dispositivo)' };

  return {
    mode: 'local',
    async getUser() { return user; },
    async autorizado() { return true; },
    onAuthChange() {},
    async signIn() { return user; },
    async signUp() { return user; },
    async resetPassword() {},
    async signOut() {},
    async load() { return read(); },
    async saveMes(rec) {
      const db = read();
      const i = db.meses.findIndex((m) => m.ano === rec.ano && m.mes === rec.mes);
      if (i >= 0) db.meses[i] = rec; else db.meses.push(rec);
      write(db);
      return rec;
    },
    async deleteMes(ano, mes) {
      const db = read();
      db.meses = db.meses.filter((m) => !(m.ano === ano && m.mes === mes));
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
    async savePrefs(p) {
      const db = read();
      db.prefs = { ...db.prefs, ...p };
      write(db);
      return db.prefs;
    },
    async replaceAll(data) {
      write({ categorias: data.categorias || [], meses: data.meses || [], prefs: { ...PREFS_PADRAO, ...(data.prefs || {}) } });
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
  const MES_COLS = 'ano, mes, receita, investimento, rendimento, saldo_inicial, despesas, formulas, observacao';
  const limpaMes = (r) => ({
    ano: r.ano, mes: r.mes,
    receita: r.receita ?? null,
    investimento: r.investimento ?? null,
    rendimento: r.rendimento ?? null,
    saldo_inicial: r.saldo_inicial ?? null,
    despesas: r.despesas || {},
    formulas: r.formulas || {},
    observacao: r.observacao || null,
  });

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

    // Só contas cadastradas em fin_usuarios acessam as finanças
    // (o projeto Supabase é dividido com outro app).
    async autorizado() {
      const { data, error } = await sb.from('fin_usuarios').select('user_id').maybeSingle();
      if (error) throw new Error(error.message);
      return !!data;
    },

    async load() {
      const [cats, meses, prefs] = await Promise.all([
        sb.from('fin_categorias').select('id, nome, tipo, ordem, ativo').order('ordem'),
        sb.from('fin_meses').select(MES_COLS).order('ano').order('mes'),
        sb.from('fin_preferencias').select('pct_investir, meses_reserva, pct_max_gasto').maybeSingle(),
      ]);
      return {
        categorias: check(cats),
        meses: check(meses),
        prefs: { ...PREFS_PADRAO, ...(check(prefs) || {}) },
      };
    },
    async saveMes(rec) {
      return check(await sb.from('fin_meses').upsert(limpaMes(rec), { onConflict: 'user_id,ano,mes' }).select(MES_COLS).single());
    },
    async deleteMes(ano, mes) {
      check(await sb.from('fin_meses').delete().eq('ano', ano).eq('mes', mes));
    },
    async saveCategoria(cat) {
      const row = { nome: cat.nome, tipo: cat.tipo, ordem: cat.ordem ?? 0, ativo: cat.ativo ?? true };
      if (cat.id) row.id = cat.id;
      return check(await sb.from('fin_categorias').upsert(row).select('id, nome, tipo, ordem, ativo').single());
    },
    async deleteCategoria(id) {
      check(await sb.from('fin_categorias').delete().eq('id', id));
    },
    async savePrefs(p) {
      const row = { pct_investir: p.pct_investir, meses_reserva: p.meses_reserva, pct_max_gasto: p.pct_max_gasto };
      return check(await sb.from('fin_preferencias').upsert(row, { onConflict: 'user_id' }).select('pct_investir, meses_reserva, pct_max_gasto').single());
    },
    async replaceAll(data) {
      // Usado pela restauração de backup: substitui tudo do usuário logado.
      check(await sb.from('fin_meses').delete().gte('ano', 0));
      check(await sb.from('fin_categorias').delete().not('id', 'is', null));
      if (data.categorias?.length) {
        check(await sb.from('fin_categorias').insert(data.categorias.map((c) => ({ id: c.id, nome: c.nome, tipo: c.tipo, ordem: c.ordem ?? 0, ativo: c.ativo ?? true }))));
      }
      if (data.meses?.length) check(await sb.from('fin_meses').insert(data.meses.map(limpaMes)));
      if (data.prefs) await this.savePrefs({ ...PREFS_PADRAO, ...data.prefs });
    },
  };
}
