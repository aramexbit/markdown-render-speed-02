// parse.js — a fast CommonMark 0.31.2 + GFM 0.29 parser.
// parse(markdown) returns exactly the HTML marked 18.1.3 produces with
// its default options (gfm, breaks off, pedantic off).
// Written from the specifications and from black-box probing of marked's
// observable behaviour. No third-party code, no dependencies.

// ---------------------------------------------------------------- utilities

const CC = {
  SP: 32, TAB: 9, LF: 10, CR: 13, VT: 11, FF: 12,
  BANG: 33, QUOT: 34, HASH: 35, DOLLAR: 36, PCT: 37, AMP: 38, APOS: 39,
  LPAR: 40, RPAR: 41, STAR: 42, PLUS: 43, COMMA: 44, MINUS: 45, DOT: 46,
  SLASH: 47, COLON: 58, SEMI: 59, LT: 60, EQ: 61, GT: 62, Q: 63, AT: 64,
  LBR: 91, BSLASH: 92, RBR: 93, CARET: 94, US: 95, BT: 96,
  LBRACE: 123, PIPE: 124, RBRACE: 125, TILDE: 126,
};

function isSpaceCode(c) {
  return c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 0xA0;
}
function isDigitCode(c) { return c >= 48 && c <= 57; }
function isAlphaCode(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c > 127;
}
function isAlnumCode(c) { return isDigitCode(c) || isAlphaCode(c); }

const ASCII_PUNCT = new Set();
for (const ch of "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~") ASCII_PUNCT.add(ch.charCodeAt(0));
const UNICODE_PUNCT_RE = /[\p{P}\p{S}]/u;
function isPunctCode(c) {
  if (c < 128) return ASCII_PUNCT.has(c);
  return UNICODE_PUNCT_RE.test(String.fromCodePoint(c));
}
function isWhitespaceCode(c) { return isSpaceCode(c); }

// Decode a numeric character reference at s[i] ('&' is at i).
// Returns [replacementString, endIndex] or null when no valid reference.
function tryEntity(s, i) {
  const n = s.length;
  if (i + 1 >= n) return null;
  const c1 = s.charCodeAt(i + 1);
  if (c1 === 35) { // '#'
    let j = i + 2, hex = false;
    if (j < n && (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88)) { hex = true; j++; }
    const ds = j;
    while (j < n) {
      const c = s.charCodeAt(j);
      if (hex ? (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102) : (c >= 48 && c <= 57)) j++;
      else break;
    }
    if (j === ds || j >= n || s.charCodeAt(j) !== 59) return null;
    let cp = 0;
    for (let k = ds; k < j; k++) {
      const c = s.charCodeAt(k);
      cp = cp * (hex ? 16 : 10) + (c >= 48 && c <= 57 ? c - 48 : (c >= 65 && c <= 70 ? c - 55 : c - 87));
      if (cp > 0x10FFFF) break;
    }
    if (cp === 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) cp = 0xFFFD;
    return [String.fromCodePoint(cp), j + 1];
  }
  // named-entity-like: &word; passes through verbatim (marked never decodes
  // named entities; the browser does). A word is [A-Za-z0-9_]+ .
  let j = i + 1;
  while (j < n) {
    const c = s.charCodeAt(j);
    if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95) j++;
    else break;
  }
  if (j > i + 1 && j < n && s.charCodeAt(j) === 59) return [s.slice(i, j + 1), j + 1];
  return null;
}

// Escape text for HTML output. '&' is escaped unless it begins a numeric
// character reference (decoded) or a named-entity-like &word; (kept verbatim).
function escText(s) {
  let out = null, start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) {
      const r = tryEntity(s, i);
      if (r) {
        if (out === null) out = '';
        out += s.slice(start, i) + r[0];
        i = r[1] - 1; start = r[1];
        continue;
      }
      rep = '&amp;';
    } else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep !== null) {
      if (out === null) out = '';
      out += s.slice(start, i) + rep;
      start = i + 1;
    }
  }
  if (out === null) return s;
  return out + s.slice(start);
}

// Escape for code spans / fenced code: '&' is always escaped.
function escCode(s) {
  let out = null, start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) rep = '&amp;';
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep !== null) {
      if (out === null) out = '';
      out += s.slice(start, i) + rep;
      start = i + 1;
    }
  }
  if (out === null) return s;
  return out + s.slice(start);
}

// Percent-encode a link destination the way marked does: like encodeURI
// (space, " < > [ ] { } | \ ^ `, controls and non-ASCII are encoded;
// everything else, including ( ) ; : = ? # % + , @ ~ ! $, is kept),
// then HTML-escape the result (' becomes &#39;, & becomes &amp; unless
// it begins an entity-like &word; which is kept verbatim).
function encodeHref(url) {
  let enc;
  try { enc = encodeURI(url); } catch (e) { enc = url; }
  return escText(enc);
}

// Resolve backslash escapes and numeric character references inside a
// string (link destinations, titles, labels). Named entities are left
// untouched here; they are handled by escText at render time.
function unescapeStr(s) {
  if (s.indexOf('\\') < 0 && s.indexOf('&') < 0) return s;
  let out = '', start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 92 && i + 1 < s.length && isPunctCode(s.charCodeAt(i + 1))) {
      out += s.slice(start, i) + s[i + 1];
      i++; start = i + 1;
    } else if (c === 38) {
      const r = tryEntity(s, i);
      if (r && r[0] !== s.slice(i, r[1])) {
        out += s.slice(start, i) + r[0];
        i = r[1] - 1; start = r[1];
      }
    }
  }
  return out + s.slice(start);
}

// Normalise a link reference label: collapse whitespace, trim, fold case.
// Full case folding maps ß and ẞ to "ss" (plain toLowerCase does not).
function normalizeLabel(s) {
  return s.replace(/[\s]+/g, ' ').trim()
    .replace(/\u00DF/g, 'ss').replace(/\u1E9E/g, 'ss').toLowerCase();
}

// Is the character at position i of s an escapable punctuation?
function isEscapableAt(s, i) {
  return i < s.length && isPunctCode(s.charCodeAt(i));
}

// ---------------------------------------------------------------- line cursor
// A cursor walks one source line, tracking column and partial tabs.
// cur = { s, pos, col, tab } — tab>0 means s[pos] is a tab whose `tab`
// columns are still unconsumed.

function curPeek(cur) { return cur.pos < cur.s.length ? cur.s.charCodeAt(cur.pos) : -1; }
function curAtEnd(cur) { return cur.pos >= cur.s.length; }

function curAdvance(cur, n) {
  while (n > 0) {
    if (cur.tab > 0) {
      const w = n < cur.tab ? n : cur.tab;
      cur.tab -= w; cur.col += w; n -= w;
      if (cur.tab === 0) cur.pos++;
    } else if (cur.pos < cur.s.length) {
      const c = cur.s.charCodeAt(cur.pos);
      if (c === 9) {
        const w = 4 - (cur.col % 4);
        const use = n < w ? n : w;
        cur.col += use; n -= use;
        if (use === w) cur.pos++; else cur.tab = w - use;
      } else { cur.pos++; cur.col++; n--; }
    } else break;
  }
}

// Columns of whitespace starting at the cursor.
function curIndent(cur) {
  let n = 0, i = cur.pos, col = cur.col;
  if (cur.tab > 0) { n += cur.tab; col += cur.tab; i++; }
  while (i < cur.s.length) {
    const c = cur.s.charCodeAt(i);
    if (c === 32) { n++; col++; i++; }
    else if (c === 9) { const w = 4 - (col % 4); n += w; col += w; i++; }
    else break;
  }
  return n;
}

// Remainder of the line from the cursor, partial tab expanded to spaces.
function curRest(cur) {
  if (cur.tab > 0) return ' '.repeat(cur.tab) + cur.s.slice(cur.pos + 1);
  return cur.s.slice(cur.pos);
}

// Is the rest of the line blank (only spaces/tabs)?
function curIsBlank(cur) {
  let i = cur.pos;
  if (cur.tab > 0) i++;
  while (i < cur.s.length) {
    const c = cur.s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
    i++;
  }
  return true;
}

// Is the raw line blank?
function rawIsBlank(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// ---------------------------------------------------------------- block nodes

const B_DOC = 'doc', B_PARA = 'para', B_H = 'h', B_HR = 'hr', B_CODE = 'code',
  B_FENCE = 'fence', B_HTML = 'html', B_BQ = 'bq', B_LIST = 'list',
  B_ITEM = 'item', B_TABLE = 'table';

function newBlock(t, parent) {
  return { t, c: [], parent: parent || null, lastBlank: false };
}

// ---------------------------------------------------------------- block parser

// HTML block start conditions (CommonMark types 1-7).
const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'base', 'basefont', 'blockquote', 'body',
  'caption', 'center', 'col', 'colgroup', 'dd', 'details', 'dialog', 'dir',
  'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form',
  'frame', 'frameset', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header',
  'hr', 'html', 'iframe', 'legend', 'li', 'link', 'main', 'menu', 'menuitem',
  'nav', 'noframes', 'ol', 'optgroup', 'option', 'p', 'param', 'search',
  'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead',
  'title', 'tr', 'track', 'ul',
]);

// Parse an inline HTML tag starting at s[i] ('<' is at i).
// Returns the index just past '>' on success, -2 if the prefix is valid but
// the tag is not complete on this line, -1 if it is not a tag at all.
// Strict CommonMark rules: tag name [a-zA-Z][a-zA-Z0-9-]*, attributes need
// >=1 whitespace before them, closing tags take no attributes, '/' must be
// followed directly by '>', unquoted values are non-empty and hold no
// space " ' = < > ` .
function parseHtmlTag(s, i) {
  const n = s.length;
  let j = i + 1;
  let closing = false;
  if (j < n && s.charCodeAt(j) === 47) { closing = true; j++; }
  if (j >= n) return -2;
  const c0 = s.charCodeAt(j);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return -1;
  j++;
  while (j < n) {
    const c = s.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45) j++;
    else break;
  }
  if (closing) {
    while (j < n && (s.charCodeAt(j) === 32 || s.charCodeAt(j) === 9)) j++;
    if (j < n && s.charCodeAt(j) === 62) return j + 1;
    if (j >= n) return -2;
    return -1;
  }
  // open tag: attributes then optional '/'
  for (;;) {
    let k = j;
    while (k < n && (s.charCodeAt(k) === 32 || s.charCodeAt(k) === 9)) k++;
    if (k >= n) return -2;
    const c = s.charCodeAt(k);
    if (c === 62) return k + 1;
    if (c === 47) {
      if (k + 1 < n && s.charCodeAt(k + 1) === 62) return k + 2;
      if (k + 1 >= n) return -2;
      return -1;
    }
    if (k === j) return -1; // attribute without preceding whitespace
    // attribute name
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 58)) return -1;
    j = k + 1;
    while (j < n) {
      const d = s.charCodeAt(j);
      if ((d >= 65 && d <= 90) || (d >= 97 && d <= 122) || (d >= 48 && d <= 57) || d === 95 || d === 58 || d === 45 || d === 46) j++;
      else break;
    }
    // optional = value
    let m = j;
    while (m < n && (s.charCodeAt(m) === 32 || s.charCodeAt(m) === 9)) m++;
    if (m < n && s.charCodeAt(m) === 61) {
      m++;
      while (m < n && (s.charCodeAt(m) === 32 || s.charCodeAt(m) === 9)) m++;
      if (m >= n) return -2;
      const q = s.charCodeAt(m);
      if (q === 34 || q === 39) {
        const end = s.indexOf(String.fromCharCode(q), m + 1);
        if (end < 0) return -2;
        j = end + 1;
      } else {
        if (m === j) { /* empty unquoted value */ }
        let e = m;
        while (e < n) {
          const d = s.charCodeAt(e);
          if (d === 32 || d === 9 || d === 34 || d === 39 || d === 61 || d === 60 || d === 62 || d === 96) break;
          e++;
        }
        if (e === m) return -1;
        j = e;
      }
    } else {
      j = m;
    }
  }
}

// Detect an HTML block start at the cursor (indent < 4).
// Returns the block type 1-7, or 0 when there is none.
function htmlBlockType(cur) {
  const s = cur.s;
  let i = cur.pos;
  if (cur.tab > 0) return 0;
  if (s.charCodeAt(i) !== 60) return 0;
  const n = s.length;
  // type 2: comment
  if (s.startsWith('<!--', i)) return 2;
  // type 3: processing instruction
  if (s.startsWith('<?', i)) return 3;
  // type 4: declaration
  if (s.startsWith('<!', i) && i + 2 < n) {
    const c = s.charCodeAt(i + 2);
    if (c >= 65 && c <= 90) return 4;
  }
  // type 5: CDATA
  if (s.startsWith('<![CDATA[', i)) return 5;
  // type 6/7: open or closing tag
  let j = i + 1, closing = false;
  if (j < n && s.charCodeAt(j) === 47) { closing = true; j++; }
  if (j >= n) return 0;
  const c0 = s.charCodeAt(j);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return 0;
  let k = j + 1;
  while (k < n) {
    const c = s.charCodeAt(k);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45) k++;
    else break;
  }
  const name = s.slice(j, k).toLowerCase();
  if (closing) {
    // closing tag: only spaces/tabs then '>' (or EOL) on this line
    let m = k;
    while (m < n && (s.charCodeAt(m) === 32 || s.charCodeAt(m) === 9)) m++;
    if (m < n && s.charCodeAt(m) === 62) {
      // after '>' only spaces/tabs may follow for type 7; for type 6 the
      // tag name must be a block tag and the rest of the line is free
      if (BLOCK_TAGS.has(name)) return 6;
      return 7;
    }
    if (m >= n) return BLOCK_TAGS.has(name) ? 6 : 7;
    return 0;
  }
  // open tag: type 6 when the name is a block tag and what follows the name
  // is a space, tab, '>', '/>' or end of line (loose rule); type 7 otherwise.
  if (BLOCK_TAGS.has(name)) {
    if (k >= n) return 6;
    const c = s.charCodeAt(k);
    if (c === 32 || c === 9 || c === 62) return 6;
    if (c === 47 && k + 1 < n && s.charCodeAt(k + 1) === 62) return 6;
    return 0;
  }
  // type 7: a complete tag on this line, only spaces after it
  const end = parseHtmlTag(s, i);
  if (end > 0) {
    let m = end;
    while (m < n && (s.charCodeAt(m) === 32 || s.charCodeAt(m) === 9)) m++;
    if (m >= n) return 7;
  }
  return 0;
}

// Match an ATX heading at the cursor. Returns [level, contentEnd] or null.
// contentEnd is the index just past the content (before closing #'s).
function atxHeading(cur) {
  const s = cur.s;
  let i = cur.pos, lvl = 0;
  while (i < s.length && s.charCodeAt(i) === 35 && lvl < 7) { lvl++; i++; }
  if (lvl === 0 || lvl > 6) return null;
  if (i >= s.length) return [lvl, i, i];
  const c = s.charCodeAt(i);
  if (c !== 32 && c !== 9) return null;
  // skip spaces, find content end (strip trailing closing #'s sequence)
  let j = i;
  while (j < s.length && (s.charCodeAt(j) === 32 || s.charCodeAt(j) === 9)) j++;
  let end = s.length;
  while (end > j && (s.charCodeAt(end - 1) === 32 || s.charCodeAt(end - 1) === 9)) end--;
  let k = end;
  while (k > j && s.charCodeAt(k - 1) === 35) k--;
  if (k < end && k > j && (s.charCodeAt(k - 1) === 32 || s.charCodeAt(k - 1) === 9)) end = k - 1;
  while (end > j && (s.charCodeAt(end - 1) === 32 || s.charCodeAt(end - 1) === 9)) end--;
  return [lvl, j, end];
}

// Match a fenced code start at the cursor. Returns [char, length, info] or null.
function fenceStart(cur) {
  const s = cur.s;
  let i = cur.pos;
  const ch = s.charCodeAt(i);
  if (ch !== 96 && ch !== 126) return null;
  let len = 0;
  while (i < s.length && s.charCodeAt(i) === ch) { len++; i++; }
  if (len < 3) return null;
  const info = s.slice(i).trim();
  if (ch === 96 && info.indexOf('`') >= 0) return null;
  return [ch, len, info];
}

// Match a thematic break at the cursor (indent < 4 assumed).
function thematicBreak(cur) {
  const s = cur.s;
  let i = cur.pos;
  const ch = s.charCodeAt(i);
  if (ch !== 42 && ch !== 45 && ch !== 95) return false;
  let n = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === ch) { n++; i++; }
    else if (c === 32 || c === 9) i++;
    else return false;
  }
  return n >= 3;
}

// Match a setext underline at the cursor. Returns 1 for '=', 2 for '-', else 0.
function setextLevel(cur) {
  const s = cur.s;
  let i = cur.pos;
  const ch = s.charCodeAt(i);
  if (ch !== 61 && ch !== 45) return 0;
  let n = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === ch) { n++; i++; }
    else if (c === 32 || c === 9) i++;
    else return 0;
  }
  return n >= 1 ? (ch === 61 ? 1 : 2) : 0;
}

// Match a list item marker at the cursor.
// Returns {ordered, delim, start, markerLen, contentIndent, empty} or null.
// contentIndent is the number of columns from the line start to the content.
function listMarker(cur) {
  const s = cur.s;
  const startPos = cur.pos, startCol = cur.col;
  let i = cur.pos;
  const c = s.charCodeAt(i);
  if (c === 42 || c === 43 || c === 45) {
    i++;
    // content must follow after 1+ spaces, or the marker is empty
    if (i >= s.length) {
      return { ordered: false, delim: null, start: 0, markerLen: 1, contentIndent: startCol + 2, empty: true, after: i };
    }
    const nc = s.charCodeAt(i);
    if (nc === 32 || nc === 9) {
      let sp = 0, j = i, col = startCol + 1;
      while (j < s.length) {
        const d = s.charCodeAt(j);
        if (d === 32) { sp++; col++; j++; }
        else if (d === 9) { const w = 4 - (col % 4); sp += w; col += w; j++; }
        else break;
      }
      if (sp === 0) return null;
      if (j >= s.length) {
        // marker + only spaces: empty item; content indent is marker+1
        return { ordered: false, delim: null, start: 0, markerLen: 1, contentIndent: startCol + 2, empty: true, after: i };
      }
      if (sp >= 5) {
        return { ordered: false, delim: null, start: 0, markerLen: 1, contentIndent: startCol + 2, empty: false, after: i };
      }
      return { ordered: false, delim: null, start: 0, markerLen: 1, contentIndent: col, empty: false, after: j };
    }
    return null;
  }
  if (c >= 48 && c <= 57) {
    let j = i, num = 0, digits = 0;
    while (j < s.length && s.charCodeAt(j) >= 48 && s.charCodeAt(j) <= 57 && digits < 10) {
      num = num * 10 + (s.charCodeAt(j) - 48); digits++; j++;
    }
    if (digits === 0 || digits > 9) return null;
    if (j >= s.length) return null;
    const d = s.charCodeAt(j);
    if (d !== 46 && d !== 41) return null;
    const delim = d === 46 ? '.' : ')';
    j++;
    if (j >= s.length) {
      return { ordered: true, delim, start: num, markerLen: j - startPos, contentIndent: startCol + (j - startPos) + 1, empty: true, after: j };
    }
    const nc = s.charCodeAt(j);
    if (nc === 32 || nc === 9) {
      let sp = 0, k = j, col = startCol + (j - startPos);
      while (k < s.length) {
        const e = s.charCodeAt(k);
        if (e === 32) { sp++; col++; k++; }
        else if (e === 9) { const w = 4 - (col % 4); sp += w; col += w; k++; }
        else break;
      }
      if (sp === 0) return null;
      if (k >= s.length) {
        return { ordered: true, delim, start: num, markerLen: j - startPos, contentIndent: startCol + (j - startPos) + 1, empty: true, after: j };
      }
      if (sp >= 5) {
        return { ordered: true, delim, start: num, markerLen: j - startPos, contentIndent: startCol + (j - startPos) + 1, empty: false, after: j };
      }
      return { ordered: true, delim, start: num, markerLen: j - startPos, contentIndent: col, empty: false, after: k };
    }
    return null;
  }
  return null;
}

// Does list A match list B (same type/delimiter, and ordered start rule)?
function sameList(a, b) {
  if (a.ordered !== b.ordered) return false;
  if (!a.ordered) return true;
  return a.delim === b.delim;
}

// ---------------------------------------------------------------- block parser

// HTML block end conditions per type (checked per line, case-insensitive).
function htmlBlockEnds(hType, line, name) {
  const low = line.toLowerCase();
  if (hType === 1) {
    if (name === 'pre') return low.indexOf('</pre>') >= 0;
    if (name === 'script') return low.indexOf('</script>') >= 0;
    if (name === 'style') return low.indexOf('</style>') >= 0;
    return low.indexOf('</textarea>') >= 0;
  }
  if (hType === 2) return low.indexOf('-->') >= 0;
  if (hType === 3) return low.indexOf('?>') >= 0;
  if (hType === 4) return low.indexOf('>') >= 0;
  if (hType === 5) return low.indexOf(']]>') >= 0;
  return false;
}

// Split a table row line into cells. `\|` is an escaped pipe (kept as a
// placeholder so it does not split), then turned back into '|'.
function splitTableRow(line) {
  const cells = [];
  let cur = '', i = 0;
  // strip one leading and one trailing pipe (with surrounding spaces)
  let s = line;
  let a = 0, b = s.length;
  while (a < b && (s.charCodeAt(a) === 32 || s.charCodeAt(a) === 9)) a++;
  while (b > a && (s.charCodeAt(b - 1) === 32 || s.charCodeAt(b - 1) === 9)) b--;
  if (a < b && s.charCodeAt(a) === 124) a++;
  if (b > a && s.charCodeAt(b - 1) === 124) b--;
  s = s.slice(a, b);
  for (i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 92 && i + 1 < s.length && s.charCodeAt(i + 1) === 124) {
      cur += '\u0001'; i++;
    } else if (c === 124) {
      cells.push(cur); cur = '';
    } else {
      cur += s[i];
    }
  }
  cells.push(cur);
  for (let k = 0; k < cells.length; k++) {
    let cell = cells[k];
    cell = cell.replace(/\u0001/g, '|');
    // trim spaces/tabs
    let x = 0, y = cell.length;
    while (x < y && (cell.charCodeAt(x) === 32 || cell.charCodeAt(x) === 9)) x++;
    while (y > x && (cell.charCodeAt(y - 1) === 32 || cell.charCodeAt(y - 1) === 9)) y--;
    cells[k] = cell.slice(x, y);
  }
  return cells;
}

// Is this line a table delimiter row? Returns the alignment array or null.
function tableDelimiter(line) {
  const cells = splitTableRow(line);
  if (cells.length === 0) return null;
  const aligns = [];
  for (const cell of cells) {
    let s = cell;
    let left = false, right = false;
    if (s.charCodeAt(0) === 58) { left = true; s = s.slice(1); }
    if (s.length && s.charCodeAt(s.length - 1) === 58) { right = true; s = s.slice(0, -1); }
    if (s.length === 0) return null;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c !== 45 && c !== 32 && c !== 9) return null;
    }
    // at least one dash
    let dashes = 0;
    for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 45) dashes++;
    if (dashes === 0) return null;
    aligns.push(left ? (right ? 'center' : 'left') : (right ? 'right' : null));
  }
  return aligns;
}

// Does this (already container-stripped) line start a new block?
// Used to stop table body collection: blockquote, ATX, list, fence,
// thematic break, html block, or indented code (indent >= 4).
function lineStartsBlock(s) {
  const cur = { s, pos: 0, col: 0, tab: 0 };
  const ind = curIndent(cur);
  if (ind >= 4) return true;
  curAdvance(cur, ind);
  if (curAtEnd(cur)) return false;
  const c = curPeek(cur);
  if (c === 62) return true; // blockquote
  if (c === 35) { const r = atxHeading(cur); if (r) return true; }
  if (c === 96 || c === 126) { if (fenceStart(cur)) return true; }
  if (c === 60) { if (htmlBlockType(cur)) return true; }
  if (thematicBreak(cur)) return true;
  if (listMarker(cur)) return true;
  return false;
}

// Parse link reference definitions from the start of a paragraph's lines.
// lines: array of strings (the paragraph's raw lines, joined with '\n').
// Returns { defs: [{label, dest, title}], rest: string|null } where rest is
// the remaining paragraph text after the defs (null when the paragraph is
// entirely definitions). Definitions are only recognised when they start at
// the beginning of the paragraph text.
function parseRefDefs(text, refs) {
  let pos = 0;
  const n = text.length;
  let consumed = 0;
  while (pos < n) {
    // a definition must start at the beginning of a line
    const save = pos;
    // up to 3 spaces indent
    let sp = 0;
    while (pos < n && text.charCodeAt(pos) === 32 && sp < 3) { sp++; pos++; }
    if (pos >= n || text.charCodeAt(pos) !== 91) { pos = save; break; } // '['
    // label: [ ... ] with balanced brackets, no unescaped [ or ] inside,
    // at most 999 chars, no blank line inside
    let j = pos + 1, depth = 0, labelEnd = -1;
    while (j < n) {
      const c = text.charCodeAt(j);
      if (c === 92 && j + 1 < n) { j += 2; continue; }
      if (c === 91) { depth++; }
      else if (c === 93) {
        if (depth === 0) { labelEnd = j; break; }
        depth--;
      } else if (c === 10) {
        // blank line inside label? check if next line is blank
        let k = j + 1;
        while (k < n && (text.charCodeAt(k) === 32 || text.charCodeAt(k) === 9)) k++;
        if (k < n && text.charCodeAt(k) === 10) { labelEnd = -2; break; }
      }
      j++;
    }
    if (labelEnd === -2 || labelEnd < 0) { pos = save; break; }
    const rawLabel = text.slice(pos + 1, labelEnd);
    if (rawLabel.length === 0 || rawLabel.length > 999) { pos = save; break; }
    // label must not contain an unescaped '['
    let bad = false;
    for (let k = 0; k < rawLabel.length; k++) {
      if (rawLabel.charCodeAt(k) === 91) { bad = true; break; }
      if (rawLabel.charCodeAt(k) === 92) k++;
    }
    if (bad) { pos = save; break; }
    const label = normalizeLabel(unescapeStr(rawLabel));
    if (label.length === 0) { pos = save; break; }
    j = labelEnd + 1;
    // ':'
    while (j < n && (text.charCodeAt(j) === 32 || text.charCodeAt(j) === 9)) j++;
    if (j >= n || text.charCodeAt(j) !== 58) { pos = save; break; }
    j++;
    // optional whitespace, newlines allowed (but not blank lines)
    let ok = true;
    while (j < n) {
      const c = text.charCodeAt(j);
      if (c === 32 || c === 9) { j++; continue; }
      if (c === 10) {
        let k = j + 1;
        while (k < n && (text.charCodeAt(k) === 32 || text.charCodeAt(k) === 9)) k++;
        if (k < n && text.charCodeAt(k) === 10) { ok = false; break; }
        j = k; continue;
      }
      break;
    }
    if (!ok) { pos = save; break; }
    // destination: <...> or bare (no spaces, no control, balanced parens)
    let dest = null;
    if (j < n && text.charCodeAt(j) === 60) {
      let e = j + 1, closed = false;
      while (e < n) {
        const c = text.charCodeAt(e);
        if (c === 62) { closed = true; break; }
        if (c === 10 || c === 60) break;
        if (c === 92 && e + 1 < n) e += 2;
        else e++;
      }
      if (!closed) { pos = save; break; }
      dest = text.slice(j + 1, e);
      j = e + 1;
    } else {
      let e = j, depth = 0, good = true;
      while (e < n) {
        const c = text.charCodeAt(e);
        if (c === 32 || c === 9 || c === 10) break;
        if (c < 32) { good = false; break; }
        if (c === 92 && e + 1 < n) { e += 2; continue; }
        if (c === 40) depth++;
        else if (c === 41) { if (depth === 0) break; depth--; }
        e++;
      }
      if (!good || e === j) { pos = save; break; }
      dest = text.slice(j, e);
      j = e;
    }
    dest = unescapeStr(dest);
    // optional title on the same line or the next line (not blank)
    let title = null;
    let tj = j;
    // skip spaces/tabs on this line
    let lineEnd = tj;
    while (lineEnd < n && text.charCodeAt(lineEnd) !== 10) lineEnd++;
    let after = tj;
    while (after < lineEnd && (text.charCodeAt(after) === 32 || text.charCodeAt(after) === 9)) after++;
    let titleOk = false;
    if (after < lineEnd) {
      const q = text.charCodeAt(after);
      if (q === 34 || q === 39 || q === 40) {
        const close = q === 40 ? 41 : q;
        let e = after + 1, closed = false;
        while (e < lineEnd) {
          const c = text.charCodeAt(e);
          if (c === 92 && e + 1 < lineEnd) { e += 2; continue; }
          if (c === close) { closed = true; break; }
          e++;
        }
        if (closed) {
          let rest = e + 1;
          while (rest < lineEnd && (text.charCodeAt(rest) === 32 || text.charCodeAt(rest) === 9)) rest++;
          if (rest === lineEnd) {
            title = unescapeStr(text.slice(after + 1, e));
            titleOk = true;
            j = lineEnd;
          }
        }
      }
    }
    if (!titleOk) {
      // title on the next line?
      if (lineEnd < n) {
        let nl = lineEnd + 1, sp2 = 0;
        while (nl < n && text.charCodeAt(nl) === 32 && sp2 < 3) { sp2++; nl++; }
        // next line must not be blank
        if (nl < n && text.charCodeAt(nl) !== 10) {
          let le2 = nl;
          while (le2 < n && text.charCodeAt(le2) !== 10) le2++;
          const q = text.charCodeAt(nl);
          if (q === 34 || q === 39 || q === 40) {
            const close = q === 40 ? 41 : q;
            let e = nl + 1, closed = false;
            while (e < le2) {
              const c = text.charCodeAt(e);
              if (c === 92 && e + 1 < le2) { e += 2; continue; }
              if (c === close) { closed = true; break; }
              e++;
            }
            if (closed) {
              let rest = e + 1;
              while (rest < le2 && (text.charCodeAt(rest) === 32 || text.charCodeAt(rest) === 9)) rest++;
              if (rest === le2) {
                title = unescapeStr(text.slice(nl + 1, e));
                j = le2;
              }
            }
          }
        }
      }
    }
    // after the definition, the next char must be a newline or EOF
    if (j < n && text.charCodeAt(j) !== 10) { pos = save; break; }
    if (!refs.has(label)) refs.set(label, { dest, title });
    consumed = j < n ? j + 1 : j;
    pos = consumed;
  }
  if (consumed === 0) return { defs: 0, rest: text };
  const rest = text.slice(consumed);
  return { defs: 1, rest: rest.length ? rest : null };
}

// ---------------------------------------------------------------- main parser

function parseBlocks(src) {
  const refs = new Map();
  src = src.replace(/\r\n?/g, '\n');
  let lines = src.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const srcEndsNL = src.length === 0 || src.charCodeAt(src.length - 1) === 10;

  const doc = newBlock(B_DOC, null);
  let tip = doc;
  let blankPending = false, blankScope = null;

  // queue of lines to process: {s, term, pre}
  // pre = already stripped to the current container (table leftovers)
  const queue = lines.map((s, i) => ({
    s, term: i < lines.length - 1 || srcEndsNL, pre: false,
  }));
  // for cm-241 we need to peek at the next raw line
  let qi = 0;

  function isDescendantOrEqual(node, anc) {
    let n = node;
    while (n) { if (n === anc) return true; n = n.parent; }
    return false;
  }

  function addChild(parent, child) {
    if (blankPending && parent.c.length > 0 &&
        (blankScope === null || isDescendantOrEqual(parent, blankScope))) {
      parent.c[parent.c.length - 1].lastBlank = true;
    }
    blankPending = false; blankScope = null;
    child.parent = parent;
    parent.c.push(child);
    return child;
  }

  function lastChildOf(b) {
    return b.c.length ? b.c[b.c.length - 1] : null;
  }

  // deepest open container (doc/bq/list/item) starting from the tip
  function deepestContainer() {
    let n = tip;
    while (n && n.t !== B_DOC && n.t !== B_BQ && n.t !== B_LIST && n.t !== B_ITEM) n = n.parent;
    return n || doc;
  }

  // Finalize a block when it is closed. Returns leftover lines (table) or null.
  function finalize(b) {
    if (b.t === B_PARA) {
      const text = b.lines.join('\n');
      const r = parseRefDefs(text, refs);
      if (r.rest === null) {
        // paragraph was only reference definitions: remove it
        const p = b.parent, idx = p.c.indexOf(b);
        if (idx >= 0) p.c.splice(idx, 1);
        return null;
      }
      const plines = r.rest.split('\n');
      if (plines.length >= 2) {
        const aligns = tableDelimiter(plines[1]);
        if (aligns && (plines[1].indexOf('|') >= 0 || plines[0].indexOf('|') >= 0)) {
          // convert to a table
          const tbl = newBlock(B_TABLE, b.parent);
          tbl.align = aligns;
          const ncol = aligns.length;
          const head = splitTableRow(plines[0]);
          while (head.length < ncol) head.push('');
          tbl.head = head.slice(0, ncol);
          tbl.body = [];
          let i = 2;
          for (; i < plines.length; i++) {
            if (lineStartsBlock(plines[i])) break;
            const row = splitTableRow(plines[i]);
            while (row.length < ncol) row.push('');
            tbl.body.push(row.slice(0, ncol));
          }
          const p = b.parent, idx = p.c.indexOf(b);
          if (idx >= 0) p.c[idx] = tbl;
          if (tip === b) tip = tbl;
          const leftovers = plines.slice(i);
          if (leftovers.length) {
            return leftovers.map(s => ({ s, term: true, pre: true }));
          }
          return null;
        }
      }
      b.text = r.rest;
      return null;
    }
    if (b.t === B_LIST) {
      let tight = true;
      for (const item of b.c) {
        if (item.lastBlank) { tight = false; break; }
        for (const sub of item.c) {
          if (sub.lastBlank) { tight = false; break; }
        }
        if (!tight) break;
      }
      b.tight = tight;
      return null;
    }
    if (b.t === B_FENCE) {
      // strip exactly one trailing empty line (cm-318)
      if (b.lines.length && b.lines[b.lines.length - 1] === '') b.lines.pop();
      b.text = b.lines.join('\n');
      if (b.lines.length) b.text += '\n';
      return null;
    }
    if (b.t === B_CODE) {
      b.text = b.lines.join('\n');
      if (b.lines.length) b.text += '\n';
      return null;
    }
    if (b.t === B_HTML) {
      b.text = b.lines.join('\n');
      if (b.htmlAddNL) b.text += '\n';
      return null;
    }
    return null;
  }

  // Close blocks from the tip up to (but excluding) `stop` (a container).
  // Returns leftover lines from a table conversion, if any.
  function closeTo(stop) {
    let leftovers = null;
    while (tip !== stop && tip !== doc) {
      const b = tip;
      tip = b.parent;
      const l = finalize(b);
      if (l) leftovers = l;
    }
    return leftovers;
  }

  // Does the next raw line continue the given blockquote node?
  function nextContinuesBq(nextLine, bq) {
    if (nextLine === null || nextLine === undefined) return false;
    // walk the container chain from the root down to bq, stripping prefixes
    const chain = [];
    let n = bq;
    while (n && n !== doc) { chain.unshift(n); n = n.parent; }
    let cur = { s: nextLine, pos: 0, col: 0, tab: 0 };
    for (const c of chain) {
      if (c.t === B_BQ) {
        const ind = curIndent(cur);
        if (ind > 3) return false;
        curAdvance(cur, ind);
        if (curPeek(cur) !== 62) return false;
        curAdvance(cur, 1);
        if (curPeek(cur) === 32) curAdvance(cur, 1);
      } else if (c.t === B_ITEM) {
        const ind = curIndent(cur);
        if (ind < c.cIndent && !curIsBlank(cur)) return false;
        if (ind >= c.cIndent) curAdvance(cur, c.cIndent);
      } else if (c.t === B_LIST) {
        // lists consume nothing
      } else {
        return false;
      }
    }
    return true;
  }

  // Process one line. Returns {leftovers, retry} when a table conversion
  // produced lines that must be processed before this line.
  function processLine(item) {
    const line = item.s;
    const cur = { s: line, pos: 0, col: 0, tab: 0 };
    const rawBlank = rawIsBlank(line);

    // ---- Phase 1: match open containers
    let container = doc, allMatched = true, lastConsumed = null;
    if (!item.pre) {
      let n = doc;
      for (;;) {
        const child = lastChildOf(n);
        if (!child) break;
        if (child.t === B_BQ) {
          const ind = curIndent(cur);
          if (ind > 3) { allMatched = false; break; }
          const save = { pos: cur.pos, col: cur.col, tab: cur.tab };
          curAdvance(cur, ind);
          if (curPeek(cur) !== 62) { cur.pos = save.pos; cur.col = save.col; cur.tab = save.tab; allMatched = false; break; }
          curAdvance(cur, 1);
          if (curPeek(cur) === 32) curAdvance(cur, 1);
          lastConsumed = child;
          container = child; n = child;
        } else if (child.t === B_ITEM) {
          if (child.closedByBlank) { allMatched = false; break; }
          const ind = curIndent(cur);
          if (curIsBlank(cur)) {
            // blank lines match items without consuming
            container = child; n = child;
          } else if (ind >= child.cIndent) {
            curAdvance(cur, child.cIndent);
            lastConsumed = child;
            container = child; n = child;
          } else { allMatched = false; break; }
        } else if (child.t === B_LIST) {
          container = child; n = child;
        } else {
          break;
        }
      }
      // close unmatched containers
      if (!allMatched) {
        const l = closeTo(container);
        if (l) return { leftovers: l, retry: true };
      }
    } else {
      container = deepestContainer();
      allMatched = true;
    }

    const blank = curIsBlank(cur);

    // ---- blank line
    if (blank) {
      // cm-241: a container-blank line (blank after a marker, raw not blank)
      // joins the paragraph when the tip is a paragraph in that blockquote
      // and the next line does not continue the blockquote.
      if (!rawBlank && tip.t === B_PARA && tip.parent === lastConsumed &&
          lastConsumed && lastConsumed.t === B_BQ) {
        const nextLine = qi + 1 < queue.length ? queue[qi + 1].s : null;
        if (!nextContinuesBq(nextLine, lastConsumed)) {
          tip.lines.push(curRest(cur));
          const l = closeTo(tip.parent);
          if (l) return { leftovers: l, retry: true };
          tip = tip.parent;
          return null;
        }
      }
      if (rawBlank) { blankPending = true; blankScope = null; }
      else if (lastConsumed) { blankPending = true; blankScope = lastConsumed; }
      // a blank line closes a paragraph / code / html / fence tip
      if (tip.t === B_PARA || tip.t === B_CODE || tip.t === B_HTML || tip.t === B_FENCE) {
        if (tip.t === B_PARA && tip.c === undefined) { /* para */ }
        const parent = tip.parent;
        // remember whether the html block is followed by a blank line
        if (tip.t === B_HTML) tip.htmlAddNL = false;
        const l = closeTo(parent);
        if (l) return { leftovers: l, retry: true };
        tip = parent;
      } else if (tip.t === B_ITEM && tip.c.length === 0) {
        tip.closedByBlank = true;
      }
      return null;
    }

    // ---- Phase 2: try to start new blocks at `container`
    // Fenced code and HTML blocks take the line directly (Phase 3).
    // An indented code block continues only while the indent is >= 4.
    const tipIsPara = tip.t === B_PARA;
    let skipPhase2 = false;
    if (tip.t === B_FENCE || tip.t === B_HTML) skipPhase2 = true;
    else if (tip.t === B_CODE) {
      if (curIndent(cur) < 4) {
        const l = closeTo(tip.parent);
        if (l) return { leftovers: l, retry: true };
      } else skipPhase2 = true;
    }
    for (; !skipPhase2;) {
      const ind = curIndent(cur);
      if (ind >= 4 && tip.t !== B_PARA) {
        // indented code (cannot interrupt a paragraph)
        if (tip.t !== B_CODE) {
          const code = addChild(container, newBlock(B_CODE, container));
          code.lines = [];
          tip = code;
        }
        break;
      }
      // save the cursor before stripping the block indent: an HTML block
      // keeps its leading spaces, so its branch restores this position
      const indentSave = { pos: cur.pos, col: cur.col, tab: cur.tab };
      if (ind < 4) curAdvance(cur, ind);
      // setext underline when the tip is a paragraph
      if (tip.t === B_PARA) {
        const sl = setextLevel(cur);
        if (sl) {
          // extract ref defs first: a paragraph of only defs is not a heading
          const text = tip.lines.join('\n');
          const r = parseRefDefs(text, refs);
          if (r.rest === null) {
            const p = tip.parent, idx = p.c.indexOf(tip);
            if (idx >= 0) p.c.splice(idx, 1);
            tip = p;
            // the underline line is re-processed as a fresh line
            return { leftovers: [{ s: line, term: item.term, pre: true }], retry: true };
          }
          const h = newBlock(B_H, tip.parent);
          h.lvl = sl;
          h.text = r.rest;
          const p = tip.parent, idx = p.c.indexOf(tip);
          if (idx >= 0) p.c[idx] = h;
          tip = h;
          // the heading is closed immediately
          tip = p;
          return null;
        }
      }
      // blockquote start
      if (curPeek(cur) === 62) {
        if (tip.t === B_PARA || tip.t === B_CODE) {
          const pl = closeTo(tip.parent);
          if (pl) return { leftovers: pl, retry: true };
        }
        const bq = addChild(container, newBlock(B_BQ, container));
        container = bq; tip = bq;
        curAdvance(cur, 1);
        if (curPeek(cur) === 32) curAdvance(cur, 1);
        continue;
      }
      // ATX heading
      const atx = atxHeading(cur);
      if (atx) {
        if (tip.t === B_PARA || tip.t === B_CODE) {
          const pl = closeTo(tip.parent);
          if (pl) return { leftovers: pl, retry: true };
        }
        const h = addChild(container, newBlock(B_H, container));
        h.lvl = atx[0];
        h.text = cur.s.slice(atx[1], atx[2]);
        tip = container;
        return null;
      }
      // fenced code
      const fs = fenceStart(cur);
      if (fs && (!tipIsPara || true)) {
        if (tip.t === B_PARA || tip.t === B_CODE) {
          const pl = closeTo(tip.parent);
          if (pl) return { leftovers: pl, retry: true };
        }
        const f = addChild(container, newBlock(B_FENCE, container));
        f.fenceChar = fs[0]; f.fenceLen = fs[1]; f.info = fs[2]; f.lines = [];
        tip = f;
        return null;
      }
      // html block (type 7 cannot interrupt a paragraph)
      const ht = htmlBlockType(cur);
      if (ht && (ht !== 7 || !tipIsPara)) {
        if (tip.t === B_PARA || tip.t === B_CODE) {
          const pl = closeTo(tip.parent);
          if (pl) return { leftovers: pl, retry: true };
        }
        const hb = addChild(container, newBlock(B_HTML, container));
        hb.hType = ht; hb.lines = []; hb.htmlAddNL = true;
        hb.htmlName = null;
        if (ht === 1) {
          const m = cur.s.slice(cur.pos).match(/<(pre|script|style|textarea)/i);
          if (m) hb.htmlName = m[1].toLowerCase();
        }
        tip = hb;
        // restore the cursor to before this iteration's indent advance:
        // an HTML block's lines keep their leading spaces (cm-150)
        cur.pos = indentSave.pos; cur.col = indentSave.col; cur.tab = indentSave.tab;
        // fall through to add this line to the html block
        break;
      }
      // thematic break (can interrupt a paragraph, but not as setext)
      if (thematicBreak(cur)) {
        if (tip.t === B_PARA || tip.t === B_CODE) {
          const pl = closeTo(tip.parent);
          if (pl) return { leftovers: pl, retry: true };
        }
        addChild(container, newBlock(B_HR, container));
        tip = container;
        return null;
      }
      // list item
      const lm = listMarker(cur);
      if (lm) {
        const canInterrupt = !tipIsPara || !allMatched || !lm.ordered || lm.start === 1;
        const emptyItem = lm.empty;
        if (canInterrupt && !(tipIsPara && emptyItem)) {
          if (tip.t === B_PARA || tip.t === B_CODE) {
            const pl = closeTo(tip.parent);
            if (pl) return { leftovers: pl, retry: true };
          }
          // find or create the list: a marker that matches the container
          // list itself belongs in that list (sibling item); otherwise
          // it may continue the container's last-child list (sublist)
          let list = null;
          if (container.t === B_LIST && sameList(container, lm)) list = container;
          else {
            const last = lastChildOf(container);
            if (last && last.t === B_LIST && sameList(last, lm)) list = last;
          }
          if (!list) {
            list = addChild(container, newBlock(B_LIST, container));
            list.ordered = lm.ordered; list.delim = lm.delim; list.start = lm.start;
          }
          const it = addChild(list, newBlock(B_ITEM, list));
          it.cIndent = lm.contentIndent;
          it.closedByBlank = false;
          container = it; tip = it;
          if (lm.empty) {
            // empty item: nothing more on this line
            return null;
          }
          // position the cursor at the content (advance handles tabs)
          curAdvance(cur, lm.contentIndent - cur.col);
          continue;
        }
      }
      break;
    }

    // ---- Phase 3: add the line to the tip leaf
    if (tip.t === B_CODE) {
      // indented code: strip up to 4 columns
      curAdvance(cur, Math.min(4, curIndent(cur)));
      tip.lines.push(curRest(cur));
      return null;
    }
    if (tip.t === B_FENCE) {
      // closing fence?
      const save = { pos: cur.pos, col: cur.col, tab: cur.tab };
      const ind = curIndent(cur);
      if (ind < 4) {
        curAdvance(cur, ind);
        const ch = curPeek(cur);
        if (ch === tip.fenceChar) {
          let j = cur.pos, len = 0;
          while (j < line.length && line.charCodeAt(j) === ch) { len++; j++; }
          let k = j;
          while (k < line.length && (line.charCodeAt(k) === 32 || line.charCodeAt(k) === 9)) k++;
          if (len >= tip.fenceLen && k >= line.length) {
            finalize(tip);
            tip = tip.parent;
            return null;
          }
        }
      }
      cur.pos = save.pos; cur.col = save.col; cur.tab = save.tab;
      tip.lines.push(curRest(cur));
      return null;
    }
    if (tip.t === B_HTML) {
      tip.lines.push(curRest(cur));
      if (tip.hType !== 7 && tip.hType !== 6 && htmlBlockEnds(tip.hType, curRest(cur), tip.htmlName)) {
        tip.htmlAddNL = item.term;
        tip = tip.parent;
      }
      return null;
    }
    if (tip.t === B_PARA) {
      // paragraph continuation: lazy vs proper strip
      if (allMatched) {
        // proper continuation: the container matching already consumed the
        // item content indent; apply the extra-4 strip when the line's
        // remaining indent is >= 4 (STATUS rule 3)
        if (curIndent(cur) >= 4 && lastConsumed && lastConsumed.t === B_ITEM) {
          curAdvance(cur, 4);
        }
      } else {
        // lazy continuation: strip 4 if indent >= 4
        if (curIndent(cur) >= 4) curAdvance(cur, 4);
      }
      tip.lines.push(curRest(cur));
      return null;
    }
    // tip is a container: start a new paragraph
    const p = addChild(container, newBlock(B_PARA, container));
    p.lines = [curRest(cur)];
    tip = p;
    return null;
  }

  while (qi < queue.length) {
    const item = queue[qi];
    const res = processLine(item);
    if (res && res.leftovers) {
      // insert leftovers before the current line and retry it afterwards
      queue.splice(qi, 0, ...res.leftovers);
      if (res.retry) {
        // current line stays at its (shifted) position; do not advance qi
        continue;
      }
    }
    qi++;
  }

  // close everything left open
  closeTo(doc);
  return { doc, refs };
}

/* ------------------------------------------------------------------ */
/* Inline parsing                                                      */
/*                                                                     */
/* Scanner model (CommonMark reference, rebuilt from the spec): the    */
/* text of one block is scanned left to right, building a node list.   */
/* `[` pushes a bracket; `]` tries to form a link/image from the top   */
/* bracket; backticks form code spans (never swallowing a `]` whose    */
/* label would form a link); `*`/`_`/`~` runs are recorded as         */
/* delimiters and resolved afterwards.  Emphasis cannot span a link    */
/* boundary, and a link label may not contain another link.            */
/* ------------------------------------------------------------------ */

/* --- link destination / title parsing (source offsets) --- */
/* Parse a link destination starting at i (just after `(` or after `<`).
   Returns {dest, end} where end is the offset just past the destination
   (for `<...>` form, just past `>`; for bare form, just before the
   closing `)` or whitespace), or null.  Backslash escapes are resolved
   in both forms; encodeHref percent/HTML-encodes at render time (the
   raw unescaped destination is stored here). */
function parseLinkDest(s, i) {
  const n = s.length;
  if (i >= n) return null;
  if (s[i] === '<') {
    let j = i + 1, out = '';
    while (j < n) {
      const c = s[j];
      if (c === '>') return { dest: out, end: j + 1 };
      if (c === '\n' || c === '<') return null;
      if (c === '\\' && j + 1 < n && isAsciiPunct(s[j + 1])) { out += s[j + 1]; j += 2; continue; }
      out += c; j++;
    }
    return null;
  }
  let j = i, out = '', depth = 0;
  while (j < n) {
    const c = s[j];
    if (c === ' ' || c === '\n' || c === '\t' || c === '\r' || c === '\x0b' || c === '\x0c' || c.charCodeAt(0) < 32) break;
    if (c === '\\' && j + 1 < n && isAsciiPunct(s[j + 1])) { out += s[j + 1]; j += 2; continue; }
    if (c === '(') { depth++; out += c; j++; continue; }
    if (c === ')') {
      if (depth === 0) break;
      depth--; out += c; j++; continue;
    }
    out += c; j++;
  }
  if (j === i) return { dest: '', end: j };
  return { dest: out, end: j };
}

/* Parse a link title starting at i (after skipping spaces).  Returns
   {title, end} or null.  Title may be "...", '...', or (...). */
function parseLinkTitle(s, i) {
  const n = s.length;
  if (i >= n) return null;
  const q = s[i];
  if (q === '"' || q === "'") {
    let j = i + 1, out = '';
    while (j < n) {
      const c = s[j];
      if (c === q) return { title: out, end: j + 1 };
      if (c === '\n') return null;
      if (c === '\\' && j + 1 < n && isAsciiPunct(s[j + 1])) { out += s[j + 1]; j += 2; continue; }
      out += c; j++;
    }
    return null;
  }
  if (q === '(') {
    let j = i + 1, out = '', depth = 1;
    while (j < n) {
      const c = s[j];
      if (c === '\n') return null;
      if (c === '\\' && j + 1 < n && isAsciiPunct(s[j + 1])) { out += s[j + 1]; j += 2; continue; }
      if (c === '(') depth++;
      else if (c === ')') { depth--; if (depth === 0) return { title: out, end: j + 1 }; }
      out += c; j++;
    }
    return null;
  }
  return null;
}

function skipInlineSpace(s, i) {
  while (i < s.length && (s[i] === ' ' || s[i] === '\n' || s[i] === '\t' || s[i] === '\r')) i++;
  return i;
}

/* Try to parse an inline link `(dest "title")` starting at i (where
   s[i] should be `(`).  Returns {href, title, end} or null. */
function parseInlineLink(s, i) {
  const n = s.length;
  if (i >= n || s[i] !== '(') return null;
  let j = skipInlineSpace(s, i + 1);
  const d = parseLinkDest(s, j);
  if (!d) return null;
  j = skipInlineSpace(s, d.end);
  let title = '';
  if (j < n && (s[j] === '"' || s[j] === "'" || s[j] === '(')) {
    const t = parseLinkTitle(s, j);
    if (!t) return null;
    title = t.title;
    j = skipInlineSpace(s, t.end);
  }
  if (j >= n || s[j] !== ')') return null;
  return { href: d.dest, title, end: j + 1 };
}

/* Parse a reference label `[label]` starting at i.  Returns
   {label, end} (label = raw inner text, end = just past `]`) or null.
   The label may not contain an unescaped `[` or `]` and may not be
   empty after trimming; newlines are allowed. */
function parseRefLabel(s, i) {
  const n = s.length;
  if (i >= n || s[i] !== '[') return null;
  let j = i + 1;
  if (j < n && s[j] === ']') return { label: '', end: j + 1 };
  let out = '';
  while (j < n) {
    const c = s[j];
    if (c === ']') {
      if (out.length === 0) return null;
      return { label: out, end: j + 1 };
    }
    if (c === '[') return null;
    if (c === '\\' && j + 1 < n && isAsciiPunct(s[j + 1])) { out += s[j] + s[j + 1]; j += 2; continue; }
    out += c; j++;
    if (out.length > 999) return null;
  }
  return null;
}

/* --- link-label validity (marked's label grammar) --- */
/* A link label is valid iff its raw text is fully consumable as a
   sequence of: nested bracket `[...]` (no nested `[`/`]` inside),
   backslash escape, code span `` `+ [^`]* `+ ``, or any char except
   `[`, `]`, backtick.  A lone unmatched backtick run makes the label
   invalid, so no link forms from it (probed: `[a `b](u)` fails,
   `[a ``b`](u)` succeeds because `` ``b` `` is a code span). */
function isValidLabel(label) {
  const n = label.length;
  let j = 0;
  while (j < n) {
    const c = label[j];
    if (c === '\\' && j + 1 < n) { j += 2; continue; }
    if (c === '\\') { j++; continue; }
    if (c === '[') {
      let k = j + 1, ok = false;
      while (k < n) {
        const d = label[k];
        if (d === '\\' && k + 1 < n) { k += 2; continue; }
        if (d === ']') { ok = true; break; }
        if (d === '[') break;
        k++;
      }
      if (!ok) return false;
      j = k + 1; continue;
    }
    if (c === '`') {
      let k = j;
      while (k < n && label[k] === '`') k++;
      let m = k;
      while (m < n && label[m] !== '`') m++;
      if (m >= n) return false;
      while (m < n && label[m] === '`') m++;
      j = m; continue;
    }
    if (c === ']') return false;
    j++;
  }
  return true;
}

/* Would the bracket whose label is `label` (raw text from `[`+1 to the
   `]` at closePos) form a link/image given the text after closePos?
   Checks inline `(dest)`, full ref `[x]`, collapsed `[]`, shortcut. */
function labelWouldFormLink(text, closePos, label, refDefs) {
  const n = text.length;
  const after = closePos + 1;
  if (after < n && text[after] === '(') {
    if (parseInlineLink(text, after)) return true;
  }
  if (after < n && text[after] === '[') {
    const r = parseRefLabel(text, after);
    if (r) {
      if (r.label === '') {
        if (refDefs.has(normalizeLabel(label))) return true;
      } else if (refDefs.has(normalizeLabel(r.label))) return true;
    }
  }
  if (refDefs.has(normalizeLabel(label))) return true;
  return false;
}

/* Find the next backtick run of exactly length `len` at or after `from`.
   Returns {pos, len} or null. */
function nextTickRun(s, from, len) {
  const n = s.length;
  let i = from;
  while (i < n) {
    if (s[i] === '`') {
      let j = i;
      while (j < n && s[j] === '`') j++;
      if (j - i === len) return { pos: i, len: j - i };
      i = j;
    } else i++;
  }
  return null;
}

/* Find the `]` that closes the topmost bracket, scanning from `from`
   to `limit` (exclusive).  Depth counts `[` opened after `from`.
   Returns the offset of that `]`, or -1. */
function findBracketClose(s, from, limit) {
  let depth = 0;
  let i = from;
  while (i < limit) {
    const c = s[i];
    if (c === '\\' && i + 1 < limit && isAsciiPunct(s[i + 1])) { i += 2; continue; }
    if (c === '[') depth++;
    else if (c === ']') {
      if (depth === 0) return i;
      depth--;
    }
    i++;
  }
  return -1;
}

/* --- inline node helpers --- */
function textNode(s) { return { t: 'text', s }; }
function addTextTo(out, s) {
  if (!s) return;
  const last = out[out.length - 1];
  if (last && last.t === 'text' && !last.delim && !last.bracket) last.s += s;
  else out.push(textNode(s));
}
/* Plain-text content of inline nodes (for image alt text). */
function plainText(nodes) {
  let out = '';
  for (const nd of nodes) {
    if (nd.t === 'text' || nd.t === 'code' || nd.t === 'html') out += nd.s;
    else if (nd.t === 'softbreak' || nd.t === 'hardbreak') out += '\n';
    else if (nd.t === 'image') out += nd.alt;
    else if (nd.children) out += plainText(nd.children);
  }
  return out;
}

/* --- single-char helpers (string chars) --- */
function isAsciiPunct(ch) { return ch.length === 1 && ASCII_PUNCT.has(ch.charCodeAt(0)); }
function isSpaceCh(ch) { return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\x0b' || ch === '\x0c' || ch === '\u00A0'; }
function isPunctCh(ch) { return isPunctCode(ch.charCodeAt(0)); }

/* Parse an inline HTML construct at s[i] ('<').  Returns the end offset
   (just past the construct) or -1.  Handles comments (incl. <!--> and
   <!--->), processing instructions, declarations, CDATA, and open/close
   tags via parseHtmlTag. */
function parseInlineHtml(s, i) {
  const n = s.length;
  if (s[i] !== '<') return -1;
  if (s.startsWith('<!--', i)) {
    if (s.startsWith('<!-->', i)) return i + 5;
    if (s.startsWith('<!--->', i)) return i + 6;
    let j = i + 4;
    while (j < n) {
      if (s[j] === '-' && s[j + 1] === '-') {
        if (s[j + 2] === '>') return j + 3;
        return -1;
      }
      j++;
    }
    return -1;
  }
  if (s.startsWith('<?', i)) {
    const end = s.indexOf('?>', i + 2);
    return end < 0 ? -1 : end + 2;
  }
  if (s.startsWith('<![CDATA[', i)) {
    const end = s.indexOf(']]>', i + 9);
    return end < 0 ? -1 : end + 3;
  }
  if (s.startsWith('<!', i)) {
    const c = s.charCodeAt(i + 2);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) {
      const end = s.indexOf('>', i + 2);
      return end < 0 ? -1 : end + 1;
    }
    return -1;
  }
  const r = parseHtmlTag(s, i);
  return r >= 0 ? r : -1;
}

/* Match an email address starting at s[i].  Returns the end offset
   (just past the email) or -1.  Local part: 1+ of the RFC chars.
   Domain: labels of alphanumerics/hyphens not ending in `-`,
   separated by `.`. */
function matchEmail(s, i) {
  const n = s.length;
  const LOCAL = /[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]/;
  const ALNUM = /[A-Za-z0-9]/;
  const LABELCH = /[A-Za-z0-9-]/;
  let j = i;
  const ls = j;
  while (j < n && LOCAL.test(s[j])) j++;
  if (j === ls) return -1;
  if (j >= n || s[j] !== '@') return -1;
  j++;
  if (j >= n || !ALNUM.test(s[j])) return -1;
  let lab = j;
  j++;
  while (j < n && LABELCH.test(s[j])) j++;
  while (j > lab && s[j - 1] === '-') j--;
  while (j < n && s[j] === '.') {
    if (j + 1 >= n || !ALNUM.test(s[j + 1])) break;
    j++;
    lab = j;
    j++;
    while (j < n && LABELCH.test(s[j])) j++;
    while (j > lab && s[j - 1] === '-') j--;
  }
  return j;
}

/* Match a `<...>` autolink at s[i] ('<').  Returns {href, text, end}
   or null.  A space/control/`<` inside kills it; a backslash does NOT
   escape the closing `>`. */
function matchAutolink(s, i) {
  const n = s.length;
  let j = i + 1;
  if (j < n && /[A-Za-z]/.test(s[j])) {
    let k = j + 1;
    while (k < n && /[A-Za-z0-9+.-]/.test(s[k])) k++;
    if (k - j >= 2 && k - j <= 32 && k < n && s[k] === ':') {
      let m = k + 1;
      while (m < n) {
        const c = s[m];
        if (c === '>') return { href: s.slice(i + 1, m), text: s.slice(i + 1, m), end: m + 1 };
        if (c === ' ' || c === '\n' || c === '\t' || c === '<' || c.charCodeAt(0) < 32) break;
        m++;
      }
    }
  }
  const em = matchEmail(s, i + 1);
  if (em > i + 1 && em < n && s[em] === '>') {
    const email = s.slice(i + 1, em);
    return { href: 'mailto:' + email, text: email, end: em + 1 };
  }
  return null;
}

/* Flanking for a delimiter run starting at i with length len. */
function flankInfo(text, i, len) {
  const before = i > 0 ? text[i - 1] : undefined;
  const after = i + len < text.length ? text[i + len] : undefined;
  const bSpace = before === undefined || isSpaceCh(before);
  const aSpace = after === undefined || isSpaceCh(after);
  const bPunct = before !== undefined && isPunctCh(before);
  const aPunct = after !== undefined && isPunctCh(after);
  const left = !aSpace && (!aPunct || bSpace || bPunct);
  const right = !bSpace && (!bPunct || aSpace || aPunct);
  return { left, right, before, after };
}

/* The inline scanner.  Returns the top-level list of inline nodes for
   the block text `text` (newlines are line breaks inside the block).
   `refDefs` maps normalized labels to {href, title}. */
function parseInline(text, refDefs) {
  const n = text.length;
  const out = [];
  const brackets = []; // {isImage, active, nodeIdx, labelStart}
  let i = 0;

  function pushDelim(ch, len, canOpen, canClose) {
    const nd = textNode(ch.repeat(len));
    nd.delim = { ch, len, canOpen, canClose };
    out.push(nd);
  }
  /* Push a bracket marker (`[` or `![`) as its own text node so link
     formation can replace it.  Marked with .bracket so addTextTo never
     merges following text into it. */
  function pushBracketMarker(s) {
    const nd = textNode(s);
    nd.bracket = true;
    out.push(nd);
  }

  while (i < n) {
    const c = text[i];

    /* --- backslash --- */
    if (c === '\\') {
      if (i + 1 < n && text[i + 1] === '\n') {
        // backslash + newline = hard break, unless the rest is all space
        let k = i + 2;
        while (k < n && (text[k] === ' ' || text[k] === '\t')) k++;
        let restSpace = true;
        for (let m = k; m < n; m++) {
          const d = text[m];
          if (d !== ' ' && d !== '\t' && d !== '\n' && d !== '\r') { restSpace = false; break; }
        }
        if (!restSpace) {
          out.push({ t: 'hardbreak' });
          i = k;
          continue;
        }
        addTextTo(out, '\\');
        i++;
        continue;
      }
      if (i + 1 < n && isAsciiPunct(text[i + 1])) {
        addTextTo(out, text[i + 1]);
        i += 2;
        continue;
      }
      addTextTo(out, '\\');
      i++;
      continue;
    }

    /* --- newline: soft / hard break --- */
    if (c === '\n') {
      // count spaces/tabs immediately before i (in source)
      let sp = 0, p = i - 1;
      while (p >= 0 && (text[p] === ' ' || text[p] === '\t')) { sp++; p--; }
      // NOTE: a hard break via a backslash before the newline is handled
      // in the `\` branch; by the time we reach a bare `\n` here, any
      // `\` directly before it is an escaped pair, i.e. literal text.
      let k = i + 1;
      while (k < n && (text[k] === ' ' || text[k] === '\t')) k++;
      let restSpace = true;
      for (let m = k; m < n; m++) {
        const d = text[m];
        if (d !== ' ' && d !== '\t' && d !== '\n' && d !== '\r') { restSpace = false; break; }
      }
      const hard = !restSpace && sp >= 2;
      if (hard) {
        // strip the trailing spaces from the last text node
        const last = out[out.length - 1];
        if (last && last.t === 'text' && !last.delim && !last.bracket) {
          let s = last.s;
          let e = s.length;
          while (e > 0 && (s[e - 1] === ' ' || s[e - 1] === '\t')) e--;
          last.s = s.slice(0, e);
          if (last.s === '') out.pop();
        }
        out.push({ t: 'hardbreak' });
      } else {
        out.push({ t: 'softbreak' });
      }
      i = k;
      continue;
    }

    /* --- backtick: code span --- */
    if (c === '`') {
      let j = i;
      while (j < n && text[j] === '`') j++;
      const len = j - i;
      const closer = nextTickRun(text, j, len);
      if (!closer) {
        addTextTo(out, text.slice(i, j));
        i = j;
        continue;
      }
      let blocked = false;
      if (brackets.length > 0) {
        const closePos = findBracketClose(text, j, closer.pos);
        if (closePos >= 0) {
          const top = brackets[brackets.length - 1];
          const label = text.slice(top.labelStart, closePos);
          if (isValidLabel(label) && labelWouldFormLink(text, closePos, label, refDefs)) {
            blocked = true;
          }
        }
      }
      if (blocked) {
        addTextTo(out, text.slice(i, j));
        i = j;
        continue;
      }
      let content = text.slice(j, closer.pos).replace(/\n/g, ' ');
      if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && content.trim() !== '') {
        content = content.slice(1, -1);
      }
      out.push({ t: 'code', s: content });
      i = closer.pos + len;
      continue;
    }

    /* --- image opener `![` --- */
    if (c === '!' && i + 1 < n && text[i + 1] === '[') {
      pushBracketMarker('![');
      brackets.push({ isImage: true, active: true, nodeIdx: out.length, labelStart: i + 2 });
      i += 2;
      continue;
    }

    /* --- link opener `[` --- */
    if (c === '[') {
      pushBracketMarker('[');
      brackets.push({ isImage: false, active: true, nodeIdx: out.length, labelStart: i + 1 });
      i++;
      continue;
    }

    /* --- closer `]` --- */
    if (c === ']') {
      if (brackets.length === 0) {
        addTextTo(out, ']');
        i++;
        continue;
      }
      const opener = brackets[brackets.length - 1];
      if (!opener.active) {
        brackets.pop();
        addTextTo(out, ']');
        i++;
        continue;
      }
      const labelStr = text.slice(opener.labelStart, i);
      if (!isValidLabel(labelStr)) {
        brackets.pop();
        addTextTo(out, ']');
        i++;
        continue;
      }
      // try to form a link/image
      let link = null;
      const j = skipInlineSpace(text, i + 1);
      if (j < n && text[j] === '(') {
        link = parseInlineLink(text, j);
        if (!link) {
          const ref = refDefs.get(normalizeLabel(labelStr));
          if (ref) link = { href: ref.href, title: ref.title, end: i + 1 };
        }
      } else if (j < n && text[j] === '[') {
        const r = parseRefLabel(text, j);
        if (r) {
          if (r.label === '') {
            const ref = refDefs.get(normalizeLabel(labelStr));
            if (ref) link = { href: ref.href, title: ref.title, end: r.end };
          } else {
            const ref = refDefs.get(normalizeLabel(r.label));
            if (ref) link = { href: ref.href, title: ref.title, end: r.end };
          }
          // full/collapsed ref with a missing label: NO shortcut fallback
        } else {
          const ref = refDefs.get(normalizeLabel(labelStr));
          if (ref) link = { href: ref.href, title: ref.title, end: i + 1 };
        }
      } else {
        const ref = refDefs.get(normalizeLabel(labelStr));
        if (ref) link = { href: ref.href, title: ref.title, end: i + 1 };
      }
      if (!link) {
        brackets.pop();
        addTextTo(out, ']');
        i++;
        continue;
      }
      const labelNodes = out.slice(opener.nodeIdx);
      out.length = opener.nodeIdx;
      if (opener.isImage) {
        out[opener.nodeIdx - 1] = { t: 'image', src: link.href, alt: plainText(labelNodes), title: link.title };
      } else {
        out[opener.nodeIdx - 1] = { t: 'link', href: link.href, title: link.title, children: labelNodes };
        for (const b of brackets) if (!b.isImage) b.active = false;
      }
      brackets.pop();
      i = link.end;
      continue;
    }

    /* --- `<`: autolink or inline HTML --- */
    if (c === '<') {
      const au = matchAutolink(text, i);
      if (au) {
        out.push({ t: 'link', href: au.href, title: '', children: [textNode(au.text)] });
        i = au.end;
        continue;
      }
      const he = parseInlineHtml(text, i);
      if (he >= 0) {
        out.push({ t: 'html', s: text.slice(i, he) });
        i = he;
        continue;
      }
      addTextTo(out, '<');
      i++;
      continue;
    }

    /* --- `&`: entity --- */
    if (c === '&') {
      const e = tryEntity(text, i);
      if (e) {
        addTextTo(out, e[0]);
        i = e[1];
        continue;
      }
      addTextTo(out, '&');
      i++;
      continue;
    }

    /* --- delimiter runs `*` `_` `~` --- */
    if (c === '*' || c === '_' || c === '~') {
      let j = i;
      while (j < n && text[j] === c) j++;
      const len = j - i;
      if (c === '~' && len >= 3) {
        addTextTo(out, text.slice(i, j));
        i = j;
        continue;
      }
      const fl = flankInfo(text, i, len);
      let canOpen, canClose;
      if (c === '_') {
        canOpen = fl.left && (!fl.right || (fl.before !== undefined && isPunctCh(fl.before)));
        canClose = fl.right && (!fl.left || (fl.after !== undefined && isPunctCh(fl.after)));
      } else {
        canOpen = fl.left;
        canClose = fl.right;
      }
      pushDelim(c, len, canOpen, canClose);
      i = j;
      continue;
    }

    /* --- ordinary text run --- */
    {
      let j = i;
      while (j < n) {
        const d = text[j];
        if (d === '\\' || d === '`' || d === '[' || d === ']' || d === '<' || d === '&' ||
            d === '*' || d === '_' || d === '~' || d === '\n' || (d === '!' && j + 1 < n && text[j + 1] === '[')) break;
        j++;
      }
      if (j === i) j = i + 1; // safety: always progress
      addTextTo(out, text.slice(i, j));
      i = j;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Emphasis / strikethrough                                            */
/*                                                                     */
/* Delimiter runs are separate text nodes carrying .delim {ch, len,    */
/* canOpen, canClose}.  processEmphasisList resolves one node list:    */
/* it recurses into link/em/strong/del children first (emphasis never  */
/* spans a link boundary), then repeatedly matches the first closer    */
/* that has a matching opener, honouring the Rule of 3 for `*`/`_`.    */
/* ------------------------------------------------------------------ */
function processEmphasisList(nodes) {
  for (const nd of nodes) {
    if (nd.children) processEmphasisList(nd.children);
  }
  for (;;) {
    const delims = [];
    for (let idx = 0; idx < nodes.length; idx++) {
      const nd = nodes[idx];
      if (nd.t === 'text' && nd.delim && nd.delim.len > 0) delims.push(idx);
    }
    let formed = false;
    for (let ci = 0; ci < delims.length && !formed; ci++) {
      const cIdx = delims[ci];
      const closer = nodes[cIdx];
      const cd = closer.delim;
      if (!cd.canClose) continue;
      for (let oi = ci - 1; oi >= 0; oi--) {
        const oIdx = delims[oi];
        const opener = nodes[oIdx];
        const od = opener.delim;
        if (od.ch !== cd.ch) continue;
        if (!od.canOpen) continue;
        if (cd.ch === '*' || cd.ch === '_') {
          const oddMatch = (od.canClose || cd.canOpen) &&
            ((od.len + cd.len) % 3 === 0) &&
            !(od.len % 3 === 0 && cd.len % 3 === 0);
          if (oddMatch) continue;
        }
        const use = (od.len >= 2 && cd.len >= 2) ? 2 : 1;
        const tag = cd.ch === '~' ? 'del' : (use === 2 ? 'strong' : 'em');
        const children = nodes.slice(oIdx + 1, cIdx);
        const rep = [];
        if (od.len > use) {
          const rem = textNode(od.ch.repeat(od.len - use));
          rem.delim = { ch: od.ch, len: od.len - use, canOpen: od.canOpen, canClose: od.canClose };
          rep.push(rem);
        }
        rep.push({ t: tag, children });
        if (cd.len > use) {
          const rem = textNode(cd.ch.repeat(cd.len - use));
          rem.delim = { ch: cd.ch, len: cd.len - use, canOpen: cd.canOpen, canClose: cd.canClose };
          rep.push(rem);
        }
        nodes.splice(oIdx, cIdx - oIdx + 1, ...rep);
        formed = true;
        break;
      }
    }
    if (!formed) break;
  }
}

/* ------------------------------------------------------------------ */
/* Extended autolinks (GFM) — post-pass over plain text nodes          */
/* ------------------------------------------------------------------ */
const URL_END_PUNCT = '?!.,:;*_~\'"';
function isUrlChar(c) {
  const code = c.charCodeAt(0);
  return code > 32 && c !== '<' && c !== '>' && c !== ' ' && c !== '\t' && c !== '\n' && c !== '\r';
}
/* Longest run of URL chars starting at i. */
function urlRunEnd(s, i) {
  let j = i;
  while (j < s.length && isUrlChar(s[j])) j++;
  return j;
}
/* Is `dom` (the part after www. or scheme://, up to the first / ? # or
   end) a valid domain of labels?  Each label: alnum ends, may contain
   `-` inside, 1-63 chars. */
function validDomain(dom) {
  if (!dom) return false;
  const labels = dom.split('.');
  for (const lab of labels) {
    if (!lab || lab.length > 63) return false;
    if (!/^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$/.test(lab)) return false;
  }
  return true;
}
/* Backpedal a candidate: drop trailing `)` while unbalanced, drop a
   trailing entity-like `&word;`, drop trailing punctuation.  Loops
   until stable. */
function backpedal(cand) {
  for (;;) {
    if (cand.endsWith(')')) {
      let opens = 0, closes = 0;
      for (const ch of cand) { if (ch === '(') opens++; else if (ch === ')') closes++; }
      if (closes > opens) { cand = cand.slice(0, -1); continue; }
    }
    const em = cand.match(/&[A-Za-z0-9_]+;$/);
    if (em) { cand = cand.slice(0, cand.length - em[0].length); continue; }
    if (cand.length && URL_END_PUNCT.includes(cand[cand.length - 1])) { cand = cand.slice(0, -1); continue; }
    return cand;
  }
}
/* Try to match one extended autolink starting at s[i].  Returns
   {href, text, end} or null. */
function matchExtAutolink(s, i) {
  const n = s.length;
  // www. (case-insensitive)
  if (i + 4 <= n && s.slice(i, i + 4).toLowerCase() === 'www.') {
    const end = urlRunEnd(s, i);
    let cand = s.slice(i, end);
    cand = backpedal(cand);
    if (cand.length > 4) {
      const rest = cand.slice(4);
      const domEnd = rest.search(/[\/?#]/);
      const dom = domEnd < 0 ? rest : rest.slice(0, domEnd);
      if (validDomain(dom)) return { href: 'http://' + cand, text: cand, end: i + cand.length };
    }
    return null;
  }
  // scheme://
  if (i < n && /[A-Za-z]/.test(s[i])) {
    let k = i + 1;
    while (k < n && /[A-Za-z0-9+.-]/.test(s[k])) k++;
    if (k - i >= 2 && k - i <= 32 && s.slice(k, k + 3) === '://') {
      const scheme = s.slice(i, k).toLowerCase();
      if (scheme === 'mailto' || scheme === 'xmpp') {
        // email plus at most one /segment
        const emEnd = matchEmail(s, k + 3);
        if (emEnd > k + 3) {
          let end = emEnd;
          if (end < n && s[end] === '/') {
            let m = end + 1;
            while (m < n && isUrlChar(s[m]) && s[m] !== '/') m++;
            if (m > end + 1) end = m;
          }
          const cand = s.slice(i, end);
          return { href: cand, text: cand, end };
        }
        return null;
      }
      const end = urlRunEnd(s, i);
      let cand = s.slice(i, end);
      cand = backpedal(cand);
      const rest = cand.slice(k + 3 - i);
      const domEnd = rest.search(/[\/?#]/);
      const dom = domEnd < 0 ? rest : rest.slice(0, domEnd);
      if (cand.length > k + 3 - i && validDomain(dom)) {
        return { href: cand, text: cand, end: i + cand.length };
      }
      return null;
    }
  }
  // bare email
  if (i < n && /[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]/.test(s[i])) {
    const emEnd = matchEmail(s, i);
    if (emEnd > i) {
      // trailing - or _ kills the link entirely
      if (emEnd < n && (s[emEnd] === '-' || s[emEnd] === '_')) return null;
      const email = s.slice(i, emEnd);
      return { href: 'mailto:' + email, text: email, end: emEnd };
    }
  }
  return null;
}
/* Split a plain text string into text/link nodes at extended autolinks. */
function autolinkSplit(s) {
  const parts = [];
  let i = 0;   // start of pending (not yet emitted) text
  let pos = 0; // search position for the next candidate
  const n = s.length;
  while (pos < n) {
    // find the next plausible candidate start at or after pos
    let next = -1;
    const w = s.toLowerCase().indexOf('www.', pos);
    if (w >= 0) next = w;
    const sch = s.slice(pos).search(/[A-Za-z][A-Za-z0-9+.-]{1,31}:\/\//);
    if (sch >= 0 && (next < 0 || pos + sch < next)) next = pos + sch;
    const at = s.indexOf('@', pos);
    if (at >= 0) {
      // an email starts before the @; walk back over local-part chars
      let st = at;
      while (st > pos && /[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]/.test(s[st - 1])) st--;
      if (next < 0 || st < next) next = st;
    }
    if (next < 0) break;
    const m = matchExtAutolink(s, next);
    if (!m) { pos = next + 1; continue; }
    if (next > i) parts.push(textNode(s.slice(i, next)));
    parts.push({ t: 'link', href: m.href, title: '', children: [textNode(m.text)] });
    i = m.end;
    pos = m.end;
  }
  if (i < n) parts.push(textNode(s.slice(i)));
  if (parts.length === 0) parts.push(textNode(s));
  return parts;
}
/* Run the extended-autolink post-pass over the top-level node list.
   `state` carries the cross-paragraph inLink flag (an unclosed raw
   <a> suppresses autolinks until </a>).  Skips link children (no
   nested links) and delimiter/code/html nodes. */
function extAutolinkPass(nodes, state) {
  for (let idx = 0; idx < nodes.length; idx++) {
    const nd = nodes[idx];
    if (nd.t === 'html') {
      const s = nd.s;
      if (/^<\/a\s*>$/i.test(s)) state.inLink = false;
      else if (/^<a(\s[^>]*)?>$/i.test(s)) {
        // self-closing only when the `/` is directly after the name or
        // an attribute value (no space before it): <a/> no, <a /> yes.
        const selfClose = /[^ \t]\/>$/.test(s);
        if (!selfClose) state.inLink = true;
      }
      continue;
    }
    if (nd.t !== 'text' || nd.delim) continue;
    if (state.inLink) continue;
    const parts = autolinkSplit(nd.s);
    if (parts.length > 1 || (parts.length === 1 && parts[0].t === 'link')) {
      nodes.splice(idx, 1, ...parts);
      idx += parts.length - 1;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */
function renderInlineNodes(nodes) {
  let out = '';
  for (const nd of nodes) {
    switch (nd.t) {
      case 'text': out += escText(nd.s); break;
      case 'code': out += '<code>' + escCode(nd.s) + '</code>'; break;
      case 'softbreak': out += '\n'; break;
      case 'hardbreak': out += '<br>\n'; break;
      case 'html': out += nd.s; break;
      case 'link':
        out += '<a href="' + encodeHref(nd.href) + '"';
        if (nd.title) out += ' title="' + escText(nd.title) + '"';
        out += '>' + renderInlineNodes(nd.children) + '</a>';
        break;
      case 'image':
        out += '<img src="' + encodeHref(nd.src) + '" alt="' + escText(nd.alt) + '"';
        if (nd.title) out += ' title="' + escText(nd.title) + '"';
        out += '>';
        break;
      case 'em': out += '<em>' + renderInlineNodes(nd.children) + '</em>'; break;
      case 'strong': out += '<strong>' + renderInlineNodes(nd.children) + '</strong>'; break;
      case 'del': out += '<del>' + renderInlineNodes(nd.children) + '</del>'; break;
    }
  }
  return out;
}

/* Full inline pipeline for one block's text: scan, extended autolinks,
   emphasis.  `state` carries the cross-paragraph inLink flag. */
function renderInline(text, refDefs, state) {
  const nodes = parseInline(text, refDefs);
  extAutolinkPass(nodes, state);
  processEmphasisList(nodes);
  return renderInlineNodes(nodes);
}

function renderTable(tbl, refDefs, state) {
  let out = '<table>\n<thead>\n<tr>\n';
  for (let ci = 0; ci < tbl.head.length; ci++) {
    const a = tbl.align[ci];
    out += '<th' + (a ? ' align="' + a + '"' : '') + '>' +
      renderInline(tbl.head[ci], refDefs, state) + '</th>\n';
  }
  out += '</tr>\n</thead>\n<tbody>';
  for (const row of tbl.body) {
    out += '<tr>\n';
    for (let ci = 0; ci < row.length; ci++) {
      const a = tbl.align[ci];
      out += '<td' + (a ? ' align="' + a + '"' : '') + '>' +
        renderInline(row[ci], refDefs, state) + '</td>\n';
    }
    out += '</tr>\n';
  }
  out += '</tbody></table>\n';
  return out;
}

function renderListItem(item, refDefs, state, tight) {
  let out = '<li>';
  const kids = item.c;
  for (let idx = 0; idx < kids.length; idx++) {
    const k = kids[idx];
    if (k.t === 'para') {
      let text = k.text;
      let checkbox = '';
      if (idx === 0) {
        const tm = text.match(/^\[( |x|X)\](?: |$)/);
        if (tm) {
          checkbox = (tm[1] === 'x' || tm[1] === 'X')
            ? '<input checked="" disabled="" type="checkbox">'
            : '<input disabled="" type="checkbox">';
          text = text.slice(tm[0].length);
        }
      }
      let inner = renderInline(text, refDefs, state);
      if (checkbox) inner = checkbox + (inner ? ' ' + inner : '');
      if (tight) {
        // tight: paragraph text runs straight into the next block
        out += inner;
      } else {
        out += '<p>' + inner + '</p>\n';
      }
    } else {
      out += renderBlock(k, refDefs, state, false);
    }
  }
  out += '</li>\n';
  return out;
}

function renderList(list, refDefs, state) {
  const tag = list.ordered ? 'ol' : 'ul';
  let out = '<' + tag;
  if (list.ordered && list.start !== 1) out += ' start="' + list.start + '"';
  out += '>\n';
  for (const item of list.c) out += renderListItem(item, refDefs, state, list.tight);
  out += '</' + tag + '>\n';
  return out;
}

function renderBlock(b, refDefs, state, tightItem) {
  switch (b.t) {
    case 'para':
      if (tightItem) return renderInline(b.text, refDefs, state);
      return '<p>' + renderInline(b.text, refDefs, state) + '</p>\n';
    case 'h':
      return '<h' + b.lvl + '>' + renderInline(b.text, refDefs, state) + '</h' + b.lvl + '>\n';
    case 'hr': return '<hr>\n';
    case 'code': return '<pre><code>' + escCode(b.text) + '</code></pre>\n';
    case 'fence': {
      const info = (b.info || '').trim();
      const lang = info ? unescapeStr(info.split(/[ \t]+/)[0]) : '';
      const cls = lang ? ' class="language-' + escText(lang) + '"' : '';
      return '<pre><code' + cls + '>' + escCode(b.text) + '</code></pre>\n';
    }
    case 'html': return b.text;
    case 'bq':
      return '<blockquote>\n' + renderBlocks(b.c, refDefs, state, false) + '</blockquote>\n';
    case 'list': return renderList(b, refDefs, state);
    case 'table': return renderTable(b, refDefs, state);
    default: return renderBlocks(b.c, refDefs, state, false);
  }
}

function renderBlocks(blocks, refDefs, state, tightItem) {
  let out = '';
  for (const b of blocks) out += renderBlock(b, refDefs, state, tightItem);
  return out;
}

/* The entry point: render markdown to exactly the HTML marked 18.1.3
   (default options) produces.  Stateless across calls: no cache, no
   memo, nothing retained between invocations. */
export function parse(markdown) {
  const { doc, refs } = parseBlocks(markdown);
  // parseRefDefs stores {dest, title}; the inline layer reads {href, title}
  const refDefs = new Map();
  for (const [k, v] of refs) refDefs.set(k, { href: v.dest, title: v.title });
  const state = { inLink: false };
  return renderBlocks(doc.c, refDefs, state, false);
}
