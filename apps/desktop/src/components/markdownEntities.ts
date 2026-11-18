/**
 * HTML character references for chat prose. The Markdown lexer leaves `&amp;`,
 * `&#65;` and `&#x1F600;` in a text node as typed; the safe renderer prints text
 * nodes verbatim, so references are decoded here. Unknown names stay as typed,
 * as CommonMark requires. The table holds the names that occur in model output,
 * not the whole HTML5 list.
 */
const NAMED: Readonly<Record<string, string>> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', ensp: '\u2002', emsp: '\u2003', thinsp: '\u2009', shy: '\u00ad',
  copy: '\u00a9', reg: '\u00ae', trade: '\u2122', sect: '\u00a7', para: '\u00b6', deg: '\u00b0', micro: '\u00b5', middot: '\u00b7',
  plusmn: '\u00b1', times: '\u00d7', divide: '\u00f7', frac12: '\u00bd', frac14: '\u00bc', frac34: '\u00be',
  sup1: '\u00b9', sup2: '\u00b2', sup3: '\u00b3', cent: '\u00a2', pound: '\u00a3', yen: '\u00a5', euro: '\u20ac', curren: '\u00a4',
  laquo: '\u00ab', raquo: '\u00bb', lsquo: '\u2018', rsquo: '\u2019', sbquo: '\u201a', ldquo: '\u201c', rdquo: '\u201d', bdquo: '\u201e',
  lsaquo: '\u2039', rsaquo: '\u203a', ndash: '\u2013', mdash: '\u2014', hellip: '\u2026', bull: '\u2022', dagger: '\u2020', Dagger: '\u2021',
  prime: '\u2032', Prime: '\u2033', permil: '\u2030', iexcl: '\u00a1', iquest: '\u00bf', not: '\u00ac', ordf: '\u00aa', ordm: '\u00ba',
  larr: '\u2190', uarr: '\u2191', rarr: '\u2192', darr: '\u2193', harr: '\u2194', lArr: '\u21d0', uArr: '\u21d1', rArr: '\u21d2', dArr: '\u21d3', hArr: '\u21d4',
  forall: '\u2200', part: '\u2202', exist: '\u2203', empty: '\u2205', nabla: '\u2207', isin: '\u2208', notin: '\u2209', ni: '\u220b',
  prod: '\u220f', sum: '\u2211', minus: '\u2212', lowast: '\u2217', radic: '\u221a', prop: '\u221d', infin: '\u221e', ang: '\u2220',
  and: '\u2227', or: '\u2228', cap: '\u2229', cup: '\u222a', int: '\u222b', there4: '\u2234', sim: '\u223c', cong: '\u2245', asymp: '\u2248',
  ne: '\u2260', equiv: '\u2261', le: '\u2264', ge: '\u2265', sub: '\u2282', sup: '\u2283', sube: '\u2286', supe: '\u2287', oplus: '\u2295', otimes: '\u2297',
  check: '\u2713', cross: '\u2717', star: '\u2606', starf: '\u2605', hearts: '\u2665', spades: '\u2660', clubs: '\u2663', diams: '\u2666',
  alpha: '\u03b1', beta: '\u03b2', gamma: '\u03b3', delta: '\u03b4', epsilon: '\u03b5', zeta: '\u03b6', eta: '\u03b7', theta: '\u03b8',
  iota: '\u03b9', kappa: '\u03ba', lambda: '\u03bb', mu: '\u03bc', nu: '\u03bd', xi: '\u03be', pi: '\u03c0', rho: '\u03c1',
  sigma: '\u03c3', tau: '\u03c4', upsilon: '\u03c5', phi: '\u03c6', chi: '\u03c7', psi: '\u03c8', omega: '\u03c9',
  Alpha: '\u0391', Beta: '\u0392', Gamma: '\u0393', Delta: '\u0394', Theta: '\u0398', Lambda: '\u039b', Pi: '\u03a0', Sigma: '\u03a3', Phi: '\u03a6', Psi: '\u03a8', Omega: '\u03a9',
  agrave: '\u00e0', aacute: '\u00e1', acirc: '\u00e2', atilde: '\u00e3', auml: '\u00e4', aring: '\u00e5', aelig: '\u00e6', ccedil: '\u00e7',
  egrave: '\u00e8', eacute: '\u00e9', ecirc: '\u00ea', euml: '\u00eb', igrave: '\u00ec', iacute: '\u00ed', icirc: '\u00ee', iuml: '\u00ef',
  ntilde: '\u00f1', ograve: '\u00f2', oacute: '\u00f3', ocirc: '\u00f4', otilde: '\u00f5', ouml: '\u00f6', oslash: '\u00f8',
  ugrave: '\u00f9', uacute: '\u00fa', ucirc: '\u00fb', uuml: '\u00fc', yacute: '\u00fd', yuml: '\u00ff', szlig: '\u00df',
  Agrave: '\u00c0', Aacute: '\u00c1', Acirc: '\u00c2', Auml: '\u00c4', Aring: '\u00c5', AElig: '\u00c6', Ccedil: '\u00c7',
  Egrave: '\u00c8', Eacute: '\u00c9', Ntilde: '\u00d1', Oacute: '\u00d3', Ouml: '\u00d6', Uuml: '\u00dc',
};

const REFERENCE = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{1,31}));/gu;

function codePoint(value: number): string {
  // CommonMark: NUL, surrogates and values past U+10FFFF become the replacement character.
  if (value === 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) return '\ufffd';
  return String.fromCodePoint(value);
}

/** Decodes numeric and the common named character references; anything else is returned as typed. */
export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(REFERENCE, (match: string, decimal: string | undefined, hex: string | undefined, name: string | undefined) => {
    if (decimal !== undefined) return codePoint(Number.parseInt(decimal, 10));
    if (hex !== undefined) return codePoint(Number.parseInt(hex, 16));
    // Own keys only: `&constructor;` must not reach Object.prototype.
    return name !== undefined && Object.hasOwn(NAMED, name) ? NAMED[name]! : match;
  });
}
