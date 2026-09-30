// ページ内で動く中核部分。拡張機能からは chrome.scripting.executeScript で各フレームに注入される。
// chrome.* には依存しない（テストでは素のページに読み込んで同じコードを検証する）。
//
// 守ること:
// - 送信・保存・申請ボタンは絶対に押さない（whyNotClick を通らない要素は click しない）
// - click はチェックボックスの切り替えと、ひな形の steps（画面を開くまでの操作）にだけ使う
// - パスワード欄とカード欄には触らない
// - 画面に入っている既存の値は外に出さない（scan の戻り値に含めない）
(() => {
  // 古い版が注入済みのタブでも、新しい版で置き換える
  if (window.__jevAF?.version >= 3) return;

  const SKIP_TYPES = new Set([
    'hidden', 'password', 'file', 'submit', 'button', 'reset', 'image',
    'checkbox', 'radio', 'color', 'range',
  ]);
  const ATTR = 'data-jevaf-id';
  let registry = [];

  const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').replace(/[*＊※]/g, '').trim();

  // document と、開いている shadow root をすべて辿る
  function* roots(root) {
    yield root;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    for (let n = walker.currentNode; n; n = walker.nextNode()) {
      if (n.shadowRoot) yield* roots(n.shadowRoot);
    }
  }

  function isVisible(el) {
    if (el.disabled || el.readOnly) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    return el.getClientRects().length > 0;
  }

  function isSensitive(el) {
    const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
    if (ac.startsWith('cc-') || ac === 'current-password' || ac === 'new-password' || ac === 'one-time-code') return true;
    const hint = `${el.name} ${el.id}`.toLowerCase();
    return /pass(word|wd)|card.?(number|no)|cvv|cvc|securitycode|暗証/.test(hint);
  }

  function textOf(node) {
    return clean(node?.innerText ?? node?.textContent ?? '');
  }

  // ラベルを推定する。上から順に信頼度が高い
  function labelOf(el) {
    const root = el.getRootNode();
    const aria = el.getAttribute('aria-label');
    if (aria) return clean(aria);

    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const t = by.split(/\s+/).map((id) => textOf(root.getElementById?.(id) ?? document.getElementById(id))).join(' ');
      if (clean(t)) return clean(t);
    }
    if (el.id && root.querySelector) {
      const lab = root.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lab && textOf(lab)) return textOf(lab);
    }
    const wrap = el.closest('label');
    if (wrap) {
      const t = clean([...wrap.childNodes].filter((n) => n !== el && !n.contains?.(el)).map(textOf).join(' '));
      if (t) return t;
    }
    // shadow DOM の中の欄は、ホスト要素の属性やラベルを見る（SAP / KAT-INPUT 系）
    const host = root instanceof ShadowRoot ? root.host : null;
    if (host) {
      const hl = host.getAttribute('label') || host.getAttribute('aria-label');
      if (hl) return clean(hl);
    }
    if (el.placeholder) return clean(el.placeholder);
    if (el.title) return clean(el.title);

    // 直前にある短いテキストを探す（表形式のフォームで多い）
    let cur = host || el;
    for (let depth = 0; depth < 4 && cur; depth++) {
      let sib = cur.previousElementSibling;
      while (sib) {
        const t = textOf(sib);
        if (t && t.length <= 40) return t;
        sib = sib.previousElementSibling;
      }
      cur = cur.parentElement;
    }
    return clean(el.name || el.id || '');
  }

  // その欄が属する「見出し」。表の行見出し（th）・fieldset の legend・直前の見出しを探す。
  // 「住所(ローマ字)」のように、欄のラベルだけでは分からない条件がここに書かれていることがある
  function sectionOf(el) {
    const root = el.getRootNode();
    const host = root instanceof ShadowRoot ? root.host : el;
    const row = host.closest?.('tr');
    const th = row?.querySelector('th') || row?.querySelector('td:first-child');
    if (th && !th.contains(host)) {
      const t = textOf(th);
      if (t && t.length <= 60) return t;
    }
    const legend = host.closest?.('fieldset')?.querySelector('legend');
    if (legend) {
      const t = textOf(legend);
      if (t && t.length <= 60) return t;
    }
    // 直前にある見出し要素
    let cur = host;
    for (let depth = 0; depth < 6 && cur; depth++) {
      let sib = cur.previousElementSibling;
      while (sib) {
        if (/^H[1-6]$/.test(sib.tagName) || sib.classList?.contains('title')) {
          const t = textOf(sib);
          if (t && t.length <= 60) return t;
        }
        sib = sib.previousElementSibling;
      }
      cur = cur.parentElement;
    }
    return '';
  }

  // checkboxes: true のときだけチェックボックスも読む（定型入力・貼り付け用。個人情報の入力では読まない）
  function scan({ checkboxes = false } = {}) {
    document.querySelectorAll(`[${ATTR}]`).forEach((e) => e.removeAttribute(ATTR));
    registry = [];
    const out = [];
    const skipped = [];

    for (const root of roots(document)) {
      const els = root.querySelectorAll('input, textarea, select, [contenteditable="true"]');
      for (const el of els) {
        const type = el.tagName === 'SELECT' ? 'select'
          : el.tagName === 'TEXTAREA' ? 'textarea'
          : el.isContentEditable && el.tagName !== 'INPUT' ? 'contenteditable'
          : (el.getAttribute('type') || 'text').toLowerCase();

        if (SKIP_TYPES.has(type) && !(checkboxes && type === 'checkbox')) {
          if (type === 'password') skipped.push({ label: labelOf(el), reason: 'パスワード欄' });
          continue;
        }
        if (isSensitive(el)) { skipped.push({ label: labelOf(el), reason: '機密情報の欄' }); continue; }
        if (!isVisible(el)) continue;

        const id = `f${registry.length}`;
        registry.push(el);
        el.setAttribute(ATTR, id);
        const label = labelOf(el) || `(無名の${type}欄)`;
        const field = {
          id, label, type, name: el.name || '', section: sectionOf(el),
          signature: `${label}|${el.name || ''}|${type}`,
          autocomplete: el.getAttribute('autocomplete') || '',
          placeholder: el.getAttribute('placeholder') || '',
          maxLength: el.maxLength > 0 ? el.maxLength : 0,
        };
        if (type === 'select') {
          field.options = [...el.options]
            .filter((o) => !o.disabled && clean(o.text) && o.value !== '')
            .map((o) => ({ value: o.value, text: clean(o.text) }));
        }
        out.push(field);
      }
    }
    return { url: location.origin + location.pathname, fields: out, skipped };
  }

  // --- 入力 -----------------------------------------------------------------
  function toDateValue(v) {
    const m = String(v).match(/(\d{4})[\/\-年.](\d{1,2})[\/\-月.](\d{1,2})/);
    return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : v;
  }

  function fire(el, type) {
    el.dispatchEvent(new Event(type, { bubbles: true, composed: true }));
  }

  // React などが value の setter を横取りしているので、プロトタイプの setter を直接呼ぶ
  function nativeSet(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  }

  function fillText(el, value) {
    el.focus();
    nativeSet(el, value);
    fire(el, 'input');
    fire(el, 'change');
    el.blur();
    if (el.value === value) return 'ok';

    // フレームワークに戻された場合は、実際のキー入力に近い形で入れ直す
    el.focus();
    el.select?.();
    el.ownerDocument.execCommand('insertText', false, value);
    fire(el, 'change');
    el.blur();
    return el.value === value ? 'ok(insertText)' : 'rejected';
  }

  function fillSelect(el, value) {
    const want = clean(value);
    const opts = [...el.options];
    const num = /^\d+$/.test(want) ? Number(want) : null;
    const digitsOf = (s) => (String(s).match(/^\D*(\d+)\D*$/) || [])[1];
    const hit = opts.find((o) => o.value === value)
      || opts.find((o) => clean(o.text) === want)
      // 数字（誕生月「1」など）は "01" / "1月" / "1日" と数値で照合する。部分一致だと「10月」に当たる
      || (num != null && opts.find((o) => Number(digitsOf(o.value)) === num || Number(digitsOf(clean(o.text))) === num))
      || opts.find((o) => want && (clean(o.text).includes(want) || want.includes(clean(o.text))) && clean(o.text));
    if (!hit) return 'no-option';
    el.focus();
    nativeSet(el, hit.value);
    fire(el, 'input');
    fire(el, 'change');
    el.blur();
    return el.value === hit.value ? 'ok' : 'rejected';
  }

  // 「✓」「はい」「on」などでチェック、「無」「いいえ」「off」などで外す。状態が変わるときだけ click する
  const OFF = /^(|0|false|off|no|いいえ|無|なし|☐|□|×|✗)$/i;
  function fillCheckbox(el, value) {
    const want = !OFF.test(clean(value));
    if (el.checked !== want) el.click();
    if (el.checked !== want) { el.checked = want; fire(el, 'input'); fire(el, 'change'); }
    return el.checked === want ? 'ok' : 'rejected';
  }

  function fillEditable(el, value) {
    el.focus();
    el.ownerDocument.execCommand('selectAll', false);
    el.ownerDocument.execCommand('insertText', false, value);
    el.blur();
    return clean(el.innerText) === clean(value) ? 'ok' : 'rejected';
  }

  function fill(assignments) {
    const results = [];
    for (const { id, value } of assignments) {
      const el = registry[Number(String(id).slice(1))];
      if (!el || !el.isConnected) { results.push({ id, status: 'missing' }); continue; }
      if (isSensitive(el) || el.type === 'password') { results.push({ id, status: 'blocked' }); continue; }
      let v = String(value ?? '');
      if (el.type === 'date') v = toDateValue(v);
      if (el.type === 'number') v = v.replace(/[,，円¥￥\s]/g, '');
      let status;
      try {
        status = el.type === 'checkbox' ? fillCheckbox(el, v)
          : el.tagName === 'SELECT' ? fillSelect(el, v)
          : el.isContentEditable && el.tagName !== 'INPUT' ? fillEditable(el, v)
          : fillText(el, v);
      } catch (e) {
        status = `error: ${e.message}`;
      }
      highlight(el, status.startsWith('ok') ? '#2f7d5c' : '#b4453a');
      results.push({ id, status, value: el.tagName === 'SELECT' ? el.options[el.selectedIndex]?.text : undefined });
    }
    return results;
  }

  // --- ひな形の steps（入力画面を開くまでの操作） --------------------------
  // 保存・提出・申請などに当たる語を含む要素は、絶対にクリックしない
  // 文字のどこかに出てきたら押さない
  const NEVER = /保存|提出|送信|削除|承認|却下|支払|submit|save|delete|remove|approve|reject/i;
  // その文字だけのボタンは押さない（TimePro の「申請」ボタンなど）
  const NEVER_EXACT = new Set(['申請', '申請する', '確定', '確定する', '実行', '送る', 'OK', 'はい', '登録']);
  // ボタンの形をしていて、この語を含むなら押さない（メニューの「打刻修正申請」などは押せる）
  const NEVER_ON_BUTTON = /申請|確定|実行|登録|精算/;
  const BUTTONISH = 'button,[type=submit],[type=button],[role=button]';

  function whyNotClick(el, t) {
    if (NEVER.test(t)) return '保存・提出などは押しません';
    if (NEVER_EXACT.has(t)) return `「${t}」ボタンは押しません`;
    if (NEVER_ON_BUTTON.test(t) && el?.matches?.(BUTTONISH)) return `「${t}」ボタンは押しません（申請・確定に当たるため）`;
    return null;
  }
  const CLICKABLE = 'button,a,[role=button],[role=menuitem],[role=menuitemradio],[role=option],[role=tab],[role=link],li,td,div,span,p';

  function isClickable(el) {
    if (el.matches('button,a,[role=button],[role=menuitem],[role=menuitemradio],[role=option],[role=tab],[role=link]')) return true;
    if (el.onclick || el.getAttribute('tabindex') !== null) return true;
    return getComputedStyle(el).cursor === 'pointer';
  }

  // 画面のどこかに text があるか（steps の待ち合わせに使う）
  function hasText(text) {
    const want = clean(text);
    for (const root of roots(document)) {
      const host = root === document ? document.body : root;
      if (host && textOf(host).includes(want)) return true;
    }
    return false;
  }

  function clickText(text) {
    const want = clean(text);
    if (!want) return { status: 'no-text' };
    if (NEVER.test(want) || NEVER_EXACT.has(want)) return { status: 'blocked', reason: whyNotClick(null, want) };
    let best = null;
    let bestLen = Infinity;
    for (const root of roots(document)) {
      for (const el of root.querySelectorAll(CLICKABLE)) {
        const t = textOf(el);
        if (!t || !t.includes(want) || t.length > want.length + 30) continue;
        if (whyNotClick(el, t)) continue;
        if (!isVisible(el) || !isClickable(el)) continue;
        if (t.length < bestLen) { best = el; bestLen = t.length; }
      }
    }
    if (!best) return { status: 'not-found' };
    const why = whyNotClick(best, textOf(best));
    if (why) return { status: 'blocked', reason: why };
    best.scrollIntoView({ block: 'center' });
    best.click();
    return { status: 'ok', text: textOf(best) };
  }

  function highlight(el, color) {
    el.style.setProperty('outline', `2px solid ${color}`, 'important');
    el.style.setProperty('outline-offset', '1px', 'important');
    el.dataset.jevafHl = '1';
  }

  function preview(items) {
    clearMarks();
    for (const { id, confidence } of items) {
      const el = registry[Number(String(id).slice(1))];
      if (el) highlight(el, confidence >= 0.7 ? '#c8643c' : '#c9a227');
    }
  }

  function clearMarks() {
    for (const root of roots(document)) {
      root.querySelectorAll('[data-jevaf-hl]').forEach((el) => {
        el.style.removeProperty('outline');
        el.style.removeProperty('outline-offset');
        delete el.dataset.jevafHl;
      });
    }
  }

  window.__jevAF = { scan, fill, preview, clearMarks, clickText, hasText, version: 3 };
})();
