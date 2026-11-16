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
