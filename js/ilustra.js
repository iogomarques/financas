// Ilustrações 3D de cada quadro (deixam óbvio, à primeira vista, do que o quadro trata).
// Imagens do conjunto "Fluent Emoji" da Microsoft — licença MIT (uso livre, com crédito):
// https://github.com/microsoft/fluentui-emoji  · versão fixa abaixo para nunca mudar sozinha.
// Uso: ILUSTRA.carteira → string <img>. Tamanho controlado pelo CSS (.ilustra / .vg-icone).

const BASE = 'https://cdn.jsdelivr.net/gh/microsoft/fluentui-emoji@1ffb34c752ecf5d402f04cfb4b392c77f57c54bc/assets/';
const img = (pasta, arquivo, rotulo) =>
  `<img class="ilustra-img" src="${BASE}${encodeURIComponent(pasta)}/3D/${arquivo}_3d.png" alt="${rotulo}" loading="lazy" decoding="async" draggable="false">`;

export const ILUSTRA = {
  carteira: img('Purse', 'purse', 'Carteira'),               // sobra / dinheiro do mês
  calendario: img('Spiral calendar', 'spiral_calendar', 'Calendário'),
  cofrinho: img('Coin', 'coin', 'Moeda'),                    // investimento
  grafico: img('Bar chart', 'bar_chart', 'Gráfico'),
  cartoes: img('Credit card', 'credit_card', 'Cartão de crédito'),
  cofre: img('Bank', 'bank', 'Banco'),                       // saldo nas contas
  alvo: img('Bullseye', 'bullseye', 'Alvo'),                 // metas
  moedas: img('Money bag', 'money_bag', 'Saco de dinheiro'),
  // usados nos quadros da Visão geral
  banco: img('Bank', 'bank', 'Banco'),
  entrou: img('Dollar banknote', 'dollar_banknote', 'Dinheiro que entrou'),
  saiu: img('Money with wings', 'money_with_wings', 'Dinheiro que saiu'),
  balanco: img('Balance scale', 'balance_scale', 'Balanço'),
  ideia: img('Light bulb', 'light_bulb', 'Dica'),
  livro: img('Open book', 'open_book', 'Ajuda'),
  engrenagem: img('Gear', 'gear', 'Configurar'),
  recibo: img('Receipt', 'receipt', 'Recibo'),
};
