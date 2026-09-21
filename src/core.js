// ページ内で動く中核部分。拡張機能からは chrome.scripting.executeScript で各フレームに注入される。
// chrome.* には依存しない（テストでは素のページに読み込んで同じコードを検証する）。
//
// 守ること:
// - 送信・保存ボタンは絶対に押さない（click は一切呼ばない）
// - パスワード欄とカード欄には触らない
// - 画面に入っている既存の値は外に出さない（scan の戻り値に含めない）
(() => {
  if (window.__jevAF) return;

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

  function scan() {
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

        if (SKIP_TYPES.has(type)) {
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
          id, label, type, name: el.name || '', signature: `${label}|${el.name || ''}|${type}`,
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
        status = el.tagName === 'SELECT' ? fillSelect(el, v)
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

  window.__jevAF = { scan, fill, preview, clearMarks, version: 1 };
})();
