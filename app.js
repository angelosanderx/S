// App de Campo — PNS 2026 (Campos dos Goytacazes e região)
// 100% offline, sem backend. Ver especificacao-app-campo.md.
'use strict';

// ---------------------------------------------------------------------
// Constantes fáceis de ajustar
// ---------------------------------------------------------------------

// Mantida em sincronia manual com CACHE_VERSION em sw.js — só pra exibir no menu
// e conferir facilmente se o celular já pegou a última atualização.
const VERSAO_APP = 'v23';

const CHAVE_ESTADO = 'pns2026_estado_v1';

const STATUS_LIST = [
  { chave: 'realizado', label: 'Realizada', cor: '#16a34a' },
  { chave: 'ausente', label: 'Morador ausente', cor: '#d97706' },
  { chave: 'vago_ocasional', label: 'Vago/Ocasional', cor: '#7c3aed' },
  { chave: 'recusa', label: 'Recusa', cor: '#dc2626' },
  { chave: 'outros', label: 'Outros', cor: '#64748b' },
];
const STATUS_POR_CHAVE = Object.fromEntries(STATUS_LIST.map((s) => [s.chave, s]));
const STATUS_PADRAO = null; // sem classificação ainda
const COR_SEM_STATUS = '#94a3b8'; // cinza neutro — domicílio ainda não classificado

// Cor de preenchimento do pino por entrevistador (domicílios atribuídos).
// Entrevistadores cadastrados depois (fora desta lista) usam PALETA_CORES_EXTRA por ordem de cadastro.
const CORES_ENTREVISTADORES = {
  'Maurício': '#38bdf8',      // azul claro
  'Ricardo': '#1e3a8a',       // azul escuro
  'Maria Letícia': '#eab308', // amarelo
  'Lorena': '#dc2626',        // vermelho
};
const PALETA_CORES_EXTRA = ['#16a34a', '#7c3aed', '#ea580c', '#0891b2', '#db2777', '#65a30d'];

const REPASSE_TEMPLATE = (d, usuario, destino) => `🔄 REPASSE DE DOMICÍLIO — PNS 2026
De: ${usuario}  →  Para: ${destino}
Setor: ${d.setor} · Dom. nº ${d.numDomicilio ?? '?'}
${d.logradouro || ''}, ${d.numero || 'S/N'} ${d.complemento || ''} — ${d.bairro || ''}
ID_CNEFE: ${d.id}
➡️ ${destino}: abra o app, filtre pelo setor acima, encontre esse domicílio no mapa e toque em "Atribuir a mim".`;

const CARTA_RECUSA_TEMPLATE = (d, usuario, obs, nomeMorador) => `📋 CARTA DE RECUSA — PNS 2026
Entrevistador: ${usuario}
Data: ${new Date().toLocaleDateString('pt-BR')}
Morador: ${nomeMorador}
Setor: ${d.setor} · Quadra ${d.quadra ?? '?'} Face ${d.face ?? '?'} · Dom. nº ${d.numDomicilio ?? '?'}
${d.logradouro || ''}, ${d.numero || 'S/N'} ${d.complemento || ''} — ${d.bairro || ''}
ID_CNEFE: ${d.id}
${obs ? 'Observação: ' + obs : ''}`;

const COR_SELECAO = '#2563eb';
const RAIO_DECLUTTER_PX = 26; // distância mínima (px) antes de dois pinos serem considerados sobrepostos
const LIMITE_MARCADORES_DECLUTTER = 1500; // acima disso o mapa está zoom-out demais pra valer o custo
const ZOOM_MINIMO_DECLUTTER = 17; // = maxZoom do "ir para o setor", pra já vir separado ao filtrar um setor pra fazer atribuições
const NOME_PADRAO_ETIQUETA = 'Sr(a) Morador(a)';
const LOTE_COLUNAS = 2;
const LOTE_LINHAS = 7; // folha A4, 2×7 = 14 etiquetas por página (igual ao campo.html)

const TILE_URL = (s, z, x, y) => `https://${s}.tile.openstreetmap.org/${z}/${x}/${y}.png`;
const TILE_SUBDOMINIOS = ['a', 'b', 'c'];

// ---------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const agora = () => new Date().toISOString();

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// ---------------------------------------------------------------------
// Estado local (localStorage)
// ---------------------------------------------------------------------

let estado = carregarEstado();

function estadoPadrao() {
  return { usuario: null, domicilios: {}, entrevistadoresExtras: [], tilesBaixados: false };
}

function carregarEstado() {
  try {
    const bruto = localStorage.getItem(CHAVE_ESTADO);
    if (!bruto) return estadoPadrao();
    const obj = JSON.parse(bruto);
    return { ...estadoPadrao(), ...obj };
  } catch (e) {
    console.error('Falha ao carregar estado local, iniciando vazio.', e);
    return estadoPadrao();
  }
}

function salvarEstado() {
  localStorage.setItem(CHAVE_ESTADO, JSON.stringify(estado));
}

function estadoDomicilio(id) {
  if (!estado.domicilios[id]) {
    estado.domicilios[id] = {
      atribuido: false,
      atribuidoPara: null,
      codigo: null,
      status: STATUS_PADRAO,
      statusOutro: null,
      obs: '',
      etiqueta: { nome: NOME_PADRAO_ETIQUETA, logradouro: null, numero: null, complemento: null, bairro: null, cidadeUf: null, codigo: null },
      repassadoPara: null,
      enviadoSupervisorEm: null,
      cartaRecusaSolicitadaEm: null,
      atualizadoEm: agora(),
    };
  }
  return estado.domicilios[id];
}

// Quem o domicílio está atribuído — cai para o usuário atual em registros
// salvos antes do campo atribuidoPara existir (só tinham o booleano atribuido).
function donoDomicilio(est) {
  if (!est.atribuido) return null;
  return est.atribuidoPara || estado.usuario;
}

function entrevistadores() {
  return [...DADOS.entrevistadores, ...estado.entrevistadoresExtras];
}

// ---------------------------------------------------------------------
// Índices de dados estáticos
// ---------------------------------------------------------------------

const domiciliosPorId = Object.fromEntries(DADOS.domicilios.map((d) => [d.id, d]));
const setoresPorControle = Object.fromEntries(DADOS.setores.map((s) => [s.controle, s]));

// Bairro/localidade mais frequente entre os domicílios de cada setor — usado como
// rótulo no mapa quando o setor não tem "nomeZona" preenchido na planilha de origem.
const bairroPorSetor = (() => {
  const contagem = {};
  DADOS.domicilios.forEach((d) => {
    const bairro = (d.bairro || '').trim();
    if (!bairro) return;
    (contagem[d.setor] || (contagem[d.setor] = {}));
    contagem[d.setor][bairro] = (contagem[d.setor][bairro] || 0) + 1;
  });
  const resultado = {};
  Object.keys(contagem).forEach((setor) => {
    const [maisFrequente] = Object.entries(contagem[setor]).sort((a, b) => b[1] - a[1]);
    resultado[setor] = maisFrequente[0];
  });
  return resultado;
})();

function nomeLocalidadeSetor(setor) {
  return paraTituloProprio(setor.nomeZona || bairroPorSetor[setor.controle] || '');
}

// Códigos dos setores que formam a mesma UPA (Unidade Primária de Amostragem) de
// um dado setor — a UPA tem sempre 15 domicílios selecionados, que podem estar
// espalhados entre mais de um setor. Setores sem "upa" mapeada (dados antigos,
// sem a planilha de UPAs) contam como uma UPA só com eles mesmos.
function setoresDaUpaDe(codigoSetor) {
  const s = setoresPorControle[codigoSetor];
  if (!s || !s.upa) return [codigoSetor];
  return DADOS.setores.filter((outro) => outro.upa === s.upa).map((outro) => outro.controle);
}

// ---------------------------------------------------------------------
// Dados pessoais (nome/telefone) — NÃO vêm em dados.js (que pode ser publicado
// publicamente). Ficam num arquivo à parte, importado uma vez por aqui e
// guardado só no localStorage deste aparelho. Ver dados-fonte/dados-pessoais.json.
// ---------------------------------------------------------------------

const CHAVE_DADOS_PESSOAIS = 'pns2026_dados_pessoais';
let dadosPessoais = {};

function carregarDadosPessoais() {
  try {
    const bruto = localStorage.getItem(CHAVE_DADOS_PESSOAIS);
    dadosPessoais = bruto ? JSON.parse(bruto) : {};
  } catch (e) {
    dadosPessoais = {};
  }
}

function moradorDe(id) {
  return (dadosPessoais[id] && dadosPessoais[id].morador) || null;
}

function telefoneDe(id) {
  return (dadosPessoais[id] && dadosPessoais[id].telefone) || null;
}

function atualizarStatusDadosPessoais() {
  const el = $('status-dados-pessoais');
  if (!el) return;
  const n = Object.keys(dadosPessoais).length;
  el.textContent = n > 0 ? `Dados pessoais: ${n} registro(s) importados` : 'Dados pessoais: não importados';
}

function importarDadosPessoais(arquivo) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const obj = JSON.parse(reader.result);
      dadosPessoais = obj;
      localStorage.setItem(CHAVE_DADOS_PESSOAIS, JSON.stringify(obj));
      atualizarStatusDadosPessoais();
      if (mapaLeaflet) aplicarFiltros();
      alert(`Dados pessoais importados: ${Object.keys(obj).length} registro(s).`);
    } catch (e) {
      alert('Arquivo de dados pessoais inválido.');
    }
  };
  reader.readAsText(arquivo);
}

// ---------------------------------------------------------------------
// Navegação entre telas
// ---------------------------------------------------------------------

function mostrar(id) { $(id).classList.remove('oculto'); }
function esconder(id) { $(id).classList.add('oculto'); }

document.addEventListener('click', (ev) => {
  const alvo = ev.target.closest('[data-fechar]');
  if (alvo) esconder(alvo.dataset.fechar);

  // Modais e o menu lateral ocupam a tela toda com um fundo escurecido em volta
  // da caixa — clicar nesse fundo (fora da caixa) fecha, igual clicar no "x".
  if (ev.target.classList.contains('tela-modal') || ev.target.classList.contains('tela-menu')) {
    esconder(ev.target.id);
  }
});

// ---------------------------------------------------------------------
// Inicialização
// ---------------------------------------------------------------------

function iniciar() {
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().catch(() => {});
  }
  registrarServiceWorker();
  carregarDadosPessoais();
  renderListaEntrevistadores();
  popularFiltroSetores();
  popularFiltroDistribuir();
  popularSelectStatus();
  popularLegenda();
  atualizarStatusDadosPessoais();
  $('status-versao-app').textContent = `Versão do app: ${VERSAO_APP}`;
  wireEventosGlobais();

  if (estado.usuario) {
    entrarNoMapa();
  } else {
    mostrar('tela-identificacao');
  }
}

function renderListaEntrevistadores() {
  const cont = $('lista-entrevistadores');
  cont.innerHTML = '';
  entrevistadores().forEach((e) => {
    const btn = document.createElement('button');
    btn.className = 'botao-grande';
    btn.textContent = e.nome;
    btn.addEventListener('click', () => {
      estado.usuario = e.nome;
      salvarEstado();
      entrarNoMapa();
    });
    cont.appendChild(btn);
  });
}

async function entrarNoMapa() {
  esconder('tela-identificacao');
  mostrar('tela-mapa');
  $('menu-usuario-atual').textContent = estado.usuario;
  if (!mapaLeaflet) await initMapa();
  atualizarContador();
  aplicarFiltros();
  posicionarBotaoSoMeus();
}

function posicionarBotaoSoMeus() {
  const filtros = $('barra-filtros');
  const tela = $('tela-mapa');
  const btn = $('btn-so-meus');
  const offset = filtros.getBoundingClientRect().bottom - tela.getBoundingClientRect().top;
  btn.style.top = `${offset + 10}px`;
}

window.addEventListener('resize', () => { if (mapaLeaflet) posicionarBotaoSoMeus(); });

// ---------------------------------------------------------------------
// Mapa
// ---------------------------------------------------------------------

let mapaLeaflet = null;
let camadaMarcadores = null;
let camadaSetores = null;
let camadaDeclutter = null;
let marcadoresPorId = {};
let modoSelecao = false;
let filtroSoMeusAtivo = false;
const filtroSetoresSelecionados = new Set(); // vazio = todos os setores
let marcadorLocalizacao = null;
let circuloPrecisaoLocalizacao = null;
const domiciliosSelecionados = new Set();

async function initMapa() {
  const lats = DADOS.domicilios.map((d) => d.lat).filter((v) => v != null);
  const lngs = DADOS.domicilios.map((d) => d.lng).filter((v) => v != null);
  const bounds = [
    [Math.min(...lats), Math.min(...lngs)],
    [Math.max(...lats), Math.max(...lngs)],
  ];

  mapaLeaflet = L.map('mapa', { zoomControl: true });
  mapaLeaflet.fitBounds(bounds, { padding: [20, 20] });

  await criarCamadaMapaOffline(mapaLeaflet);
  atualizarStatusMapaOffline();

  camadaSetores = L.layerGroup().addTo(mapaLeaflet);
  DADOS.setores.forEach((setor) => {
    if (!setor.geojson || !setor.geojson.coordinates || !setor.geojson.coordinates.length) return;
    const camadaPoligono = L.geoJSON(setor.geojson, {
      style: {
        color: '#334155',
        weight: 1.5,
        fillOpacity: 0.04,
        dashArray: setor.aproximado ? '6,4' : null,
      },
    }).addTo(camadaSetores);

    const nomeLocalidade = nomeLocalidadeSetor(setor);
    if (nomeLocalidade) {
      camadaPoligono.bindTooltip(nomeLocalidade, {
        permanent: true,
        direction: 'center',
        className: 'rotulo-bairro',
      });
    }

    const centro = camadaPoligono.getBounds().getCenter();
    L.marker(centro, {
      icon: L.divIcon({
        className: '',
        html: '<div class="botao-enviar-setor">📤</div>',
        iconSize: [28, 28],
        iconAnchor: [14, -8],
      }),
      interactive: true,
      keyboard: false,
      zIndexOffset: -200,
    }).addTo(camadaSetores)
      .bindTooltip('Enviar associações deste setor/UPA', { direction: 'top' })
      .on('click', () => abrirDistribuirSetorParaSetor(setor.controle));
  });

  camadaDeclutter = L.layerGroup().addTo(mapaLeaflet);
  camadaMarcadores = L.layerGroup().addTo(mapaLeaflet);

  mapaLeaflet.on('zoomend', declutterMarcadores);
  mapaLeaflet.on('locationerror', () => alert('Não foi possível obter sua localização.'));
  mapaLeaflet.on('locationfound', (e) => {
    if (marcadorLocalizacao) {
      marcadorLocalizacao.setLatLng(e.latlng);
    } else {
      marcadorLocalizacao = L.marker(e.latlng, {
        icon: L.divIcon({
          className: '',
          html: '<div class="pino-minha-localizacao"></div>',
          iconSize: [16, 16],
          iconAnchor: [8, 8],
        }),
        zIndexOffset: 1000,
        interactive: false,
      }).addTo(mapaLeaflet);
    }
    if (circuloPrecisaoLocalizacao) {
      circuloPrecisaoLocalizacao.setLatLng(e.latlng).setRadius(e.accuracy);
    } else {
      circuloPrecisaoLocalizacao = L.circle(e.latlng, {
        radius: e.accuracy,
        color: '#2563eb',
        weight: 1,
        fillColor: '#2563eb',
        fillOpacity: 0.08,
        interactive: false,
      }).addTo(mapaLeaflet);
    }
  });
}

function corDoStatus(chave) {
  return (STATUS_POR_CHAVE[chave] || {}).cor || COR_SEM_STATUS;
}

function corDoEntrevistador(nome) {
  if (CORES_ENTREVISTADORES[nome]) return CORES_ENTREVISTADORES[nome];
  const idx = entrevistadores().findIndex((e) => e.nome === nome);
  return PALETA_CORES_EXTRA[idx % PALETA_CORES_EXTRA.length] || COR_SEM_STATUS;
}

function corDoPino(domicilio, est) {
  return est.atribuido ? corDoEntrevistador(donoDomicilio(est)) : corDoStatus(est.status);
}

// Domicílio atribuído e repassado ao mesmo tempo (repasse ainda não assumido pelo
// destino) — pino meio a meio com a cor de quem tem hoje e de pra quem foi repassado.
function fundoPino(domicilio, est) {
  if (est.atribuido && est.repassadoPara) {
    const corOrigem = corDoEntrevistador(donoDomicilio(est));
    const corDestino = corDoEntrevistador(est.repassadoPara);
    return `linear-gradient(90deg, ${corOrigem} 50%, ${corDestino} 50%)`;
  }
  return corDoPino(domicilio, est);
}

function iconePino(domicilio, est) {
  const fundo = fundoPino(domicilio, est);
  const tamanho = 32;
  const fonte = 11;
  const estiloBorda = est.repassadoPara ? 'dashed' : 'solid';
  const corBorda = est.status === 'realizado' ? '#15803d' : '#fff';
  const opacidade = est.atribuido ? 1 : 0.6;
  const numero = domicilio.numDomicilio ?? '';
  const check = est.status === 'realizado' ? '<div class="pino-check">✓</div>' : '';
  const carta = est.cartaRecusaSolicitadaEm ? '<div class="pino-carta" title="Carta de recusa solicitada">✉</div>' : '';
  const anelSelecao = domiciliosSelecionados.has(domicilio.id) ? `box-shadow:0 0 0 4px ${COR_SELECAO};` : '';
  const marcaSelecao = domiciliosSelecionados.has(domicilio.id) ? '<div class="pino-selecionado">✓</div>' : '';
  return L.divIcon({
    className: '',
    html: `<div class="pino-domicilio" style="width:${tamanho}px;height:${tamanho}px;background:${fundo};` +
      `border:3px ${estiloBorda} ${corBorda};font-size:${fonte}px;opacity:${opacidade};${anelSelecao}">${numero}${check}${carta}${marcaSelecao}</div>`,
    iconSize: [tamanho, tamanho],
    iconAnchor: [tamanho / 2, tamanho / 2],
    popupAnchor: [0, -tamanho / 2],
  });
}

function renderMarcadores() {
  camadaMarcadores.clearLayers();
  marcadoresPorId = {};

  const filtroStatus = $('filtro-status').value;

  DADOS.domicilios.forEach((d) => {
    const est = estadoDomicilio(d.id);
    if (filtroSetoresSelecionados.size && !filtroSetoresSelecionados.has(d.setor)) return;
    if (filtroStatus && est.status !== filtroStatus) return;
    if (filtroSoMeusAtivo && donoDomicilio(est) !== estado.usuario) return;
    if (d.lat == null || d.lng == null) return;

    const marcador = L.marker([d.lat, d.lng], { icon: iconePino(d, est) });
    marcador.on('click', () => {
      if (modoSelecao) {
        alternarSelecaoDomicilio(d.id);
      } else {
        L.popup({ maxWidth: 280, autoPanPadding: [20, 80] })
          .setLatLng(marcador.getLatLng())
          .setContent(popupDomicilio(d))
          .openOn(mapaLeaflet);
      }
    });
    marcador.addTo(camadaMarcadores);
    marcadoresPorId[d.id] = marcador;
  });

  declutterMarcadores();
}

// Quando dois ou mais domicílios caem no mesmo pixel (ex.: apartamentos do mesmo prédio),
// cravamos um pontinho fixo no local real e afastamos só os rótulos (os pinos numerados)
// ao redor dele, ligados por uma linha fina — como o Google Earth faz. d.lat/d.lng nunca mudam.
// Recalculado a cada zoom, já que a distância em pixels entre dois pontos muda com o zoom.
function declutterMarcadores() {
  camadaDeclutter.clearLayers();
  const ids = Object.keys(marcadoresPorId);
  if (!mapaLeaflet || ids.length === 0) return;

  if (mapaLeaflet.getZoom() < ZOOM_MINIMO_DECLUTTER || ids.length > LIMITE_MARCADORES_DECLUTTER) {
    ids.forEach((id) => {
      const d = domiciliosPorId[id];
      marcadoresPorId[id].setLatLng([d.lat, d.lng]);
    });
    return;
  }

  const pontos = ids.map((id) => {
    const d = domiciliosPorId[id];
    return { id, real: L.latLng(d.lat, d.lng), ponto: mapaLeaflet.latLngToContainerPoint([d.lat, d.lng]) };
  });

  const grade = new Map();
  const chave = (x, y) => `${Math.round(x / RAIO_DECLUTTER_PX)}:${Math.round(y / RAIO_DECLUTTER_PX)}`;
  pontos.forEach((p) => {
    const k = chave(p.ponto.x, p.ponto.y);
    if (!grade.has(k)) grade.set(k, []);
    grade.get(k).push(p);
  });

  const visitados = new Set();
  pontos.forEach((p) => {
    if (visitados.has(p.id)) return;
    const [gx, gy] = chave(p.ponto.x, p.ponto.y).split(':').map(Number);
    const grupo = [];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const vizinhos = grade.get(`${gx + dx}:${gy + dy}`) || [];
        vizinhos.forEach((v) => {
          if (visitados.has(v.id)) return;
          const dist = Math.hypot(p.ponto.x - v.ponto.x, p.ponto.y - v.ponto.y);
          if (dist <= RAIO_DECLUTTER_PX) grupo.push(v);
        });
      }
    }
    grupo.forEach((v) => visitados.add(v.id));

    if (grupo.length === 1) {
      marcadoresPorId[grupo[0].id].setLatLng(grupo[0].real);
      return;
    }

    const cx = grupo.reduce((s, v) => s + v.ponto.x, 0) / grupo.length;
    const cy = grupo.reduce((s, v) => s + v.ponto.y, 0) / grupo.length;
    const ancoraPonto = L.point(cx, cy);
    const ancoraLatLng = mapaLeaflet.containerPointToLatLng(ancoraPonto);

    L.circleMarker(ancoraLatLng, {
      radius: 4,
      color: '#fff',
      weight: 1.5,
      fillColor: '#334155',
      fillOpacity: 1,
      interactive: false,
    }).addTo(camadaDeclutter);

    const raio = 26 + grupo.length * 4;
    grupo.forEach((v, i) => {
      const angulo = (2 * Math.PI * i) / grupo.length - Math.PI / 2;
      const destino = L.point(cx + raio * Math.cos(angulo), cy + raio * Math.sin(angulo));
      const destinoLatLng = mapaLeaflet.containerPointToLatLng(destino);
      L.polyline([ancoraLatLng, destinoLatLng], {
        color: '#334155',
        weight: 1.5,
        opacity: 0.8,
        interactive: false,
      }).addTo(camadaDeclutter);
      marcadoresPorId[v.id].setLatLng(destinoLatLng);
    });
  });
}

function popupDomicilio(d) {
  const est = estadoDomicilio(d.id);
  const roteiro = DADOS.roteiro[d.setor] || [];
  const idx = roteiro.findIndex((it) => it.id === d.id);
  const trecho = idx === -1 ? [] : roteiro.slice(Math.max(0, idx - 3), Math.min(roteiro.length, idx + 4));

  const linhasRoteiro = trecho.map((it) => {
    const classe = it.id === d.id ? 'popup-roteiro-item eh-este-domicilio' : 'popup-roteiro-item';
    const moradorIt = moradorDe(it.id);
    return `<div class="${classe}">Q${it.quadra ?? '?'} F${it.face ?? '?'} — ${it.logradouro || ''}, ${it.numero || 'S/N'}` +
      `${moradorIt ? `<small>${moradorIt}</small>` : ''}</div>`;
  }).join('');

  const contato = [];
  const moradorD = moradorDe(d.id);
  const telefoneD = telefoneDe(d.id);
  if (moradorD) contato.push(`Morador: ${moradorD}`);
  if (telefoneD) contato.push(`Tel.: ${telefoneD}`);

  const statusLabel = est.status
    ? (STATUS_POR_CHAVE[est.status] || {}).label + (est.status === 'outros' && est.statusOutro ? `: ${est.statusOutro}` : '')
    : 'Sem classificação';

  const dono = donoDomicilio(est);
  const textoBotaoAtribuir = !est.atribuido
    ? '☑️ Atribuir a mim'
    : dono === estado.usuario
      ? '✕ Remover minha atribuição'
      : `✕ Remover atribuição de ${dono}`;

  return `<div class="popup-pino">
    ${est.codigo ? `<b>${est.codigo}</b>` : ''}
    <b>${d.logradouro || ''}, ${d.numero || 'S/N'}</b>${d.complemento ? ' — ' + d.complemento : ''}<br>
    ${d.bairro || ''}
    ${contato.length ? `<div class="popup-contato">${contato.join(' · ')}</div>` : ''}
    <div class="popup-contato">Status: ${statusLabel}</div>
    ${est.atribuido && est.repassadoPara ? `<div class="popup-contato popup-alerta-carta">🔄 Repassado de ${dono} para ${est.repassadoPara} (ainda não assumido)</div>` : ''}
    ${est.cartaRecusaSolicitadaEm ? `<div class="popup-contato popup-alerta-carta">✉️ Carta de recusa solicitada em ${new Date(est.cartaRecusaSolicitadaEm).toLocaleDateString('pt-BR')}</div>` : ''}
    <div class="popup-mini-roteiro">${linhasRoteiro}</div>
    <div class="popup-botoes">
      <button class="botao-primario" onclick="atribuirOuRemoverDoMapa('${d.id}')">${textoBotaoAtribuir}</button>
      <button class="botao-secundario" onclick="abrirEscolhaAtribuirOutroMapa('${d.id}')">👥 Atribuir a outro</button>
      <button class="botao-secundario" onclick="mapaLeaflet.closePopup(); abrirFicha('${d.id}')">📋 Roteiro completo</button>
      <button class="botao-secundario" onclick="solicitarCartaDoMapa('${d.id}')">✉️ Carta de recusa</button>
      ${est.cartaRecusaSolicitadaEm ? `<button class="botao-secundario" onclick="excluirSolicitacaoCarta('${d.id}')">🗑️ Excluir solicitação de carta</button>` : ''}
      <button class="botao-secundario" onclick="mapaLeaflet.closePopup(); abrirModalStatus('${d.id}')">✅ Classificar status</button>
    </div>
  </div>`;
}

function solicitarCartaDoMapa(id) {
  const est = estadoDomicilio(id);
  est.status = 'recusa';
  est.atualizadoEm = agora();
  salvarEstado();
  aplicarFiltros();
  mapaLeaflet.closePopup();
  abrirModalCartaRecusa(id);
}

function aplicarFiltros() {
  renderMarcadores();
  atualizarContador();
  atualizarBotaoFiltroSetor();
  $('btn-lista-setor').classList.toggle('oculto', filtroSetoresSelecionados.size !== 1);
}

function atualizarBotaoFiltroSetor() {
  const n = filtroSetoresSelecionados.size;
  let texto = 'Todos os setores';
  if (n === 1) {
    const s = setoresPorControle[[...filtroSetoresSelecionados][0]];
    const nome = s && nomeLocalidadeSetor(s);
    texto = `Setor ${[...filtroSetoresSelecionados][0]}${nome ? ' — ' + nome : ''}`;
  } else if (n > 1) {
    texto = `${n} setores selecionados`;
  }
  $('btn-abrir-filtro-setor').textContent = texto;
  $('btn-limpar-filtro-setor-rapido').classList.toggle('oculto', n === 0);
}

function limparFiltroSetor() {
  filtroSetoresSelecionados.clear();
  renderListaFiltroSetor($('busca-filtro-setor').value);
  aplicarFiltros();
  if (mapaLeaflet) centralizarNoFiltroSetor();
}

function centralizarNoFiltroSetor() {
  if (filtroSetoresSelecionados.size) {
    const grupo = L.featureGroup();
    filtroSetoresSelecionados.forEach((codigo) => {
      const s = setoresPorControle[codigo];
      const temPoligono = s && s.geojson && s.geojson.coordinates && s.geojson.coordinates.length;
      if (temPoligono) {
        L.geoJSON(s.geojson).addTo(grupo);
      } else {
        domiciliosDoSetor(codigo).forEach((d) => {
          if (d.lat != null && d.lng != null) L.marker([d.lat, d.lng]).addTo(grupo);
        });
      }
    });
    if (grupo.getLayers().length) {
      mapaLeaflet.fitBounds(grupo.getBounds(), { padding: [30, 30], maxZoom: 17 });
    }
  } else {
    const lats = DADOS.domicilios.map((d) => d.lat).filter((v) => v != null);
    const lngs = DADOS.domicilios.map((d) => d.lng).filter((v) => v != null);
    mapaLeaflet.fitBounds(
      [[Math.min(...lats), Math.min(...lngs)], [Math.max(...lats), Math.max(...lngs)]],
      { padding: [20, 20] }
    );
  }
}

function alternarSetorFiltro(codigo, marcado) {
  if (marcado) {
    filtroSetoresSelecionados.add(codigo);
    const irmaos = setoresDaUpaDe(codigo).filter((c) => c !== codigo && !filtroSetoresSelecionados.has(c));
    if (irmaos.length) {
      irmaos.forEach((c) => filtroSetoresSelecionados.add(c));
      renderListaFiltroSetor($('busca-filtro-setor').value);
      alert(`O setor ${codigo} faz parte da mesma UPA (Unidade Primária de Amostragem) que ${irmaos.join(', ')} — os 15 domicílios da UPA ficam espalhados entre eles, então foram selecionados juntos.`);
    }
  } else {
    filtroSetoresSelecionados.delete(codigo);
  }
  aplicarFiltros();
}

function setoresFiltradosPorBusca(textoBusca) {
  const busca = (textoBusca || '').trim().toLowerCase();
  const setoresOrdenados = [...DADOS.setores].sort((a, b) => a.controle.localeCompare(b.controle));
  if (!busca) return setoresOrdenados;
  return setoresOrdenados.filter((s) => (
    s.controle.includes(busca) || nomeLocalidadeSetor(s).toLowerCase().includes(busca)
  ));
}

function renderListaFiltroSetor(textoBusca) {
  const visiveis = setoresFiltradosPorBusca(textoBusca);
  const cont = $('lista-filtro-setor');
  cont.innerHTML = visiveis.map((s) => {
    const nome = nomeLocalidadeSetor(s);
    const marcado = filtroSetoresSelecionados.has(s.controle) ? 'checked' : '';
    return `<label class="item-checklist-setor">
      <input type="checkbox" data-setor="${s.controle}" ${marcado}>
      <span>
        <span class="item-checklist-setor-codigo">${s.controle}</span>
        ${nome ? `<span class="item-checklist-setor-bairro"> — ${nome}</span>` : ''}
      </span>
    </label>`;
  }).join('') || '<p class="vazio">Nenhum setor encontrado.</p>';

  cont.querySelectorAll('input[type="checkbox"]').forEach((chk) => {
    chk.addEventListener('change', () => alternarSetorFiltro(chk.dataset.setor, chk.checked));
  });
}

function domiciliosDoSetor(setor) {
  return DADOS.domicilios
    .filter((d) => d.setor === setor)
    .sort((a, b) => (a.quadra || 0) - (b.quadra || 0) || (a.face || 0) - (b.face || 0) || (a.numDomicilio || 0) - (b.numDomicilio || 0));
}

function abrirListaSetor() {
  const [setor] = filtroSetoresSelecionados;
  if (filtroSetoresSelecionados.size !== 1 || !setor) return;
  const lista = domiciliosDoSetor(setor);
  $('lista-setor-titulo').textContent = `Domicílios do setor ${setor}`;
  const cont = $('lista-setor-conteudo');
  if (!lista.length) {
    cont.innerHTML = '<p class="vazio">Nenhum domicílio selecionado neste setor.</p>';
  } else {
    cont.innerHTML = `<p class="texto-ajuda">${lista.length} domicílio(s)</p>` + lista.map((d) => {
      const est = estadoDomicilio(d.id);
      const contato = [];
      const moradorD = moradorDe(d.id);
      if (moradorD) contato.push(`Morador: ${moradorD}`);
      contato.push(`Tel.: ${telefoneDe(d.id) || 'não informado'}`);
      return `<div class="item-lista-setor" onclick="mapaLeaflet.closePopup(); esconder('tela-lista-setor'); abrirFicha('${d.id}')">
        <div class="item-lista-setor-cabec">
          <span class="item-lista-setor-endereco">${d.logradouro || ''}, ${d.numero || 'S/N'}${d.complemento ? ' — ' + d.complemento : ''}</span>
          ${est.codigo ? `<span class="item-lista-setor-codigo">${est.codigo}</span>` : ''}
        </div>
        <div class="texto-ajuda">Q${d.quadra ?? '?'} F${d.face ?? '?'} · Dom. nº ${d.numDomicilio ?? '?'} · ${d.bairro || ''}</div>
        <div class="item-lista-setor-contato">${contato.join(' · ')}</div>
      </div>`;
    }).join('');
  }
  mostrar('tela-lista-setor');
}

function atualizarContador() {
  const meus = DADOS.domicilios.filter((d) => donoDomicilio(estadoDomicilio(d.id)) === estado.usuario);
  const realizados = meus.filter((d) => estadoDomicilio(d.id).status === 'realizado');
  $('contador-realizados').textContent = `${realizados.length} de ${meus.length} realizados`;
}

// ---------------------------------------------------------------------
// Seleção de domicílios no mapa (para atribuir vários de uma vez)
// ---------------------------------------------------------------------

function alternarModoSelecao() {
  modoSelecao = !modoSelecao;
  domiciliosSelecionados.clear();
  $('btn-modo-selecao').classList.toggle('oculto', modoSelecao);
  $('barra-selecao').classList.toggle('oculto', !modoSelecao);
  atualizarContagemSelecao();
  renderMarcadores();
}

function alternarSelecaoDomicilio(id) {
  if (domiciliosSelecionados.has(id)) domiciliosSelecionados.delete(id);
  else domiciliosSelecionados.add(id);
  const marcador = marcadoresPorId[id];
  if (marcador) marcador.setIcon(iconePino(domiciliosPorId[id], estadoDomicilio(id)));
  atualizarContagemSelecao();
}

function atualizarContagemSelecao() {
  const n = domiciliosSelecionados.size;
  $('contagem-selecao').textContent = `${n} selecionado(s)`;
  $('btn-atribuir-selecao').disabled = n === 0;
  $('btn-desassociar-selecao').disabled = n === 0;
}

function cancelarSelecao() {
  domiciliosSelecionados.clear();
  modoSelecao = false;
  $('btn-modo-selecao').classList.remove('oculto');
  $('barra-selecao').classList.add('oculto');
  renderMarcadores();
}

// Atribui (ou remove) um domicílio — usado tanto pra "atribuir a mim" quanto
// pra atribuir a qualquer outro entrevistador do grupo (ex.: distribuir os
// domicílios de um setor entre os 4 entrevistadores depois de combinarem
// quem fica com o quê).
function atribuirA(id, nome) {
  const d = domiciliosPorId[id];
  const est = estadoDomicilio(id);
  const entrevistador = entrevistadores().find((e) => e.nome === nome);
  if (!entrevistador) return;
  est.atribuido = true;
  est.atribuidoPara = nome;
  est.status = STATUS_PADRAO;
  est.repassadoPara = null;
  est.enviadoSupervisorEm = null;
  est.cartaRecusaSolicitadaEm = null;
  est.codigo = gerarCodigo(entrevistador.letra, d.setor, d.numDomicilio);
  est.atualizadoEm = agora();
}

function removerAtribuicao(id) {
  const est = estadoDomicilio(id);
  est.atribuido = false;
  est.atribuidoPara = null;
  est.codigo = null;
  est.atualizadoEm = agora();
}

function alternarAtribuicao(id) {
  if (estadoDomicilio(id).atribuido) removerAtribuicao(id);
  else atribuirA(id, estado.usuario);
}

function abrirEscolherEntrevistador(titulo, { incluirEuMesmo = true } = {}, callback) {
  $('titulo-escolher-entrevistador').textContent = titulo;
  const cont = $('lista-escolher-entrevistador');
  cont.innerHTML = '';
  const lista = incluirEuMesmo ? entrevistadores() : entrevistadores().filter((e) => e.nome !== estado.usuario);
  lista.forEach((e) => {
    const btn = document.createElement('button');
    btn.className = 'botao-grande';
    btn.textContent = e.nome === estado.usuario ? `${e.nome} (eu)` : e.nome;
    btn.addEventListener('click', () => {
      esconder('modal-escolher-entrevistador');
      callback(e.nome);
    });
    cont.appendChild(btn);
  });
  mostrar('modal-escolher-entrevistador');
}

function abrirEscolhaAtribuirSelecionados() {
  if (!domiciliosSelecionados.size) return;
  abrirEscolherEntrevistador('Atribuir selecionados a quem?', { incluirEuMesmo: true }, (nome) => {
    const n = domiciliosSelecionados.size;
    domiciliosSelecionados.forEach((id) => atribuirA(id, nome));
    salvarEstado();
    cancelarSelecao();
    aplicarFiltros();
    alert(`${n} domicílio(s) atribuído(s) a ${nome}.`);
  });
}

function desassociarSelecionados() {
  if (!domiciliosSelecionados.size) return;
  const n = domiciliosSelecionados.size;
  if (!confirm(`Desassociar ${n} domicílio(s) selecionado(s)?`)) return;
  domiciliosSelecionados.forEach((id) => removerAtribuicao(id));
  salvarEstado();
  cancelarSelecao();
  aplicarFiltros();
  alert(`${n} domicílio(s) desassociado(s).`);
}

// ---------------------------------------------------------------------
// Meus domicílios associados (ver todos + desassociar individualmente)
// ---------------------------------------------------------------------

function abrirMeusAssociados() {
  renderMeusAssociados();
  mostrar('tela-meus-associados');
}

function renderMeusAssociados() {
  const lista = DADOS.domicilios
    .filter((d) => donoDomicilio(estadoDomicilio(d.id)) === estado.usuario)
    .sort((a, b) => a.setor.localeCompare(b.setor) || (a.numDomicilio || 0) - (b.numDomicilio || 0));

  $('meus-associados-contagem').textContent = lista.length
    ? `${lista.length} domicílio(s) associado(s) a você`
    : '';

  const cont = $('meus-associados-lista');
  if (!lista.length) {
    cont.innerHTML = '<p class="vazio">Nenhum domicílio associado no momento.</p>';
    return;
  }

  cont.innerHTML = lista.map((d) => {
    const est = estadoDomicilio(d.id);
    const statusLabel = (STATUS_POR_CHAVE[est.status] || {}).label || 'Sem classificação';
    return `<div class="item-lista-setor" data-id="${d.id}">
      <div class="item-lista-setor-cabec">
        <span class="item-lista-setor-endereco">${d.logradouro || ''}, ${d.numero || 'S/N'}${d.complemento ? ' — ' + d.complemento : ''}</span>
        ${est.codigo ? `<span class="item-lista-setor-codigo">${est.codigo}</span>` : ''}
      </div>
      <div class="texto-ajuda">Setor ${d.setor} · ${statusLabel}</div>
      <div class="linha-controles" style="margin:8px 0 0">
        <button class="botao-secundario btn-desassociar-item" data-id="${d.id}">Desassociar</button>
      </div>
    </div>`;
  }).join('');

  cont.querySelectorAll('.item-lista-setor').forEach((el) => {
    el.addEventListener('click', (ev) => {
      if (ev.target.closest('.btn-desassociar-item')) return;
      esconder('tela-meus-associados');
      abrirFicha(el.dataset.id);
    });
  });
  cont.querySelectorAll('.btn-desassociar-item').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      desassociarUm(btn.dataset.id);
    });
  });
}

function desassociarUm(id) {
  removerAtribuicao(id);
  salvarEstado();
  renderMeusAssociados();
  aplicarFiltros();
}

function popularFiltroSetores() {
  const setoresOrdenados = [...DADOS.setores].sort((a, b) => a.controle.localeCompare(b.controle));
  setoresOrdenados.forEach((s) => {
    const opt = document.createElement('option');
    opt.value = s.controle;
    const nome = nomeLocalidadeSetor(s);
    const irmaos = setoresDaUpaDe(s.controle).length - 1;
    const sufixoUpa = irmaos > 0 ? ` (UPA com +${irmaos} setor${irmaos > 1 ? 'es' : ''})` : '';
    opt.textContent = `Setor ${s.controle}${nome ? ' — ' + nome : ''}${sufixoUpa}`;
    $('lote-filtro-setor').appendChild(opt);
  });
  renderListaFiltroSetor();
  atualizarBotaoFiltroSetor();
}

function popularSelectStatus() {
  const selects = [$('filtro-status'), $('select-status')];
  selects.forEach((sel) => {
    STATUS_LIST.forEach((s) => {
      const opt = document.createElement('option');
      opt.value = s.chave;
      opt.textContent = s.label;
      sel.appendChild(opt);
    });
  });
  $('select-status').insertBefore(new Option('Selecione o status', ''), $('select-status').firstChild);
}

function popularLegenda() {
  const ul = $('lista-legenda');
  ul.innerHTML = '';
  const legendaExtra = [
    { label: 'Sem classificação', cor: COR_SEM_STATUS },
  ];
  [...STATUS_LIST, ...legendaExtra].forEach((s) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="ponto-legenda" style="background:${s.cor};${s.tracejado ? 'border:2px dashed #334155;' : ''}"></span> ${s.label}`;
    ul.appendChild(li);
  });
  const liRepasse = document.createElement('li');
  liRepasse.innerHTML = `<span class="ponto-legenda" style="background:linear-gradient(90deg, ${COR_SEM_STATUS} 50%, #475569 50%);border:2px dashed #334155;"></span> Repassado (metade da cor de quem tem hoje, metade de pra quem foi)`;
  ul.appendChild(liRepasse);

  const ulEntr = $('lista-legenda-entrevistadores');
  ulEntr.innerHTML = '';
  entrevistadores().forEach((e) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="ponto-legenda" style="background:${corDoEntrevistador(e.nome)}"></span> ${e.nome}`;
    ulEntr.appendChild(li);
  });
}

// ---------------------------------------------------------------------
// Ficha do domicílio
// ---------------------------------------------------------------------

let fichaAtualId = null;

function abrirFicha(id) {
  const d = domiciliosPorId[id];
  if (!d) return;
  fichaAtualId = id;
  const est = estadoDomicilio(id);

  $('ficha-codigo').textContent = est.codigo || '';
  $('ficha-endereco').textContent = `${d.logradouro || ''}, ${d.numero || 'S/N'}${d.complemento ? ' — ' + d.complemento : ''}`;
  $('ficha-meta').textContent = `Setor ${d.setor} · Quadra ${d.quadra ?? '?'} Face ${d.face ?? '?'} · ` +
    `Dom. nº ${d.numDomicilio ?? '?'} · ID_CNEFE ${d.id}`;

  const badges = [];
  if (d.antropometria) badges.push('Antropometria');
  if (d.biomarcador) badges.push('Biomarcador');
  if (est.atribuido && est.repassadoPara) badges.push(`🔄 Repassado para ${est.repassadoPara}`);
  if (est.cartaRecusaSolicitadaEm) badges.push('✉️ Carta de recusa solicitada');
  $('ficha-badges').innerHTML = badges.map((b) => `<span class="badge">${b}</span>`).join('');

  const contato = [];
  const moradorFicha = moradorDe(d.id);
  const telefoneFicha = telefoneDe(d.id);
  if (moradorFicha) contato.push(`Morador: ${moradorFicha}`);
  if (telefoneFicha) contato.push(`Tel.: ${telefoneFicha}`);
  $('ficha-contato').textContent = contato.join(' · ');

  const donoFicha = donoDomicilio(est);
  $('btn-atribuir').textContent = !est.atribuido
    ? 'Atribuir a mim'
    : donoFicha === estado.usuario
      ? 'Remover minha atribuição'
      : `Remover atribuição de ${donoFicha}`;
  $('select-status').value = est.status || '';
  $('campo-status-outro').classList.toggle('oculto', est.status !== 'outros');
  $('campo-status-outro').value = est.statusOutro || '';
  $('campo-obs').value = est.obs || '';

  $('btn-carta-recusa').classList.toggle('oculto', est.status !== 'recusa');
  $('btn-excluir-carta-recusa').classList.toggle('oculto', !est.cartaRecusaSolicitadaEm);
  $('btn-etiqueta').disabled = donoFicha !== estado.usuario;
  $('btn-etiqueta').title = donoFicha === estado.usuario ? '' : 'Atribua o domicílio a você para gerar a etiqueta';

  renderRoteiro(d);
  mostrar('ficha-domicilio');
}

function renderRoteiro(d) {
  $('roteiro-setor-num').textContent = d.setor.slice(-4);
  const itens = DADOS.roteiro[d.setor] || [];
  const cont = $('lista-roteiro');
  cont.innerHTML = '';
  let elementoAlvo = null;
  itens.forEach((it) => {
    const div = document.createElement('div');
    div.className = 'item-roteiro';
    if (it.alvo) div.classList.add('eh-alvo-selecionado');
    if (it.id === d.id) {
      div.classList.add('eh-este-domicilio');
      elementoAlvo = div;
    }
    const domNumero = it.numDomicilio != null ? `<span class="dom-numero">Dom. nº ${it.numDomicilio}</span> ` : '';
    const moradorIt = moradorDe(it.id);
    div.innerHTML = `${domNumero}Q${it.quadra ?? '?'} F${it.face ?? '?'} — ${it.logradouro || ''}, ${it.numero || 'S/N'}` +
      `${it.complemento ? `<small>${it.complemento}</small>` : ''}` +
      `${moradorIt ? `<small>Morador: ${moradorIt}</small>` : ''}`;
    cont.appendChild(div);
  });
  if (elementoAlvo) {
    requestAnimationFrame(() => elementoAlvo.scrollIntoView({ block: 'center' }));
  }
}

function gerarCodigo(letra, setor, numDomicilio) {
  return `${letra}${setor.slice(-4)}/${numDomicilio ?? '?'}`;
}

function atribuirOuRemover() {
  alternarAtribuicao(fichaAtualId);
  abrirFicha(fichaAtualId);
  aplicarFiltros();
}

function atribuirOuRemoverDoMapa(id) {
  alternarAtribuicao(id);
  aplicarFiltros();
  reabrirPopupDomicilio(id);
}

function reabrirPopupDomicilio(id) {
  const d = domiciliosPorId[id];
  const marcador = marcadoresPorId[id];
  L.popup({ maxWidth: 280, autoPanPadding: [20, 80] })
    .setLatLng(marcador ? marcador.getLatLng() : [d.lat, d.lng])
    .setContent(popupDomicilio(d))
    .openOn(mapaLeaflet);
}

function abrirEscolhaAtribuirOutroFicha() {
  abrirEscolherEntrevistador('Atribuir a quem?', { incluirEuMesmo: false }, (nome) => {
    atribuirA(fichaAtualId, nome);
    salvarEstado();
    abrirFicha(fichaAtualId);
    aplicarFiltros();
  });
}

function abrirEscolhaAtribuirOutroMapa(id) {
  mapaLeaflet.closePopup();
  abrirEscolherEntrevistador('Atribuir a quem?', { incluirEuMesmo: false }, (nome) => {
    atribuirA(id, nome);
    salvarEstado();
    aplicarFiltros();
    reabrirPopupDomicilio(id);
  });
}

function onMudarStatus() {
  const est = estadoDomicilio(fichaAtualId);
  est.status = $('select-status').value || null;
  if (est.status !== 'outros') est.statusOutro = null;
  est.atualizadoEm = agora();
  salvarEstado();
  $('btn-carta-recusa').classList.toggle('oculto', est.status !== 'recusa');
  $('campo-status-outro').classList.toggle('oculto', est.status !== 'outros');
  $('campo-status-outro').value = est.statusOutro || '';
  aplicarFiltros();
}

const salvarObsDebounced = debounce((id, texto) => {
  const est = estadoDomicilio(id);
  est.obs = texto;
  est.atualizadoEm = agora();
  salvarEstado();
}, 400);

const salvarStatusOutroDebounced = debounce((id, texto) => {
  const est = estadoDomicilio(id);
  est.statusOutro = texto;
  est.atualizadoEm = agora();
  salvarEstado();
}, 400);

// ---------------------------------------------------------------------
// Compartilhamento (Web Share API com fallback de cópia)
// ---------------------------------------------------------------------

async function compartilharOuCopiar(texto) {
  if (navigator.share) {
    try {
      await navigator.share({ text: texto });
      return;
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      // cai no fallback abaixo
    }
  }
  try {
    await navigator.clipboard.writeText(texto);
    alert('Mensagem copiada. Cole no grupo do WhatsApp da equipe.');
  } catch (e) {
    prompt('Copie a mensagem abaixo e cole no grupo do WhatsApp:', texto);
  }
}

// ---------------------------------------------------------------------
// Repasse
// ---------------------------------------------------------------------

function abrirModalRepasse() {
  const cont = $('lista-repasse-destinos');
  cont.innerHTML = '';
  entrevistadores().filter((e) => e.nome !== estado.usuario).forEach((e) => {
    const btn = document.createElement('button');
    btn.className = 'botao-grande';
    btn.textContent = e.nome;
    btn.addEventListener('click', () => confirmarRepasse(e.nome));
    cont.appendChild(btn);
  });
  mostrar('modal-repasse');
}

function confirmarRepasse(destino) {
  const d = domiciliosPorId[fichaAtualId];
  const est = estadoDomicilio(fichaAtualId);
  // Mantém a atribuição original — o pino mostra as duas cores (metade de cada
  // entrevistador) até alguém assumir de vez com "Atribuir a mim"/"Atribuir a outro",
  // que aí sim substitui e limpa o repasse.
  est.repassadoPara = destino;
  est.atualizadoEm = agora();
  salvarEstado();
  esconder('modal-repasse');
  abrirFicha(fichaAtualId);
  aplicarFiltros();
  compartilharOuCopiar(REPASSE_TEMPLATE(d, estado.usuario, destino));
}

// ---------------------------------------------------------------------
// Carta de recusa
// ---------------------------------------------------------------------

function gerarCartaRecusa() {
  abrirModalCartaRecusa(fichaAtualId);
}

function abrirModalCartaRecusa(id) {
  fichaAtualId = id;
  const d = domiciliosPorId[id];
  const moradorCadastrado = moradorDe(id);
  const temCadastrado = !!moradorCadastrado;
  $('opcoes-nome-carta').innerHTML = `
    ${temCadastrado ? `<label class="opcao-nome"><input type="radio" name="nome-carta" value="cadastrado" checked> ${moradorCadastrado}</label>` : ''}
    <label class="opcao-nome"><input type="radio" name="nome-carta" value="padrao" ${temCadastrado ? '' : 'checked'}> ${NOME_PADRAO_ETIQUETA}</label>
    <label class="opcao-nome"><input type="radio" name="nome-carta" value="outro"> Outro nome:</label>
    <input type="text" id="campo-nome-carta-outro" class="oculto" placeholder="Digite o nome do morador">
  `;
  $('opcoes-nome-carta').querySelectorAll('input[name="nome-carta"]').forEach((r) => {
    r.addEventListener('change', atualizarCampoOutroNomeCarta);
  });
  $('erro-nome-carta').classList.add('oculto');
  mostrar('modal-carta-recusa');
}

function atualizarCampoOutroNomeCarta() {
  const outro = $('opcoes-nome-carta').querySelector('input[value="outro"]').checked;
  $('campo-nome-carta-outro').classList.toggle('oculto', !outro);
}

function confirmarNomeCartaRecusa() {
  const selecionado = $('opcoes-nome-carta').querySelector('input[name="nome-carta"]:checked');
  const d = domiciliosPorId[fichaAtualId];
  let nome = '';
  if (selecionado) {
    if (selecionado.value === 'outro') nome = $('campo-nome-carta-outro').value.trim();
    else if (selecionado.value === 'cadastrado') nome = moradorDe(fichaAtualId);
    else nome = NOME_PADRAO_ETIQUETA;
  }
  if (!nome) {
    $('erro-nome-carta').classList.remove('oculto');
    return;
  }
  esconder('modal-carta-recusa');
  const est = estadoDomicilio(fichaAtualId);
  est.cartaRecusaSolicitadaEm = agora();
  est.atualizadoEm = agora();
  salvarEstado();
  aplicarFiltros();
  if (!$('ficha-domicilio').classList.contains('oculto')) abrirFicha(fichaAtualId);
  compartilharOuCopiar(CARTA_RECUSA_TEMPLATE(d, estado.usuario, est.obs, nome));
}

function excluirSolicitacaoCarta(id) {
  if (!confirm('Excluir a solicitação de carta de recusa deste domicílio?')) return;
  const est = estadoDomicilio(id);
  est.cartaRecusaSolicitadaEm = null;
  est.atualizadoEm = agora();
  salvarEstado();
  aplicarFiltros();
  if (mapaLeaflet) mapaLeaflet.closePopup();
  if (fichaAtualId === id && !$('ficha-domicilio').classList.contains('oculto')) abrirFicha(id);
}

// ---------------------------------------------------------------------
// Classificar status (modal, usado a partir do popup do mapa)
// ---------------------------------------------------------------------

function abrirModalStatus(id) {
  fichaAtualId = id;
  const est = estadoDomicilio(id);
  $('opcoes-status').innerHTML =
    `<label class="opcao-nome">
      <input type="radio" name="status-escolha" value="" ${!est.status ? 'checked' : ''}>
      Sem classificação
    </label>` +
    STATUS_LIST.map((s) => `
    <label class="opcao-nome">
      <input type="radio" name="status-escolha" value="${s.chave}" ${est.status === s.chave ? 'checked' : ''}>
      ${s.label}
    </label>`).join('') +
    `<input type="text" id="campo-status-outro-modal" class="oculto" placeholder="Descreva o status" value="${est.statusOutro || ''}">`;
  $('opcoes-status').querySelectorAll('input[name="status-escolha"]').forEach((r) => {
    r.addEventListener('change', atualizarCampoOutroStatusModal);
  });
  atualizarCampoOutroStatusModal();
  mostrar('modal-status');
}

function atualizarCampoOutroStatusModal() {
  const outro = $('opcoes-status').querySelector('input[value="outros"]');
  $('campo-status-outro-modal').classList.toggle('oculto', !(outro && outro.checked));
}

function confirmarStatusModal() {
  const selecionado = $('opcoes-status').querySelector('input[name="status-escolha"]:checked');
  if (!selecionado) {
    esconder('modal-status');
    return;
  }
  const est = estadoDomicilio(fichaAtualId);
  est.status = selecionado.value || null;
  est.statusOutro = selecionado.value === 'outros' ? $('campo-status-outro-modal').value.trim() : null;
  est.atualizadoEm = agora();
  salvarEstado();
  esconder('modal-status');
  aplicarFiltros();
  if (fichaAtualId && !$('ficha-domicilio').classList.contains('oculto')) {
    $('select-status').value = est.status || '';
    $('campo-status-outro').classList.toggle('oculto', est.status !== 'outros');
    $('campo-status-outro').value = est.statusOutro || '';
    $('btn-carta-recusa').classList.toggle('oculto', est.status !== 'recusa');
  }
}

// ---------------------------------------------------------------------
// Etiquetas
// ---------------------------------------------------------------------

// Conectores que ficam em minúsculas no meio do texto (exceto na 1ª palavra).
const PALAVRAS_MINUSCULAS = new Set([
  'de', 'da', 'do', 'das', 'dos', 'e', 'em', 'a', 'o', 'os', 'as',
  'ao', 'aos', 'à', 'às', 'na', 'no', 'nas', 'nos', 'por', 'pelo',
  'pela', 'pelos', 'pelas', 'com', 'sem', 'sob', 'sobre', 'para',
]);
// Correções conhecidas de acentuação perdida na planilha de origem (chave em minúsculas).
const CORRECOES_ACENTUACAO = {
  travessao: 'travessão',
};

// Nome próprio (logradouro/bairro): cada palavra relevante maiúscula, conectores minúsculos.
function paraTituloProprio(texto) {
  if (!texto) return texto;
  return texto.trim().toLowerCase().split(/\s+/).map((palavra, i) => {
    const corrigida = CORRECOES_ACENTUACAO[palavra] || palavra;
    if (corrigida.length === 1) return corrigida.toUpperCase();
    if (i > 0 && PALAVRAS_MINUSCULAS.has(corrigida)) return corrigida;
    return corrigida.charAt(0).toUpperCase() + corrigida.slice(1);
  }).join(' ');
}

// Estilo frase (complemento): só a 1ª palavra maiúscula, o resto minúsculo.
function paraFraseCase(texto) {
  if (!texto) return texto;
  return texto.trim().toLowerCase().split(/\s+/).map((palavra, i) => {
    const corrigida = CORRECOES_ACENTUACAO[palavra] || palavra;
    if (corrigida.length === 1) return corrigida.toUpperCase();
    if (i === 0) return corrigida.charAt(0).toUpperCase() + corrigida.slice(1);
    return corrigida;
  }).join(' ');
}

function valorEtiqueta(d, est, campo) {
  const bruto = est.etiqueta[campo] != null ? est.etiqueta[campo] : d[campo];
  if (campo === 'logradouro' || campo === 'bairro') return paraTituloProprio(bruto);
  if (campo === 'complemento') return paraFraseCase(bruto);
  return bruto;
}

function cidadeUfEtiqueta(d, est) {
  if (est.etiqueta.cidadeUf != null) return est.etiqueta.cidadeUf;
  return d.municipio ? `${d.municipio}/RJ` : '';
}

function codigoEtiqueta(est) {
  return est.etiqueta.codigo != null ? est.etiqueta.codigo : (est.codigo || '');
}

function abrirEtiqueta() {
  const d = domiciliosPorId[fichaAtualId];
  const est = estadoDomicilio(fichaAtualId);
  $('et-nome').value = est.etiqueta.nome || NOME_PADRAO_ETIQUETA;
  $('et-logradouro').value = valorEtiqueta(d, est, 'logradouro') || '';
  $('et-numero').value = valorEtiqueta(d, est, 'numero') || '';
  $('et-complemento').value = valorEtiqueta(d, est, 'complemento') || '';
  $('et-bairro').value = valorEtiqueta(d, est, 'bairro') || '';
  $('et-cidade-uf').value = cidadeUfEtiqueta(d, est);
  $('et-codigo').value = codigoEtiqueta(est);
  atualizarPreviewEtiqueta();
  mostrar('tela-etiqueta');
}

function lerCamposEtiqueta() {
  return {
    nome: $('et-nome').value.trim() || NOME_PADRAO_ETIQUETA,
    logradouro: $('et-logradouro').value.trim() || null,
    numero: $('et-numero').value.trim() || null,
    complemento: $('et-complemento').value.trim() || null,
    bairro: $('et-bairro').value.trim() || null,
    cidadeUf: $('et-cidade-uf').value.trim() || null,
    codigo: $('et-codigo').value.trim() || null,
  };
}

function salvarCamposEtiqueta() {
  const est = estadoDomicilio(fichaAtualId);
  est.etiqueta = lerCamposEtiqueta();
  est.atualizadoEm = agora();
  salvarEstado();
  atualizarPreviewEtiqueta();
}

function marcacaoEtiqueta(campos, editavel) {
  const ce = editavel ? ' contenteditable="true"' : '';
  return `<div class="et-nome"${ce}>${campos.nome}</div>` +
    `<div class="et-end"${ce}>${campos.logradouro || ''}, ${campos.numero || 'S/N'}${campos.complemento ? ' — ' + campos.complemento : ''}</div>` +
    `<div class="et-end"${ce}>${campos.bairro || ''}${campos.bairro && campos.cidadeUf ? ' — ' : ''}${campos.cidadeUf || ''}</div>` +
    `<div class="et-cod"${ce}>${campos.codigo || ''}</div>`;
}

function atualizarPreviewEtiqueta() {
  $('etiqueta-preview').innerHTML = marcacaoEtiqueta(lerCamposEtiqueta());
}

function abrirTelaImpressao(infoTexto) {
  $('impressao-etiquetas-info').textContent = infoTexto;
  mostrar('tela-impressao-etiquetas');
}

function imprimirEtiquetas() {
  window.print();
}

function gerarImpressaoEtiquetaIndividual() {
  salvarCamposEtiqueta();
  const est = estadoDomicilio(fichaAtualId);
  const html = `<div class="etiqueta-impressa etiqueta-impressa-individual">${marcacaoEtiqueta(est.etiqueta, true)}</div>`;
  $('area-impressao').innerHTML = html;
  abrirTelaImpressao('1 etiqueta — toque em qualquer campo para corrigir antes de imprimir.');
}

function abrirEtiquetasLote() {
  if (filtroSetoresSelecionados.size === 1) {
    $('lote-filtro-setor').value = [...filtroSetoresSelecionados][0];
  }
  atualizarContagemLote();
  mostrar('tela-etiquetas-lote');
}

function domiciliosParaLote() {
  const setor = $('lote-filtro-setor').value;
  if (!setor) return [];
  return domiciliosDaUpa(setor);
}

function atualizarContagemLote() {
  const setor = $('lote-filtro-setor').value;
  const lista = domiciliosParaLote();
  const naoAtribuidos = lista.filter((d) => !donoDomicilio(estadoDomicilio(d.id))).length;
  let texto = setor ? `${rotuloUpaDoSetor(setor)} — ${lista.length} etiqueta(s) serão geradas` : `${lista.length} etiqueta(s) serão geradas`;
  if (naoAtribuidos > 0) texto += ` (${naoAtribuidos} ainda não atribuído(s) a ninguém)`;
  $('lote-contagem').textContent = texto + '.';
}

function gerarImpressaoLote() {
  const lista = domiciliosParaLote();
  if (!lista.length) {
    alert('Selecione um setor com domicílios no roteiro.');
    return;
  }
  const naoAtribuidos = lista.filter((d) => !donoDomicilio(estadoDomicilio(d.id))).length;
  if (naoAtribuidos > 0) {
    if (!confirm(`${naoAtribuidos} de ${lista.length} domicílio(s) ainda não foram atribuídos a ninguém. Gerar as etiquetas mesmo assim?`)) return;
  }
  const porPagina = LOTE_COLUNAS * LOTE_LINHAS;
  let html = '';
  for (let i = 0; i < lista.length; i += porPagina) {
    const pagina = lista.slice(i, i + porPagina);
    html += `<div class="folha-etiquetas" style="grid-template-columns:repeat(${LOTE_COLUNAS},1fr)">`;
    pagina.forEach((d) => {
      const est = estadoDomicilio(d.id);
      html += `<div class="etiqueta-impressa">${marcacaoEtiqueta({
        nome: est.etiqueta.nome || NOME_PADRAO_ETIQUETA,
        logradouro: valorEtiqueta(d, est, 'logradouro'),
        numero: valorEtiqueta(d, est, 'numero'),
        complemento: valorEtiqueta(d, est, 'complemento'),
        bairro: valorEtiqueta(d, est, 'bairro'),
        cidadeUf: cidadeUfEtiqueta(d, est),
        codigo: codigoEtiqueta(est),
      }, true)}</div>`;
    });
    html += `</div>`;
  }
  $('area-impressao').innerHTML = html;
  abrirTelaImpressao(`${lista.length} etiqueta(s) — toque em qualquer campo para corrigir antes de imprimir.`);
}

// ---------------------------------------------------------------------
// Cadastro de entrevistador extra
// ---------------------------------------------------------------------

function abrirCadastroEntrevistador() {
  $('campo-novo-nome').value = '';
  $('campo-nova-letra').value = '';
  $('erro-cadastro-entrevistador').classList.add('oculto');
  mostrar('modal-cadastro-entrevistador');
}

function salvarNovoEntrevistador() {
  const nome = $('campo-novo-nome').value.trim();
  const letra = $('campo-nova-letra').value.trim();
  const erroEl = $('erro-cadastro-entrevistador');
  if (!nome || !letra) {
    erroEl.textContent = 'Preencha nome e letra.';
    erroEl.classList.remove('oculto');
    return;
  }
  const existentes = entrevistadores();
  if (existentes.some((e) => e.letra.toLowerCase() === letra.toLowerCase())) {
    erroEl.textContent = 'Já existe um entrevistador com essa letra.';
    erroEl.classList.remove('oculto');
    return;
  }
  if (existentes.some((e) => e.nome.toLowerCase() === nome.toLowerCase())) {
    erroEl.textContent = 'Já existe um entrevistador com esse nome.';
    erroEl.classList.remove('oculto');
    return;
  }
  estado.entrevistadoresExtras.push({ nome, letra });
  salvarEstado();
  esconder('modal-cadastro-entrevistador');
  renderListaEntrevistadores();
  popularLegenda();
  if (mapaLeaflet) aplicarFiltros();
}

// ---------------------------------------------------------------------
// Distribuir domicílios do setor entre a equipe (mensagem única pro grupo)
// ---------------------------------------------------------------------

function popularFiltroDistribuir() {
  const sel = $('distribuir-filtro-setor');
  const setoresOrdenados = [...DADOS.setores].sort((a, b) => a.controle.localeCompare(b.controle));
  setoresOrdenados.forEach((s) => {
    const opt = document.createElement('option');
    opt.value = s.controle;
    const nome = nomeLocalidadeSetor(s);
    const irmaos = setoresDaUpaDe(s.controle).length - 1;
    const sufixoUpa = irmaos > 0 ? ` (UPA com +${irmaos} setor${irmaos > 1 ? 'es' : ''})` : '';
    opt.textContent = `Setor ${s.controle}${nome ? ' — ' + nome : ''}${sufixoUpa}`;
    sel.appendChild(opt);
  });
}

function rotuloUpaDoSetor(setor) {
  const setores = setoresDaUpaDe(setor);
  if (setores.length === 1) {
    const s = setoresPorControle[setor];
    const nome = s ? nomeLocalidadeSetor(s) : '';
    return `Setor ${setor}${nome ? ' — ' + nome : ''}`;
  }
  return `UPA (setores ${setores.join(', ')})`;
}

function domiciliosDaUpa(setor) {
  const setores = setoresDaUpaDe(setor);
  return DADOS.domicilios
    .filter((d) => setores.includes(d.setor))
    .sort((a, b) => (a.numDomicilio || 0) - (b.numDomicilio || 0));
}

function abrirDistribuirSetor() {
  if (filtroSetoresSelecionados.size === 1) {
    $('distribuir-filtro-setor').value = [...filtroSetoresSelecionados][0];
  }
  renderDistribuirSetor();
  mostrar('tela-distribuir-setor');
}

// Botão "📤" no meio de cada setor no mapa — atalho pra abrir direto o
// envio de associações daquele setor/UPA, sem passar pelo menu.
function abrirDistribuirSetorParaSetor(codigo) {
  mapaLeaflet.closePopup();
  $('distribuir-filtro-setor').value = codigo;
  renderDistribuirSetor();
  mostrar('tela-distribuir-setor');
}

function agruparPorEntrevistador(lista) {
  const grupos = {};
  lista.forEach((d) => {
    const nome = donoDomicilio(estadoDomicilio(d.id)) || 'Não atribuído';
    (grupos[nome] = grupos[nome] || []).push(d.numDomicilio);
  });
  Object.values(grupos).forEach((nums) => nums.sort((a, b) => a - b));
  return grupos;
}

function ordenarNomesGrupos(grupos) {
  return Object.keys(grupos).sort((a, b) => {
    if (a === 'Não atribuído') return 1;
    if (b === 'Não atribuído') return -1;
    return a.localeCompare(b);
  });
}

function renderDistribuirSetor() {
  const setor = $('distribuir-filtro-setor').value;
  const lista = domiciliosDaUpa(setor);
  const cont = $('distribuir-resumo');
  if (!lista.length) {
    cont.innerHTML = '<p class="vazio">Essa UPA não tem domicílios no roteiro.</p>';
    return;
  }
  const grupos = agruparPorEntrevistador(lista);
  const naoAtribuidos = (grupos['Não atribuído'] || []).length;
  const atribuidos = lista.length - naoAtribuidos;

  cont.innerHTML = `<p class="texto-ajuda"><strong>${rotuloUpaDoSetor(setor)}</strong></p>` +
    `<p class="texto-ajuda">${atribuidos} de ${lista.length} domicílio(s) já atribuído(s)</p>` +
    ordenarNomesGrupos(grupos).map((nome) => `
      <div class="setor-resumo">
        <strong>${nome}</strong>
        <div class="texto-ajuda">${grupos[nome].length} domicílio(s): dom. ${grupos[nome].join(', ')}</div>
      </div>`).join('');
}

function montarMensagemDistribuicao(setor, grupos, nomesOrdenados) {
  const linhas = nomesOrdenados.map((nome) => `${nome}: dom. ${grupos[nome].join(', ')} (${grupos[nome].length})`);
  const total = Object.values(grupos).reduce((acc, arr) => acc + arr.length, 0);
  return `👥 DISTRIBUIÇÃO DE DOMICÍLIOS — ${rotuloUpaDoSetor(setor)}
Data: ${new Date().toLocaleDateString('pt-BR')}

${linhas.join('\n')}

Total: ${total} domicílio(s)`;
}

function gerarMensagemDistribuicao() {
  const setor = $('distribuir-filtro-setor').value;
  if (!setor) return;
  const lista = domiciliosDaUpa(setor);
  if (!lista.length) {
    alert('Essa UPA não tem domicílios no roteiro.');
    return;
  }

  const grupos = agruparPorEntrevistador(lista);
  const naoAtribuidos = (grupos['Não atribuído'] || []).length;
  if (naoAtribuidos > 0) {
    const atribuidos = lista.length - naoAtribuidos;
    if (!confirm(`${rotuloUpaDoSetor(setor)} tem ${lista.length} domicílios, mas só ${atribuidos} foram atribuídos. Deseja enviar mesmo assim só com esses ${atribuidos}?`)) return;
  }

  const texto = montarMensagemDistribuicao(setor, grupos, ordenarNomesGrupos(grupos));
  esconder('tela-distribuir-setor');
  compartilharOuCopiar(texto);
}

// ---------------------------------------------------------------------
// Trocar usuário
// ---------------------------------------------------------------------

function trocarUsuario() {
  if (!confirm('Trocar de usuário? Os dados salvos neste aparelho não serão apagados.')) return;
  estado.usuario = null;
  salvarEstado();
  esconder('menu-lateral');
  esconder('tela-mapa');
  mostrar('tela-identificacao');
}

function limparTodasAssociacoes() {
  // estadoDomicilio() cria uma entrada "vazia" só de ler (ex.: ao renderizar os pinos do
  // mapa) — contar só as que têm alguma alteração de verdade evita um aviso enganoso.
  const n = Object.values(estado.domicilios).filter((est) => (
    est.atribuido || est.status || est.obs || est.repassadoPara ||
    est.cartaRecusaSolicitadaEm || est.enviadoSupervisorEm
  )).length;
  if (!n) {
    alert('Não há nada pra limpar — nenhum domicílio tem status, atribuição ou observação salvos neste aparelho.');
    return;
  }
  if (!confirm(
    `Isso apaga TUDO que foi preenchido neste aparelho pra ${n} domicílio(s): atribuições, status, ` +
    'observações, repasses e solicitações de carta de recusa. Não afeta outros aparelhos nem pode ser desfeito. ' +
    'Recomendado: exporte um backup antes, se quiser guardar algo. Continuar?'
  )) return;
  if (!confirm('Tem certeza? Essa é a segunda e última confirmação — os dados serão apagados agora.')) return;
  estado.domicilios = {};
  salvarEstado();
  esconder('menu-lateral');
  if (mapaLeaflet) aplicarFiltros();
  alert('Associações, status e observações apagados neste aparelho.');
}

// ---------------------------------------------------------------------
// Backup
// ---------------------------------------------------------------------

function exportarBackup() {
  const dataStr = new Date().toISOString().slice(0, 10);
  const blob = new Blob([JSON.stringify(estado, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `backup-${estado.usuario || 'sem-usuario'}-${dataStr}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function importarBackup(arquivo) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const importado = JSON.parse(reader.result);
      Object.entries(importado.domicilios || {}).forEach(([id, novo]) => {
        const atual = estado.domicilios[id];
        if (!atual || new Date(novo.atualizadoEm || 0) >= new Date(atual.atualizadoEm || 0)) {
          estado.domicilios[id] = novo;
        }
      });
      (importado.entrevistadoresExtras || []).forEach((e) => {
        if (!entrevistadores().some((x) => x.letra === e.letra)) {
          estado.entrevistadoresExtras.push(e);
        }
      });
      salvarEstado();
      renderListaEntrevistadores();
      aplicarFiltros();
      alert('Backup importado com sucesso.');
    } catch (e) {
      alert('Arquivo de backup inválido.');
    }
  };
  reader.readAsText(arquivo);
}

// ---------------------------------------------------------------------
// Mapa offline (leaflet.offline + idb, vendorizados — mesmo mecanismo do campo.html)
// ---------------------------------------------------------------------

let _promessaLeafletOffline = null;

function carregarScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

function carregarLeafletOffline() {
  if (_promessaLeafletOffline) return _promessaLeafletOffline;
  _promessaLeafletOffline = (async () => {
    if (window.LeafletOffline) return window.LeafletOffline;
    if (!window.idb) await carregarScript('vendor/leaflet-offline/idb.umd.js');
    await carregarScript('vendor/leaflet-offline/leaflet-offline.bundle.js');
    return window.LeafletOffline;
  })();
  return _promessaLeafletOffline;
}

let camadaTilesOffline = null;
let controleSalvarTiles = null;

async function criarCamadaMapaOffline(mapa) {
  await carregarLeafletOffline();
  camadaTilesOffline = L.tileLayer.offline(TILE_URL('{s}', '{z}', '{x}', '{y}'), {
    subdomains: TILE_SUBDOMINIOS,
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap',
  }).addTo(mapa);
  controleSalvarTiles = L.control.savetiles(camadaTilesOffline, {
    saveWhatYouSee: true,
    maxZoom: 18,
    parallel: 6,
  }).addTo(mapa);
  // o controle nativo da lib fica escondido; usamos nosso próprio botão no menu
  const ctrlEl = controleSalvarTiles.getContainer && controleSalvarTiles.getContainer();
  if (ctrlEl) ctrlEl.style.display = 'none';
}

function baixarMapaOffline() {
  if (!controleSalvarTiles || !camadaTilesOffline) {
    alert('Mapa ainda não carregado.');
    return;
  }
  if (navigator.onLine === false) {
    alert('Sem conexão com a internet.');
    return;
  }

  const btn = $('btn-baixar-tiles');
  $('progresso-tiles').classList.remove('oculto');
  const barra = $('barra-progresso-tiles');
  const texto = $('texto-progresso-tiles');
  let acabou = false;
  let ultimoProgresso = Date.now();

  const onLoadTile = () => { ultimoProgresso = Date.now(); };
  const onSaveTile = (st) => {
    ultimoProgresso = Date.now();
    barra.max = st.lengthToBeSaved;
    barra.value = st.lengthSaved;
    texto.textContent = `Baixando mapa… ${st.lengthSaved}/${st.lengthToBeSaved}`;
  };
  const finalizar = (st) => {
    if (acabou) return;
    acabou = true;
    clearInterval(checadorParado);
    camadaTilesOffline.off('loadtileend', onLoadTile);
    camadaTilesOffline.off('savetileend', onSaveTile);
    camadaTilesOffline.off('saveend', onSaveEnd);
    btn.disabled = false;
    texto.textContent = `Concluído: ${st.lengthSaved}/${st.lengthToBeSaved} blocos salvos para uso offline.`;
    estado.tilesBaixados = st.lengthSaved > 0;
    salvarEstado();
    atualizarStatusMapaOffline();
  };
  const onSaveEnd = (st) => finalizar(st);

  // se ficar 8s sem nenhum progresso, encerra (provável falha de rede em algum bloco)
  const checadorParado = setInterval(() => {
    if (Date.now() - ultimoProgresso > 8000) finalizar(controleSalvarTiles.status);
  }, 2000);

  camadaTilesOffline.on('loadtileend', onLoadTile);
  camadaTilesOffline.on('savetileend', onSaveTile);
  camadaTilesOffline.on('saveend', onSaveEnd);

  controleSalvarTiles.options.confirm = (status, ok) => {
    if (confirm(`Baixar ${status.lengthToBeSaved} blocos do mapa (área visível na tela) para uso offline?`)) {
      btn.disabled = true;
      texto.textContent = `Baixando mapa… 0/${status.lengthToBeSaved}`;
      ok();
    } else {
      clearInterval(checadorParado);
      camadaTilesOffline.off('loadtileend', onLoadTile);
      camadaTilesOffline.off('savetileend', onSaveTile);
      camadaTilesOffline.off('saveend', onSaveEnd);
    }
  };
  try {
    controleSalvarTiles._saveTiles();
  } catch (e) {
    console.error('Falha ao iniciar download do mapa offline', e);
    alert('Erro ao iniciar download do mapa offline.');
    clearInterval(checadorParado);
    camadaTilesOffline.off('loadtileend', onLoadTile);
    camadaTilesOffline.off('savetileend', onSaveTile);
    camadaTilesOffline.off('saveend', onSaveEnd);
    btn.disabled = false;
  }
}

async function limparMapaOffline() {
  if (!confirm('Remover todos os blocos do mapa salvos para uso offline?')) return;
  await carregarLeafletOffline();
  await window.LeafletOffline.truncate();
  estado.tilesBaixados = false;
  salvarEstado();
  await atualizarStatusMapaOffline();
  alert('Mapa offline removido.');
}

async function atualizarStatusMapaOffline() {
  const el = $('status-mapa-offline');
  if (!el) return;
  try {
    await carregarLeafletOffline();
    const n = await window.LeafletOffline.getStorageLength();
    el.textContent = n > 0 ? `Mapa offline: ${n} blocos salvos` : 'Mapa offline: nenhum bloco salvo';
  } catch (e) {
    el.textContent = 'Mapa offline: —';
  }
}

// ---------------------------------------------------------------------
// Service worker
// ---------------------------------------------------------------------

let registroSW = null;

function registrarServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  navigator.serviceWorker.register('sw.js').then((registro) => {
    registroSW = registro;
    // Reabrir o app (ícone na tela inicial) não garante que o navegador foi checar
    // se existe um sw.js novo no servidor — força essa checagem sempre que o app volta a ficar visível.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') registro.update().catch(() => {});
    });
  }).catch((e) => console.error('Falha ao registrar SW', e));

  // O sw.js usa skipWaiting()+clients.claim(), então assim que uma versão nova é
  // instalada ela assume o controle sozinha — só falta recarregar a página pra
  // ela passar a usar o HTML/JS/CSS novos em vez dos que já estavam na memória.
  let recarregando = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (recarregando) return;
    recarregando = true;
    window.location.reload();
  });
}

function verificarAtualizacaoApp() {
  if (!registroSW) return;
  registroSW.update().catch(() => {});
  alert('Verificando atualização... se houver uma versão nova, o app recarrega sozinho em instantes.');
}

// ---------------------------------------------------------------------
// Eventos
// ---------------------------------------------------------------------

function wireEventosGlobais() {
  $('btn-abrir-cadastro-entrevistador').addEventListener('click', abrirCadastroEntrevistador);
  $('btn-cadastrar-entrevistador-menu').addEventListener('click', () => {
    esconder('menu-lateral');
    abrirCadastroEntrevistador();
  });
  $('btn-salvar-entrevistador').addEventListener('click', salvarNovoEntrevistador);

  $('btn-menu').addEventListener('click', () => { mostrar('menu-lateral'); atualizarStatusMapaOffline(); });
  $('btn-legenda').addEventListener('click', () => mostrar('painel-legenda'));
  $('btn-localizar').addEventListener('click', () => mapaLeaflet && mapaLeaflet.locate({ setView: true, maxZoom: 17 }));
  $('btn-modo-selecao').addEventListener('click', alternarModoSelecao);
  $('btn-cancelar-selecao').addEventListener('click', cancelarSelecao);
  $('btn-atribuir-selecao').addEventListener('click', abrirEscolhaAtribuirSelecionados);
  $('btn-desassociar-selecao').addEventListener('click', desassociarSelecionados);

  $('btn-abrir-filtro-setor').addEventListener('click', () => {
    renderListaFiltroSetor();
    mostrar('tela-filtro-setor');
  });
  $('btn-fechar-filtro-setor').addEventListener('click', () => {
    esconder('tela-filtro-setor');
    $('busca-filtro-setor').value = '';
    centralizarNoFiltroSetor();
  });
  $('busca-filtro-setor').addEventListener('input', (e) => renderListaFiltroSetor(e.target.value));
  $('btn-marcar-todos-setores').addEventListener('click', () => {
    setoresFiltradosPorBusca($('busca-filtro-setor').value).forEach((s) => filtroSetoresSelecionados.add(s.controle));
    renderListaFiltroSetor($('busca-filtro-setor').value);
    aplicarFiltros();
  });
  $('btn-limpar-filtro-setor').addEventListener('click', () => {
    filtroSetoresSelecionados.clear();
    renderListaFiltroSetor($('busca-filtro-setor').value);
    aplicarFiltros();
  });
  $('btn-limpar-filtro-setor-rapido').addEventListener('click', (e) => {
    e.stopPropagation();
    limparFiltroSetor();
  });
  $('btn-lista-setor').addEventListener('click', abrirListaSetor);
  $('filtro-status').addEventListener('change', aplicarFiltros);
  $('btn-so-meus').addEventListener('click', () => {
    filtroSoMeusAtivo = !filtroSoMeusAtivo;
    $('btn-so-meus').classList.toggle('ativo', filtroSoMeusAtivo);
    aplicarFiltros();
  });

  $('btn-atribuir').addEventListener('click', atribuirOuRemover);
  $('btn-atribuir-outro').addEventListener('click', abrirEscolhaAtribuirOutroFicha);
  $('select-status').addEventListener('change', onMudarStatus);
  $('campo-status-outro').addEventListener('input', (e) => salvarStatusOutroDebounced(fichaAtualId, e.target.value));
  $('campo-obs').addEventListener('input', (e) => salvarObsDebounced(fichaAtualId, e.target.value));

  $('btn-repassar').addEventListener('click', abrirModalRepasse);
  $('btn-carta-recusa').addEventListener('click', gerarCartaRecusa);
  $('btn-excluir-carta-recusa').addEventListener('click', () => excluirSolicitacaoCarta(fichaAtualId));
  $('btn-confirmar-carta-recusa').addEventListener('click', confirmarNomeCartaRecusa);
  $('btn-confirmar-status').addEventListener('click', confirmarStatusModal);
  $('btn-etiqueta').addEventListener('click', () => { if (!$('btn-etiqueta').disabled) abrirEtiqueta(); });

  ['et-nome', 'et-logradouro', 'et-numero', 'et-complemento', 'et-bairro', 'et-cidade-uf', 'et-codigo'].forEach((id) => {
    $(id).addEventListener('input', () => { salvarCamposEtiqueta(); });
  });
  $('btn-gerar-etiqueta').addEventListener('click', gerarImpressaoEtiquetaIndividual);
  $('btn-imprimir-etiquetas').addEventListener('click', imprimirEtiquetas);

  $('btn-abrir-meus-associados').addEventListener('click', () => { esconder('menu-lateral'); abrirMeusAssociados(); });
  $('btn-abrir-distribuir-setor').addEventListener('click', () => { esconder('menu-lateral'); abrirDistribuirSetor(); });
  $('distribuir-filtro-setor').addEventListener('change', renderDistribuirSetor);
  $('btn-gerar-mensagem-distribuicao').addEventListener('click', gerarMensagemDistribuicao);

  $('btn-etiquetas-lote').addEventListener('click', () => { esconder('menu-lateral'); abrirEtiquetasLote(); });
  $('lote-filtro-setor').addEventListener('change', atualizarContagemLote);
  $('btn-gerar-lote').addEventListener('click', gerarImpressaoLote);

  $('btn-exportar-backup').addEventListener('click', exportarBackup);
  $('btn-importar-backup').addEventListener('click', () => $('input-importar-backup').click());
  $('input-importar-backup').addEventListener('change', (e) => {
    if (e.target.files[0]) importarBackup(e.target.files[0]);
    e.target.value = '';
  });

  $('btn-importar-dados-pessoais').addEventListener('click', () => $('input-dados-pessoais').click());
  $('input-dados-pessoais').addEventListener('change', (e) => {
    if (e.target.files[0]) importarDadosPessoais(e.target.files[0]);
    e.target.value = '';
  });

  $('btn-baixar-tiles').addEventListener('click', baixarMapaOffline);
  $('btn-limpar-mapa-offline').addEventListener('click', limparMapaOffline);
  $('btn-trocar-usuario').addEventListener('click', trocarUsuario);
  $('btn-verificar-atualizacao').addEventListener('click', verificarAtualizacaoApp);
  $('btn-limpar-associacoes').addEventListener('click', limparTodasAssociacoes);
}

document.addEventListener('DOMContentLoaded', iniciar);
