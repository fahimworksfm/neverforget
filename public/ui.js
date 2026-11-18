/* ==========================================================================
   Shared UI: in-app messages, an in-app "are you sure?" dialog, and the
   week-detail sheet. Used by both the owner page and the partner view, so
   neither ever falls back to a browser alert() or confirm() box, which look
   like the phone is asking rather than the app, and cannot be styled or
   undone.
   ========================================================================== */

(() => {
  // Small DOM builder. Text always goes in as text, never as HTML.
  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of [].concat(children)) {
      if (c == null || c === false) continue;
      node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
  }

  const ICONS = {
    ok: 'M5 12.5l4.5 4.5L19 7.5',
    bad: 'M12 7.5v6M12 16.8v.2',
    info: 'M12 11v6M12 7.2v.2',
  };
  function icon(kind) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', 'toast-icon');
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', ICONS[kind] || ICONS.info);
    svg.append(path);
    return svg;
  }

  // ---------------------------------------------------------------- toast

  let region = null;
  let current = null;

  function ensureRegion() {
    if (region) return region;
    region = el('div', { class: 'toast-region', role: 'status', 'aria-live': 'polite' });
    document.body.append(region);
    return region;
  }

  // toast('Saved.') or toast('Recorded.', { kind: 'ok', action: { label:
  // 'Undo', run: fn }, seconds: 8 }). One at a time: a new message replaces
  // the old one. Returns a function that dismisses it.
  function toast(message, { kind = 'info', action = null, seconds = action ? 8 : 4 } = {}) {
    ensureRegion();
    current?.dismiss();

    let left = seconds;
    let timer = null;
    const actionBtn = action
      ? el('button', { type: 'button', class: 'toast-action' }, action.label)
      : null;
    const node = el('div', { class: `toast toast-${kind}` }, [
      icon(kind),
      el('span', { class: 'toast-text' }, message),
      actionBtn,
    ]);

    const handle = {
      dismiss() {
        clearInterval(timer);
        node.classList.add('is-leaving');
        setTimeout(() => node.remove(), 200);
        if (current === handle) current = null;
      },
    };

    const label = () => {
      if (actionBtn) actionBtn.textContent = action.countdown === false ? action.label : `${action.label} · ${left}`;
    };
    label();
    if (actionBtn) {
      actionBtn.addEventListener('click', () => {
        handle.dismiss();
        action.run();
      });
    }

    timer = setInterval(() => {
      left -= 1;
      if (left <= 0) handle.dismiss();
      else label();
    }, 1000);

    region.append(node);
    current = handle;
    return handle.dismiss;
  }

  // ------------------------------------------------------------------ ask

  // An in-app replacement for confirm(). Resolves true only on the OK button.
  function ask({ title, body = '', ok = 'OK', cancel = 'Cancel', danger = false }) {
    if (typeof HTMLDialogElement === 'undefined') {
      return Promise.resolve(window.confirm(`${title}\n\n${body}`));
    }
    return new Promise((resolve) => {
      const okBtn = el('button', { type: 'button', class: `btn ${danger ? 'btn-danger' : 'btn-primary btn-compact'}` }, ok);
      const cancelBtn = el('button', { type: 'button', class: 'btn' }, cancel);
      const dialog = el('dialog', { class: 'sheet', 'aria-labelledby': 'askTitle' }, [
        el('div', { class: 'sheet-grip', 'aria-hidden': 'true' }),
        el('h2', { class: 'sheet-title', id: 'askTitle' }, title),
        body ? el('p', { class: 'sheet-body' }, body) : null,
        el('div', { class: 'sheet-actions' }, [okBtn, cancelBtn]),
      ]);
      const finish = (answer) => {
        dialog.close();
        dialog.remove();
        resolve(answer);
      };
      okBtn.addEventListener('click', () => finish(true));
      cancelBtn.addEventListener('click', () => finish(false));
      dialog.addEventListener('cancel', (e) => {
        e.preventDefault();
        finish(false);
      });
      document.body.append(dialog);
      dialog.showModal();
      cancelBtn.focus();
    });
  }

  // ----------------------------------------------------------- week sheet

  const STATUS = {
    ontime: { word: 'On time', tone: 'ok' },
    late: { word: 'Late', tone: 'late' },
    missed: { word: 'Missed', tone: 'bad' },
    skipped: { word: 'Holiday', tone: 'neutral' },
    pending: { word: 'This week', tone: 'neutral' },
  };

  function weekState(w) {
    return w.status === 'confirmed' ? (w.onTime ? 'ontime' : 'late') : w.status;
  }

  function when(iso) {
    if (!iso) return null;
    return new Date(iso).toLocaleString(undefined, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  // Shows what happened in one week. `onMarkHoliday`, when given and the week
  // was missed, offers to turn the miss into a day off.
  function weekSheet(w, { onMarkHoliday = null } = {}) {
    if (typeof HTMLDialogElement === 'undefined') return;
    const s = STATUS[weekState(w)] || STATUS.pending;

    const rows = [
      ['Reminders sent', String(w.nudgeCount ?? 0)],
      ['Submitted', when(w.confirmedAt) || (w.status === 'confirmed' ? 'Yes' : 'Not yet')],
      w.holiday ? ['Holiday', w.holiday] : null,
      w.status === 'missed' && w.streakLost > 0
        ? ['Streak lost', `${w.streakLost} week${w.streakLost === 1 ? '' : 's'}`]
        : null,
      w.stake ? ['Stake', `$${w.stake.amount} · ${w.stake.status}`] : null,
    ].filter(Boolean);

    const close = el('button', { type: 'button', class: 'sheet-close', 'aria-label': 'Close' });
    close.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"></path></svg>';

    const canMark = Boolean(onMarkHoliday) && w.status === 'missed';
    const markBtn = canMark
      ? el('button', { type: 'button', class: 'btn btn-primary btn-compact' }, 'Mark as a holiday')
      : null;

    const dialog = el('dialog', { class: 'sheet', 'aria-labelledby': 'weekTitle' }, [
      el('div', { class: 'sheet-grip', 'aria-hidden': 'true' }),
      el('div', { class: 'sheet-head' }, [
        el('div', {}, [
          el('div', { class: 'sheet-kicker' }, w.label),
          el('h2', { class: `sheet-title tone-${s.tone}`, id: 'weekTitle' }, s.word),
        ]),
        close,
      ]),
      el(
        'dl',
        { class: 'sheet-rows' },
        rows.map(([k, v]) => el('div', { class: 'sheet-row' }, [el('dt', {}, k), el('dd', {}, v)]))
      ),
      canMark
        ? el('p', { class: 'sheet-note' },
            'Was this a day off? Mark it and the miss comes off the record. Any stake still owed is dropped.')
        : null,
      markBtn,
    ]);

    const shut = () => {
      dialog.close();
      dialog.remove();
    };
    close.addEventListener('click', shut);
    dialog.addEventListener('cancel', (e) => {
      e.preventDefault();
      shut();
    });
    // Tapping the dimmed area outside the sheet closes it.
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) shut();
    });
    if (markBtn) {
      markBtn.addEventListener('click', async () => {
        markBtn.disabled = true;
        const done = await onMarkHoliday(w);
        if (done) shut();
        else markBtn.disabled = false;
      });
    }

    document.body.append(dialog);
    dialog.showModal();
    close.focus();
  }

  // Renders the 12-week record as buttons, each labelled with its date.
  function renderWeeks(host, history, onOpen) {
    host.replaceChildren(
      ...history.map((w) => {
        const s = weekState(w);
        const date = (w.label || '').replace(/^\w+,\s*/, '');
        const word = (STATUS[s] || STATUS.pending).word;
        const btn = el('button', { type: 'button', class: 'hweek', 'aria-label': `${w.label}: ${word}` }, [
          el('span', { class: 'hbar', 'data-s': s, 'aria-hidden': 'true' }),
          el('span', { class: 'hdate', 'aria-hidden': 'true' }, date),
        ]);
        btn.addEventListener('click', () => onOpen(w));
        return btn;
      })
    );
  }

  window.ui = { el, toast, ask, weekSheet, renderWeeks };
})();
