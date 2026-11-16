# Finanças Marques — site

Versão web da planilha **FINANÇAS GERAIS.xlsx**: lança receita, despesas por cartão (débito/crédito),
investimento, rendimento e saldo inicial mês a mês, e calcula tudo igual à planilha
(totais, médias que ignoram meses vazios, saldo final = saldo inicial do mês seguinte, resultado do saldo,
organização 15% / 6× / 70%).

- Site estático (HTML/CSS/JS puro, sem build) — hospedagem grátis no GitHub Pages ou Netlify.
- Dados e login no **Supabase** — o mesmo dado aparece no computador, celular e iPad.
- Multiusuário pronto: cada conta só enxerga os próprios dados (Row Level Security).
- Sem Supabase configurado, roda em **modo local** (dados só no navegador) — útil para testar.

## Estrutura

| Arquivo | O que faz |
|---|---|
| `index.html` | Página única do app |
| `js/config.js` | URL e chave do Supabase (vazio = modo local) |
| `js/calc.js` | Todas as fórmulas da planilha |
| `js/app.js` | Telas: Visão geral, Anos, Ajustes, editor do mês |
| `js/store.js` | Leitura/gravação (Supabase ou local) |
| `js/importer.js` | Importa o `.xlsx` direto no navegador |
| `supabase/schema.sql` | Tabelas e regras de segurança do banco |

## Publicar (passo a passo)

### 1. Banco de dados (Supabase)
1. Projeto usado: **Precificacao Confeitaria** (`atttyqqmqqqoewcnxpmx`) — as tabelas de finanças têm prefixo `fin_` (já criadas).
2. `supabase/schema.sql` já foi aplicado; `js/config.js` já tem a URL e a chave publicável.
3. Em **Authentication → URL Configuration**, adicione o endereço do site em *Redirect URLs*
   (sem trocar o *Site URL*, que é do app da confeitaria).

### 2. Hospedagem (GitHub Pages)
1. Crie um repositório no GitHub e envie a pasta `financas-app`.
2. **Settings → Pages → Deploy from a branch → main / (root)**.
3. O site fica em `https://SEU-USUARIO.github.io/NOME-DO-REPO/`.

(Alternativa: Netlify → *Add new site → Import from GitHub*, sem comando de build, pasta de publicação `.`.
Útil se quiser o repositório privado.)

### 3. Primeiro acesso
1. Abra o site → **Criar conta** (confirme pelo e-mail).
2. **Ajustes → Importar planilha** → escolha `FINANÇAS GERAIS.xlsx`.
3. Depois de criar sua conta, desligue novos cadastros em
   **Authentication → Sign In / Providers → Allow new users to sign up** (religue quando quiser liberar outros usuários).

No celular/iPad: abra o site no navegador → *Compartilhar → Adicionar à Tela de Início* para usar como app.

## Testar localmente

```
powershell -ExecutionPolicy Bypass -File serve.ps1
```
e abra http://localhost:5500

## Privacidade
A planilha nunca vai para o repositório (`.gitignore` bloqueia `.xlsx`). A importação lê o arquivo
no próprio navegador e grava só no seu banco Supabase.

## Atualizar o site
Antes de cada commit, rode `sh versao.sh` (carimba uma versão nova nos arquivos para os
navegadores não misturarem arquivos antigos do cache com os novos). Depois `git push`:
o GitHub Pages publica em ~1 minuto.
