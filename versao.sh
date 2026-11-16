#!/bin/sh
# Carimba uma versão nova em todos os links de .js/.css para o navegador
# não usar arquivos antigos do cache depois de uma atualização.
# Rode antes de cada commit:  sh versao.sh
cd "$(dirname "$0")" || exit 1
V=$(date +%Y%m%d%H%M%S)
sed -i -E "s#(\./[a-z]+\.js)(\?v=[0-9]+)?'#\1?v=$V'#g" js/*.js
sed -i -E "s#(js/[a-z]+\.js|css/style\.css)(\?v=[0-9]+)?\"#\1?v=$V\"#g" index.html
echo "versão $V"
