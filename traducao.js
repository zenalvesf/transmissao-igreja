'use strict';
/**
 * Tradução ao vivo: o que o pregador fala (reconhecido pela página /ouvir) vira texto
 * em outros idiomas, exibido no celular de quem não entende português (/traducao) e,
 * se o operador quiser, como legenda na transmissão.
 *
 * Provedores: Claude (Anthropic), DeepL, Google (sem chave, sem garantia) ou nenhum
 * (só o texto original). Os pedidos são feitos frase a frase, assim que o reconhecimento
 * fecha uma frase.
 */
const { EventEmitter } = require('events');

const IDIOMAS = {
  en: { nome: 'English', pt: 'Inglês', deepl: 'EN-US', google: 'en', voz: 'en-US' },
  es: { nome: 'Español', pt: 'Espanhol', deepl: 'ES', google: 'es', voz: 'es-ES' },
  fr: { nome: 'Français', pt: 'Francês', deepl: 'FR', google: 'fr', voz: 'fr-FR' },
  de: { nome: 'Deutsch', pt: 'Alemão', deepl: 'DE', google: 'de', voz: 'de-DE' },
  it: { nome: 'Italiano', pt: 'Italiano', deepl: 'IT', google: 'it', voz: 'it-IT' },
  zh: { nome: '中文', pt: 'Chinês', deepl: 'ZH', google: 'zh-CN', voz: 'zh-CN' },
  ja: { nome: '日本語', pt: 'Japonês', deepl: 'JA', google: 'ja', voz: 'ja-JP' },
  ko: { nome: '한국어', pt: 'Coreano', deepl: 'KO', google: 'ko', voz: 'ko-KR' },
  ru: { nome: 'Русский', pt: 'Russo', deepl: 'RU', google: 'ru', voz: 'ru-RU' },
  ar: { nome: 'العربية', pt: 'Árabe', deepl: 'AR', google: 'ar', voz: 'ar-SA' },
  nl: { nome: 'Nederlands', pt: 'Holandês', deepl: 'NL', google: 'nl', voz: 'nl-NL' },
  pl: { nome: 'Polski', pt: 'Polonês', deepl: 'PL', google: 'pl', voz: 'pl-PL' },
  uk: { nome: 'Українська', pt: 'Ucraniano', deepl: 'UK', google: 'uk', voz: 'uk-UA' },
  'pt-BR': { nome: 'Português', pt: 'Português (original)', deepl: 'PT-BR', google: 'pt', voz: 'pt-BR' },
};
const MODELOS = {
  'claude-opus-5-5': 'Claude Opus 5.5 (melhor qualidade)',
  'claude-sonnet-5-5': 'Claude Sonnet 5.5 (equilíbrio)',
  'claude-haiku-5-5': 'Claude Haiku 5.5 (mais rápido e barato)',
};
const PROVEDORES = {
  anthropic: 'Claude (Anthropic) — precisa de chave, melhor qualidade',
  deepl: 'DeepL — precisa de chave (há plano gratuito)',
  google: 'Google Tradutor — sem chave, sem garantia de funcionar',
  nenhum: 'Nenhum — só mostra o que foi falado, em português',
};
const MAX_HISTORICO = 60;

let anthropicClient = null, anthropicKey = '';
function sdkAnthropic() {
  const mod = require('@anthropic-ai/sdk');
  return mod.default || mod.Anthropic || mod;
}

class Traducao extends EventEmitter {
  constructor(getConfig) {
    super();
    this.getConfig = getConfig;
    this.historico = [];      // últimos itens traduzidos: { id, ts, original, traducoes: { en: '...' }, erro }
    this.parcial = '';        // frase ainda sendo falada (do reconhecimento)
    this.ouvintes = new Map(); // páginas /ouvir conectadas: id -> { estado, erro, ts }
    this.fila = [];
    this.ocupado = false;
    this.erro = '';
    this.contador = { pedidos: 0, falhas: 0, caracteres: 0 };
    this.nextId = 1;
    this.anterior = '';
  }

  cfg() {
    const c = this.getConfig() || {};
    const idiomas = Array.isArray(c.idiomas) ? c.idiomas.filter((i) => IDIOMAS[i] && i !== 'pt-BR') : ['en'];
    return {
      ativo: !!c.ativo,
      idiomaOrigem: c.idiomaOrigem || 'pt-BR',
      idiomas: idiomas.length ? idiomas : ['en'],
      provedor: PROVEDORES[c.provedor] ? c.provedor : 'anthropic',
      chave: c.chave || '',
      modelo: MODELOS[c.modelo] ? c.modelo : 'claude-opus-5-5',
      naLive: !!c.naLive,
      idiomaLive: IDIOMAS[c.idiomaLive] ? c.idiomaLive : 'en',
    };
  }

  // ---- mensagens da página /ouvir
  onOuvinte(clientId, m) {
    this.ouvintes.set(clientId, { estado: m.estado || 'parado', erro: m.erro || '', ts: Date.now() });
    this.emitState();
  }
  ouvinteSaiu(clientId) {
    if (!this.ouvintes.delete(clientId)) return;
    if (!this.ouvinteAtual().id) { this.parcial = ''; this.emit('parcial', ''); }
    this.emitState();
  }
  /** O ouvinte que importa: o que está ouvindo; senão, o mais recente. */
  ouvinteAtual() {
    let melhor = null;
    for (const [id, o] of this.ouvintes) if (!melhor || (o.estado === 'ouvindo' && melhor.estado !== 'ouvindo') || (o.estado === melhor.estado && o.ts > melhor.ts)) melhor = Object.assign({ id }, o);
    return melhor || { id: null, estado: 'desconectado', erro: '' };
  }
  onFala(m) {
    const texto = String(m.texto || '').replace(/\s+/g, ' ').trim();
    if (!m.final) {
      this.parcial = texto;
      this.emit('parcial', texto);
      return;
    }
    this.parcial = '';
    this.emit('parcial', '');
    if (!texto) return;
    if (!this.cfg().ativo) return;
    this.fila.push({ id: this.nextId++, ts: Date.now(), original: texto });
    this.processar();
  }

  async processar() {
    if (this.ocupado) return;
    this.ocupado = true;
    try {
      while (this.fila.length) {
        // Se a tradução atrasou, junta as frases acumuladas num pedido só (até ~500 caracteres)
        const item = this.fila.shift();
        while (this.fila.length && (item.original.length + this.fila[0].original.length) < 500) item.original += ' ' + this.fila.shift().original;
        const c = this.cfg();
        try {
          item.traducoes = await this.traduzir(item.original, c.idiomas, c, this.anterior);
          this.erro = '';
        } catch (e) {
          item.traducoes = {};
          item.erro = traduzErro(e);
          this.erro = item.erro;
          this.contador.falhas++;
          console.warn('[traducao]', item.erro);
        }
        this.anterior = item.original;
        this.historico.push(item);
        if (this.historico.length > MAX_HISTORICO) this.historico.splice(0, this.historico.length - MAX_HISTORICO);
        this.emit('traducao', item);
        this.emitState();
      }
    } finally { this.ocupado = false; }
  }

  async traduzir(texto, idiomas, c, anterior) {
    this.contador.pedidos++;
    this.contador.caracteres += texto.length;
    const alvos = idiomas.filter((i) => IDIOMAS[i]);
    if (!alvos.length || c.provedor === 'nenhum') return {};
    if (c.provedor === 'anthropic') return traduzirAnthropic(texto, alvos, c, anterior);
    const out = {};
    for (const i of alvos) out[i] = c.provedor === 'deepl' ? await traduzirDeepL(texto, i, c) : await traduzirGoogle(texto, i);
    return out;
  }

  limpar() { this.historico = []; this.anterior = ''; this.erro = ''; this.emit('limpar'); this.emitState(); }

  state() {
    const c = this.cfg();
    return {
      ativo: c.ativo, provedor: c.provedor, modelo: c.modelo, idiomas: c.idiomas, idiomaOrigem: c.idiomaOrigem,
      naLive: c.naLive, idiomaLive: c.idiomaLive, temChave: !!c.chave,
      ouvinte: (({ estado, erro }) => ({ estado, erro }))(this.ouvinteAtual()), ouvintes: this.ouvintes.size,
      parcial: this.parcial, erro: this.erro, contador: this.contador,
      fila: this.fila.length, ocupado: this.ocupado,
      historico: this.historico.slice(-12),
    };
  }
  emitState() { this.emit('state', this.state()); }

  /** Faz uma tradução de teste com a configuração dada (sem salvar). */
  static async testar(c) {
    const t0 = Date.now();
    const frase = 'Porque Deus amou o mundo de tal maneira que deu o seu Filho unigênito.';
    const alvo = (c.idiomas && c.idiomas[0]) || 'en';
    let r;
    if (c.provedor === 'nenhum') r = { [alvo]: frase };
    else if (c.provedor === 'anthropic') r = await traduzirAnthropic(frase, [alvo], c, '');
    else if (c.provedor === 'deepl') r = { [alvo]: await traduzirDeepL(frase, alvo, c) };
    else r = { [alvo]: await traduzirGoogle(frase, alvo) };
    return { ok: true, idioma: alvo, texto: r[alvo], ms: Date.now() - t0 };
  }
}

// ---------------------------------------------------------------- provedores
const SISTEMA = `You translate live speech from a Brazilian Portuguese church service (sermon, prayer, announcements) for people in the congregation who do not understand Portuguese.
The input comes from automatic speech recognition: it may lack punctuation and contain recognition mistakes; infer the intended meaning. Translate faithfully and naturally, in the register of a spoken sermon. Use the standard Bible book names, biblical names and Christian terms of each target language. Do not add explanations, notes or anything that was not said. If the input is empty or meaningless noise, return an empty string for that language.
Reply with a single JSON object whose keys are the target language codes and whose values are the translations, and nothing else.`;

async function traduzirAnthropic(texto, alvos, c, anterior) {
  if (!c.chave) throw new Error('Informe a chave da API da Anthropic.');
  if (!anthropicClient || anthropicKey !== c.chave) { const Anthropic = sdkAnthropic(); anthropicClient = new Anthropic({ apiKey: c.chave, maxRetries: 1, timeout: 20000, baseURL: process.env.TI_ANTHROPIC_BASE_URL || undefined }); anthropicKey = c.chave; }
  const nomes = alvos.map((i) => `${i} (${IDIOMAS[i].nome})`).join(', ');
  const user = (anterior ? `Previous sentence, for context only (already translated, do not repeat it):\n${anterior}\n\n` : '')
    + `Target languages: ${nomes}\n\nTranslate this:\n${texto}`;
  const r = await anthropicClient.beta.messages.create({
    model: c.modelo || 'claude-opus-5-5',
    max_tokens: 2048,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low' },
    system: [{ type: 'text', text: SISTEMA, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: user }],
  });
  if (r.stop_reason === 'refusal') throw new Error('O modelo recusou traduzir esta frase.');
  const txt = r.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const obj = extrairJson(txt);
  const out = {};
  for (const i of alvos) out[i] = typeof obj[i] === 'string' ? obj[i].trim() : '';
  return out;
}
function extrairJson(txt) {
  const a = txt.indexOf('{'), b = txt.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('Resposta inesperada do modelo');
  try { return JSON.parse(txt.slice(a, b + 1)); } catch { throw new Error('Resposta inesperada do modelo'); }
}

async function traduzirDeepL(texto, idioma, c) {
  if (!c.chave) throw new Error('Informe a chave da API do DeepL.');
  const host = c.chave.trim().endsWith(':fx') ? 'api-free.deepl.com' : 'api.deepl.com';
  const r = await fetch(`https://${host}/v2/translate`, {
    method: 'POST', signal: AbortSignal.timeout(15000),
    headers: { Authorization: 'DeepL-Auth-Key ' + c.chave.trim(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: [texto], source_lang: 'PT', target_lang: IDIOMAS[idioma].deepl }),
  });
  if (r.status === 403) throw new Error('DeepL recusou a chave (403).');
  if (r.status === 456) throw new Error('A cota do DeepL deste mês acabou (456).');
  if (!r.ok) throw new Error(`DeepL respondeu ${r.status}`);
  const j = await r.json();
  return ((j.translations || [])[0] || {}).text || '';
}

async function traduzirGoogle(texto, idioma) {
  const u = 'https://translate.googleapis.com/translate_a/single?client=gtx&dt=t&sl=pt&tl=' + encodeURIComponent(IDIOMAS[idioma].google) + '&q=' + encodeURIComponent(texto);
  const r = await fetch(u, { signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (r.status === 429) throw new Error('O Google limitou os pedidos (429); tente outro provedor.');
  if (!r.ok) throw new Error(`Google respondeu ${r.status}`);
  const j = await r.json();
  return (Array.isArray(j[0]) ? j[0].map((x) => x[0]).join('') : '').trim();
}

function traduzErro(e) {
  const m = String(e && e.message || e);
  if (e && e.status === 401) return 'Chave da API inválida (401).';
  if (e && e.status === 429) return 'Limite de pedidos da API atingido (429); aguarde um pouco.';
  if (e && e.status === 400 && /credit|balance/i.test(m)) return 'A conta da API está sem créditos.';
  if (/ENOTFOUND|EAI_AGAIN|fetch failed|ECONNREFUSED/i.test(m)) return 'Sem acesso à internet para traduzir.';
  if (/aborted|timeout|TimeoutError/i.test(m)) return 'O serviço de tradução demorou demais.';
  return m;
}

module.exports = { Traducao, IDIOMAS, MODELOS, PROVEDORES, traduzErro };
