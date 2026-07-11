# App de Campo — PNS 2026 (Campos dos Goytacazes e região)

App web 100% offline e sem backend para apoiar os entrevistadores da PNS 2026 em campo.
Ver `especificacao-app-campo.md` para a especificação completa.

## Estrutura

```
/scripts/converter.py    planilhas + malha do IBGE → app/dados.js (+ relatório)
/app/index.html          telas do app
/app/app.js               lógica e estado local
/app/styles.css           estilos
/app/dados.js              gerado pelo conversor — não editar à mão
/app/vendor/leaflet/…      Leaflet vendorizado (sem CDN)
/app/vendor/leaflet-offline/…  leaflet.offline + idb vendorizados (mapa offline)
/app/sw.js  /app/manifest.json  /app/icons/…
/dados-fonte/               planilhas originais + malha de setores do IBGE
```

## 1. Rodar a conversão dos dados

Pré-requisitos (uma vez):

```bash
pip3 install --user openpyxl pyshp
```

As planilhas (`selecionados.xlsx`, `completo.xlsx` ou o arquivo combinado
`selecionado e completo.xlsx`) devem estar em `dados-fonte/`.

`dados-fonte/upas.xlsx` (colunas "UPA" e "Setor", 1ª aba) mapeia cada setor à sua UPA
(Unidade Primária de Amostragem) — uma UPA sempre tem 15 domicílios selecionados, que
podem estar espalhados entre mais de um setor. Sem esse arquivo o conversor roda normal,
só que cada setor vira uma UPA sozinho (sem agrupar irmãos).

A malha de setores censitários do IBGE (2022, shapefile do RJ) também precisa estar
em `dados-fonte/RJ_setores_CD2022/` — baixe uma vez com:

```bash
curl -o dados-fonte/RJ_setores_CD2022.zip \
  "https://geoftp.ibge.gov.br/organizacao_do_territorio/malhas_territoriais/malhas_de_setores_censitarios__divisoes_intramunicipais/censo_2022/setores/shp/UF/RJ_setores_CD2022.zip"
unzip dados-fonte/RJ_setores_CD2022.zip -d dados-fonte/RJ_setores_CD2022
```

Depois, sempre que as planilhas mudarem, rode:

```bash
python3 scripts/converter.py
```

Isso gera `app/dados.js` e `relatorio-conversao.txt` (na raiz). **Confira o relatório** —
ele lista qualquer coordenada fora da região, telefone corrompido ou setor sem malha
oficial (contorno aproximado) antes de publicar o app.

Os dados reais de origem cobrem **4 municípios** (Campos dos Goytacazes, Italva, São
Francisco de Itabapoana e São João da Barra), não só Campos — o script já baixa/filtra
a malha para os 43 setores encontrados, qualquer que seja o município, e anexa o nome
do município (`municipio`) a cada domicílio e setor a partir da malha do IBGE.

## 2. Testar localmente

```bash
cd app
python3 -m http.server 8000
```

Abra `http://localhost:8000`. Para testar o modo offline de verdade, carregue a
página uma vez (para o service worker pré-cachear tudo), depois desligue o Wi-Fi/dados
e recarregue.

## 3. Entrevistadores

A lista inicial (`DADOS.entrevistadores` em `app/dados.js`) traz Maurício (M),
Ricardo (R), Maria Letícia (ML) e Lorena (L). Cada aparelho também pode cadastrar
entrevistadores extras pelo próprio app (tela inicial ou menu → "Cadastrar
entrevistador") — ficam salvos localmente naquele aparelho, sem alterar `dados.js`.

## 4. Publicar (GitHub Pages / Netlify)

Publique a pasta `app/` como raiz do site (não o repositório inteiro). Qualquer uma
das duas opções funciona sem configuração adicional, já que o app é só HTML/CSS/JS
estático.

Ao publicar uma atualização, aumente `CACHE_VERSION` em `app/sw.js` para forçar os
aparelhos a buscar a nova versão do app shell.

## 5. Dados pessoais (nome e telefone) — não vão para o repositório público

`scripts/converter.py` gera **dois** arquivos:

- `app/dados.js` — sem nome/telefone de ninguém. Pode ser publicado publicamente
  (GitHub Pages, Netlify etc.) sem risco de expor dado pessoal de morador.
- `dados-fonte/dados-pessoais.json` — só nome + telefone, indexado por `ID_CNEFE`.
  **Nunca commitar nem publicar este arquivo** (já está no `.gitignore`). Distribua-o
  à equipe por um canal privado (WhatsApp, Google Drive com link restrito etc.).

Cada entrevistador, depois de abrir o app publicado, importa esse arquivo uma vez pelo
menu → **"🔐 Importar dados pessoais"**. A partir daí nome/telefone passam a aparecer
normalmente na ficha, no popup do mapa, no roteiro e na carta de recusa — mas o dado
fica só no `localStorage` daquele aparelho, nunca passa pelo GitHub/hospedagem.

Se as planilhas mudarem, rode `python3 scripts/converter.py` de novo e redistribua o
`dados-pessoais.json` atualizado (o app substitui o anterior a cada nova importação).

## 6. Mapa offline

O download de tiles do mapa usa a biblioteca [`leaflet.offline`](https://github.com/allartk/leaflet.offline)
(+ [`idb`](https://github.com/jakearchibald/idb)), vendorizadas em `app/vendor/leaflet-offline/`
(mesmo mecanismo do app de referência `campo.html`) — os tiles ficam guardados em IndexedDB,
com download da "área visível na tela" (o entrevistador navega até a região desejada e toca em
"Baixar mapa offline"). Menu → "Limpar mapa offline" remove tudo. Se algum dia for preciso
atualizar essas duas bibliotecas, baixe de novo os arquivos de
`https://unpkg.com/leaflet.offline@<versão>/dist/bundle.js` e `https://unpkg.com/idb@<versão>/build/umd.js`.

## 7. Limitações conhecidas

- Navegadores não permitem que JavaScript defina um `User-Agent` customizado em
  requisições de tile; o download usa o user-agent padrão do navegador.
- `navigator.share` / `navigator.clipboard` exigem contexto seguro (HTTPS ou
  localhost) — funcionam em GitHub Pages/Netlify, mas não abrindo `index.html`
  direto do disco (`file://`).
