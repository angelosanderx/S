# Especificação — App de Campo Offline (PNS 2026 · Campos dos Goytacazes)

## 1. Contexto e objetivo

Construir um aplicativo web **100% offline e sem backend** para apoiar 4 entrevistadores
em uma pesquisa domiciliar (PNS 2026). O app é uma versão simplificada de um sistema
existente (que usava Firebase) e deve funcionar de forma totalmente independente:
**não usar Firebase, nem banco remoto, nem autenticação em servidor, nem API externa**.

Funções essenciais:

1. Mapa geral com **todos os domicílios selecionados** da amostra (pinos coloridos por status).
2. Ao tocar num pino, abre a **ficha do domicílio**, contendo os dados de identificação
   e o **roteiro de campo (CNEFE)** — a lista completa de endereços da mesma quadra/face,
   destacando o domicílio-alvo.
3. Cada entrevistador **se autoatribui** domicílios e **controla o status** de cada um
   localmente (nada é sincronizado; cada aparelho é independente).
4. **Repasse** de domicílio para outro entrevistador via mensagem pronta compartilhada
   no grupo de WhatsApp da equipe.
5. **Carta de recusa** gerada pelo app e compartilhada no mesmo grupo de WhatsApp.
6. **Backup** local exportável/importável (JSON).

## 2. Restrições e decisões de arquitetura

- **PWA estático**: HTML/CSS/JS puros (sem framework obrigatório; se usar, que o build
  gere arquivos estáticos simples). Hospedagem em GitHub Pages ou Netlify.
- **Leaflet** para o mapa, com JS/CSS **vendorizados no projeto** (não usar CDN em
  runtime — tudo precisa funcionar offline após o primeiro carregamento).
- **Dados embutidos**: os domicílios, o roteiro CNEFE e os polígonos dos setores são
  convertidos das planilhas/KML para um arquivo `dados.js` (ou JSON importado) gerado
  por um **script de conversão** que faz parte do repositório (ver seção 4).
- **Persistência local**: estado do entrevistador (identidade, atribuições, status,
  observações) em `localStorage` ou IndexedDB. Chamar
  `navigator.storage.persist()` na inicialização para pedir armazenamento persistente.
- **Service worker**: pré-cacheia o app inteiro (app shell + dados + Leaflet) na
  primeira visita. Estratégia cache-first. Incluir botão "Baixar mapa offline" que
  baixa e guarda no Cache Storage os tiles OSM da área de estudo (ver seção 8).
- **Sem coleta de dados de pesquisa**: o app NÃO registra respostas de entrevista.
  Os status servem apenas ao controle pessoal do entrevistador.

## 3. Dados de entrada (fornecidos pelo usuário)

Serão anexados ao projeto:

1. **Planilha de endereços selecionados** ("Lista de Endereços - PNS 2026") — os
   domicílios-alvo da amostra (`Selecionado = Sim`).
2. **Planilha CNEFE completa** — todos os endereços dos setores, usada para montar o
   roteiro de campo.
3. Lista com os **nomes dos 4 entrevistadores** (com a letra de código de cada um).

**Não há arquivo KML dos setores.** Os polígonos devem ser obtidos pelo script de
conversão (ver 4.3): malha oficial de setores censitários do IBGE, com fallback
gerado a partir dos próprios pontos da planilha.

### 3.1 Colunas das planilhas (ambas têm o mesmo layout)

| Coluna | Significado | Observações |
|---|---|---|
| Controle | Código do setor censitário (ex.: `330100905060007`) | Chave de agrupamento do roteiro e dos filtros |
| ID_CNEFE | Identificador único do endereço | Chave primária do domicílio no app |
| N.º Domicílio | Número de ordem do domicílio selecionado no setor | Preenchido só nos selecionados |
| Quadra / Face | Localização dentro do setor | Usadas para ordenar o roteiro |
| Logradouro / Número / Complemento / Bairro | Endereço | Exibir na ficha e no roteiro |
| Latitude / Longitude | Coordenadas em **graus minutos segundos sem sinal** (ex.: `21 45 20.851` / `41 20 13.1789`) | Ver conversão em 4.2 |
| Telefone | Telefone do morador | CUIDADO: pode vir corrompido em notação científica (`2,2998E+10`) — ler como texto; se estiver em notação científica, descartar ou marcar como inválido |
| Morador | Nome do morador (quando houver) | Exibir na ficha |
| Situação | URBANO/RURAL | Exibir |
| Selecionado | Sim/Não | `Sim` = domicílio-alvo da amostra |
| Antropometria / Biomarcador | Sim/Não/- | Exibir como badges na ficha quando `Sim` |
| ID Zona / Nome ZONA | Zona da pesquisa | Exibir e permitir filtro se houver valores |

### 3.2 Armadilhas conhecidas das planilhas (o parser DEVE tratar)

- A planilha de selecionados contém **blocos por setor**, com linha-título
  ("Lista de Enderecos - PNS 2026") e **cabeçalhos repetidos** no meio dos dados.
  O parser deve pular linhas-título, linhas vazias e cabeçalhos duplicados
  (detectar linha cujo valor da coluna A é "Controle").
- Valores "-" devem ser tratados como vazio/nulo.
- `Controle` e `ID_CNEFE` devem ser lidos como **texto** (nunca número — Excel pode
  truncar ou converter para notação científica).
- Células podem ter espaços extras; aplicar `trim()` em tudo.

## 4. Script de conversão de dados

Criar `scripts/converter.py` (ou Node) que lê as duas planilhas (XLSX/CSV) e
gera `app/dados.js` com a estrutura da seção 5. Deve ser reexecutável (dados mudam →
roda de novo → novo `dados.js`).

### 4.1 Lógica

- Domicílios do app = linhas com `Selecionado = Sim` da planilha de selecionados.
- Roteiro de campo = TODAS as linhas da planilha CNEFE completa, agrupadas por
  `Controle` (setor) e ordenadas por Quadra → Face → sequência original da planilha.
- Vincular cada domicílio selecionado à sua posição no roteiro via `ID_CNEFE`
  (marcar `alvo: true` na linha correspondente do roteiro).
- Gerar os polígonos dos setores conforme 4.3.

### 4.2 Conversão de coordenadas (CRÍTICO)

As coordenadas vêm como `"GG MM SS.sss"` **sem sinal**. A área de estudo é
Campos dos Goytacazes/RJ (hemisfério Sul, oeste de Greenwich), portanto:

```
decimal = -(GG + MM/60 + SS/3600)
```

Aplicar o sinal negativo tanto à latitude quanto à longitude.

**Validação obrigatória**: após converter, todo ponto deve cair dentro do retângulo
aproximado de Campos dos Goytacazes — latitude entre −22.3 e −21.2, longitude entre
−41.9 e −40.8. O script deve listar num relatório (`relatorio-conversao.txt`) os
registros fora da caixa, sem coordenada ou com formato inesperado, em vez de falhar
silenciosamente ou plotar pontos errados.

### 4.3 Polígonos dos setores (sem KML disponível)

Os valores de `Controle` são geocódigos de setor censitário do IBGE
(ex.: `330100905060007`; o prefixo `3301009` é o município de Campos dos
Goytacazes). O script deve obter os contornos assim, nesta ordem:

1. **Fonte oficial**: baixar a malha de setores censitários do IBGE
   (Censo 2022, disponível no geoftp/portal de malhas territoriais do IBGE;
   basta o recorte do RJ ou do município 3301009), filtrar apenas os setores
   cujos geocódigos aparecem na coluna Controle e converter para GeoJSON
   simplificado (tolerância pequena, só para reduzir tamanho). O download
   ocorre apenas na máquina de desenvolvimento, durante a conversão — o app
   final permanece 100% offline. Guardar o arquivo baixado em `dados-fonte/`
   para builds futuros não dependerem de internet.
2. **Fallback por pontos**: se algum geocódigo não for encontrado na malha,
   gerar um contorno aproximado pela envoltória (concave/convex hull com
   pequeno buffer, ~30 m) dos pontos da planilha CNEFE completa daquele setor.
   Marcar esses setores como `aproximado: true` no GeoJSON (exibidos com
   linha tracejada no mapa) e listá-los no relatório de conversão.

## 5. Modelo de dados

### 5.1 Dados estáticos (gerados pelo script, somente leitura)

```js
// app/dados.js
const DADOS = {
  geradoEm: "2026-07-10T12:00:00Z",
  entrevistadores: [
    // "letra" = inicial usada no código da etiqueta; deve ser ÚNICA entre os 4
    // (se dois nomes começarem com a mesma letra, definir letras distintas à mão)
    { nome: "Mauricio", letra: "M" },
    { nome: "Nome 2",  letra: "…" },
    { nome: "Nome 3",  letra: "…" },
    { nome: "Nome 4",  letra: "…" }
  ],
  setores: [
    { controle: "330100905060007", nomeZona: "…", aproximado: false, geojson: {…} }
  ],
  domicilios: [ // apenas Selecionado = Sim
    {
      id: "40976814",            // ID_CNEFE (string)
      setor: "330100905060007",
      numDomicilio: 11, quadra: 1, face: 2,
      logradouro: "RUA DOUTOR …", numero: "0",
      complemento: "SN LADO DO…", bairro: "PARQUE TAM…",
      lat: -21.755792, lng: -41.337050,
      telefone: null, morador: null,
      situacao: "URBANO",
      antropometria: true, biomarcador: false,
      zona: null
    }
  ],
  roteiro: { // por setor, todas as linhas do CNEFE completo, já ordenadas
    "330100905060007": [
      { id: "40976801", quadra: 1, face: 1, logradouro: "RUA TENENTI…",
        numero: "1001", complemento: null, alvo: false },
      …
    ]
  }
};
```

### 5.2 Estado local (por aparelho — localStorage/IndexedDB)

```js
{
  usuario: "Nome 2",                    // escolhido na primeira abertura
  domicilios: {
    "40976814": {
      atribuido: true,                  // "meu"
      codigo: "M0007/11",               // gerado na atribuição — ver seção 7.7
      status: "recusa",                 // ver seção 6
      obs: "voltar sábado de manhã",
      etiqueta: {                       // sobrescreve os dados da planilha na etiqueta
        nome: "Sr(a) Morador(a)",       // padrão; editável
        logradouro: null, numero: null, // null = usa o valor original da planilha
        complemento: null, bairro: null
      },
      repassadoPara: null,              // nome, quando status = repassado
      atualizadoEm: "2026-07-15T…"
    }
  },
  tilesBaixados: true
}
```

## 6. Status e cores dos pinos

| Status | Cor sugerida | Observação |
|---|---|---|
| Não visitado (padrão) | cinza `#64748b` | |
| Agendado | azul `#2563eb` | |
| Realizado | verde `#16a34a` | |
| Domicílio fechado | amarelo `#d97706` | |
| Domicílio vago | roxo `#7c3aed` | |
| Recusa | vermelho `#dc2626` | habilita o botão "Carta de recusa" |
| Mudou-se / inexistente | laranja `#ea580c` | |
| Repassado | contorno tracejado + cor cinza | guarda `repassadoPara` |

Domicílios **não atribuídos a mim** aparecem com pino menor/opaco; os "meus" em
tamanho normal. Legenda acessível por botão flutuante no mapa.

## 7. Telas e fluxos

### 7.1 Primeira abertura — identificação
Tela simples "Quem é você?" com os 4 nomes. Sem senha/PIN. Grava em localStorage.
Opção "trocar usuário" escondida no menu (com confirmação), sem apagar os dados.

### 7.2 Mapa (tela principal)
- Todos os domicílios selecionados como pinos coloridos por status.
- Polígonos dos setores (contorno visível, preenchimento sutil).
- Filtros persistentes (barra de chips ou painel): por **setor**, por **status**,
  e alternância **"Só os meus"**.
- **Busca** por ID_CNEFE ou nº do domicílio → centraliza e abre a ficha.
- Botão de localização GPS do aparelho (Leaflet locate).
- Contador visível: "X de Y realizados" (dos meus).

### 7.3 Ficha do domicílio (abre ao tocar no pino)
1. Cabeçalho: endereço completo, setor, quadra/face, nº domicílio, ID_CNEFE,
   morador/telefone quando houver, badges Antropometria/Biomarcador.
2. Controles: **Atribuir a mim / Remover**, seletor de **status**, campo de
   **observações** (texto livre, salvo localmente).
3. **Roteiro de campo (CNEFE)**: lista do setor inteiro (ordenada por quadra/face),
   com scroll automático até o domicílio-alvo, que aparece destacado. Cada linha:
   logradouro, número, complemento. Linhas de outros domicílios selecionados do
   mesmo setor também levemente destacadas.
4. Botões de ação: **Repassar**, **Etiqueta de endereço** (só habilitado se o
   domicílio estiver atribuído a mim — ver 7.7) e, quando status = recusa,
   **Carta de recusa**.
5. O **código do domicílio** (ex.: `M0007/11`), quando existir, aparece em destaque
   no cabeçalho da ficha e no popup do pino no mapa.

### 7.4 Repasse
1. Botão "Repassar" → escolhe um dos outros 3 nomes.
2. Localmente: status vira `repassado`, grava `repassadoPara`.
3. Monta mensagem e abre `navigator.share({ text })` (Web Share API). Fallback:
   copiar para a área de transferência + aviso "cole no grupo do WhatsApp".

Modelo da mensagem:
```
🔄 REPASSE DE DOMICÍLIO — PNS 2026
De: {usuario}  →  Para: {destino}
Motivo: morador selecionado de sexo oposto
Setor: {setor} · Quadra {q} Face {f} · Dom. nº {n}
{logradouro}, {numero} {complemento} — {bairro}
ID_CNEFE: {id}
➡️ {destino}: abra o app, busque o ID acima e toque em "Atribuir a mim".
```

Quem recebe busca o ID_CNEFE no app e toca "Atribuir a mim" (isso limpa qualquer
status anterior no aparelho dele e marca como não visitado/atribuído).

### 7.5 Carta de recusa
Ao definir status "recusa", botão "Gerar carta de recusa" monta o texto padrão
preenchido (data, entrevistador, setor, endereço, ID_CNEFE) e compartilha via
Web Share API no grupo do WhatsApp (mesmo fallback de cópia). O texto-modelo da
carta deve ficar em uma constante fácil de editar no topo do código.

### 7.6 Etiquetas de endereço

**Código do domicílio.** Gerado automaticamente no momento em que o entrevistador
toca "Atribuir a mim":

```
codigo = letra do entrevistador
       + últimos 4 dígitos do código do setor (Controle)
       + "/" + N.º Domicílio
```

Exemplo: Mauricio, setor `330100905060101`, domicílio 1 → **`M0101/1`**.
O código é gravado no estado local, exibido na ficha e no popup do pino, e é
removido/regerado se o domicílio for desatribuído ou repassado (no aparelho de quem
recebe, o código é gerado com a letra do receptor).

**Geração da etiqueta.** Pré-condição: domicílio atribuído a mim (o botão fica
desabilitado, com explicação, caso contrário). Ao tocar em "Etiqueta de endereço":

1. Abre uma tela de edição com os campos pré-preenchidos: **Nome** (padrão fixo
   `Sr(a) Morador(a)`, mesmo quando a planilha traz o nome do morador), Logradouro,
   Número, Complemento, Bairro — **todos editáveis**. As edições ficam salvas no
   estado local (`etiqueta`) e valem para futuras reimpressões; os dados originais
   da planilha nunca são alterados.
2. A etiqueta traz também o **código** (`M0101/1`) em posição destacada e o setor.
3. Botão "Gerar": abre uma página de impressão (`window.print()` com CSS `@media
   print`) — funciona offline e permite salvar como PDF pelo próprio navegador.
   Além do modo individual, oferecer **"Gerar etiquetas em lote"** (no menu ou no
   filtro do mapa): produz uma folha A4 com as etiquetas de todos os domicílios
   atribuídos a mim (opcionalmente filtrados por setor), em grade compatível com
   folhas adesivas padrão (ex.: 2 colunas × 5–7 linhas; deixar as dimensões da
   grade em constantes fáceis de ajustar no topo do código).

Layout de cada etiqueta:

```
┌─────────────────────────────────────┐
│  M0101/1                 Setor 0101 │
│  Sr(a) Morador(a)                   │
│  RUA DOUTOR …, 32 — APARTAMENTO …   │
│  PARQUE TAM… — Campos dos G./RJ     │
└─────────────────────────────────────┘
```

### 7.7 Backup
Menu → "Exportar backup": baixa `backup-{usuario}-{data}.json` com todo o estado
local. "Importar backup": lê o arquivo e mescla (registro mais recente vence,
usando `atualizadoEm`). Exibir aviso recomendando exportar semanalmente.

## 8. Offline / PWA

- `manifest.json` + ícones + service worker com pré-cache do app shell, `dados.js`
  e Leaflet. Versionar o cache (invalidação a cada deploy).
- **Tiles offline**: botão "Baixar mapa offline" nas configurações. Calcular o
  bounding box de todos os pontos + margem de ~1 km e baixar tiles OSM dos zooms
  14–17 para o Cache Storage, com barra de progresso e estimativa de tamanho.
  Respeitar a política do OSM (User-Agent identificado, download com throttle).
  Se a área for grande demais (> ~3.000 tiles), baixar por setor filtrado.
- **Fallback garantido**: se um tile não estiver em cache e não houver rede,
  o mapa mostra fundo neutro — polígonos dos setores e pinos continuam visíveis
  (são vetoriais e estão embutidos).

## 9. Estrutura sugerida do repositório

```
/scripts/converter.py        # planilhas + KML → app/dados.js (+ relatório)
/app/index.html
/app/app.js  /app/styles.css
/app/dados.js                # gerado — não editar à mão
/app/vendor/leaflet/…        # Leaflet vendorizado
/app/sw.js  /app/manifest.json  /app/icons/…
/dados-fonte/                # planilhas originais + malha IBGE baixada
README.md                    # como rodar conversão, testar local e publicar
```

## 10. Critérios de aceitação

1. Com o aparelho em **modo avião** (após primeira visita + tiles baixados): mapa,
   filtros, ficha, roteiro, status, observações e backup funcionam integralmente.
2. Todos os pontos plotados caem dentro de Campos dos Goytacazes; relatório de
   conversão sem erros não tratados.
3. Buscar um ID_CNEFE de repasse encontra o domicílio e abre a ficha em ≤ 2 toques.
4. Repasse e carta de recusa abrem a folha de compartilhamento nativa no Android
   e iOS; fallback de cópia funciona no desktop.
5. Recarregar a página / fechar o navegador não perde nenhum status.
6. `dados.js` regenerado pelo script substitui o antigo sem quebrar o estado local
   (estado é indexado por ID_CNEFE).
7. Interface em português, botões grandes (uso em campo, sob sol), tema claro.
8. Atribuir um domicílio gera o código no formato correto (`M0101/1`); a etiqueta
   só pode ser gerada para domicílios atribuídos, com todos os campos editáveis e
   nome padrão `Sr(a) Morador(a)`; impressão individual e em lote funcionam offline.

## 11. Fora do escopo (não implementar)

- Login/senha, sincronização entre aparelhos, painel de supervisão, coleta de
  respostas de entrevista, notificações push, qualquer serviço de backend.
