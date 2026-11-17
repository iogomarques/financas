// Ilustrações simples (SVG próprio) para deixar cada quadro óbvio à primeira vista.
// Uso: ILUSTRA.carteira → string SVG. Tamanho controlado pelo CSS (.ilustra).

const svg = (corpo, rotulo) =>
  `<svg class="ilustra-svg" viewBox="0 0 96 96" role="img" aria-label="${rotulo}" xmlns="http://www.w3.org/2000/svg">${corpo}</svg>`;

export const ILUSTRA = {
  // Carteira com notas: sobra / dinheiro do mês
  carteira: svg(`
    <ellipse cx="50" cy="86" rx="34" ry="5" fill="#000" opacity=".08"/>
    <rect x="22" y="20" width="44" height="26" rx="3" fill="#86efac" transform="rotate(-10 44 33)"/>
    <rect x="28" y="16" width="44" height="26" rx="3" fill="#4ade80" transform="rotate(6 50 29)"/>
    <circle cx="51" cy="29" r="6" fill="#22c55e" transform="rotate(6 50 29)"/>
    <rect x="12" y="32" width="72" height="50" rx="10" fill="#0f766e"/>
    <rect x="12" y="32" width="72" height="14" rx="7" fill="#115e59"/>
    <rect x="56" y="48" width="32" height="20" rx="8" fill="#134e4a"/>
    <circle cx="68" cy="58" r="4.5" fill="#fbbf24"/>`, 'Carteira'),

  // Calendário: mês
  calendario: svg(`
    <ellipse cx="48" cy="87" rx="32" ry="5" fill="#000" opacity=".08"/>
    <rect x="14" y="20" width="68" height="62" rx="10" fill="#fff" stroke="#e2e8f0" stroke-width="2"/>
    <path d="M14 30a10 10 0 0 1 10-10h48a10 10 0 0 1 10 10v8H14z" fill="#ef4444"/>
    <rect x="29" y="12" width="6" height="16" rx="3" fill="#475569"/>
    <rect x="61" y="12" width="6" height="16" rx="3" fill="#475569"/>
    <g fill="#cbd5e1"><rect x="24" y="46" width="10" height="8" rx="2"/><rect x="43" y="46" width="10" height="8" rx="2"/><rect x="62" y="46" width="10" height="8" rx="2"/>
    <rect x="24" y="60" width="10" height="8" rx="2"/><rect x="62" y="60" width="10" height="8" rx="2"/></g>
    <rect x="43" y="60" width="10" height="8" rx="2" fill="#0d9488"/>`, 'Calendário'),

  // Cofrinho: investimento / reserva
  cofrinho: svg(`
    <ellipse cx="48" cy="87" rx="30" ry="5" fill="#000" opacity=".08"/>
    <circle cx="52" cy="16" r="9" fill="#fbbf24" stroke="#d97706" stroke-width="2"/>
    <path d="M52 12v8M49 14h5a2 2 0 0 1 0 4h-4" stroke="#b45309" stroke-width="1.6" fill="none" stroke-linecap="round"/>
    <ellipse cx="48" cy="54" rx="32" ry="24" fill="#f9a8d4"/>
    <rect x="40" y="31" width="16" height="4" rx="2" fill="#be185d"/>
    <rect x="28" y="70" width="9" height="12" rx="3" fill="#f472b6"/>
    <rect x="58" y="70" width="9" height="12" rx="3" fill="#f472b6"/>
    <ellipse cx="80" cy="54" rx="7" ry="8" fill="#f472b6"/>
    <circle cx="78" cy="52" r="1.5" fill="#9d174d"/><circle cx="83" cy="52" r="1.5" fill="#9d174d"/>
    <circle cx="66" cy="44" r="2.5" fill="#831843"/>
    <path d="M22 40 14 34l11 1z" fill="#f472b6"/>`, 'Cofrinho'),

  // Gráfico subindo: comparação / evolução
  grafico: svg(`
    <ellipse cx="48" cy="87" rx="32" ry="5" fill="#000" opacity=".08"/>
    <rect x="12" y="14" width="72" height="68" rx="10" fill="#fff" stroke="#e2e8f0" stroke-width="2"/>
    <rect x="22" y="56" width="10" height="18" rx="2" fill="#99f6e4"/>
    <rect x="38" y="46" width="10" height="28" rx="2" fill="#5eead4"/>
    <rect x="54" y="38" width="10" height="36" rx="2" fill="#2dd4bf"/>
    <rect x="70" y="28" width="6" height="46" rx="2" fill="#0d9488"/>
    <path d="M20 44 38 32l14 6 22-18" stroke="#f97316" stroke-width="3.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M66 20h8v8" stroke="#f97316" stroke-width="3.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`, 'Gráfico'),

  // Dois cartões: cartões de crédito
  cartoes: svg(`
    <ellipse cx="48" cy="86" rx="34" ry="5" fill="#000" opacity=".08"/>
    <rect x="18" y="20" width="62" height="40" rx="7" fill="#38bdf8" transform="rotate(-12 49 40)"/>
    <rect x="12" y="34" width="66" height="44" rx="8" fill="#1e293b"/>
    <rect x="20" y="46" width="13" height="10" rx="2" fill="#fbbf24"/>
    <rect x="20" y="66" width="30" height="4" rx="2" fill="#64748b"/>
    <circle cx="62" cy="68" r="5" fill="#ef4444" opacity=".9"/><circle cx="69" cy="68" r="5" fill="#f59e0b" opacity=".9"/>`, 'Cartões'),

  // Cofre: saldo guardado
  cofre: svg(`
    <ellipse cx="48" cy="87" rx="32" ry="5" fill="#000" opacity=".08"/>
    <rect x="14" y="16" width="68" height="64" rx="10" fill="#475569"/>
    <rect x="20" y="22" width="56" height="52" rx="6" fill="#64748b"/>
    <circle cx="48" cy="48" r="14" fill="#334155" stroke="#94a3b8" stroke-width="3"/>
    <path d="M48 36v6M48 54v6M36 48h6M54 48h6" stroke="#cbd5e1" stroke-width="3" stroke-linecap="round"/>
    <circle cx="48" cy="48" r="4" fill="#fbbf24"/>
    <rect x="20" y="78" width="10" height="5" rx="2" fill="#334155"/><rect x="66" y="78" width="10" height="5" rx="2" fill="#334155"/>`, 'Cofre'),

  // Alvo: metas
  alvo: svg(`
    <ellipse cx="46" cy="87" rx="30" ry="5" fill="#000" opacity=".08"/>
    <circle cx="44" cy="50" r="32" fill="#fecaca"/>
    <circle cx="44" cy="50" r="23" fill="#fff"/>
    <circle cx="44" cy="50" r="15" fill="#f87171"/>
    <circle cx="44" cy="50" r="6" fill="#fff"/>
    <path d="M44 50 78 18" stroke="#334155" stroke-width="4" stroke-linecap="round"/>
    <path d="M72 14l10-2-2 10-5 1z" fill="#0d9488"/>`, 'Alvo'),

  // Moedas: receita
  moedas: svg(`
    <ellipse cx="48" cy="87" rx="32" ry="5" fill="#000" opacity=".08"/>
    <g fill="#fbbf24" stroke="#d97706" stroke-width="2">
      <ellipse cx="34" cy="74" rx="18" ry="6"/><rect x="16" y="64" width="36" height="10" fill="#fbbf24" stroke="none"/><ellipse cx="34" cy="64" rx="18" ry="6"/>
      <ellipse cx="34" cy="56" rx="18" ry="6"/><rect x="16" y="46" width="36" height="10" fill="#fbbf24" stroke="none"/><ellipse cx="34" cy="46" rx="18" ry="6"/>
    </g>
    <circle cx="66" cy="50" r="20" fill="#facc15" stroke="#d97706" stroke-width="2.5"/>
    <text x="66" y="57" text-anchor="middle" font-size="20" font-weight="800" fill="#b45309" font-family="Inter, sans-serif">$</text>`, 'Moedas'),
};
