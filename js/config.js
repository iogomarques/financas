// Configuração do Supabase (banco de dados na nuvem + login).
// Se os dois campos ficarem vazios, o site roda em "modo local"
// (dados salvos só no navegador deste dispositivo).
//
// A chave publicável pode ficar pública: quem protege os dados são as regras
// de segurança (RLS) do banco — cada usuário só enxerga os próprios dados.
window.FIN_CONFIG = {
  SUPABASE_URL: 'https://atttyqqmqqqoewcnxpmx.supabase.co',
  SUPABASE_KEY: 'sb_publishable_vdF1bs5426oC089EM3HnVw_jx-B4nt_',
};

// Teste: abrir o site com "?local" usa o modo local (dados só deste navegador),
// sem tocar nos dados reais da nuvem.
if (/[?&]local\b/.test(location.search)) window.FIN_CONFIG = { SUPABASE_URL: '', SUPABASE_KEY: '' };
