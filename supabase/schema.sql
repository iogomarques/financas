-- Banco de dados do site Finanças Gerais (Supabase / Postgres)
-- As tabelas usam o prefixo fin_ porque dividem o projeto Supabase com outro app.
-- Cada usuário só enxerga e altera os próprios dados (Row Level Security).

-- Cartões / categorias de despesa (ex.: Débito, Crédito Iogo, Crédito Ivoney)
create table if not exists public.fin_categorias (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  nome       text not null check (char_length(nome) between 1 and 80),
  tipo       text not null check (tipo in ('debito', 'credito')),
  ordem      int  not null default 0,
  ativo      boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists fin_categorias_user_idx on public.fin_categorias (user_id);

-- Um registro por mês (equivale a uma linha da aba do ano na planilha)
create table if not exists public.fin_meses (
  user_id       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  ano           int  not null check (ano between 1990 and 2200),
  mes           int  not null check (mes between 1 and 12),
  receita       numeric(14, 2),
  investimento  numeric(14, 2),
  rendimento    numeric(14, 2),
  saldo_inicial numeric(14, 2),
  despesas      jsonb not null default '{}'::jsonb,  -- { "<categoria_id>": valor }
  formulas      jsonb not null default '{}'::jsonb,  -- contas digitadas, ex.: { "receita": "1598.4-38.9" }
  observacao    text,
  updated_at    timestamptz not null default now(),
  primary key (user_id, ano, mes)
);

-- Percentuais do painel "Organização finanças"
create table if not exists public.fin_preferencias (
  user_id       uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  pct_investir  numeric not null default 0.15,
  meses_reserva numeric not null default 6,
  pct_max_gasto numeric not null default 0.70,
  updated_at    timestamptz not null default now()
);

-- updated_at automático
create or replace function public.fin_tocar_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;
revoke execute on function public.fin_tocar_updated_at() from public, anon, authenticated;

drop trigger if exists fin_meses_updated on public.fin_meses;
create trigger fin_meses_updated before update on public.fin_meses
  for each row execute function public.fin_tocar_updated_at();
drop trigger if exists fin_preferencias_updated on public.fin_preferencias;
create trigger fin_preferencias_updated before update on public.fin_preferencias
  for each row execute function public.fin_tocar_updated_at();

-- Segurança: cada usuário acessa apenas as próprias linhas
alter table public.fin_categorias   enable row level security;
alter table public.fin_meses        enable row level security;
alter table public.fin_preferencias enable row level security;

drop policy if exists "fin categorias do dono" on public.fin_categorias;
create policy "fin categorias do dono" on public.fin_categorias for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

drop policy if exists "fin meses do dono" on public.fin_meses;
create policy "fin meses do dono" on public.fin_meses for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

drop policy if exists "fin preferencias do dono" on public.fin_preferencias;
create policy "fin preferencias do dono" on public.fin_preferencias for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

-- ===================================================================
-- Isolamento do app da confeitaria (aplicado em 16/11/2026)
-- O projeto Supabase é compartilhado; as contas de login (auth.users) também.
-- Garantias:
--  1. Só contas listadas em fin_usuarios acessam qualquer tabela fin_.
--     (Contas da confeitaria NÃO entram aqui; a confeitaria usa a tabela membros.)
--  2. Excluir uma conta nunca apaga dados de finanças (on delete restrict).
--  3. Visitantes sem login não têm permissão nenhuma nas tabelas fin_.
-- Para liberar uma conta:  insert into public.fin_usuarios (user_id) values ('<id da conta>');
-- ===================================================================
create table if not exists public.fin_usuarios (
  user_id   uuid primary key references auth.users (id) on delete restrict,
  criado_em timestamptz not null default now()
);
alter table public.fin_usuarios enable row level security;
drop policy if exists "fin usuario ve a si mesmo" on public.fin_usuarios;
create policy "fin usuario ve a si mesmo" on public.fin_usuarios for select to authenticated
  using ((select auth.uid()) = user_id);
revoke insert, update, delete on public.fin_usuarios from anon, authenticated;

alter table public.fin_categorias   drop constraint fin_categorias_user_id_fkey,
  add constraint fin_categorias_user_id_fkey foreign key (user_id) references auth.users (id) on delete restrict;
alter table public.fin_meses        drop constraint fin_meses_user_id_fkey,
  add constraint fin_meses_user_id_fkey foreign key (user_id) references auth.users (id) on delete restrict;
alter table public.fin_preferencias drop constraint fin_preferencias_user_id_fkey,
  add constraint fin_preferencias_user_id_fkey foreign key (user_id) references auth.users (id) on delete restrict;

drop policy if exists "fin categorias do dono" on public.fin_categorias;
create policy "fin categorias do dono" on public.fin_categorias for all to authenticated
  using ((select auth.uid()) = user_id and exists (select 1 from public.fin_usuarios u where u.user_id = (select auth.uid())))
  with check ((select auth.uid()) = user_id and exists (select 1 from public.fin_usuarios u where u.user_id = (select auth.uid())));
drop policy if exists "fin meses do dono" on public.fin_meses;
create policy "fin meses do dono" on public.fin_meses for all to authenticated
  using ((select auth.uid()) = user_id and exists (select 1 from public.fin_usuarios u where u.user_id = (select auth.uid())))
  with check ((select auth.uid()) = user_id and exists (select 1 from public.fin_usuarios u where u.user_id = (select auth.uid())));
drop policy if exists "fin preferencias do dono" on public.fin_preferencias;
create policy "fin preferencias do dono" on public.fin_preferencias for all to authenticated
  using ((select auth.uid()) = user_id and exists (select 1 from public.fin_usuarios u where u.user_id = (select auth.uid())))
  with check ((select auth.uid()) = user_id and exists (select 1 from public.fin_usuarios u where u.user_id = (select auth.uid())));

revoke all on public.fin_categorias, public.fin_meses, public.fin_preferencias, public.fin_usuarios from anon;

-- ===================================================================
-- Perfis internos e convites por e-mail (aplicado em 16/11/2026)
-- Cada login tem um perfil (criado automaticamente pelo site); pessoal e empresa
-- ficam juntos no mesmo perfil, separados por categoria.
-- Convites: e-mail em fin_convites entra liberado ao criar a conta.
--   insert into public.fin_convites (email) values ('pessoa@exemplo.com');
-- ===================================================================
create table if not exists public.fin_convites (
  email     text primary key check (email = lower(email)),
  criado_em timestamptz not null default now()
);
alter table public.fin_convites enable row level security;
create policy "fin convite proprio" on public.fin_convites for select to authenticated
  using (email = lower(coalesce((select auth.jwt()) ->> 'email', '')));
revoke all on public.fin_convites from anon;
revoke insert, update, delete on public.fin_convites from authenticated;

create or replace function public.fin_acesso() returns boolean
language sql stable set search_path = '' as $$
  select exists (select 1 from public.fin_usuarios u where u.user_id = (select auth.uid()))
      or exists (select 1 from public.fin_convites c where c.email = lower(coalesce((select auth.jwt()) ->> 'email', '')));
$$;
revoke execute on function public.fin_acesso() from public, anon;
grant execute on function public.fin_acesso() to authenticated;

create table if not exists public.fin_perfis (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users (id) on delete restrict,
  nome       text not null check (char_length(nome) between 1 and 40),
  tipo       text not null default 'pessoal' check (tipo in ('pessoal', 'empresa')),
  cor        text not null default '#0f766e' check (cor ~ '^#[0-9a-fA-F]{6}$'),
  ordem      int  not null default 0,
  created_at timestamptz not null default now(),
  unique (id, user_id)
);
-- fin_categorias, fin_meses e fin_preferencias ganharam perfil_id (not null),
-- FK (perfil_id, user_id) -> fin_perfis on delete cascade, e chaves:
--   fin_meses: (user_id, perfil_id, ano, mes) · fin_preferencias: (user_id, perfil_id)
-- Todas as policies fin_* passaram a usar: (select auth.uid()) = user_id and (select public.fin_acesso())

-- ===================================================================
-- Lançamentos individuais (aplicado em 17/11/2026)
-- O total de cada campo do mês (receita, rendimento, investimento, cada categoria)
-- passa a ser a soma dos lançamentos daquele campo quando houver algum.
-- A chave impede importar a mesma movimentação do banco duas vezes.
-- ===================================================================
create table if not exists public.fin_lancamentos (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users (id) on delete restrict,
  perfil_id    uuid not null,
  data         date not null,
  descricao    text not null check (char_length(descricao) between 1 and 200),
  valor        numeric(14, 2) not null check (valor > 0),
  destino      text not null check (destino in ('despesa', 'receita', 'rendimento', 'investimento')),
  categoria_id uuid references public.fin_categorias (id) on delete no action,
  escopo       text not null default 'pessoal' check (escopo in ('pessoal', 'empresa')),
  origem       text not null default 'manual' check (origem in ('manual', 'extrato')),
  conta        text,
  chave        text,
  created_at   timestamptz not null default now(),
  constraint fin_lancamentos_perfil_fkey foreign key (perfil_id, user_id)
    references public.fin_perfis (id, user_id) on delete cascade,
  constraint fin_lancamentos_categoria_ok check ((destino = 'despesa') = (categoria_id is not null)),
  constraint fin_lancamentos_sem_repetir unique (user_id, perfil_id, chave)
);
create index if not exists fin_lancamentos_data_idx on public.fin_lancamentos (user_id, perfil_id, data);
create index if not exists fin_lancamentos_perfil_idx on public.fin_lancamentos (perfil_id, user_id);
create index if not exists fin_lancamentos_categoria_idx on public.fin_lancamentos (categoria_id);
alter table public.fin_lancamentos enable row level security;
revoke all on public.fin_lancamentos from anon;
create policy "fin lancamentos do dono" on public.fin_lancamentos for all to authenticated
  using ((select auth.uid()) = user_id and (select public.fin_acesso()))
  with check ((select auth.uid()) = user_id and (select public.fin_acesso()));

-- ===================================================================
-- Categorias de gasto e regras automáticas (aplicado em 17/11/2026)
-- fin_categorias = de onde saiu o dinheiro (contas e cartões)
-- fin_classes    = com o que foi gasto (Funcionários, Assinaturas...)
-- Pessoal × empresa é por lançamento (fin_lancamentos.escopo); a categoria
-- tem um lado padrão e a regra pode fixar o lado.
-- ===================================================================
create table if not exists public.fin_classes (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users (id) on delete restrict,
  perfil_id     uuid not null,
  nome          text not null check (char_length(nome) between 1 and 60),
  cor           text not null default '#64748b' check (cor ~ '^#[0-9a-fA-F]{6}$'),
  ordem         int  not null default 0,
  ativo         boolean not null default true,
  escopo_padrao text check (escopo_padrao in ('pessoal', 'empresa')),
  created_at    timestamptz not null default now(),
  constraint fin_classes_perfil_fkey foreign key (perfil_id, user_id)
    references public.fin_perfis (id, user_id) on delete cascade
);
create index if not exists fin_classes_perfil_idx on public.fin_classes (perfil_id, user_id);

create table if not exists public.fin_regras (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users (id) on delete restrict,
  perfil_id  uuid not null,
  texto      text not null check (char_length(texto) between 2 and 120),
  classe_id  uuid not null references public.fin_classes (id) on delete cascade,
  escopo     text check (escopo in ('pessoal', 'empresa')),
  created_at timestamptz not null default now(),
  constraint fin_regras_perfil_fkey foreign key (perfil_id, user_id)
    references public.fin_perfis (id, user_id) on delete cascade,
  constraint fin_regras_texto_unico unique (user_id, perfil_id, texto)
);
create index if not exists fin_regras_classe_idx on public.fin_regras (classe_id);
create index if not exists fin_regras_perfil_idx on public.fin_regras (perfil_id, user_id);

alter table public.fin_lancamentos add column if not exists classe_id uuid
  references public.fin_classes (id) on delete set null;
create index if not exists fin_lancamentos_classe_idx on public.fin_lancamentos (classe_id);

alter table public.fin_classes enable row level security;
alter table public.fin_regras  enable row level security;
revoke all on public.fin_classes, public.fin_regras from anon;
create policy "fin classes do dono" on public.fin_classes for all to authenticated
  using ((select auth.uid()) = user_id and (select public.fin_acesso()))
  with check ((select auth.uid()) = user_id and (select public.fin_acesso()));
create policy "fin regras do dono" on public.fin_regras for all to authenticated
  using ((select auth.uid()) = user_id and (select public.fin_acesso()))
  with check ((select auth.uid()) = user_id and (select public.fin_acesso()));

-- ===================================================================
-- Transferências entre as próprias contas (aplicado em 17/11/2026)
-- destino 'transferencia' fica registrado mas não conta como receita nem despesa.
-- sentido: entrada/saída do dinheiro na conta (para achar o "par" da transferência).
-- meus_nomes: nomes que identificam as próprias contas no extrato.
-- ===================================================================
alter table public.fin_lancamentos drop constraint fin_lancamentos_destino_check;
alter table public.fin_lancamentos add constraint fin_lancamentos_destino_check
  check (destino in ('despesa', 'receita', 'rendimento', 'investimento', 'transferencia'));
alter table public.fin_lancamentos drop constraint fin_lancamentos_categoria_ok;
alter table public.fin_lancamentos add constraint fin_lancamentos_categoria_ok
  check (destino <> 'despesa' or categoria_id is not null);
alter table public.fin_lancamentos add column if not exists sentido text check (sentido in ('entrada', 'saida'));
alter table public.fin_preferencias add column if not exists meus_nomes text[] not null default '{}';
