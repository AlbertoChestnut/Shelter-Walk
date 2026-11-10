// Play group notes, shared by the phone app (app.js) and the desk page
// (playgroup.js): "@" tagging of other dogs, showing tags, and the date row.
//
// A note's body stores a tag as @[dogId]. In an editor it reads "@Name";
// `picks` maps that text (after the @) to the dog's id, and two tagged dogs
// with the same name become "@Name#id".
(function () {
  const TAG_RE = /@\[(\d+)\]/g;

  function esc(str) {
    if (str == null) return '';
    return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  const nameMatches = (dog, q) => [dog.name, ...(dog.previousNames || [])].some((n) => String(n).toLowerCase().includes(q));

  // Turn a YouTube link into a clickable one. Only YouTube: letting every
  // URL in a note become a link would make notes an easy spot to plant a
  // phishing link that looks safe because it's "just a note". Runs on text
  // that's already been through esc(), so matches land on &amp;-encoded text.
  // The lookbehind/lookahead keep this from matching "youtube.com" as a
  // substring of a longer host, e.g. "evil.com/youtube.com/..." (wrong site,
  // dropped from the link text) or "youtube.com.evil.ru" (impersonation).
  const YOUTUBE_RE = /(?<![/.\w])(?:https?:\/\/)?(?:www\.|m\.)?(?:youtube\.com|youtu\.be)(?![\w.-])(?:\/\S*)?/gi;
  function linkifyYouTube(escapedHtml) {
    return escapedHtml.replace(YOUTUBE_RE, (m) => {
      const trail = /[.,!?;:)\]'"]+$/.exec(m);
      const core = trail ? m.slice(0, -trail[0].length) : m;
      const rest = trail ? trail[0] : '';
      if (!core) return m;
      const href = /^https?:\/\//i.test(core) ? core : `https://${core}`;
      return `<a href="${href}" target="_blank" rel="noopener noreferrer">${core}</a>${rest}`;
    });
  }

  function pickLabel(picks, name, id) {
    let label = name;
    if (picks.has(label) && picks.get(label) !== String(id)) label = `${name}#${id}`;
    picks.set(label, String(id));
    return label;
  }
  function toEditable(body, dogs) {
    const picks = new Map();
    const text = body.replace(TAG_RE, (all, id) => '@' + pickLabel(picks, (dogs[id] && dogs[id].name) || `dog ${id}`, id));
    return { text, picks };
  }
  function fromEditable(text, picks) {
    let out = text;
    // Longest first, so "@Maxine" isn't read as "@Max" + "ine".
    for (const label of [...picks.keys()].sort((a, b) => b.length - a.length)) {
      const re = new RegExp(`@${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\w)`, 'g');
      out = out.replace(re, `@[${picks.get(label)}]`);
    }
    return out;
  }
  // A light markdown, same spirit as the Guide's renderMarkdown() but
  // deliberately smaller: no links or images, since any walker (even
  // anonymous) can write a note, and letting free text become a clickable
  // link is exactly the phishing risk linkifyYouTube's comment warns about.
  // **bold**, *italic*, "- "/"* " bullets and "1. " numbered lists only.
  function inlineMd(text, dogs) {
    let t = esc(text);
    t = t.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/(^|[^*])\*([^*\s][^*\n]*)\*/g, '$1<em>$2</em>');
    t = linkifyYouTube(t);
    return t.replace(TAG_RE, (all, id) => (dogs[id]
      ? `<button type="button" class="pg-tag" data-pg-dog="${id}">@${esc(dogs[id].name)}</button>`
      : `@${id}`));
  }
  function bodyHtml(body, dogs) {
    let html = '';
    let listType = null;
    let para = [];
    const flushPara = () => { if (para.length) { html += `<p>${para.map((l) => inlineMd(l, dogs)).join('<br>')}</p>`; para = []; } };
    const closeList = () => { if (listType) { html += `</${listType}>`; listType = null; } };
    String(body == null ? '' : body).replace(/\r\n?/g, '\n').split('\n').forEach((raw) => {
      const line = raw.trimEnd();
      if (!line.trim()) { flushPara(); closeList(); return; }
      let m;
      if ((m = /^[-*]\s+(.*)$/.exec(line))) {
        flushPara();
        if (listType !== 'ul') { closeList(); html += '<ul>'; listType = 'ul'; }
        html += `<li>${inlineMd(m[1], dogs)}</li>`;
      } else if ((m = /^\d+[.)]\s+(.*)$/.exec(line))) {
        flushPara();
        if (listType !== 'ol') { closeList(); html += '<ol>'; listType = 'ol'; }
        html += `<li>${inlineMd(m[1], dogs)}</li>`;
      } else {
        closeList();
        para.push(line);
      }
    });
    flushPara(); closeList();
    return html;
  }
  // Plain text, tags as @Name (for exports and copying).
  const bodyText = (body, dogs) => body.replace(TAG_RE, (all, id) => `@${(dogs[id] && dogs[id].name) || id}`);

  // A short, one-line, plain-text preview of a note -- markdown markers and
  // line breaks stripped, tags read as names -- for a "mentioned in another
  // dog's notes" row where showing every full note would make the list grow
  // without bound. `truncated` tells the caller whether a "Read more" toggle
  // is worth showing at all (a short note just renders in full).
  function bodySnippet(body, dogs, maxLen = 160) {
    const plain = bodyText(body, dogs)
      .split('\n')
      .map((l) => l.replace(/^\s*(?:[-*]\s+|\d+[.)]\s+)/, ''))
      .join(' ')
      .replace(/\*\*([^*\n]+)\*\*/g, '$1')
      .replace(/[*_`]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (plain.length <= maxLen) return { text: plain, truncated: false };
    return { text: `${plain.slice(0, maxLen).replace(/\s+\S*$/, '')}…`, truncated: true };
  }

  // "Today" is the shelter's date (America/New_York), whatever time zone this
  // device is in -- the server rejects a note dated after the shelter's
  // today, so a device ahead of New York (or a UTC clock) must not offer it.
  const shelterKeyFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
  const today = () => shelterKeyFmt.format(new Date()); // YYYY-MM-DD
  const daysAgo = (n) => {
    const d = new Date(`${today()}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - n);
    return d.toISOString().slice(0, 10);
  };
  function fmtDate(key, { weekday = false } = {}) {
    const [y, m, d] = key.split('-').map(Number);
    const opts = { month: 'short', day: 'numeric', timeZone: 'UTC' };
    if (weekday) opts.weekday = 'short';
    if (String(y) !== today().slice(0, 4)) opts.year = 'numeric';
    return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString(undefined, opts);
  }

  // The date of the play group: Today / Yesterday chips and a picker for
  // anything older, so backdating is one or two taps.
  function dateRowHtml(date) {
    return `<div class="pg-date-row">
      <span class="small muted">Play group date</span>
      <button type="button" class="pg-day-chip" data-pg-day="0">Today</button>
      <button type="button" class="pg-day-chip" data-pg-day="1">Yesterday</button>
      <input type="date" class="pg-date" value="${esc(date || today())}" max="${today()}" aria-label="Play group date" />
    </div>`;
  }
  function wireDateRow(root) {
    const input = root.querySelector('.pg-date');
    if (!input) return;
    const chips = root.querySelectorAll('[data-pg-day]');
    const sync = () => chips.forEach((c) => c.classList.toggle('active', input.value === daysAgo(Number(c.dataset.pgDay))));
    chips.forEach((c) => c.addEventListener('click', () => { input.value = daysAgo(Number(c.dataset.pgDay)); sync(); }));
    input.addEventListener('input', sync);
    input.addEventListener('change', sync);
    sync();
  }

  // ================= Rich text core =================
  // `.pg-text` used to be a plain <textarea>; it's now a contenteditable
  // <div> so a recognized dog's name can get an actual highlighted, clickable
  // box drawn around it (see wireAutoTagger below) -- something a textarea
  // simply can't render. Everything in this section exists to give the rest
  // of the file back what a textarea provided for free: a plain-text value,
  // a caret position, and a way to set both.
  //
  // Model: the DOM is read as plain text by walking it (only <br> counts as
  // a line break -- Enter is intercepted below to always insert one of
  // those, rather than letting the browser wrap a new line in its own
  // <div>, which would make "how many line breaks does this represent"
  // ambiguous: an empty line is just a lone <br> marking the cursor's
  // height, and there'd be no reliable way to tell that apart from a
  // deliberate one typed at the end of the note). Writing is done by
  // rebuilding the DOM from a plain-text string plus a list of ranges to
  // wrap in a span (confirmed tags and auto-tag highlights are just plain
  // "@Name"/"Name" text with that styling on top, not a special atomic
  // node -- so the existing fromEditable()/picks string-based save logic
  // needs no changes at all). Ordinary typing is left completely alone (no
  // re-render on every keystroke); only Enter, toolbar clicks, picking a
  // tag, pasting and the auto-tag rescan ever rebuild the DOM, and each
  // does it through the same renderModel() + caret save/restore path.
  function richText(el) {
    let out = '';
    (function walk(node) {
      // ﻿ is renderModel()'s invisible caret anchor after a <br> --
      // never part of the note itself.
      if (node.nodeType === 3) { out += node.nodeValue.replace(/﻿/g, ''); return; }
      if (node.nodeType !== 1) return;
      if (node.tagName === 'BR') { out += '\n'; return; }
      for (const child of node.childNodes) walk(child);
    }(el));
    return out;
  }

  // Caret offset into the richText() string, from the current Selection
  // (0 if the selection isn't inside `el` at all).
  function caretOffset(el) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return 0;
    const range = sel.getRangeAt(0);
    if (!el.contains(range.startContainer)) return 0;
    const pre = range.cloneRange();
    pre.selectNodeContents(el);
    pre.setEnd(range.startContainer, range.startOffset);
    return preContentsText(pre).length;
  }
  // cloneContents() drops the live DOM's distinction between <br> and text,
  // so richText() needs a real (detached) element to walk -- this builds one.
  function preContentsText(range) {
    const holder = document.createElement('div');
    holder.appendChild(range.cloneContents());
    return richText(holder);
  }

  // The inverse: given an offset into the richText() string, a Range at that
  // point (collapsed) or spanning [start,end) when `end` is given.
  function offsetToRange(el, start, end) {
    const range = document.createRange();
    let remaining = start;
    let endRemaining = end == null ? null : end;
    let startSet = false;
    let endSet = end == null;
    (function walk(node) {
      if (startSet && endSet) return;
      if (node.nodeType === 3) {
        const len = node.nodeValue.length;
        if (!startSet && remaining <= len) { range.setStart(node, Math.max(0, remaining)); startSet = true; }
        else if (!startSet) remaining -= len;
        if (!endSet && endRemaining <= len) { range.setEnd(node, Math.max(0, endRemaining)); endSet = true; }
        else if (!endSet) endRemaining -= len;
        return;
      }
      if (node.nodeType !== 1) return;
      if (node.tagName === 'BR') {
        // A boundary set with setStartAfter()/setEndAfter() is a parent+
        // child-index position; even with a text node (very possibly
        // renderModel()'s own ﻿ caret anchor) sitting right there as
        // the next sibling, Chrome's native typing from a position like
        // that can still land in the text *before* the <br> instead of
        // after it. Anchoring into that next text node directly (offset 0)
        // is unambiguous and reliably respected.
        const next = node.nextSibling;
        const anchor = (atEnd) => { if (next && next.nodeType === 3) range[atEnd ? 'setEnd' : 'setStart'](next, 0); else range[atEnd ? 'setEndAfter' : 'setStartAfter'](node); };
        if (!startSet && remaining <= 1) { anchor(false); startSet = true; } else if (!startSet) remaining -= 1;
        if (!endSet && endRemaining <= 1) { anchor(true); endSet = true; } else if (!endSet) endRemaining -= 1;
        return;
      }
      for (const child of [...node.childNodes]) { walk(child); if (startSet && endSet) return; }
    }(el));
    if (!startSet) range.setStart(el, el.childNodes.length);
    if (!endSet) range.setEnd(el, el.childNodes.length);
    return range;
  }
  function setCaretOffset(el, offset) {
    const range = offsetToRange(el, offset);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // Rebuilds `el`'s DOM from plain text, wrapping the given ranges (sorted,
  // non-overlapping) in a span with `className`. `\n` becomes <br>.
  function renderModel(el, text, ranges = []) {
    el.innerHTML = '';
    let i = 0;
    const emit = (slice, span) => {
      const lines = slice.split('\n');
      lines.forEach((line, idx) => {
        if (idx > 0) el.appendChild(document.createElement('br'));
        if (!line) return;
        if (span) {
          const s = document.createElement('span');
          s.className = span.className;
          if (span.attrs) for (const k in span.attrs) s.setAttribute(k, span.attrs[k]);
          s.textContent = line;
          el.appendChild(s);
        } else {
          el.appendChild(document.createTextNode(line));
        }
      });
    };
    for (const r of ranges) {
      if (r.start > i) emit(text.slice(i, r.start), null);
      emit(text.slice(r.start, r.end), { className: r.className, attrs: r.attrs });
      i = r.end;
    }
    if (i < text.length) emit(text.slice(i), null);
    if (!text) el.appendChild(document.createTextNode(''));
    // A <br> with nothing after it, or another <br> right after it (a
    // trailing newline, or two in a row), leaves the caret with nowhere but
    // a parent+child-index position to anchor to there -- Chrome's native
    // typing from a position like that merges the next character into the
    // text run *before* the <br> instead of inserting after it. An empty
    // text node right after gives it somewhere unambiguous to land.
    [...el.childNodes].forEach((node) => {
      if (node.nodeName === 'BR' && (!node.nextSibling || node.nextSibling.nodeName === 'BR')) {
        // A genuinely empty text node gets optimized away as an anchor by
        // Chrome's own selection handling -- a zero-width space survives
        // and actually holds the position. richText() strips it back out.
        el.insertBefore(document.createTextNode('﻿'), node.nextSibling);
      }
    });
  }

  // Replaces [start,end) with `insert`, keeping the caret right after it.
  // Used for toolbar actions, picking a tag, and pasting -- the few things
  // that aren't native typing and need to rebuild the DOM. Any pending
  // auto-tag highlight spans are dropped rather than offset-shifted (their
  // offsets would otherwise go stale the moment anything earlier in the
  // text changes); wireAutoTagger's own rescan, which every splice triggers
  // via the 'input' event below, puts correct ones back right after.
  function spliceText(el, start, end, insert) {
    const text = richText(el);
    const next = text.slice(0, start) + insert + text.slice(end);
    renderModel(el, next);
    setCaretOffset(el, start + insert.length);
    el.focus();
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  const richWiredKey = '__pgRichWired';
  // Toggles a class (CSS shows the placeholder off it) instead of relying on
  // :empty -- contenteditable often leaves a lone, truly-empty-looking <br>
  // behind after the last character is deleted, which :empty wouldn't match.
  function syncEmpty(el) { el.classList.toggle('pg-text-empty', !richText(el).trim()); }

  // One-time setup shared by wireTagPicker/wireMarkdownTools/wireAutoTagger,
  // whichever of them runs first: makes `el` a working rich-text box (paste
  // pasted as plain text, a hard length cap, placeholder text) without
  // touching native typing at all. Also normalizes whatever initial text the
  // HTML template put in `el` (plain escaped text, no <br>s yet) into the
  // same <br>-based form every later render produces.
  function wireRichText(el, { maxLength = 4000 } = {}) {
    if (el[richWiredKey]) return;
    el[richWiredKey] = true;
    el.setAttribute('contenteditable', 'true');
    el.setAttribute('role', 'textbox');
    el.setAttribute('aria-multiline', 'true');
    renderModel(el, richText(el));
    syncEmpty(el);
    // Always insert a plain <br> ourselves (see the richText() comment on
    // why) rather than letting the browser wrap a new line in its own
    // block element. Ctrl/Cmd+Enter is left alone -- the desk page uses it
    // to save, not to add a line -- and so is a plain Enter while the "@"
    // suggestion box is open, which wireTagPicker's own keydown handler
    // (wired after this one) uses to pick the highlighted dog instead.
    el.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.isComposing || e.ctrlKey || e.metaKey) return;
      const wrap = el.closest('.pg-text-wrap');
      if (wrap && wrap.querySelector('.pg-suggest:not(.hidden)')) return;
      e.preventDefault();
      const caret = caretOffset(el);
      spliceText(el, caret, caret, '\n');
    });
    el.addEventListener('paste', (e) => {
      e.preventDefault();
      const text = (e.clipboardData || window.clipboardData).getData('text/plain').replace(/\r\n?/g, '\n');
      if (!text) return;
      const start = caretOffset(el);
      const sel = window.getSelection();
      const end = sel && sel.rangeCount && !sel.getRangeAt(0).collapsed ? start + preContentsText(sel.getRangeAt(0)).length : start;
      spliceText(el, start, end, text);
      el.dispatchEvent(new CustomEvent('pg-pasted', { bubbles: true }));
    });
    el.addEventListener('input', (e) => {
      // The ﻿ caret anchor (see renderModel) needs to survive the
      // *synthetic* 'input' event spliceText itself fires right after
      // planting one (stripping it then, before the real next keystroke
      // even happens, would be removing it before it's done its job) --
      // only a genuine, user-typed keystroke's input event should trigger
      // this cleanup. Once it does: caretOffset()/offsetToRange() count raw
      // text-node length and know nothing about ﻿, unlike richText(),
      // so leaving a stray one in the DOM any longer would make the two
      // disagree about what offset means what.
      if (e.isTrusted) {
        // deleteData(), not a wholesale node.nodeValue reassignment: Chrome
        // tracks a plain property reassignment as "this text node's content
        // was replaced" and resets where the *next* keystroke lands back to
        // its start, even though the reassignment produces the exact same
        // string the node already had everywhere but the removed character.
        // deleteData() is a well-defined, narrow mutation browsers already
        // know how to carry a nearby caret through correctly -- it's the
        // same primitive a native Backspace uses.
        (function stripAnchors(node) {
          if (node.nodeType === 3) {
            const i = node.nodeValue.indexOf('﻿');
            if (i !== -1) node.deleteData(i, 1);
            return;
          }
          for (const child of [...node.childNodes]) stripAnchors(child);
        }(el));
      }
      const text = richText(el);
      if (text.length > maxLength) {
        const caret = Math.min(caretOffset(el), maxLength);
        renderModel(el, text.slice(0, maxLength));
        setCaretOffset(el, caret);
      }
      syncEmpty(el);
    });
  }

  // ================= Writing: bold/italic/list toolbar + live preview =====
  function mdToolbarHtml() {
    return `<div class="md-toolbar pg-md-toolbar" role="toolbar" aria-label="Formatting">
      <button type="button" class="btn small-btn" data-md="bold" title="Bold"><strong>B</strong></button>
      <button type="button" class="btn small-btn" data-md="italic" title="Italic"><em>I</em></button>
      <button type="button" class="btn small-btn" data-md="bullet" title="Bulleted list">• List</button>
      <button type="button" class="btn small-btn" data-md="number" title="Numbered list">1. List</button>
    </div>`;
  }
  function selectionOffsets(el) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !el.contains(sel.anchorNode)) { const c = caretOffset(el); return [c, c]; }
    const range = sel.getRangeAt(0);
    const start = caretOffset(el);
    const end = range.collapsed ? start : start + preContentsText(range).length;
    return [Math.min(start, end), Math.max(start, end)];
  }
  function mdSurround(el, before, after, placeholder) {
    const [a, b] = selectionOffsets(el);
    const text = richText(el);
    const picked = text.slice(a, b) || placeholder;
    spliceText(el, a, b, before + picked + after);
  }
  function mdLinePrefix(el, prefix) {
    const [a] = selectionOffsets(el);
    const text = richText(el);
    const lineStart = text.lastIndexOf('\n', a - 1) + 1;
    spliceText(el, lineStart, lineStart, prefix);
  }
  const MD_ACTIONS = {
    bold: (el) => mdSurround(el, '**', '**', 'bold text'),
    italic: (el) => mdSurround(el, '*', '*', 'italic text'),
    bullet: (el) => mdLinePrefix(el, '- '),
    number: (el) => mdLinePrefix(el, '1. ')
  };
  // Wires the toolbar buttons (if any, inside `root`) and a live preview
  // (an element with class "pg-preview", if present) to a note's rich text
  // box.
  function wireMarkdownTools(root, el) {
    wireRichText(el);
    root.querySelectorAll('[data-md]').forEach((btn) => {
      // Without this, clicking the button moves focus to it first, which
      // clears the window Selection out of `el` -- unlike a textarea's
      // selectionStart/End, which survive a focus change, so the action
      // would always land back at the very start of the text.
      btn.addEventListener('mousedown', (e) => e.preventDefault());
      btn.addEventListener('click', () => MD_ACTIONS[btn.dataset.md](el));
    });
    const preview = root.querySelector('.pg-preview');
    if (!preview) return;
    const text = () => richText(el);
    const update = () => { const t = text(); preview.innerHTML = t.trim() ? bodyHtml(t, {}) : '<p class="muted small">Nothing typed yet.</p>'; };
    el.addEventListener('input', update);
    el.addEventListener('pg-pasted', update);
    update();
  }

  // Wires "@" tagging on a rich text box. `box` is the suggestion list's
  // element; getDogs() returns (a promise of) the dogs that can be tagged.
  function wireTagPicker(el, box, { getDogs, picks = new Map(), ownId = null, onChange } = {}) {
    wireRichText(el);
    let dogs = [];
    Promise.resolve(getDogs()).then((list) => { dogs = list || []; });
    let at = -1; // where the "@" being completed sits
    let shown = [];
    let sel = 0;
    const close = () => { box.classList.add('hidden'); at = -1; };
    const paint = () => {
      box.innerHTML = shown.map((d, i) => `<button type="button" class="pg-suggest-item${i === sel ? ' active' : ''}" role="option" aria-selected="${i === sel}" data-id="${d.id}">
          <img src="${d.photoUrl ? esc(d.photoUrl.replace(/^\/cached-images\/(\d+\.jpg)/, '/cached-images/thumbs/$1')) : `/dog-silhouettes/${d.id}.svg`}" alt="" loading="lazy" />
          <span class="pg-suggest-name">${esc(d.name)}</span>
          <span class="small muted nowrap">🏠 ${esc(d.kennelLocation || '?')}</span>
        </button>`).join('');
    };
    const update = () => {
      const caret = caretOffset(el);
      const upto = richText(el).slice(0, caret);
      const m = /(?:^|[^\w@])@([^@\n[\]#]{0,30})$/.exec(upto);
      if (!m) return close();
      const q = m[1].toLowerCase();
      shown = dogs.filter((d) => String(d.id) !== String(ownId) && nameMatches(d, q))
        .sort((a, b) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q)) || a.name.localeCompare(b.name))
        .slice(0, 6);
      if (!shown.length) return close();
      at = upto.length - m[1].length - 1;
      sel = 0;
      paint();
      box.classList.remove('hidden');
    };
    const pick = (d) => {
      const caret = caretOffset(el);
      const after = richText(el).slice(caret, caret + 1) === ' ' ? caret + 1 : caret;
      spliceText(el, at, after, `@${pickLabel(picks, d.name, d.id)} `);
      close();
      if (onChange) onChange();
    };
    box.addEventListener('mousedown', (e) => e.preventDefault()); // keep the keyboard up
    box.addEventListener('click', (e) => {
      const item = e.target.closest('.pg-suggest-item');
      const d = item && shown.find((x) => String(x.id) === item.dataset.id);
      if (d && at >= 0) pick(d);
    });
    el.addEventListener('input', () => { if (onChange) onChange(); update(); });
    el.addEventListener('pg-pasted', () => { if (onChange) onChange(); update(); });
    el.addEventListener('click', update);
    el.addEventListener('keyup', (e) => { if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End') update(); });
    // Arrow keys, Enter/Tab and Escape for keyboards (the desk page).
    el.addEventListener('keydown', (e) => {
      if (at < 0) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        sel = (sel + (e.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length;
        paint();
      } else if ((e.key === 'Enter' || e.key === 'Tab') && !e.ctrlKey && !e.metaKey && shown[sel]) {
        e.preventDefault();
        pick(shown[sel]);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    });
    el.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== el) close(); }, 300));
    return { body: () => fromEditable(richText(el).trim(), picks), picks };
  }

  // ================= Auto-detect: suggest a tag for a name typed without
  // "@" =================
  // On a pause in typing (and right after a paste), scan the note for a
  // known dog's name and wrap it in a clickable, green-outlined span --
  // still perfectly ordinary editable text, not a special node, so nothing
  // else in this file needs to know it's there. Clicking it either confirms
  // (turning it into a real "@Name " tag the same way the @ picker does) or
  // declines (back to plain text, and not suggested again this session).
  const SCAN_DEBOUNCE = 350;
  function wireAutoTagger(el, { getDogs, ownId = null, picks = new Map(), declineLabel = 'Not a dog' } = {}) {
    wireRichText(el);
    let dogs = [];
    Promise.resolve(getDogs()).then((list) => { dogs = list || []; });
    const declined = new Set(); // lowercased names the writer said "not a dog" for
    let popover = null;
    const closePopover = () => { if (popover) { popover.remove(); popover = null; } };

    // Every word/short phrase (1-3 tokens) in `text` that matches a known
    // dog's name, trying the longest phrase starting at each word first (so
    // "Lola (little Girl)" matches before plain "Lola" would), skipping
    // anything already an explicit @tag (handled by the picker) and
    // whatever word the caret is still inside (don't highlight something
    // mid-typing -- but a word the caret sits right at the end or start of,
    // having just been finished, is fair game).
    function findMatches(text, caret) {
      const words = [];
      const wordRe = /\S+/g;
      let wm;
      while ((wm = wordRe.exec(text))) words.push({ start: wm.index, end: wm.index + wm[0].length });
      const found = [];
      for (let i = 0; i < words.length; i += 1) {
        for (let n = Math.min(3, words.length - i); n >= 1; n -= 1) {
          const start = words[i].start, end = words[i + n - 1].end;
          if (caret > start && caret < end) continue; // still being typed
          if (text[start - 1] === '@') continue; // an explicit tag, not ours to touch
          const raw = text.slice(start, end);
          const trimmed = raw.replace(/^[.,!?;:()"']+|[.,!?;:()"']+$/g, '');
          if (!trimmed) continue;
          const needle = trimmed.toLowerCase();
          if (declined.has(needle)) continue;
          const matches = dogs.filter((d) => String(d.id) !== String(ownId) && d.name.toLowerCase() === needle);
          if (matches.length) {
            const trimStart = start + raw.indexOf(trimmed);
            found.push({ start: trimStart, end: trimStart + trimmed.length, text: trimmed, matches });
            break; // longest match wins at this starting word
          }
        }
      }
      // Non-overlapping, earliest first (two found phrases could only
      // overlap if they share a starting word from different outer-loop
      // iterations, which doesn't happen -- this is just a safety net).
      const kept = [];
      for (const f of found) {
        if (kept.some((k) => f.start < k.end && f.end > k.start)) continue;
        kept.push(f);
      }
      return kept;
    }

    function confirm(span, dog) {
      const start = Number(span.dataset.start), end = Number(span.dataset.end);
      // Consume a space that's already there rather than doubling it up --
      // same as the @ picker's pick().
      const after = richText(el).slice(end, end + 1) === ' ' ? end + 1 : end;
      spliceText(el, start, after, `@${pickLabel(picks, dog.name, dog.id)} `);
      closePopover();
    }
    function decline(span) {
      declined.add(span.textContent.toLowerCase());
      // Leave the text exactly as it is -- just stop treating it (and,
      // since offsets go stale as soon as anything about the text changes,
      // every other pending span too) as a suggestion; rescan() puts back
      // whichever of those are still genuinely unconfirmed, now correctly
      // positioned, and leaves this one out since it's in `declined` now.
      const caret = caretOffset(el);
      renderModel(el, richText(el));
      setCaretOffset(el, caret);
      closePopover();
      rescan();
    }
    function openPopover(span) {
      closePopover();
      const matches = JSON.parse(span.dataset.matches);
      const rect = span.getBoundingClientRect();
      popover = document.createElement('div');
      popover.className = 'pg-suggest pg-autotag-pop';
      popover.innerHTML = `${matches.map((d) => `<button type="button" class="pg-suggest-item" data-id="${d.id}">
          <span class="pg-suggest-name">Tag as ${esc(d.name)}</span>
          <span class="small muted nowrap">${d.kennelLocation ? `🏠 ${esc(d.kennelLocation)}` : ''}</span>
        </button>`).join('')}
        <button type="button" class="pg-suggest-item pg-autotag-decline">${esc(declineLabel)}</button>`;
      document.body.appendChild(popover);
      popover.style.position = 'fixed';
      popover.style.width = '260px';
      // Below the word when it fits on screen (above the keyboard, on a
      // phone), otherwise above it; never off either side.
      const viewH = window.visualViewport ? window.visualViewport.height : window.innerHeight;
      const h = popover.offsetHeight;
      const below = rect.bottom + 4;
      popover.style.top = `${below + h <= viewH - 8 ? below : Math.max(8, rect.top - h - 4)}px`;
      popover.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 268))}px`;
      popover.addEventListener('mousedown', (e) => e.preventDefault());
      popover.addEventListener('click', (e) => {
        const declineBtn = e.target.closest('.pg-autotag-decline');
        if (declineBtn) return decline(span);
        const item = e.target.closest('[data-id]');
        if (item) { const d = matches.find((x) => String(x.id) === item.dataset.id); if (d) confirm(span, d); }
      });
      setTimeout(() => document.addEventListener('click', onDocClick, { capture: true, once: true }), 0);
    }
    function onDocClick(e) { if (!popover || !popover.contains(e.target)) closePopover(); }

    el.addEventListener('click', (e) => {
      const span = e.target.closest('.pg-autotag');
      if (span && el.contains(span)) openPopover(span);
    });

    let timer = null;
    function rescan() {
      const text = richText(el);
      const caret = caretOffset(el);
      const found = findMatches(text, caret);
      // renderModel()'s span attrs go through setAttribute, which does its
      // own escaping -- the raw JSON (not esc()'d) is correct here.
      const ranges = found.map((f) => ({
        start: f.start, end: f.end, className: 'pg-autotag',
        attrs: { 'data-start': f.start, 'data-end': f.end, 'data-matches': JSON.stringify(f.matches.map((d) => ({ id: d.id, name: d.name, kennelLocation: d.kennelLocation || '' }))) }
      }));
      renderModel(el, text, ranges);
      setCaretOffset(el, caret);
    }
    el.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(rescan, SCAN_DEBOUNCE); });
    el.addEventListener('pg-pasted', () => { clearTimeout(timer); rescan(); });
    el.addEventListener('blur', () => { clearTimeout(timer); rescan(); });
  }

  window.PgTags = {
    TAG_RE, esc, pickLabel, toEditable, fromEditable, bodyHtml, bodyText, bodySnippet, linkifyYouTube,
    fmtDate, today, daysAgo, dateRowHtml, wireDateRow, wireTagPicker, mdToolbarHtml, wireMarkdownTools, wireAutoTagger,
    richText
  };
})();
