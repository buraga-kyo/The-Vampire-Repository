#!/usr/bin/env node
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import crypto, { X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import zlib from 'node:zlib';
import { parseArgs } from 'node:util';

const VERSAO = '1.1.0';

const AJUDA = `
capturar-site v${VERSAO}: captura "estilo DevTools" de um site inteiro

USO
  node capturar-site.mjs <url> [opções]

MODOS
      --modo <rapido|completo|profundo>
                              rapido: DOM, rede e fontes; sem extras pesados
                              completo: captura ampla com limites (padrão)
                              profundo: sem limite de páginas, variantes ou tamanho;
                              inclui extras, cliques e armazenamento

LOGIN
  O script abre um Chrome com perfil próprio e pausa. Faça login na janela
  (formulário, SSO, 2FA, captcha…) e aperte ENTER no terminal. A sessão fica
  guardada no perfil (veja --perfil); nas próximas execuções você costuma
  continuar logado. Sites sem login: use --sem-login.

ESCOPO
  -o, --saida <pasta>         pasta de saída (padrão: ./captura-<host>)
      --escopo <dominio|host> dominio = host + subdomínios (padrão) | host = só o host exato
      --max-paginas <n>       máximo de páginas (padrão 500)
      --max-profundidade <n>  níveis de links a partir da URL inicial (0 = sem limite)
      --incluir <regex>       só segue URLs que casem (repetível)
      --excluir <regex>       nunca segue URLs que casem (repetível)
      --max-variantes <n>     máx. de URLs com query diferente por caminho (padrão 20)
      --sem-sitemap           não lê robots.txt / sitemap.xml

SEGURANÇA (o site é logado, então o script é cuidadoso)
      --bloquear <regex>      acrescenta padrões à lista de bloqueio de URLs e
                              textos de botões (repetível)
      --sem-cliques           não clica em nada (só navega por links e rola a página)
      --max-cliques <n>       máx. de cliques por página (padrão 25)
      --permitir-escrita      NÃO bloquear DELETE/PUT/PATCH nem envio de formulários
                              (por padrão eles são abortados no navegador)

NAVEGADOR
      --chrome <caminho>      executável do Chrome/Chromium/Edge
      --perfil <pasta>        pasta do perfil (padrão: ~/.capturar-site/perfis/<host>)
      --perfil-limpo          apaga o perfil antes (desloga de tudo)
      --headless              sem janela (use depois de já ter logado uma vez)
      --sem-login             não pausa para login
      --paralelo <n>          abas simultâneas (padrão 2)
      --atraso <ms>           pausa entre páginas, por aba (padrão 300)
      --espera <ms>           espera extra após cada carga (padrão 800)
      --rolagem <n>           passos máximos de rolagem por página (padrão 40)
      --ignorar-ssl           aceita certificados inválidos
      --usar-sw               deixa os service workers interceptarem a rede
                              (padrão: ignorados, para capturar o que o servidor entrega)
      --porta <n>             porta de depuração (padrão: livre)
      --sem-sandbox           passa --no-sandbox ao Chrome (automático se root)

SAÍDA
      --max-mb <n>            maior arquivo gravado, em MB (padrão 100)
      --sem-derivados         não gera código formatado nem fontes originais via source map
      --sem-node-modules      pula node_modules ao reconstruir fontes originais
      --sem-console           não grava logs do console
      --sem-seguranca         não grava certificado/headers de segurança
      --sem-capturas          não tira screenshots
      --sem-lighthouse        não roda Lighthouse
      --lighthouse-max <n>    páginas com Lighthouse (padrão 10; 0 = todas)
      --idb-max <n>           máx. de registros por object store do IndexedDB (padrão 5000)
      --sem-aplicativo        não exporta cookies nem armazenamento do navegador
      --retomar               continua uma captura interrompida (mesma pasta de saída)
  -h, --ajuda                 esta ajuda
`;

let opt;
let positionals;
try {
  ({ values: opt, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      modo: { type: 'string', default: 'completo' },
      saida: { type: 'string', short: 'o' },
      escopo: { type: 'string', default: 'dominio' },
      'max-paginas': { type: 'string' },
      'max-profundidade': { type: 'string', default: '0' },
      'max-variantes': { type: 'string' },
      incluir: { type: 'string', multiple: true },
      excluir: { type: 'string', multiple: true },
      bloquear: { type: 'string', multiple: true },
      paralelo: { type: 'string', default: '2' },
      atraso: { type: 'string', default: '300' },
      espera: { type: 'string', default: '800' },
      rolagem: { type: 'string', default: '40' },
      'max-mb': { type: 'string' },
      'max-cliques': { type: 'string', default: '25' },
      'idb-max': { type: 'string', default: '5000' },
      'lighthouse-max': { type: 'string', default: '10' },
      chrome: { type: 'string' },
      perfil: { type: 'string' },
      porta: { type: 'string' },
      'perfil-limpo': { type: 'boolean', default: false },
      'sem-login': { type: 'boolean', default: false },
      headless: { type: 'boolean', default: false },
      'sem-sandbox': { type: 'boolean', default: false },
      'ignorar-ssl': { type: 'boolean', default: false },
      'usar-sw': { type: 'boolean', default: false },
      'permitir-escrita': { type: 'boolean', default: false },
      'sem-cliques': { type: 'boolean', default: false },
      'sem-sitemap': { type: 'boolean', default: false },
      'sem-console': { type: 'boolean', default: false },
      'sem-seguranca': { type: 'boolean', default: false },
      'sem-capturas': { type: 'boolean', default: false },
      'sem-lighthouse': { type: 'boolean', default: false },
      'sem-derivados': { type: 'boolean', default: false },
      'sem-node-modules': { type: 'boolean', default: false },
      'sem-aplicativo': { type: 'boolean', default: false },
      retomar: { type: 'boolean', default: false },
      ajuda: { type: 'boolean', short: 'h', default: false },
    },
  }));
} catch (e) {
  console.error(`Opção inválida: ${e.message}\nUse --ajuda para ver as opções.`);
  process.exit(1);
}
if (opt.ajuda || positionals.length === 0) {
  console.log(AJUDA);
  process.exit(opt.ajuda ? 0 : 1);
}
if (!['rapido', 'completo', 'profundo'].includes(opt.modo)) {
  console.error('Modo inválido: use rapido, completo ou profundo.');
  process.exit(1);
}

// ----------------------------------------------------------------------------
//  Configuração
// ----------------------------------------------------------------------------
let urlInicial = positionals[0];
if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(urlInicial)) urlInicial = 'https://' + urlInicial;
let U0;
try {
  U0 = new URL(urlInicial);
} catch {
  console.error('URL inválida: ' + positionals[0]);
  process.exit(1);
}

const NUM = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const MAX_PAGINAS = NUM(opt['max-paginas'], opt.modo === 'profundo' ? 0 : opt.modo === 'rapido' ? 50 : 500);
const MAX_PROF = NUM(opt['max-profundidade'], 0);
const MAX_VARIANTES = NUM(opt['max-variantes'], opt.modo === 'profundo' ? 0 : 20);
const PARALELO = Math.min(Math.max(NUM(opt.paralelo, 2), 1), 8);
const ATRASO = Math.max(NUM(opt.atraso, 300), 0);
const ESPERA = Math.max(NUM(opt.espera, 800), 0);
const ROLAGEM = Math.max(NUM(opt.rolagem, 40), 0);
const MAX_MB = NUM(opt['max-mb'], opt.modo === 'profundo' ? 0 : 100);
const MAX_BYTES = MAX_MB * 1024 * 1024;
const MAX_CLIQUES = Math.max(NUM(opt['max-cliques'], 25), 0);
const IDB_MAX = Math.max(NUM(opt['idb-max'], 5000), 1);
const LH_MAX = Math.max(NUM(opt['lighthouse-max'], 10), 0);
const NAV_TIMEOUT = 45000;
const PAGINA_TIMEOUT = 5 * 60 * 1000;
const MAX_FORMATAR = 8 * 1024 * 1024;
for (const [nome, valor] of Object.entries({
  'max-paginas': MAX_PAGINAS, 'max-profundidade': MAX_PROF,
  'max-variantes': MAX_VARIANTES, paralelo: PARALELO, atraso: ATRASO,
  espera: ESPERA, rolagem: ROLAGEM, 'max-mb': MAX_MB,
  'max-cliques': MAX_CLIQUES, 'idb-max': IDB_MAX, 'lighthouse-max': LH_MAX,
})) {
  if (!Number.isSafeInteger(valor) || valor < 0 || (opt[nome] !== undefined && !/^\d+$/.test(opt[nome]))) {
    console.error(`Valor inválido para --${nome}: use inteiro não negativo.`);
    process.exit(1);
  }
}
if (opt.escopo !== 'dominio' && opt.escopo !== 'host') {
  console.error('Escopo inválido: use dominio ou host.');
  process.exit(1);
}

const EXTRA = {
  console: opt.modo !== 'rapido' && !opt['sem-console'],
  seguranca: opt.modo !== 'rapido' && !opt['sem-seguranca'],
  capturas: opt.modo !== 'rapido' && !opt['sem-capturas'],
  lighthouse: opt.modo !== 'rapido' && !opt['sem-lighthouse'],
  derivados: opt.modo !== 'rapido' && !opt['sem-derivados'],
  cliques: opt.modo !== 'rapido' && !opt['sem-cliques'],
  sitemap: opt.modo !== 'rapido' && !opt['sem-sitemap'],
  aplicativo: opt.modo !== 'rapido' && !opt['sem-aplicativo'],
  nodeModules: !opt['sem-node-modules'],
};

const OUT_DIR = path.resolve(opt.saida || `captura-${U0.host.replace(':', '_')}`);
const LIMITE_CAMINHO = process.platform === 'win32' ? 240 : 2000;
const ARQ_PAGINAS = path.join(OUT_DIR, '_paginas.jsonl');
const ARQ_ERROS = path.join(OUT_DIR, '_erros.jsonl');
const ARQ_ESTADO = path.join(OUT_DIR, '_estado.json');

// Trava de segurança: nomes de URL que parecem encerrar sessão ou alterar dados.
const BLOQUEIO_EXTRA_SRC = (opt.bloquear || []).join('|');
const BLOQUEIO_URL = new RegExp(
  String.raw`(^|[\/_\-.?=&;])(log-?out|log-?off|sign-?out|deslogar|sair|encerrar-?sessao|desconectar|disconnect|delete|deletar|excluir|exclusao|remover|remove|destroy|apagar|unsubscribe|descadastrar|revoke|revogar|purge|cancelar|cancel|desativar|deactivate)([\/_\-.?=&;]|$)` +
    (BLOQUEIO_EXTRA_SRC ? `|${BLOQUEIO_EXTRA_SRC}` : ''),
  'i',
);
// ...e textos de botões/links que o script nunca clica.
const BLOQUEIO_TEXTO_SRC =
  String.raw`\b(sair|logout|log\s?out|sign\s?out|deslogar|encerrar\s+sess|excluir|apagar|remover|deletar|delete|remove|destroy|cancelar|cancel|desativar|deactivate|descadastrar|unsubscribe|confirmar|confirm|enviar|submit|salvar|save|pagar|pay|comprar|buy|finalizar|checkout|publicar|publish|aprovar|approve|rejeitar|reject|bloquear|block|reset|redefinir|limpar|clear|arquivar|archive|transferir|transfer|sacar|withdraw|denunciar|adicionar|add|criar|create)\b` +
  (BLOQUEIO_EXTRA_SRC ? `|${BLOQUEIO_EXTRA_SRC}` : '');

const EXT_ARQUIVO =
  /\.(pdf|zip|rar|7z|gz|tgz|tar|bz2|xz|docx?|xlsx?|pptx?|odt|ods|odp|csv|tsv|rtf|epub|mobi|exe|msi|dmg|pkg|apk|iso|jpe?g|png|gif|webp|avif|bmp|tiff?|ico|svg|mp3|wav|ogg|m4a|flac|aac|mp4|m4v|webm|mov|avi|mkv|wmv|woff2?|ttf|otf|eot|js|mjs|css|map|json|xml|rss|atom|txt)$/i;

const INCLUIR = (opt.incluir || []).map((r) => new RegExp(r, 'i'));
const EXCLUIR = (opt.excluir || []).map((r) => new RegExp(r, 'i'));

// ----------------------------------------------------------------------------
//  Estado global
// ----------------------------------------------------------------------------
const S = {
  inicio: Date.now(),
  fila: [],
  enfileiradas: new Set(),
  capturadas: new Set(),
  variantes: new Map(),
  arquivosFeitos: new Set(),
  contadores: {
    paginas: 0, recursos: 0, bytes: 0, scripts: 0, folhas: 0, mapas: 0,
    originais: 0, formatados: 0, pulados: 0, bloqueadas: 0, erros: 0,
  },
  emAndamento: 0,
  parando: false,
  redeArquivos: new Map(),
  fontesSalvas: new Map(),
  hashesInline: new Map(),
  mapasFeitos: new Set(),
  seg: new Map(),
  certs: new Map(),
  mixed: [],
  apps: new Map(),
  hosts: new Set(),
  bloqueados: [],
  descobertasPopup: [],
  paginasProprias: new Set(),
  criandoPaginas: 0,
  guardaPopups: false,
  paginasLH: [],
  lighthouse: [],
  ultimaUrlPorOrigem: new Map(),
  avisouSessao: false,
};

let browser = null;
let context = null;
let chromeProc = null;
let chromePorta = 0;
let UA = '';

// ----------------------------------------------------------------------------
//  Utilidades
// ----------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const agora = () => new Date().toISOString();
const sha = (d, n = 8) => crypto.createHash('sha1').update(d).digest('hex').slice(0, n);
const sha256 = (d) => crypto.createHash('sha256').update(d).digest('hex');
const semHash = (u) => String(u).replace(/#.*$/, '');

const TTY = process.stdout.isTTY;
const cor = (n, s) => (TTY ? `\x1b[${n}m${s}\x1b[0m` : s);
const log = {
  info: (...a) => console.log(...a),
  ok: (...a) => console.log(cor(32, 'OK   '), ...a),
  aviso: (...a) => console.warn(cor(33, 'AVISO'), ...a),
  erro: (...a) => console.error(cor(31, 'ERRO '), ...a),
  fraco: (...a) => console.log(cor(90, a.join(' '))),
};

function limitador(n) {
  let ativos = 0;
  const fila = [];
  const prox = () => {
    if (ativos >= n || !fila.length) return;
    ativos++;
    const { fn, res, rej } = fila.shift();
    Promise.resolve()
      .then(fn)
      .then(res, rej)
      .finally(() => {
        ativos--;
        prox();
      });
  };
  return (fn) =>
    new Promise((res, rej) => {
      fila.push({ fn, res, rej });
      prox();
    });
}

function comTempo(promessa, ms, msg) {
  let t;
  const limite = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error(msg)), ms);
  });
  return Promise.race([promessa, limite]).finally(() => clearTimeout(t));
}

function registrarErro(url, etapa, e) {
  const msg = String(e && e.message ? e.message : e).split('\n')[0];
  S.contadores.erros++;
  log.aviso(`${etapa}: ${url}: ${msg}`);
  fsp
    .appendFile(ARQ_ERROS, JSON.stringify({ url, etapa, mensagem: msg, em: agora() }) + '\n')
    .catch(() => {});
}

// ----------------------------------------------------------------------------
//  Caminhos de arquivo (seguros para Windows, macOS e Linux)
// ----------------------------------------------------------------------------
const RESERVADOS_WIN = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

function decodeSeg(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function segSeguro(s, max = 80) {
  let r = String(s).normalize('NFC').replace(/[<>:"\\|?*\x00-\x1f\x7f]/g, '_').replace(/\//g, '_');
  r = r.replace(/[. ]+$/g, '');
  if (r === '') r = '_';
  if (RESERVADOS_WIN.test(r)) r = '_' + r;
  if (r.length > max) {
    const ext = path.extname(r).slice(0, 12);
    r = r.slice(0, Math.max(8, max - ext.length - 8)) + '~' + sha(r, 6) + ext;
  }
  return r;
}

const MIME_EXT = {
  'text/html': '.html', 'application/xhtml+xml': '.xhtml', 'text/css': '.css',
  'text/javascript': '.js', 'application/javascript': '.js', 'application/x-javascript': '.js',
  'application/json': '.json', 'application/ld+json': '.json',
  'application/manifest+json': '.webmanifest', 'application/xml': '.xml', 'text/xml': '.xml',
  'text/plain': '.txt', 'text/csv': '.csv', 'image/png': '.png', 'image/jpeg': '.jpg',
  'image/gif': '.gif', 'image/webp': '.webp', 'image/avif': '.avif', 'image/svg+xml': '.svg',
  'image/x-icon': '.ico', 'image/vnd.microsoft.icon': '.ico', 'font/woff2': '.woff2',
  'font/woff': '.woff', 'font/ttf': '.ttf', 'font/otf': '.otf', 'application/font-woff': '.woff',
  'application/pdf': '.pdf', 'application/zip': '.zip', 'application/wasm': '.wasm',
  'video/mp4': '.mp4', 'video/webm': '.webm', 'audio/mpeg': '.mp3', 'audio/ogg': '.ogg',
  'audio/wav': '.wav', 'application/octet-stream': '',
};
function extPorMime(m) {
  if (!m) return '';
  m = m.toLowerCase();
  if (MIME_EXT[m] !== undefined) return MIME_EXT[m];
  if (/\+json$/.test(m)) return '.json';
  if (/\+xml$/.test(m)) return '.xml';
  if (/^text\//.test(m)) return '.txt';
  return '';
}

function slugQuery(trecho) {
  const bruto = decodeSeg(trecho.replace(/^[?#]/, ''));
  const leg = bruto.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32);
  return (leg ? leg + '-' : '') + sha(trecho, 6);
}

// URL de um recurso -> [host, ...pastas, arquivo]
function relDeUrl(urlStr, { metodo = 'GET', postData = null, mime = '' } = {}) {
  const u = new URL(urlStr);
  const host = segSeguro(u.host.replace(':', '_'));
  const partes = u.pathname.split('/').filter(Boolean).map((p) => segSeguro(decodeSeg(p)));
  const ehDir = u.pathname.endsWith('/') || partes.length === 0;
  let arq = ehDir ? 'index' : partes.pop();
  if (!path.extname(arq)) arq += extPorMime(mime);
  const ext = path.extname(arq);
  let base = arq.slice(0, arq.length - ext.length);
  if (u.search) base += '__q-' + slugQuery(u.search);
  if (metodo !== 'GET') base += `__${metodo.toLowerCase()}-` + sha(postData ? Buffer.from(postData) : '', 8);
  return [host, ...partes, segSeguro(base + ext, 120)];
}

// URL de uma página -> { host, dirs, nome }   (Elementos/<host>/<dirs>/<nome>/<nome>.html)
function relPagina(urlStr) {
  const u = new URL(urlStr);
  const host = segSeguro(u.host.replace(':', '_'));
  const partes = u.pathname.split('/').filter(Boolean).map((p) => segSeguro(decodeSeg(p)));
  let nome;
  if (u.pathname.endsWith('/') || partes.length === 0) nome = 'index';
  else nome = partes.pop().replace(/\.(html?|xhtml|php\d?|aspx?|jsp|cfm|cgi|shtml)$/i, '') || 'index';
  if (u.search) nome += '__q-' + slugQuery(u.search);
  if (/^#!?\//.test(u.hash)) nome += '__h-' + slugQuery(u.hash);
  return { host, dirs: partes, nome: segSeguro(nome, 100) };
}
const dirDaPagina = (rp) => [rp.host, ...rp.dirs, rp.nome].join('/');

// Reserva um caminho para uma "chave" (quem é o dono). Colisões de nome
// (inclusive diferença só de maiúsculas/minúsculas) ganham um sufixo.
const donos = new Map();
function comSufixo(rel, suf) {
  const ext = path.posix.extname(rel);
  return rel.slice(0, rel.length - ext.length) + suf + ext;
}
function limitarCaminho(rel) {
  const orcamento = Math.max(60, LIMITE_CAMINHO - OUT_DIR.length - 1);
  if (rel.length <= orcamento) return rel;
  const segs = rel.split('/');
  const arq = segs.pop();
  const enc = (s, n) => (s.length <= n ? s : s.slice(0, n - 8) + '~' + sha(s, 6));
  const novo = [...segs.map((s) => enc(s, 28)), enc(arq, 48)].join('/');
  if (novo.length <= orcamento) return novo;
  return [segs[0] || '_', '_longos', sha(rel, 12) + '__' + enc(arq, 30)].join('/');
}
function reservar(rel, chave) {
  rel = limitarCaminho(rel);
  let tentativa = rel;
  for (let i = 1; ; i++) {
    const k = tentativa.toLowerCase();
    const dono = donos.get(k);
    if (dono === undefined) {
      donos.set(k, chave);
      return tentativa;
    }
    if (dono === chave) return tentativa;
    tentativa = comSufixo(rel, '__c' + sha(chave + i, 6));
  }
}

const absDe = (rel) => path.join(OUT_DIR, ...rel.split('/'));
async function gravar(rel, dados) {
  try {
    await fsp.mkdir(path.dirname(absDe(rel)), { recursive: true });
    await fsp.writeFile(absDe(rel), dados);
    return rel;
  } catch (e) {
    if (['ENOTDIR', 'EEXIST', 'EISDIR', 'ENAMETOOLONG', 'EINVAL', 'ENOENT'].includes(e.code)) {
      const alt = `_conflitos/${sha(rel, 10)}__${segSeguro(path.posix.basename(rel), 60)}`;
      await fsp.mkdir(path.dirname(absDe(alt)), { recursive: true });
      await fsp.writeFile(absDe(alt), dados);
      return alt;
    }
    throw e;
  }
}
const gravarJson = (rel, obj) => gravar(reservar(rel, 'json:' + rel), JSON.stringify(obj, null, 2));

// ----------------------------------------------------------------------------
//  Escopo e fila de URLs
// ----------------------------------------------------------------------------
const ehIpOuLocal = (h) => net.isIP(h) !== 0 || h === 'localhost' || h.endsWith('.localhost');
const SLDS = new Set([
  'com', 'co', 'org', 'net', 'gov', 'edu', 'ac', 'mil', 'nom', 'ind', 'adv', 'art', 'blog', 'eco',
  'esp', 'far', 'fm', 'fot', 'jus', 'leg', 'mus', 'not', 'ppg', 'psi', 'qsl', 'rec', 'srv', 'tmp',
  'tur', 'tv', 'vet', 'zlg', 'med', 'eng', 'arq', 'bio', 'inf', 'jor', 'mat', 'pro', 'wiki',
]);
function dominioBase(h) {
  if (ehIpOuLocal(h)) return h;
  const p = h.split('.');
  if (p.length <= 2) return h;
  if (p[p.length - 1].length === 2 && SLDS.has(p[p.length - 2])) return p.slice(-3).join('.');
  return p.slice(-2).join('.');
}
const BASE0 = ehIpOuLocal(U0.hostname) ? U0.host : dominioBase(U0.hostname);
const semWww = (h) => h.replace(/^www\./, '');

function noEscopo(u) {
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (ehIpOuLocal(U0.hostname)) return u.host === U0.host;
  if (opt.escopo === 'host') return semWww(u.hostname) === semWww(U0.hostname);
  return dominioBase(u.hostname) === BASE0;
}

const RASTREIO = /^(utm_[a-z]+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|_ga|_gl|igshid|yclid)$/i;
function normalizarUrl(href, base) {
  let u;
  try {
    u = new URL(href, base);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  u.username = '';
  u.password = '';
  if (!/^#!?\//.test(u.hash)) u.hash = '';
  for (const k of [...u.searchParams.keys()]) if (RASTREIO.test(k)) u.searchParams.delete(k);
  return u.href;
}

function enfileirar(href, base, prof) {
  const url = normalizarUrl(href, base);
  if (!url) return false;
  const u = new URL(url);
  if (!noEscopo(u)) return false;
  if (BLOQUEIO_URL.test(decodeSeg(u.pathname) + u.search)) {
    S.contadores.bloqueadas++;
    return false;
  }
  if (INCLUIR.length && !INCLUIR.some((r) => r.test(url))) return false;
  if (EXCLUIR.some((r) => r.test(url))) return false;
  if (S.enfileiradas.has(url) || S.capturadas.has(url)) return false;
  if (MAX_PROF && prof > MAX_PROF) return false;
  if (u.search) {
    const k = u.origin + u.pathname;
    const n = S.variantes.get(k) || 0;
    if (MAX_VARIANTES && n >= MAX_VARIANTES) return false;
    S.variantes.set(k, n + 1);
  }
  S.enfileiradas.add(url);
  if (EXT_ARQUIVO.test(u.pathname)) {
    agendarArquivo(url);
    return true;
  }
  S.fila.push({ url, prof });
  return true;
}

// ----------------------------------------------------------------------------
//  Downloads "por fora" (robots, sitemaps, PDFs, source maps…) usando a sessão
//  do navegador (os cookies do login valem aqui também)
// ----------------------------------------------------------------------------
async function buscar(url) {
  let ultimo;
  for (let i = 0; i < 2; i++) {
    try {
      const res = await context.request.get(url, {
        timeout: 60000,
        maxRedirects: 10,
        ignoreHTTPSErrors: true,
        failOnStatusCode: false,
        ...(UA ? { headers: { 'user-agent': UA } } : {}),
      });
      const corpo = await res.body();
      return { status: res.status(), headers: res.headers(), corpo, urlFinal: res.url() };
    } catch (e) {
      ultimo = e;
      await sleep(400);
    }
  }
  throw ultimo;
}

// Grava um corpo de resposta em Rede/<host>/<caminho> (sem duplicar o que já foi salvo)
async function salvarCorpo(url, metodo, postData, mime, corpo, meta = {}) {
  const chave = `${metodo} ${url} ${postData && postData.length ? sha(postData, 10) : ''}`;
  const h = sha256(corpo);
  const anterior = S.redeArquivos.get(chave);
  if (anterior && anterior.sha === h) return anterior.rel;
  const rel0 = ['Rede', ...relDeUrl(url, { metodo, postData, mime })].join('/');
  const rel = reservar(
    anterior ? comSufixo(rel0, '__v-' + h.slice(0, 8)) : rel0,
    anterior ? `${chave}#${h.slice(0, 8)}` : chave,
  );
  const final = await gravar(rel, corpo);
  S.redeArquivos.set(chave, { rel: final, sha: h });
  S.contadores.recursos++;
  S.contadores.bytes += corpo.length;
  fsp
    .appendFile(
      path.join(OUT_DIR, 'Rede', '_arquivos.jsonl'),
      JSON.stringify({ url, metodo, status: meta.status, mime, arquivo: final, bytes: corpo.length, sha256: h }) + '\n',
    )
    .catch(() => {});
  return final;
}

const limArquivos = limitador(4);
const arquivosPend = new Set();
function agendarArquivo(url) {
  if (S.arquivosFeitos.has(url)) return;
  S.arquivosFeitos.add(url);
  const p = limArquivos(() => baixarArquivo(url))
    .catch((e) => registrarErro(url, 'arquivo', e))
    .finally(() => arquivosPend.delete(p));
  arquivosPend.add(p);
}
async function baixarArquivo(url) {
  const r = await buscar(url);
  if (r.status >= 400) throw new Error('HTTP ' + r.status);
  if (MAX_BYTES && r.corpo.length > MAX_BYTES) {
    S.contadores.pulados++;
    return;
  }
  const mime = (r.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  await salvarCorpo(url, 'GET', null, mime, r.corpo, { status: r.status });
}

// ----------------------------------------------------------------------------
//  Chrome: localizar, abrir com porta de depuração, conectar
// ----------------------------------------------------------------------------
function noPath(nome) {
  for (const d of (process.env.PATH || '').split(path.delimiter)) {
    const p = path.join(d, nome);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {}
  }
  return null;
}

function achaChrome() {
  if (opt.chrome) return opt.chrome;
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const cand = [];
  if (process.platform === 'win32') {
    const bases = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean);
    for (const b of bases) {
      cand.push(
        path.join(b, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(b, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(b, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
        path.join(b, 'Chromium', 'Application', 'chrome.exe'),
      );
    }
  } else if (process.platform === 'darwin') {
    cand.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    );
  } else {
    for (const n of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'microsoft-edge-stable', 'brave-browser']) {
      const p = noPath(n);
      if (p) cand.push(p);
    }
    cand.push('/usr/bin/google-chrome', '/usr/bin/chromium', '/snap/bin/chromium');
  }
  try {
    cand.push(chromium.executablePath()); // Chromium do Playwright, se tiver sido instalado
  } catch {}
  return cand.find((p) => p && fs.existsSync(p));
}

function portaLivre() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.unref();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
}

async function iniciarChrome() {
  const exe = achaChrome();
  if (!exe) {
    throw new Error('Não encontrei Chrome/Chromium/Edge. Instale o Google Chrome ou informe o executável com --chrome "<caminho>".');
  }
  chromePorta = opt.porta ? NUM(opt.porta, 0) : await portaLivre();
  const perfil = path.resolve(
    opt.perfil || path.join(os.homedir(), '.capturar-site', 'perfis', segSeguro(U0.host.replace(':', '_'))),
  );
  if (opt['perfil-limpo']) await fsp.rm(perfil, { recursive: true, force: true });
  await fsp.mkdir(perfil, { recursive: true });
  const args = [
    `--remote-debugging-port=${chromePorta}`,
    `--user-data-dir=${perfil}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--window-size=1440,900',
  ];
  if (opt.headless) args.push('--headless=new');
  if (opt['ignorar-ssl']) args.push('--ignore-certificate-errors');
  if (process.platform === 'darwin') args.push('--use-mock-keychain');
  if (process.platform === 'linux') args.push('--password-store=basic');
  const ehRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  if (ehRoot || opt['sem-sandbox']) args.push('--no-sandbox');
  args.push('about:blank');

  log.fraco(`Navegador: ${exe}`);
  log.fraco(`Perfil:    ${perfil}`);
  let saiu = null;
  chromeProc = spawn(exe, args, { stdio: 'ignore' });
  chromeProc.on('exit', (code, sinal) => (saiu = { code, sinal }));
  chromeProc.on('error', (e) => (saiu = { erro: e.message }));

  const t0 = Date.now();
  for (;;) {
    if (saiu) {
      throw new Error(
        `O navegador encerrou logo ao abrir (${JSON.stringify(saiu)}). Se o perfil "${perfil}" estiver aberto em outra janela do Chrome, feche-a e tente de novo.`,
      );
    }
    try {
      const r = await fetch(`http://127.0.0.1:${chromePorta}/json/version`);
      if (r.ok) break;
    } catch {}
    if (Date.now() - t0 > 30000) throw new Error('Tempo esgotado esperando a porta de depuração do navegador.');
    await sleep(250);
  }
}

async function fecharChrome() {
  try {
    if (browser) {
      const s = await browser.newBrowserCDPSession();
      await s.send('Browser.close').catch(() => {});
    }
  } catch {}
  if (chromeProc && chromeProc.exitCode === null) {
    await Promise.race([new Promise((r) => chromeProc.once('exit', r)), sleep(8000)]);
    try {
      chromeProc.kill();
    } catch {}
  }
}

// ----------------------------------------------------------------------------
//  Funções que rodam DENTRO da página (precisam ser autocontidas)
// ----------------------------------------------------------------------------

// DOM renderizado (como a aba Elementos), incluindo shadow DOM aberto.
function serializarDOM() {
  /* __capturar__ */
  const dt = document.doctype;
  const prefixo = dt
    ? `<!DOCTYPE ${dt.name}${dt.publicId ? ` PUBLIC "${dt.publicId}"` : dt.systemId ? ' SYSTEM' : ''}${dt.systemId ? ` "${dt.systemId}"` : ''}>\n`
    : '';
  const inerte = document.implementation.createHTMLDocument('');
  const clonar = (no) => {
    const c = inerte.importNode(no, false);
    if (no.nodeType !== 1) return c;
    const sr = no.shadowRoot;
    if (sr) {
      const tpl = inerte.createElement('template');
      tpl.setAttribute('shadowrootmode', sr.mode);
      if (sr.delegatesFocus) tpl.setAttribute('shadowrootdelegatesfocus', '');
      for (const f of sr.childNodes) tpl.content.appendChild(clonar(f));
      c.appendChild(tpl);
    }
    const ehTemplate = no.localName === 'template' && no.namespaceURI === 'http://www.w3.org/1999/xhtml';
    const origem = ehTemplate ? no.content : no;
    const destino = ehTemplate ? c.content : c;
    for (const f of origem.childNodes) destino.appendChild(clonar(f));
    return c;
  };
  return prefixo + clonar(document.documentElement).outerHTML;
}

function coletarLinks() {
  /* __capturar__ */
  const saida = new Set();
  const base = document.baseURI;
  const visitar = (raiz) => {
    raiz
      .querySelectorAll(
        'a[href], area[href], link[rel~="next"][href], link[rel~="prev"][href], link[rel="canonical"][href], iframe[src], frame[src]',
      )
      .forEach((el) => {
        const bruto = el.getAttribute('href') || el.getAttribute('src');
        if (!bruto) return;
        try {
          saida.add(new URL(bruto, base).href);
        } catch {}
      });
    raiz.querySelectorAll('*').forEach((el) => {
      if (el.shadowRoot) visitar(el.shadowRoot);
    });
  };
  visitar(document);
  return [...saida];
}

function lerStorages() {
  /* __capturar__ */
  const ler = (get) => {
    try {
      const s = get();
      const o = {};
      for (let i = 0; i < s.length; i++) {
        const k = s.key(i);
        o[k] = s.getItem(k);
      }
      return o;
    } catch (e) {
      return { __erro: String(e) };
    }
  };
  return { origem: location.origin, local: ler(() => window.localStorage), sessao: ler(() => window.sessionStorage) };
}

// Elementos "seguros" para clicar: abas, menus, acordeões, "ver mais"…
function coletarCandidatos({ bloqueio }) {
  /* __capturar__ */
  const reBloq = new RegExp(bloqueio, 'i');
  const reMais =
    /\b(ver|mostrar|exibir|carregar|abrir|expandir|ler)\s+(mais|tudo|todos|todas|completo|menos)\b|\b(mais|more)\b|\b(load|show|see|view|read)\s+(more|all|less)\b|\bexpand\b|\bmenu\b/i;
  const ALTERNA =
    'summary, [role="tab"], [data-bs-toggle], [data-toggle], [aria-expanded], [aria-haspopup]:not([aria-haspopup="false"])';
  const todos = [];
  const coletar = (raiz) => {
    raiz
      .querySelectorAll(
        'summary, [role="tab"], [data-bs-toggle], [data-toggle], [aria-expanded="false"], [aria-haspopup]:not([aria-haspopup="false"]), button, [role="button"], a[href="#"], a[href^="javascript:"], a:not([href])',
      )
      .forEach((el) => todos.push(el));
    raiz.querySelectorAll('*').forEach((el) => {
      if (el.shadowRoot) coletar(el.shadowRoot);
    });
  };
  coletar(document);
  const saida = [];
  let i = 0;
  for (const el of todos) {
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
    const tag = el.localName;
    if (tag === 'input' || tag === 'select' || tag === 'textarea') continue;
    const tipo = (el.getAttribute('type') || '').toLowerCase();
    const alterna = el.matches(ALTERNA);
    if (tag === 'button' && (tipo === 'submit' || tipo === 'reset')) continue;
    if (el.closest('form') && tag !== 'summary' && !(tipo === 'button' && alterna)) continue;
    if (tag === 'a') {
      const h = el.getAttribute('href');
      if (h && !/^(#|javascript:)/i.test(h)) continue;
    }
    if (el.hasAttribute('download') || el.getAttribute('target') === '_blank') continue;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (cs.visibility === 'hidden' || cs.display === 'none' || (r.width === 0 && r.height === 0)) continue;
    const rotulo = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || el.value || '')
      .trim()
      .replace(/\s+/g, ' ')
      .slice(0, 80);
    const alvo = [
      rotulo, el.getAttribute('aria-label'), el.getAttribute('title'), el.id,
      typeof el.className === 'string' ? el.className : '', el.getAttribute('name'),
      el.getAttribute('data-action'), el.getAttribute('onclick'), el.getAttribute('formaction'),
    ]
      .filter(Boolean)
      .join(' ');
    if (reBloq.test(alvo)) continue;
    if (!alterna && !reMais.test(rotulo)) continue;
    if (alterna && el.getAttribute('aria-expanded') === 'true') continue;
    const sig = [tag, el.getAttribute('role') || '', rotulo, el.getAttribute('aria-controls') || '', el.id || ''].join('|');
    el.setAttribute('data-capturar-click', String(i));
    saida.push({ i, sig, rotulo });
    i++;
  }
  return saida;
}

function limparMarcas() {
  /* __capturar__ */
  document.querySelectorAll('[data-capturar-click]').forEach((e) => e.removeAttribute('data-capturar-click'));
}

// IndexedDB inteiro -> JSON (com marcadores para Date, Blob, ArrayBuffer, Map, Set…)
async function dumpIDB({ max }) {
  /* __capturar__ */
  const LIM = 1048576;
  const paraB64 = (u8) => {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const bytes = (u8) => {
    const corte = u8.length > LIM;
    return { bytes: u8.length, base64: paraB64(corte ? u8.subarray(0, LIM) : u8), truncado: corte };
  };
  const ser = async (v, pilha = [], prof = 0) => {
    if (v === undefined) return { $undefined: true };
    if (v === null) return null;
    const t = typeof v;
    if (t === 'string' || t === 'boolean') return v;
    if (t === 'number') return Number.isFinite(v) ? v : { $numero: String(v) };
    if (t === 'bigint') return { $bigint: v.toString() };
    if (t === 'function' || t === 'symbol') return { $nao_serializavel: t };
    if (prof > 40) return { $profundidade_maxima: true };
    if (pilha.includes(v)) return { $ciclo: true };
    if (v instanceof Date) return { $data: isNaN(v) ? 'Invalid Date' : v.toISOString() };
    if (v instanceof RegExp) return { $regexp: String(v) };
    if (v instanceof Blob) {
      return { $blob: { tipo: v.type, nome: v.name || undefined, ...bytes(new Uint8Array(await v.arrayBuffer())) } };
    }
    if (v instanceof ArrayBuffer) return { $bytes: { tipo: 'ArrayBuffer', ...bytes(new Uint8Array(v)) } };
    if (ArrayBuffer.isView(v)) {
      return { $bytes: { tipo: v.constructor.name, ...bytes(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) } };
    }
    if (v instanceof Error) return { $erro: { nome: v.name, mensagem: v.message, pilha: v.stack } };
    pilha = [...pilha, v];
    if (v instanceof Map) {
      const o = [];
      for (const [k, x] of v) o.push([await ser(k, pilha, prof + 1), await ser(x, pilha, prof + 1)]);
      return { $map: o };
    }
    if (v instanceof Set) {
      const o = [];
      for (const x of v) o.push(await ser(x, pilha, prof + 1));
      return { $set: o };
    }
    if (Array.isArray(v)) {
      const o = [];
      for (const x of v) o.push(await ser(x, pilha, prof + 1));
      return o;
    }
    const o = {};
    for (const k of Object.keys(v)) o[k] = await ser(v[k], pilha, prof + 1);
    return o;
  };
  const pedir = (rq) =>
    new Promise((res, rej) => {
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    });

  let lista = [];
  try {
    lista = indexedDB.databases ? await indexedDB.databases() : [];
  } catch {}
  const saida = [];
  for (const info of lista) {
    const reg = { nome: info.name, versao: info.version, stores: [] };
    try {
      const db = await new Promise((res, rej) => {
        const r = indexedDB.open(info.name);
        const t = setTimeout(() => rej(new Error('tempo esgotado ao abrir')), 8000);
        r.onsuccess = () => {
          clearTimeout(t);
          res(r.result);
        };
        r.onerror = () => {
          clearTimeout(t);
          rej(r.error);
        };
        r.onupgradeneeded = () => r.transaction.abort(); // nunca criar/alterar nada
      });
      reg.versao = db.version;
      for (const nome of Array.from(db.objectStoreNames)) {
        const store = db.transaction(nome, 'readonly').objectStore(nome);
        const [total, chaves, valores] = await Promise.all([
          pedir(store.count()),
          pedir(store.getAllKeys(undefined, max)),
          pedir(store.getAll(undefined, max)),
        ]);
        const indices = Array.from(store.indexNames).map((n) => {
          const ix = store.index(n);
          return { nome: n, keyPath: ix.keyPath, unico: ix.unique, multiEntry: ix.multiEntry };
        });
        const registros = [];
        for (let i = 0; i < valores.length; i++) registros.push({ chave: await ser(chaves[i]), valor: await ser(valores[i]) });
        reg.stores.push({
          nome, keyPath: store.keyPath, autoIncrement: store.autoIncrement, indices, total, registros,
          truncado: total > registros.length,
        });
      }
      db.close();
    } catch (e) {
      reg.erro = String((e && e.message) || e);
    }
    saida.push(reg);
  }
  return saida;
}

async function lerSW() {
  /* __capturar__ */
  if (!('serviceWorker' in navigator)) return [];
  const regs = await navigator.serviceWorker.getRegistrations();
  return regs.map((r) => ({
    escopo: r.scope,
    updateViaCache: r.updateViaCache,
    instalando: r.installing ? r.installing.scriptURL : null,
    aguardando: r.waiting ? r.waiting.scriptURL : null,
    ativo: r.active ? { scriptURL: r.active.scriptURL, estado: r.active.state } : null,
  }));
}

// ----------------------------------------------------------------------------
//  Abas de trabalho
// ----------------------------------------------------------------------------

// Rede de segurança no navegador: aborta o que alteraria dados ou encerraria a sessão.
async function rotaSegura(route) {
  const req = route.request();
  const m = req.method();
  let motivo = null;
  if (m === 'DELETE' || m === 'PUT' || m === 'PATCH') motivo = `método ${m}`;
  else if (req.isNavigationRequest() && m !== 'GET' && m !== 'HEAD') motivo = 'envio de formulário';
  else {
    try {
      const u = new URL(req.url());
      if (BLOQUEIO_URL.test(decodeSeg(u.pathname) + u.search)) motivo = 'URL na lista de bloqueio';
    } catch {}
  }
  if (motivo) {
    S.contadores.bloqueadas++;
    if (S.bloqueados.length < 2000) S.bloqueados.push({ url: req.url(), metodo: m, motivo });
    return route.abort('blockedbyclient').catch(() => {});
  }
  return route.continue().catch(() => {});
}

async function criarAba() {
  S.criandoPaginas++;
  let page;
  try {
    page = await context.newPage();
    S.paginasProprias.add(page);
  } finally {
    S.criandoPaginas--;
  }
  page.setDefaultTimeout(30000);
  page.on('dialog', (d) => (d.type() === 'beforeunload' ? d.accept() : d.dismiss()).catch(() => {}));
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable').catch(() => {});
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true }).catch(() => {}); // "Desativar cache" do DevTools
  if (!opt['usar-sw']) await cdp.send('Network.setBypassServiceWorker', { bypass: true }).catch(() => {});
  await cdp.send('Debugger.enable');
  await cdp.send('Debugger.setSkipAllPauses', { skip: true }); // ignora "debugger;" que alguns sites usam contra o DevTools
  await cdp.send('DOM.enable');
  await cdp.send('CSS.enable');
  if (!opt['permitir-escrita']) await page.route('**/*', rotaSegura);
  return { page, cdp };
}

// ----------------------------------------------------------------------------
//  Captura de UMA página
// ----------------------------------------------------------------------------
const limCorpos = limitador(10);

function novaCaptura(url) {
  return {
    url, inicio: Date.now(), reqs: new Map(), pendentes: new Set(), fontesPend: [],
    scripts: [], css: [], console: [], ws: [], sse: [], descobertas: [], docUrls: new Set(),
  };
}

function serPayload(p) {
  if (typeof p === 'string') return p.length > 1048576 ? p.slice(0, 1048576) + '…[truncado]' : p;
  return { base64: Buffer.from(p).subarray(0, 1048576).toString('base64') };
}

function anexar(page, cdp, cap) {
  const desfazer = [];
  const on = (alvo, ev, fn) => {
    alvo.on(ev, fn);
    desfazer.push(() => {
      try {
        alvo.off(ev, fn);
      } catch {}
    });
  };

  // --- Rede ---
  on(page, 'request', (req) => {
    cap.reqs.set(req, { req, inicio: new Date(), t0: Date.now() });
    if (req.resourceType() === 'document') cap.docUrls.add(semHash(req.url()));
  });
  on(page, 'requestfinished', (req) => {
    const r = cap.reqs.get(req);
    if (!r) return;
    r.fim = true;
    try {
      r.timing = req.timing();
    } catch {}
  });
  on(page, 'requestfailed', (req) => {
    const r = cap.reqs.get(req);
    if (r) r.falha = (req.failure() || {}).errorText || 'falhou';
  });
  on(page, 'response', (res) => {
    const req = res.request();
    let r = cap.reqs.get(req);
    if (!r) {
      r = { req, inicio: new Date(), t0: Date.now() };
      cap.reqs.set(req, r);
    }
    r.res = res;
    const p = limCorpos(() => salvarResposta(cap, r))
      .catch((e) => {
        r.nota = 'erro ao salvar: ' + String(e.message).split('\n')[0];
      })
      .finally(() => cap.pendentes.delete(p));
    cap.pendentes.add(p);
  });

  // --- Console ---
  on(page, 'console', (m) => {
    const l = m.location();
    cap.console.push({
      t: agora(), tipo: m.type(), texto: m.text(),
      local: l && l.url ? `${l.url}:${l.lineNumber}:${l.columnNumber}` : '',
    });
    if (/mixed content/i.test(m.text())) S.mixed.push({ pagina: cap.url, texto: m.text() });
  });
  on(page, 'pageerror', (e) => {
    cap.console.push({ t: agora(), tipo: 'exceção', texto: (e && e.stack) || String(e), local: '' });
  });

  // --- WebSocket ---
  on(page, 'websocket', (ws) => {
    const w = { url: ws.url(), eventos: [] };
    cap.ws.push(w);
    ws.on('framesent', (f) => w.eventos.push({ t: agora(), dir: 'enviado', dados: serPayload(f.payload) }));
    ws.on('framereceived', (f) => w.eventos.push({ t: agora(), dir: 'recebido', dados: serPayload(f.payload) }));
    ws.on('socketerror', (e) => w.eventos.push({ t: agora(), dir: 'erro', dados: String(e) }));
    ws.on('close', () => w.eventos.push({ t: agora(), dir: 'fechado' }));
  });

  // --- Server-Sent Events (via CDP) ---
  const urlsReq = new Map();
  on(cdp, 'Network.requestWillBeSent', (e) => urlsReq.set(e.requestId, e.request.url));
  on(cdp, 'Network.eventSourceMessageReceived', (e) => {
    cap.sse.push({ t: agora(), url: urlsReq.get(e.requestId) || '', evento: e.eventName, id: e.eventId, dados: e.data });
  });

  // --- Fontes: scripts (Debugger) e folhas de estilo (CSS) ---
  on(cdp, 'Debugger.scriptParsed', (e) => {
    if (e.executionContextAuxData && e.executionContextAuxData.isDefault === false) return; // mundos isolados
    const url = e.url || '';
    if (/^(chrome|devtools|chrome-extension|extensions|debugger):|^__playwright|^pptr:|^v8\//i.test(url)) return;
    if (cap.scripts.length >= 600) return;
    const s = { id: e.scriptId, url, mapa: e.sourceMapURL || '', modulo: !!e.isModule, texto: null };
    cap.scripts.push(s);
    cap.fontesPend.push(
      cdp
        .send('Debugger.getScriptSource', { scriptId: e.scriptId })
        .then((r) => {
          s.texto = r.scriptSource;
        })
        .catch(() => {}),
    );
  });
  on(cdp, 'CSS.styleSheetAdded', ({ header: h }) => {
    if (h.origin !== 'regular') return;
    if (cap.css.length >= 400) return;
    const c = { id: h.styleSheetId, url: h.sourceURL || '', inline: !!h.isInline || !!h.isConstructed, mapa: h.sourceMapURL || '', texto: null };
    cap.css.push(c);
    cap.fontesPend.push(
      cdp
        .send('CSS.getStyleSheetText', { styleSheetId: h.styleSheetId })
        .then((r) => {
          c.texto = r.text;
        })
        .catch(() => {}),
    );
  });

  return () => desfazer.forEach((f) => f());
}

const HEADERS_SEG = [
  'content-security-policy', 'content-security-policy-report-only', 'strict-transport-security',
  'x-frame-options', 'x-content-type-options', 'referrer-policy', 'permissions-policy',
  'cross-origin-opener-policy', 'cross-origin-embedder-policy', 'cross-origin-resource-policy',
  'x-xss-protection',
];

async function coletarSeguranca(res, req, hdrs) {
  const u = new URL(req.url());
  let e = S.seg.get(u.host);
  if (!e) {
    e = { host: u.host, protocolo: u.protocol };
    if (u.protocol === 'https:') {
      try {
        const sd = await res.securityDetails();
        if (sd) e.tls = sd;
      } catch {}
    }
    try {
      const a = await res.serverAddr();
      if (a) e.servidor = a;
    } catch {}
    S.seg.set(u.host, e);
  }
  if (!e.cabecalhos && req.isNavigationRequest()) {
    let topo = false;
    try {
      topo = req.frame().parentFrame() === null;
    } catch {}
    if (topo && res.status() < 400) {
      const presentes = {};
      for (const h of hdrs) if (HEADERS_SEG.includes(h.name.toLowerCase())) presentes[h.name.toLowerCase()] = h.value;
      e.cabecalhos = presentes;
      e.cabecalhosAusentes = HEADERS_SEG.filter((n) => !(n in presentes));
      e.urlDoDocumento = req.url();
    }
  }
}

async function coletarCertificado(cdp, origem) {
  if (!origem.startsWith('https:') || S.certs.has(origem)) return;
  S.certs.set(origem, null);
  try {
    const r = await cdp.send('Network.getCertificate', { origin: origem });
    S.certs.set(
      origem,
      (r.tableNames || []).map((b64) => {
        const x = new X509Certificate(Buffer.from(b64, 'base64'));
        return {
          assunto: x.subject, emissor: x.issuer, validoDe: x.validFrom, validoAte: x.validTo,
          nomesAlternativos: x.subjectAltName, serial: x.serialNumber, sha256: x.fingerprint256, ehAC: x.ca,
        };
      }),
    );
  } catch (e) {
    S.certs.set(origem, { erro: String(e.message || e).split('\n')[0] });
  }
}

// Salva o corpo de UMA resposta de rede
async function salvarResposta(cap, r) {
  const { req, res } = r;
  const url = req.url();
  if (!/^https?:/i.test(url)) return;
  r.metodo = req.method();
  r.status = res.status();
  r.statusTexto = res.statusText();
  r.doSW = res.fromServiceWorker();
  try {
    r.hdrsResp = await res.headersArray();
  } catch {
    r.hdrsResp = Object.entries(res.headers()).map(([name, value]) => ({ name, value }));
  }
  const H = {};
  for (const h of r.hdrsResp) H[h.name.toLowerCase()] = h.value;
  const mime = (H['content-type'] || '').split(';')[0].trim().toLowerCase();
  r.mime = mime;
  try {
    S.hosts.add(new URL(url).host);
    if (EXTRA.seguranca) await coletarSeguranca(res, req, r.hdrsResp);
  } catch {}

  const st = r.status;
  if ((st >= 300 && st < 400) || st === 204 || st === 304 || r.metodo === 'HEAD') return;
  if (mime === 'text/event-stream') {
    r.nota = 'event-stream: corpo não salvo (veja Rede/_eventsource)';
    return;
  }
  if (st === 206) {
    r.nota = 'resposta parcial (206): o arquivo completo é baixado à parte';
    agendarArquivo(url);
    return;
  }
  const cl = Number(H['content-length']);
  if (MAX_BYTES && cl > MAX_BYTES) {
    r.nota = `maior que ${MAX_MB} MB: corpo não salvo`;
    S.contadores.pulados++;
    return;
  }
  let corpo;
  try {
    corpo = await res.body();
  } catch (e) {
    r.nota = 'corpo indisponível (' + String(e.message).split('\n')[0] + ')';
    return;
  }
  if (MAX_BYTES && corpo.length > MAX_BYTES) {
    r.nota = `maior que ${MAX_MB} MB: corpo não salvo`;
    S.contadores.pulados++;
    return;
  }
  r.bytes = corpo.length;
  const post = req.postDataBuffer();
  r.arquivo = await salvarCorpo(url, r.metodo, post, mime, corpo, { status: st });
}

// ----------------------------------------------------------------------------
//  Comportamento "de gente": esperar, rolar, clicar
// ----------------------------------------------------------------------------
async function aguardarEstavel(page) {
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await sleep(ESPERA);
}

async function rolar(page, passos = ROLAGEM) {
  if (!passos) return;
  try {
    await page.evaluate(
      async ({ passos }) => {
        /* __capturar__ */
        await new Promise((resolver) => {
          let y = 0, n = 0, ultima = 0, estavel = 0;
          const passo = () => {
            const h = Math.max(document.body ? document.body.scrollHeight : 0, document.documentElement.scrollHeight);
            window.scrollTo({ top: y, left: 0, behavior: 'instant' });
            y += Math.max(200, Math.floor(window.innerHeight * 0.8));
            estavel = h === ultima ? estavel + 1 : 0;
            ultima = h;
            if (n++ >= passos || (y > h && estavel >= 2)) return resolver();
            setTimeout(passo, 200);
          };
          passo();
        });
        window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
      },
      { passos },
    );
  } catch {
    /* a página mudou durante a rolagem */
  }
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
}

async function interagir(page, cap) {
  const urlBase = page.url();
  const chaveBase = semHash(urlBase);
  const feitos = new Set();
  let total = 0;
  for (let rodada = 0; rodada < 4 && total < MAX_CLIQUES && !S.parando; rodada++) {
    let cands;
    try {
      cands = await page.evaluate(coletarCandidatos, { bloqueio: BLOQUEIO_TEXTO_SRC });
    } catch {
      break;
    }
    cands = cands.filter((c) => !feitos.has(c.sig));
    if (!cands.length) break;
    for (const c of cands) {
      if (total >= MAX_CLIQUES || S.parando) break;
      feitos.add(c.sig);
      const alvo = page.locator(`[data-capturar-click="${c.i}"]`).first();
      try {
        if (!(await alvo.isVisible())) continue;
        await alvo.scrollIntoViewIfNeeded({ timeout: 1500 });
        await alvo.click({ timeout: 2500 });
        total++;
        await sleep(350);
        await page.waitForLoadState('networkidle', { timeout: 2500 }).catch(() => {});
        if (semHash(page.url()) !== chaveBase) {
          // o clique levou para outra página/rota: anota, volta e para de clicar aqui
          cap.descobertas.push(page.url());
          await page.goBack({ timeout: 15000, waitUntil: 'domcontentloaded' }).catch(async () => {
            await page.goto(urlBase, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }).catch(() => {});
          });
          await aguardarEstavel(page);
          return;
        }
      } catch {
        /* elemento sumiu, ficou coberto etc. */
      }
    }
  }
  await page.evaluate(limparMarcas).catch(() => {});
}

async function esperarPendentes(cap) {
  while (cap.pendentes.size) await Promise.allSettled([...cap.pendentes]);
  await Promise.allSettled(cap.fontesPend);
}

function avisarSessao(urlFinal) {
  if (S.avisouSessao) return;
  if (/(login|signin|sign-in|entrar|auth|sso|accounts\.google|login\.microsoftonline)/i.test(urlFinal)) {
    S.avisouSessao = true;
    log.aviso(
      `Uma página foi redirecionada para "${urlFinal}". A sessão pode ter expirado. Se isso aconteceu, interrompa (Ctrl+C), faça login de novo e use --retomar.`,
    );
  }
}

// ----------------------------------------------------------------------------
//  Fontes: arquivos JS/CSS, inline, dinâmicos, source maps e derivados
// ----------------------------------------------------------------------------
let _beautify;
async function carregarBeautify() {
  if (_beautify === undefined) {
    try {
      _beautify = (await import('js-beautify')).default;
    } catch {
      _beautify = null;
      log.aviso('js-beautify não encontrado: sem código formatado (npm install js-beautify).');
    }
  }
  return _beautify;
}

async function derivar(rel, texto, tipo) {
  if (!EXTRA.derivados) return;
  if (texto.length < 2000 || texto.length > MAX_FORMATAR) return;
  if (texto.length / texto.split('\n').length < 160) return; // já está legível
  try {
    const b = await carregarBeautify();
    if (!b) return;
    const formatado =
      tipo === 'css'
        ? b.css(texto, { indent_size: 2 })
        : b.js(texto, { indent_size: 2, preserve_newlines: true, max_preserve_newlines: 2 });
    const relF = reservar('Fontes/_derivados/formatado/' + rel.replace(/^Fontes\//, ''), 'FMT ' + rel);
    await gravar(relF, formatado);
    S.contadores.formatados++;
  } catch {
    /* sem derivado se não der para formatar */
  }
}

function normalizarFonteOriginal(s) {
  let r = decodeSeg(String(s)).replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/{0,3}/, '').replace(/\?.*$/, '');
  const partes = r
    .split('/')
    .map((p) => (p === '..' ? '__acima__' : p))
    .filter((p) => p && p !== '.')
    .map((p) => segSeguro(p, 80));
  return partes.join('/') || '_sem-nome';
}

async function processarMapa(urlBase, ref, relScript) {
  let abs;
  let conteudo;
  try {
    if (/^data:/i.test(ref)) {
      abs = 'data:' + sha(ref, 10);
      if (S.mapasFeitos.has(abs)) return;
      S.mapasFeitos.add(abs);
      const m = ref.match(/^data:[^,]*?(;base64)?,([\s\S]*)$/i);
      if (!m) return;
      conteudo = m[1] ? Buffer.from(m[2], 'base64') : Buffer.from(decodeURIComponent(m[2]), 'utf8');
    } else {
      abs = new URL(ref, urlBase).href;
      if (S.mapasFeitos.has(abs)) return;
      S.mapasFeitos.add(abs);
      const r = await buscar(abs);
      if (r.status !== 200) return;
      conteudo = r.corpo;
      await gravar(reservar(['Fontes', ...relDeUrl(abs, { mime: 'application/json' })].join('/'), 'MAPA ' + abs), conteudo);
    }
    S.contadores.mapas++;
    if (!EXTRA.derivados) return;
    const json = JSON.parse(conteudo.toString('utf8').replace(/^\)\]\}'/, ''));
    const mapas = Array.isArray(json.sections) ? json.sections.map((s) => s.map).filter(Boolean) : [json];
    const raiz = relScript.replace(/^Fontes\//, '');
    for (const m of mapas) {
      const srcs = m.sources || [];
      const conts = m.sourcesContent || [];
      const sr = m.sourceRoot ? m.sourceRoot.replace(/\/?$/, '/') : '';
      for (let i = 0; i < srcs.length; i++) {
        if (typeof conts[i] !== 'string') continue;
        const sp = normalizarFonteOriginal(/^[a-z][a-z0-9+.-]*:/i.test(srcs[i]) ? srcs[i] : sr + srcs[i]);
        if (!EXTRA.nodeModules && /(^|\/)node_modules\//.test(sp)) continue;
        const rel = reservar(`Fontes/_derivados/originais/${raiz}/${sp}`, `ORIG ${abs} ${i}`);
        await gravar(rel, conts[i]);
        S.contadores.originais++;
      }
    }
  } catch (e) {
    registrarErro(abs || ref, 'source-map', e);
  }
}

async function salvarArquivoFonte(url, texto, mime, meta) {
  const buf = Buffer.from(texto, 'utf8');
  const h = sha256(buf);
  const chave = 'FONTE ' + url;
  const anterior = S.fontesSalvas.get(chave);
  if (anterior && anterior.sha === h) return anterior.rel;
  const rel0 = ['Fontes', ...relDeUrl(url, { mime })].join('/');
  const rel = reservar(
    anterior ? comSufixo(rel0, '__v-' + h.slice(0, 8)) : rel0,
    anterior ? `${chave}#${h.slice(0, 8)}` : chave,
  );
  const final = await gravar(rel, buf);
  S.fontesSalvas.set(chave, { rel: final, sha: h });
  if (meta.tipo === 'css') S.contadores.folhas++;
  else S.contadores.scripts++;
  await derivar(final, texto, meta.tipo);
  if (meta.mapa) await processarMapa(url, meta.mapa, final);
  return final;
}

// inline/dinâmico: grava uma única vez por conteúdo (hash), mesmo que apareça em várias páginas
async function salvarUnico(rel, texto) {
  const h = sha256(texto);
  if (S.hashesInline.has(h)) return false;
  const final = await gravar(reservar(rel, 'UNICO ' + h), texto);
  S.hashesInline.set(h, final);
  return true;
}

async function salvarFontes(cap, rp, docUrls) {
  const dir = dirDaPagina(rp);
  const pad = (n) => String(n).padStart(3, '0');
  const saida = { arquivos: 0, inline: 0, dinamicos: 0 };
  let nIn = 0;
  let nDin = 0;
  let nCss = 0;
  for (const s of cap.scripts) {
    if (typeof s.texto !== 'string' || !s.texto.trim() || s.texto.includes('__capturar__')) continue;
    if (!s.url && s.texto.length < 400000 && /UtilityScript|__playwright|PlaywrightInjected/.test(s.texto)) continue;
    try {
      if (/^https?:/i.test(s.url) && !docUrls.has(semHash(s.url))) {
        await salvarArquivoFonte(s.url, s.texto, 'application/javascript', { mapa: s.mapa, tipo: 'js' });
        saida.arquivos++;
      } else if (/^https?:/i.test(s.url)) {
        nIn++;
        if (await salvarUnico(`Fontes/_inline/${dir}/script-${pad(nIn)}.js`, s.texto)) saida.inline++;
      } else if (!s.url) {
        nDin++;
        if (await salvarUnico(`Fontes/_dinamicos/${dir}/script-${pad(nDin)}.js`, s.texto)) saida.dinamicos++;
      } else {
        const esquema = segSeguro(s.url.split(':')[0], 20);
        const nome = segSeguro(s.url.replace(/^[a-z-]+:\/*/i, ''), 100);
        if (await salvarUnico(`Fontes/_outros/${esquema}/${nome}${/\.m?js$/.test(nome) ? '' : '.js'}`, s.texto)) saida.dinamicos++;
      }
    } catch (e) {
      registrarErro(s.url || '(script sem URL)', 'fontes', e);
    }
  }
  for (const c of cap.css) {
    if (typeof c.texto !== 'string' || !c.texto.trim()) continue;
    try {
      if (/^https?:/i.test(c.url) && !c.inline && !docUrls.has(semHash(c.url))) {
        await salvarArquivoFonte(c.url, c.texto, 'text/css', { mapa: c.mapa, tipo: 'css' });
        saida.arquivos++;
      } else {
        nCss++;
        if (await salvarUnico(`Fontes/_inline/${dir}/style-${pad(nCss)}.css`, c.texto)) saida.inline++;
      }
    } catch (e) {
      registrarErro(c.url || '(css inline)', 'fontes', e);
    }
  }
  return saida;
}

// ----------------------------------------------------------------------------
//  HAR (formato da aba Rede -> "Salvar tudo como HAR"), sem corpo embutido:
//  cada entrada aponta para o arquivo salvo em Rede/ pelo campo _arquivo
// ----------------------------------------------------------------------------
async function montarHar(cap, urlFinal, titulo) {
  const entradas = [];
  const recs = [...cap.reqs.values()]
    .filter((r) => /^https?:/i.test(r.req.url()))
    .sort((a, b) => a.t0 - b.t0);
  for (const r of recs) {
    const req = r.req;
    const res = r.res;
    let hdrsReq;
    try {
      hdrsReq = await req.headersArray();
    } catch {
      hdrsReq = Object.entries(req.headers()).map(([name, value]) => ({ name, value }));
    }
    const u = new URL(req.url());
    const post = req.postDataBuffer();
    let tam = {};
    try {
      tam = await req.sizes();
    } catch {}
    const t = r.timing || {};
    const ms = (a, b) => (a >= 0 && b >= 0 ? Math.max(0, b - a) : -1);
    const loc = (r.hdrsResp || []).find((h) => h.name.toLowerCase() === 'location');
    entradas.push({
      pageref: 'pagina_1',
      startedDateTime: r.inicio.toISOString(),
      time: t.responseEnd >= 0 ? t.responseEnd : -1,
      request: {
        method: req.method(), url: req.url(), httpVersion: 'HTTP/1.1', cookies: [], headers: hdrsReq,
        queryString: [...u.searchParams].map(([name, value]) => ({ name, value })),
        headersSize: tam.requestHeadersSize ?? -1,
        bodySize: tam.requestBodySize ?? (post ? post.length : 0),
        ...(post
          ? {
              postData: {
                mimeType: (hdrsReq.find((h) => h.name.toLowerCase() === 'content-type') || {}).value || '',
                text: post.toString('utf8'),
              },
            }
          : {}),
      },
      response: res
        ? {
            status: r.status ?? res.status(), statusText: r.statusTexto || '', httpVersion: 'HTTP/1.1', cookies: [],
            headers: r.hdrsResp || [],
            content: { size: r.bytes ?? -1, mimeType: r.mime || '', _arquivo: r.arquivo, ...(r.nota ? { _nota: r.nota } : {}) },
            redirectURL: loc ? loc.value : '',
            headersSize: tam.responseHeadersSize ?? -1, bodySize: tam.responseBodySize ?? -1,
          }
        : {
            status: 0, statusText: '', httpVersion: 'HTTP/1.1', cookies: [], headers: [],
            content: { size: 0, mimeType: '' }, redirectURL: '', headersSize: -1, bodySize: -1, _falha: r.falha || '',
          },
      cache: {},
      timings: {
        blocked: -1, dns: ms(t.domainLookupStart, t.domainLookupEnd), connect: ms(t.connectStart, t.connectEnd),
        ssl: ms(t.secureConnectionStart, t.connectEnd), send: 0, wait: ms(t.requestStart, t.responseStart),
        receive: ms(t.responseStart, t.responseEnd),
      },
      _tipoRecurso: req.resourceType(),
      _viaServiceWorker: !!r.doSW,
    });
  }
  return {
    log: {
      version: '1.2',
      creator: { name: 'capturar-site', version: VERSAO },
      pages: [{ startedDateTime: new Date(cap.inicio).toISOString(), id: 'pagina_1', title: titulo || urlFinal, pageTimings: { onContentLoad: -1, onLoad: -1 } }],
      entries: entradas,
    },
  };
}

// ----------------------------------------------------------------------------
//  Página: navegar, interagir, colher e gravar tudo
// ----------------------------------------------------------------------------
function registrarApp(stor, urlFinal) {
  if (!stor || !stor.origem || stor.origem === 'null') return;
  const atual = S.apps.get(stor.origem) || { local: {}, sessao: {} };
  Object.assign(atual.local, stor.local);
  Object.assign(atual.sessao, stor.sessao);
  S.apps.set(stor.origem, atual);
  S.ultimaUrlPorOrigem.set(stor.origem, urlFinal);
}

async function processarPagina(w, item, cap, reg) {
  const { page, cdp } = w;

  // 1) navegar (com tentativas)
  let resposta = null;
  let erroNav = null;
  for (let t = 0; t < 3 && !S.parando; t++) {
    try {
      resposta = await page.goto(item.url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
      erroNav = null;
      break;
    } catch (e) {
      erroNav = e;
      if (/Download is starting|ERR_ABORTED|ERR_BLOCKED_BY_CLIENT/.test(e.message)) break;
      await sleep(1000 * (t + 1));
    }
  }
  if (erroNav) {
    if (/Download is starting|ERR_ABORTED/.test(erroNav.message)) {
      agendarArquivo(item.url);
      reg.nota = 'tratada como arquivo/download';
      return;
    }
    if (/ERR_BLOCKED_BY_CLIENT/.test(erroNav.message)) {
      reg.nota = 'bloqueada pela trava de segurança';
      return;
    }
    throw erroNav;
  }
  await page.waitForLoadState('load', { timeout: 30000 }).catch(() => {});
  await aguardarEstavel(page);

  const urlFinal = page.url();
  const ctype = resposta ? resposta.headers()['content-type'] || '' : '';
  reg.status = resposta ? resposta.status() : null;
  reg.urlFinal = urlFinal;
  let uFinal;
  try {
    uFinal = new URL(urlFinal);
  } catch {
    reg.nota = 'URL final inválida';
    return;
  }
  if (!noEscopo(uFinal)) {
    reg.nota = 'redirecionou para fora do escopo';
    avisarSessao(urlFinal);
    await esperarPendentes(cap);
    return;
  }
  const chaveFinal = normalizarUrl(urlFinal);
  if (chaveFinal && chaveFinal !== item.url && S.capturadas.has(chaveFinal)) {
    reg.nota = 'duplicada: redirecionou para uma página já capturada';
    await esperarPendentes(cap);
    S.capturadas.add(item.url);
    return;
  }
  if (!/html|xml/i.test(ctype) && ctype) {
    reg.nota = `não é HTML (${ctype.split(';')[0]}); gravado só em Rede/`;
    await esperarPendentes(cap);
    S.capturadas.add(item.url);
    return;
  }

  // 2) agir como uma pessoa: rolar, abrir abas/menus/"ver mais"
  await rolar(page);
  if (EXTRA.cliques && MAX_CLIQUES > 0) await interagir(page, cap);
  await aguardarEstavel(page);
  if (ROLAGEM) await rolar(page, Math.min(ROLAGEM, 12));

  // 3) colher
  const html = await page.evaluate(serializarDOM);
  const titulo = await page.title().catch(() => '');
  const links = await page.evaluate(coletarLinks).catch(() => []);
  const stor = await page.evaluate(lerStorages).catch(() => null);
  const frames = [];
  for (const f of page.frames()) {
    if (f === page.mainFrame()) continue;
    const fu = f.url();
    if (!/^(https?:|about:srcdoc)/.test(fu)) continue;
    try {
      frames.push({ url: fu, html: await f.evaluate(serializarDOM) });
    } catch {}
  }
  let png = null;
  if (EXTRA.capturas) {
    try {
      png = await page.screenshot({ fullPage: true, timeout: 30000 });
    } catch {
      try {
        png = await page.screenshot({ timeout: 15000 });
      } catch {}
    }
  }
  if (EXTRA.seguranca) await coletarCertificado(cdp, uFinal.origin);
  await esperarPendentes(cap);
  const docUrls = new Set([semHash(urlFinal), ...cap.docUrls, ...page.frames().map((f) => semHash(f.url()))]);

  // 4) gravar
  S.contadores.paginas++;
  const rp = relPagina(urlFinal);
  const dir = dirDaPagina(rp);
  reg.titulo = titulo;
  reg.elementos = await gravar(reservar(`Elementos/${dir}/${rp.nome}.html`, 'EL ' + urlFinal), html);
  for (const [i, f] of frames.entries()) {
    let h = 'frame';
    try {
      h = new URL(f.url).host || 'frame';
    } catch {}
    await gravar(reservar(`Elementos/${dir}/frames/frame-${i + 1}__${segSeguro(h.replace(':', '_'), 40)}.html`, `FR ${urlFinal} ${i}`), f.html);
  }
  reg.frames = frames.length;
  if (png) reg.captura = await gravar(reservar(`Capturas/${dir}.png`, 'CAP ' + urlFinal), png);
  if (EXTRA.console && cap.console.length) {
    const linhas = cap.console.map((c) => `${c.t} [${c.tipo}] ${c.texto}${c.local ? `  @ ${c.local}` : ''}`).join('\n');
    reg.console = await gravar(reservar(`Console/${dir}.log`, 'CON ' + urlFinal), linhas + '\n');
  }
  const har = await montarHar(cap, urlFinal, titulo);
  reg.har = await gravar(reservar(`Rede/_har/${dir}.har`, 'HAR ' + urlFinal), JSON.stringify(har, null, 2));
  reg.requisicoes = har.log.entries.length;
  for (const [i, ws] of cap.ws.entries()) {
    const linhas = [JSON.stringify({ url: ws.url }), ...ws.eventos.map((e) => JSON.stringify(e))].join('\n');
    await gravar(reservar(`Rede/_websockets/${dir}__ws${i + 1}.jsonl`, `WS ${urlFinal} ${i}`), linhas + '\n');
  }
  if (cap.sse.length) {
    await gravar(
      reservar(`Rede/_eventsource/${dir}.jsonl`, 'SSE ' + urlFinal),
      cap.sse.map((e) => JSON.stringify(e)).join('\n') + '\n',
    );
  }
  const f = await salvarFontes(cap, rp, docUrls);
  reg.fontes = f;
  if (EXTRA.aplicativo) registrarApp(stor, urlFinal);
  if (EXTRA.lighthouse && S.paginasLH.length < 5000) S.paginasLH.push({ url: urlFinal, dir });

  // 5) descobrir novas páginas
  let novas = 0;
  for (const l of [...links, ...cap.descobertas, ...S.descobertasPopup.splice(0)]) {
    if (enfileirar(l, urlFinal, item.prof + 1)) novas++;
  }
  reg.linksNovos = novas;
  S.capturadas.add(item.url);
  if (chaveFinal) S.capturadas.add(chaveFinal);
}

async function capturarPagina(w, item) {
  const t0 = Date.now();
  const cap = novaCaptura(item.url);
  const reg = { url: item.url, profundidade: item.prof };
  const desanexar = anexar(w.page, w.cdp, cap);
  try {
    await processarPagina(w, item, cap, reg);
  } finally {
    desanexar();
    reg.duracaoMs = Date.now() - t0;
    reg.em = agora();
    await fsp.appendFile(ARQ_PAGINAS, JSON.stringify(reg) + '\n').catch(() => {});
  }
  return reg;
}

// ----------------------------------------------------------------------------
//  Sementes: robots.txt e sitemap.xml
// ----------------------------------------------------------------------------
const decodeXml = (s) =>
  s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");

async function sementesDeSitemap() {
  const achados = [];
  const fila = [U0.origin + '/sitemap.xml'];
  try {
    const r = await buscar(U0.origin + '/robots.txt');
    if (r.status === 200 && !/html/i.test(r.headers['content-type'] || '')) {
      await salvarCorpo(U0.origin + '/robots.txt', 'GET', null, 'text/plain', r.corpo, { status: 200 });
      for (const m of r.corpo.toString('utf8').matchAll(/^\s*sitemap:\s*(\S+)/gim)) fila.push(m[1]);
    }
  } catch {}
  const vistos = new Set();
  while (fila.length && vistos.size < 30 && achados.length < 5000) {
    const sm = fila.shift();
    if (vistos.has(sm)) continue;
    vistos.add(sm);
    try {
      const r = await buscar(sm);
      if (r.status !== 200 || /html/i.test(r.headers['content-type'] || '')) continue;
      await salvarCorpo(sm, 'GET', null, 'application/xml', r.corpo, { status: 200 });
      let buf = r.corpo;
      if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
      const txt = buf.toString('utf8');
      const ehIndice = /<sitemapindex/i.test(txt);
      for (const m of txt.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)) {
        const loc = decodeXml(m[1]);
        if (ehIndice) fila.push(loc);
        else achados.push(loc);
      }
    } catch {}
  }
  return achados;
}

// ----------------------------------------------------------------------------
//  Estado (para --retomar) e progresso
// ----------------------------------------------------------------------------
S.iniciadas = 0;
S.emCurso = new Set();

let _estadoTimer = null;
function salvarEstadoSoon() {
  if (_estadoTimer) return;
  _estadoTimer = setTimeout(() => {
    _estadoTimer = null;
    salvarEstado().catch(() => {});
  }, 3000);
}
async function salvarEstado() {
  const dados = {
    versao: VERSAO, urlInicial, atualizadoEm: agora(), iniciadas: S.iniciadas,
    modo: opt.modo, saida: OUT_DIR, contadores: S.contadores,
    origens: [...S.ultimaUrlPorOrigem],
    fila: [...S.emCurso, ...S.fila], enfileiradas: [...S.enfileiradas], capturadas: [...S.capturadas],
  };
  const temporario = ARQ_ESTADO + '.tmp';
  await fsp.writeFile(temporario, JSON.stringify(dados));
  await fsp.rename(temporario, ARQ_ESTADO);
}
async function carregarEstado() {
  try {
    const d = JSON.parse(await fsp.readFile(ARQ_ESTADO, 'utf8'));
    if (d.urlInicial !== urlInicial || d.saida && d.saida !== OUT_DIR || d.modo && d.modo !== opt.modo) {
      throw new Error('Estado pertence a outra URL, pasta de saída ou modo.');
    }
    S.fila = (d.fila || []).filter((item) => item && !d.capturadas?.includes(item.url));
    (d.enfileiradas || []).forEach((u) => S.enfileiradas.add(u));
    (d.capturadas || []).forEach((u) => S.capturadas.add(u));
    S.iniciadas = Math.max(0, (d.iniciadas || 0) - S.fila.length);
    const indiceAnterior = d.contadores ? null : await fsp.readFile(path.join(OUT_DIR, '_indice.json'), 'utf8').then(JSON.parse).catch(() => null);
    Object.assign(S.contadores, d.contadores || indiceAnterior?.totais || {});
    for (const [origem, url] of d.origens || []) S.ultimaUrlPorOrigem.set(origem, url);
    return true;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    return false;
  }
}

function mostrarProgresso(n, reg) {
  const total = Math.min(S.iniciadas + S.fila.length, MAX_PAGINAS || Infinity);
  const st = reg.status ?? '---';
  const nota = reg.nota ? ` (${reg.nota})` : '';
  const extra = reg.requisicoes != null ? ` · ${reg.requisicoes} req · ${reg.fontes ? reg.fontes.arquivos : 0} fontes` : '';
  log.info(`${cor(90, `[${n}/${total}]`)} ${st} ${reg.urlFinal || reg.url}${extra}${nota}`);
}

// ----------------------------------------------------------------------------
//  Trabalhadores (cada um com sua aba, reaproveitada de página em página)
// ----------------------------------------------------------------------------
function proximo() {
  if (S.parando) return null;
  if (MAX_PAGINAS && S.iniciadas >= MAX_PAGINAS) return null;
  const item = S.fila.shift();
  if (item) S.iniciadas++;
  return item || null;
}

async function trabalhador() {
  let w = await criarAba();
  try {
    for (;;) {
      const item = proximo();
      if (!item) {
        if (S.emAndamento === 0 || S.parando) break;
        await sleep(250);
        continue;
      }
      S.emAndamento++;
      S.emCurso.add(item);
      const n = S.iniciadas;
      try {
        const reg = await comTempo(capturarPagina(w, item), PAGINA_TIMEOUT, 'tempo esgotado na página');
        mostrarProgresso(n, reg);
      } catch (e) {
        registrarErro(item.url, 'pagina', e);
        if (!S.parando && (item.tentativas || 0) < 2) {
          S.fila.push({ ...item, tentativas: (item.tentativas || 0) + 1 });
          S.iniciadas--;
        }
        if (/tempo esgotado|closed|crash|Target|Session/i.test(e.message)) {
          await w.page.close().catch(() => {});
          S.paginasProprias.delete(w.page);
          w = await criarAba();
        }
      } finally {
        S.emCurso.delete(item);
        S.emAndamento--;
      }
      await w.page.goto('about:blank', { timeout: 10000 }).catch(() => {});
      salvarEstadoSoon();
      await sleep(ATRASO);
    }
  } finally {
    await w.page.close().catch(() => {});
  }
}

// ----------------------------------------------------------------------------
//  Aplicativo: storages, IndexedDB, Cache Storage, service workers, manifest
// ----------------------------------------------------------------------------
function acharMapaNoTexto(texto) {
  const m = texto.slice(-2000).match(/\/\/[#@]\s*sourceMappingURL=(\S+)\s*$/m);
  return m ? m[1] : '';
}

async function coletarCacheStorage(cdp, origem, host) {
  let caches = null;
  for (const alvo of [{ securityOrigin: origem }, { storageKey: origem + '/' }]) {
    try {
      caches = (await cdp.send('CacheStorage.requestCacheNames', alvo)).caches;
      break;
    } catch {}
  }
  if (!caches || !caches.length) return;
  const resumo = [];
  for (const c of caches) {
    const entradas = [];
    for (let skip = 0; ; skip += 100) {
      const r = await cdp.send('CacheStorage.requestEntries', { cacheId: c.cacheId, skipCount: skip, pageSize: 100 });
      entradas.push(...r.cacheDataEntries);
      if (!r.hasMore || entradas.length >= 5000) break;
    }
    const itens = [];
    for (const e of entradas) {
      const item = {
        url: e.requestURL, metodo: e.requestMethod, status: e.responseStatus, tipo: e.responseType,
        respostaEm: e.responseTime, cabecalhos: e.responseHeaders,
      };
      try {
        const r = await cdp.send('CacheStorage.requestCachedResponse', {
          cacheId: c.cacheId, requestURL: e.requestURL, requestHeaders: e.requestHeaders || [],
        });
        const corpo = Buffer.from(r.response.body || '', 'base64');
        if (!MAX_BYTES || corpo.length <= MAX_BYTES) {
          const ct = ((e.responseHeaders || []).find((h) => h.name.toLowerCase() === 'content-type') || {}).value || '';
          const rel = reservar(
            `Aplicativo/cache-storage/${host}/${segSeguro(c.cacheName)}/` +
              relDeUrl(e.requestURL, { mime: ct.split(';')[0].trim() }).join('/'),
            `CS ${c.cacheId} ${e.requestURL}`,
          );
          item.arquivo = await gravar(rel, corpo);
        } else {
          item.nota = 'maior que o limite: não salvo';
        }
      } catch {
        item.nota = 'corpo indisponível';
      }
      itens.push(item);
    }
    resumo.push({ cache: c.cacheName, entradas: itens });
  }
  await gravarJson(`Aplicativo/cache-storage/${host}/_indice.json`, resumo);
}

async function snapshotApp(w, origem, urlRef) {
  const { page, cdp } = w;
  let host;
  try {
    host = segSeguro(new URL(origem).host.replace(':', '_'));
  } catch {
    return;
  }
  const base = `Aplicativo/armazenamento/${host}`;
  try {
    await page.goto(urlRef, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {});
    await sleep(800);
  } catch (e) {
    registrarErro(urlRef, 'aplicativo', e);
    return;
  }
  const passo = async (nome, fn) => {
    try {
      await fn();
    } catch (e) {
      registrarErro(origem, 'aplicativo/' + nome, e);
    }
  };

  await passo('storages', async () => {
    const st = await page.evaluate(lerStorages);
    const antes = S.apps.get(origem) || { local: {}, sessao: {} };
    const local = st && st.origem === origem ? st.local : antes.local;
    const sessao = { ...antes.sessao, ...(st && st.origem === origem ? st.sessao : {}) };
    if (Object.keys(local).length) await gravarJson(`${base}/localStorage.json`, local);
    if (Object.keys(sessao).length) await gravarJson(`${base}/sessionStorage.json`, sessao);
  });
  await passo('indexeddb', async () => {
    const dbs = await comTempo(page.evaluate(dumpIDB, { max: IDB_MAX }), 90000, 'IndexedDB demorou demais');
    for (const d of dbs) await gravarJson(`${base}/indexedDB/${segSeguro(d.nome || 'sem-nome')}.json`, d);
  });
  await passo('cache-storage', () => coletarCacheStorage(cdp, origem, host));
  await passo('service-workers', async () => {
    const sws = await page.evaluate(lerSW);
    if (!sws.length) return;
    await gravarJson(`${base}/serviceWorkers.json`, sws);
    const urls = new Set();
    for (const sw of sws) for (const u of [sw.ativo && sw.ativo.scriptURL, sw.aguardando, sw.instalando]) if (u) urls.add(u);
    for (const u of urls) {
      const r = await buscar(u);
      if (r.status === 200) {
        const texto = r.corpo.toString('utf8');
        await salvarArquivoFonte(u, texto, 'application/javascript', { tipo: 'js', mapa: acharMapaNoTexto(texto) });
      }
    }
  });
  await passo('manifest', async () => {
    const m = await cdp.send('Page.getAppManifest');
    if (!m || !m.url) return;
    let dados = m.data || null;
    try {
      dados = JSON.parse(m.data);
    } catch {}
    await gravarJson(`Aplicativo/manifest/${host}.json`, { url: m.url, erros: m.errors, dados, interpretado: m.parsed });
    agendarArquivo(m.url);
  });
  await passo('uso', async () => {
    const u = await cdp.send('Storage.getUsageAndQuota', { origin: origem });
    await gravarJson(`${base}/uso.json`, u);
  });
}

async function salvarCookies() {
  const urls = [...S.hosts].flatMap((h) => [`https://${h}/`, `http://${h}/`]);
  let cookies = [];
  try {
    cookies = await context.cookies(urls);
  } catch {
    try {
      cookies = await context.cookies();
    } catch {}
  }
  await gravarJson('Aplicativo/cookies.json', cookies);
  const linhas = [
    '# Netscape HTTP Cookie File',
    '# Gerado por capturar-site. CONTÉM CREDENCIAIS DE SESSÃO: não compartilhe.',
  ];
  for (const c of cookies) {
    linhas.push(
      [
        (c.httpOnly ? '#HttpOnly_' : '') + c.domain,
        c.domain.startsWith('.') ? 'TRUE' : 'FALSE',
        c.path,
        c.secure ? 'TRUE' : 'FALSE',
        c.expires > 0 ? Math.floor(c.expires) : 0,
        c.name,
        c.value,
      ].join('\t'),
    );
  }
  await gravar(reservar('Aplicativo/cookies.txt', 'cookies.txt'), linhas.join('\n') + '\n');
  return cookies.length;
}

async function salvarSeguranca() {
  if (EXTRA.seguranca) {
    for (const [host, e] of S.seg) {
      const cert = S.certs.get(`${e.protocolo}//${host}`);
      await gravarJson(`Seguranca/${segSeguro(host.replace(':', '_'))}.json`, { ...e, certificado: cert ?? null });
    }
    if (S.mixed.length) await gravarJson('Seguranca/_conteudo-misto.json', S.mixed);
  }
  if (S.bloqueados.length) await gravar(reservar('_bloqueados-pela-trava.json', 'bloq'), JSON.stringify(S.bloqueados, null, 2));
}

// ----------------------------------------------------------------------------
//  Lighthouse (opcional; roda ao final, em sequência)
// ----------------------------------------------------------------------------
async function rodarLighthouse() {
  if (!EXTRA.lighthouse || S.parando || !S.paginasLH.length) return;
  const lista = LH_MAX > 0 ? S.paginasLH.slice(0, LH_MAX) : S.paginasLH;
  let lighthouse;
  try {
    ({ default: lighthouse } = await import('lighthouse'));
  } catch {
    log.aviso('Pacote "lighthouse" não encontrado: pulando (instale com "npm install lighthouse" ou use --sem-lighthouse).');
    return;
  }
  log.info(`Lighthouse em ${lista.length} página(s). Pode demorar…`);
  for (const p of lista) {
    if (S.parando) break;
    try {
      const r = await comTempo(
        lighthouse(p.url, { port: chromePorta, output: ['html', 'json'], logLevel: 'error', disableStorageReset: true }),
        180000,
        'Lighthouse demorou demais',
      );
      if (!r) continue;
      const [html, json] = r.report;
      await gravar(reservar(`Lighthouse/${p.dir}.html`, 'LH ' + p.url), html);
      await gravar(reservar(`Lighthouse/${p.dir}.json`, 'LHJ ' + p.url), json);
      const cat = r.lhr.categories || {};
      const nota = (k) => (cat[k] && cat[k].score != null ? Math.round(cat[k].score * 100) : null);
      S.lighthouse.push({
        url: p.url, desempenho: nota('performance'), acessibilidade: nota('accessibility'),
        boasPraticas: nota('best-practices'), seo: nota('seo'),
      });
      log.ok(`Lighthouse ${p.url}  desempenho=${nota('performance')}`);
    } catch (e) {
      registrarErro(p.url, 'lighthouse', e);
    }
  }
}

// ----------------------------------------------------------------------------
//  Índice e LEIAME
// ----------------------------------------------------------------------------
async function lerJsonl(arq) {
  try {
    return (await fsp.readFile(arq, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function gerarIndice(nCookies) {
  const paginas = await lerJsonl(ARQ_PAGINAS);
  const erros = await lerJsonl(ARQ_ERROS);
  const indice = {
    ferramenta: 'capturar-site', versao: VERSAO, urlInicial, modo: opt.modo, escopo: opt.escopo,
    iniciadoEm: new Date(S.inicio).toISOString(), terminadoEm: agora(), interrompido: S.parando,
    opcoes: {
      paralelo: PARALELO, maxPaginas: MAX_PAGINAS, maxProfundidade: MAX_PROF, maxMb: MAX_MB,
      cliques: EXTRA.cliques && MAX_CLIQUES > 0, bloqueioDeEscritaNoNavegador: !opt['permitir-escrita'],
      serviceWorkersIgnorados: !opt['usar-sw'],
    },
    totais: { ...S.contadores, cookies: nCookies ?? null, paginasNoIndice: paginas.length },
    lighthouse: S.lighthouse,
    paginas,
    erros,
  };
  await fsp.writeFile(path.join(OUT_DIR, '_indice.json'), JSON.stringify(indice, null, 2));
}

async function gerarLeiame() {
  const t = S.contadores;
  const txt = `# Captura de ${urlInicial}

Gerada por **capturar-site v${VERSAO}** em ${agora()}${S.parando ? ' (interrompida antes do fim)' : ''}.

## Atenção: esta pasta contém dados sensíveis

${EXTRA.aplicativo ? 'Pode haver **cookies e tokens de sessão** (`Aplicativo/`),\n' : ''}**headers de autenticação** (\`Rede/_har/\`) e **respostas de API com dados reais** (\`Rede/\`).
Não envie esta pasta para um repositório público nem a compartilhe. Para um remoto, só privado.

## Estrutura

| Pasta | Conteúdo |
|---|---|
| \`Elementos/<host>/<caminho>/<página>/<página>.html\` | DOM renderizado de cada página, após rolagem e cliques (como na aba Elementos). Iframes em \`frames/\`. |
| \`Fontes/<host>/<caminho>\` | JS e CSS carregados de URLs, mais os \`.map\`. |
| \`Fontes/_inline\`, \`Fontes/_dinamicos\`, \`Fontes/_outros\` | Scripts/estilos inline, criados dinamicamente (eval, new Function) ou sem URL http. |
| \`Fontes/_derivados/formatado\` | Cópia legível (pretty print) dos arquivos minificados. |
| \`Fontes/_derivados/originais\` | Código-fonte original reconstruído dos source maps (\`sourcesContent\`). |
| \`Rede/<host>/<caminho>\` | Corpo de TODAS as respostas (HTML original, JS, CSS, imagens, fontes tipográficas, JSON de API…), inclusive de terceiros. |
| \`Rede/_har/\` | Um HAR por página (headers, tempos, status). Cada entrada aponta o arquivo em \`Rede/\` pelo campo \`_arquivo\`. |
| \`Rede/_websockets\`, \`Rede/_eventsource\` | Mensagens de WebSocket e Server-Sent Events. |
| \`Rede/_arquivos.jsonl\` | Lista de todos os arquivos salvos, com hash SHA-256. |
| \`Aplicativo/\` | \`cookies.json\`/\`cookies.txt\`, e por origem: localStorage, sessionStorage, IndexedDB, Cache Storage, service workers, manifest, uso de armazenamento. |
| \`Console/\`, \`Seguranca/\`, \`Capturas/\`, \`Lighthouse/\` | Logs do console, certificado/TLS e headers de segurança, screenshot de cada página, relatórios Lighthouse. |
| \`_indice.json\` | Resumo: totais, todas as páginas capturadas (com os caminhos de cada artefato) e erros. |

Query strings viram \`__q-<texto>-<hash>\` no nome do arquivo; requisições POST viram \`__post-<hash>\`;
o mesmo endereço com conteúdo diferente ganha \`__v-<hash>\`.

## Números

- Páginas capturadas: ${t.paginas}
- Arquivos de rede salvos: ${t.recursos} (${(t.bytes / 1048576).toFixed(1)} MB)
- Scripts: ${t.scripts} · Folhas de estilo: ${t.folhas} · Source maps: ${t.mapas} · Fontes originais reconstruídas: ${t.originais} · Arquivos formatados: ${t.formatados}
- Pulados por tamanho: ${t.pulados} · Bloqueados pela trava de segurança: ${t.bloqueadas} · Erros: ${t.erros}

## Limites conhecidos

- Só é possível capturar o que o navegador recebe: código de servidor e banco de dados não vêm.
- Requisições feitas de dentro de service workers, scripts de iframes de outra origem e shadow DOM fechado não são capturados.
- Páginas que só existem após preencher formulários ou fluxos complexos não são alcançadas (o script não envia formulários).
- Streaming de vídeo (HLS/DASH) é gravado em pedaços, como o navegador os pediu.
`;
  await fsp.writeFile(path.join(OUT_DIR, 'LEIAME.md'), txt);
}

// ----------------------------------------------------------------------------
//  Login manual
// ----------------------------------------------------------------------------
async function pausaParaLogin() {
  console.log(`
${cor(1, 'LOGIN')}
  Uma janela do Chrome foi aberta em ${urlInicial}
  → Se o site exigir login (formulário, SSO, 2FA, captcha…), faça-o agora nessa janela.
  → Quando já estiver logado e vendo o site, volte aqui e pressione ENTER.
  (Site sem login? É só pressionar ENTER.)
`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise((res) => {
    rl.on('SIGINT', () => {
      rl.close();
      S.parando = true;
      res();
    });
    rl.question('Pressione ENTER para iniciar a captura… ', () => {
      rl.close();
      res();
    });
  });
}

// ----------------------------------------------------------------------------
//  Principal
// ----------------------------------------------------------------------------
process.on('SIGINT', () => {
  if (S.parando) {
    log.aviso('Saindo agora.');
    try {
      if (chromeProc) chromeProc.kill();
    } catch {}
    process.exit(130);
  }
  S.parando = true;
  log.aviso('Interrompendo: terminando as páginas em andamento… (Ctrl+C de novo força a saída)');
});
process.on('exit', () => {
  try {
    if (chromeProc && chromeProc.exitCode === null) chromeProc.kill();
  } catch {}
});
process.on('unhandledRejection', (e) => log.aviso('Rejeição não tratada:', (e && e.message) || e));

async function main() {
  console.log(`${cor(1, 'capturar-site')} v${VERSAO}  →  ${urlInicial}`);
  console.log(`Saída: ${OUT_DIR}\n`);
  await fsp.mkdir(path.join(OUT_DIR, 'Rede'), { recursive: true });
  if (!opt.retomar) {
    for (const f of [ARQ_PAGINAS, ARQ_ERROS, ARQ_ESTADO, path.join(OUT_DIR, 'Rede', '_arquivos.jsonl')]) {
      await fsp.rm(f, { force: true });
    }
  }
  const retomou = opt.retomar ? await carregarEstado() : false;
  if (opt.retomar && !retomou) log.aviso('Não há estado anterior para retomar; começando do zero.');
  if (retomou) log.info(`Retomando: ${S.capturadas.size} páginas já feitas, ${S.fila.length} na fila.`);

  await iniciarChrome();
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${chromePorta}`, { timeout: 30000 });
    context = browser.contexts()[0] || (await browser.newContext());

    // janelas/abas abertas pelo próprio site (popups, target=_blank): anota a URL e fecha
    context.on('page', (p) => {
      if (!S.guardaPopups || S.criandoPaginas > 0 || S.paginasProprias.has(p)) return;
      (async () => {
        try {
          await p.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {});
          const u = p.url();
          if (/^https?:/.test(u)) S.descobertasPopup.push(u);
        } finally {
          await p.close().catch(() => {});
        }
      })();
    });

    const abaLogin = context.pages()[0] || (await context.newPage());
    S.paginasProprias.add(abaLogin);
    await abaLogin
      .goto(urlInicial, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT })
      .catch((e) => log.aviso('Não consegui abrir a URL inicial ainda: ' + String(e.message).split('\n')[0]));
    UA = String(await abaLogin.evaluate(() => navigator.userAgent).catch(() => '')).replace('HeadlessChrome', 'Chrome');

    const interativo = process.stdin.isTTY && !opt['sem-login'] && !opt.headless;
    if (interativo) await pausaParaLogin();
    else log.fraco('Sem pausa para login (--sem-login, --headless ou terminal não interativo).');

    if (!S.parando) {
      if (!retomou) {
        enfileirar(urlInicial, urlInicial, 0);
        const aposLogin = abaLogin.url();
        if (/^https?:/.test(aposLogin)) enfileirar(aposLogin, aposLogin, 0);
        if (EXTRA.sitemap) {
          const locs = await sementesDeSitemap();
          let n = 0;
          for (const loc of locs) if (enfileirar(loc, loc, 1)) n++;
          if (n) log.info(`Sitemap: ${n} URL(s) adicionada(s) à fila.`);
        }
      }
      if (!S.fila.length) log.aviso('Fila vazia: nada a capturar. Confira a URL e o escopo.');

      S.guardaPopups = true;
      log.info(`Capturando com ${PARALELO} aba(s). Ctrl+C interrompe com segurança; --retomar continua depois.\n`);
      await Promise.all(Array.from({ length: PARALELO }, () => trabalhador()));
      S.guardaPopups = false;
      await Promise.allSettled([...arquivosPend]);
    }

    log.info('\nFinalizando: Aplicativo, segurança, índice…');
    if (!S.parando && EXTRA.aplicativo && S.ultimaUrlPorOrigem.size) {
      const w = await criarAba();
      for (const [origem, urlRef] of S.ultimaUrlPorOrigem) {
        if (S.parando) break;
        await snapshotApp(w, origem, urlRef);
      }
      await w.page.close().catch(() => {});
      await Promise.allSettled([...arquivosPend]);
    }
    const nCookies = EXTRA.aplicativo ? await salvarCookies().catch(() => null) : null;
    await salvarSeguranca();
    await rodarLighthouse();
    if (_estadoTimer) clearTimeout(_estadoTimer);
    await salvarEstado().catch(() => {});
    await gerarIndice(nCookies);
    await gerarLeiame();

    const t = S.contadores;
    console.log(`
${cor(32, 'Concluído')} em ${((Date.now() - S.inicio) / 60000).toFixed(1)} min
  páginas ${t.paginas} · arquivos de rede ${t.recursos} (${(t.bytes / 1048576).toFixed(1)} MB)
  scripts ${t.scripts} · css ${t.folhas} · source maps ${t.mapas} · fontes originais ${t.originais}
  bloqueados pela trava ${t.bloqueadas} · erros ${t.erros}
  → ${OUT_DIR}
`);
    if (S.parando) log.aviso('A captura foi interrompida; use --retomar para continuar de onde parou.');
  } finally {
    await fecharChrome();
  }
}

main()
  .then(() => process.exit(S.parando ? 130 : 0))
  .catch((e) => {
    log.erro(e && e.stack ? e.stack : e);
    process.exit(1);
  });
