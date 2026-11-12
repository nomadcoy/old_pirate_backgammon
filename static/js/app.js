/* ═══════════════════════════════════════════════════════════════
   OLD PIRATE GAMMON — cliente
   ═══════════════════════════════════════════════════════════════ */
'use strict';

(() => {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const LS = {
    nick: 'opg.nick',
    token: 'opg.token',
    sound: 'opg.sound',
  };

  const POINTS_TOP = [13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24];
  const POINTS_BOTTOM = [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
  const PIP_CELLS = {
    1: [4],
    2: [0, 8],
    3: [0, 4, 8],
    4: [0, 2, 6, 8],
    5: [0, 2, 4, 6, 8],
    6: [0, 2, 3, 5, 6, 8],
  };
  const INITIAL_POINTS = (() => {
    const p = Array(25).fill(0);
    p[24] = 2; p[13] = 5; p[8] = 3; p[6] = 5;
    p[1] = -2; p[12] = -5; p[17] = -3; p[19] = -5;
    return p;
  })();

  const store = {
    nick: localStorage.getItem(LS.nick) || '',
    token: localStorage.getItem(LS.token) || '',
    sound: localStorage.getItem(LS.sound) !== 'off',
    screen: 'login',
    lobby: { tables: [], online: 0, lan_url: '' },
    table: null,
    seat: null,
    spectator: false,
    chat: [],
    selected: null,
    overlayDismissed: false,
    pendingHello: false,
    pendingCode: (new URLSearchParams(location.search).get('mesa') || '')
      .toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4) || null,
    lastRollKey: '',
    rollFxUntil: 0,
    loginBusy: false,
  };

  const pointEls = {};
  const barEls = {};
  const offEls = {};
  let audioCtx = null;
  let lastStateForFx = null;

  // ─────────────────────────────────────────────────────────── utils
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  };

  const saveSession = () => {
    try {
      if (store.nick) localStorage.setItem(LS.nick, store.nick);
      if (store.token) localStorage.setItem(LS.token, store.token);
    } catch (_) { /* modo privado */ }
  };

  const currentState = () => (store.table ? store.table.state : null);

  const myTurn = (st) =>
    !!st && Number.isInteger(store.seat) && st.turn === store.seat && !st.game_over;

  const seatNick = (i, st) => {
    const s = st || currentState();
    if (store.table && store.table.seats && store.table.seats[i]) {
      return store.table.seats[i].nick;
    }
    return `Jogador ${i + 1}`;
  };

  const baseUrl = () => {
    const origin = location.origin || '';
    const host = location.hostname;
    const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
    const lan = (store.lobby && store.lobby.lan_url) ? store.lobby.lan_url.replace(/\/$/, '') : '';
    if (isLoopback && lan) return lan;
    if (origin.startsWith('http')) return origin;
    return lan || 'http://127.0.0.1:5000';
  };

  const fmtTime = (ts) => {
    try {
      return new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    } catch (_) {
      return '';
    }
  };

  const showScreen = (name) => {
    store.screen = name;
    document.body.dataset.screen = name;
    ['login', 'lobby', 'game'].forEach((s) => {
      const node = $('#screen-' + s);
      if (node) node.hidden = s !== name;
    });
    $('#leave-btn').hidden = name !== 'game';
    $('#user-chip').hidden = !store.nick;
    $('#logout-btn').hidden = !store.nick || name === 'login';
    if (name !== 'game') {
      document.title = 'Old Pirate Gammon';
      store.overlayDismissed = false;
    }
    if (name === 'login') {
      setTimeout(() => $('#nick-input') && $('#nick-input').focus(), 60);
    }
  };

  const setNet = (state, label) => {
    const dot = $('#net-status .dot');
    const text = $('#net-label');
    if (!dot || !text) return;
    dot.className = 'dot ' + (state === true ? 'online' : state === 'warn' ? 'amber' : 'off');
    text.textContent = label || (state === true ? 'online' : 'reconectando…');
  };

  // ─────────────────────────────────────────────────────────── som
  const audio = () => {
    if (!store.sound) return null;
    try {
      if (!audioCtx) {
        const C = window.AudioContext || window.webkitAudioContext;
        if (!C) return null;
        audioCtx = new C();
      }
      if (audioCtx.state === 'suspended') audioCtx.resume();
      return audioCtx;
    } catch (_) {
      return null;
    }
  };

  const blip = (freq, dur = 0.06, type = 'sine', vol = 0.025, delay = 0) => {
    const ctx = audio();
    if (!ctx) return;
    try {
      const t0 = ctx.currentTime + delay;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t0);
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.linearRampToValueAtTime(vol, t0 + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + dur + 0.03);
    } catch (_) { /* sem áudio */ }
  };

  const sfx = {
    tick: () => blip(430, 0.035, 'square', 0.014),
    move: () => { blip(250, 0.05, 'triangle', 0.025); blip(180, 0.05, 'triangle', 0.018, 0.04); },
    roll: () => {
      for (let i = 0; i < 5; i++) {
        setTimeout(() => blip(170 + Math.random() * 260, 0.035, 'square', 0.012), i * 46);
      }
    },
    chat: () => blip(720, 0.04, 'sine', 0.012),
    turn: () => { blip(620, 0.08, 'sine', 0.03); blip(880, 0.12, 'sine', 0.028, 0.1); },
    warn: () => { blip(330, 0.12, 'square', 0.022); blip(280, 0.14, 'square', 0.018, 0.14); },
    win: () => [523, 659, 784, 1047].forEach((f, i) => blip(f, 0.18, 'sine', 0.03, i * 0.11)),
    lose: () => [330, 262, 196].forEach((f, i) => blip(f, 0.2, 'triangle', 0.026, i * 0.13)),
  };

  const applySoundToggle = () => {
    const b = $('#sound-toggle');
    if (!b) return;
    b.textContent = store.sound ? '♪ som' : '♪ mudo';
    b.style.opacity = store.sound ? '1' : '.55';
    b.setAttribute('aria-pressed', store.sound ? 'true' : 'false');
  };

  // ─────────────────────────────────────────────────────────── toasts
  const toast = (text, kind = 'info') => {
    const wrap = $('#toasts');
    if (!wrap) return;
    while (wrap.children.length >= 4) wrap.firstElementChild.remove();
    const node = el('div', 'toast ' + kind, text);
    wrap.appendChild(node);
    setTimeout(() => {
      node.classList.add('out');
      setTimeout(() => node.remove(), 220);
    }, 4200);
  };

  // ─────────────────────────────────────────────────────────── socket
  const socket = io({
    autoConnect: false,
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 700,
    reconnectionDelayMax: 5000,
  });

  socket.on('connect', () => {
    setNet(true);
    if (store.nick && (store.token || store.pendingHello || store.nick)) {
      socket.emit('hello', { nick: store.nick, token: store.token || null });
    }
    if (store.table && store.screen === 'game') {
      // re-sincroniza a mesa após queda de conexão
      socket.emit('lobby');
    }
  });

  socket.on('disconnect', () => {
    setNet('off', 'reconectando…');
    if (store.screen === 'game') {
      const extra = $('#status-extra');
      if (extra) extra.textContent = 'conexão perdida — tentando voltar…';
    }
  });

  socket.on('connect_error', () => setNet('off', 'sem conexão'));

  socket.on('hello_ok', (d) => {
    store.nick = d.nick;
    store.token = d.token;
    store.pendingHello = false;
    store.seat = Number.isInteger(d.seat) ? d.seat : null;
    store.spectator = !!d.spectator;
    if (d.table) store.table = store.table && store.table.code === d.table ? store.table : store.table;
    saveSession();
    $('#user-nick').textContent = store.nick;
    $('#user-chip').hidden = false;
    restoreLoginBtn();

    if (!d.table) {
      if (store.table) resetTable();
      showScreen('lobby');
      if (store.pendingCode) {
        const code = store.pendingCode;
        store.pendingCode = null;
        try { history.replaceState(null, '', location.pathname); } catch (_) {}
        socket.emit('join_table', { code });
      } else {
        socket.emit('lobby');
      }
    } else {
      store.seat = Number.isInteger(d.seat) ? d.seat : null;
      store.spectator = !!d.spectator;
      if (store.pendingCode) {
        store.pendingCode = null;
        try { history.replaceState(null, '', location.pathname); } catch (_) {}
      }
    }
  });

  socket.on('lobby_state', (d) => {
    store.lobby = d || { tables: [], online: 0 };
    renderLobby();
  });

  socket.on('table_joined', (d) => {
    store.table = {
      code: d.code,
      name: d.name,
      target: d.target,
      seats: d.seats || [null, null],
      spectators: d.spectators || [],
      state: d.state || null,
    };
    store.seat = Number.isInteger(d.seat) ? d.seat : null;
    store.spectator = !!d.spectator;
    store.selected = null;
    store.overlayDismissed = false;
    store.chat = Array.isArray(d.chat) ? d.chat.slice(-150) : [];
    lastStateForFx = null;
    $('#chat-input').value = '';
    renderChatAll();
    showScreen('game');
    buildBoard();
    renderGame();
    applyStateFx(null, store.table.state, true);
    lastStateForFx = store.table.state;
  });

  socket.on('table_state', (d) => {
    if (!store.table || !d || d.code !== store.table.code) return;
    const prev = store.table.state;
    store.table = {
      code: d.code,
      name: d.name,
      target: d.target,
      seats: d.seats || [null, null],
      spectators: d.spectators || [],
      state: d.state || null,
    };
    ensureSelection(store.table.state);
    applyStateFx(prev, store.table.state, false);
    renderGame();
    lastStateForFx = store.table.state;
  });

  socket.on('table_left', () => {
    resetTable();
    showScreen('lobby');
    socket.emit('lobby');
  });

  socket.on('chat', (msg) => {
    if (!msg) return;
    if (msg.room && store.table && msg.room !== store.table.code) return;
    if (!store.table) return;
    store.chat.push(msg);
    if (store.chat.length > 160) store.chat = store.chat.slice(-150);
    appendChat(msg);
    if (msg.kind !== 'system' && msg.nick !== store.nick) sfx.chat();
  });

  socket.on('toast', (d) => {
    if (!d) return;
    toast(d.text || 'algo deu errado', d.kind === 'error' ? 'error' : 'warn');
    if (store.loginBusy) restoreLoginBtn();
  });

  // ─────────────────────────────────────────────────────────── login / lobby
  const restoreLoginBtn = () => {
    store.loginBusy = false;
    const b = $('#nick-form button[type=submit]');
    if (b) {
      b.disabled = false;
      b.textContent = 'ENTRAR';
    }
  };

  const resetTable = () => {
    store.table = null;
    store.seat = null;
    store.spectator = false;
    store.chat = [];
    store.selected = null;
    store.overlayDismissed = false;
    lastStateForFx = null;
    const body = $('#chat-body');
    if (body) body.innerHTML = '';
    const input = $('#chat-input');
    if (input) input.value = '';
    document.title = 'Old Pirate Gammon';
  };

  $('#nick-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#nick-input');
    const nick = (input.value || '').trim().replace(/[<>\u0000-\u001f]/g, '').slice(0, 16);
    if (nick.length < 2) {
      input.classList.remove('shake');
      void input.offsetWidth;
      input.classList.add('shake');
      toast('Nickname precisa de 2 a 16 caracteres.', 'error');
      input.focus();
      return;
    }
    store.nick = nick;
    saveSession();
    store.loginBusy = true;
    const b = $('#nick-form button[type=submit]');
    b.disabled = true;
    b.textContent = 'ENTRANDO…';
    store.pendingHello = true;
    ensureAudioUnlock();
    if (socket.connected) socket.emit('hello', { nick, token: store.token || null });
    else toast('Conectando…');
  });

  $('#code-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#code-input');
    const code = (input.value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
    if (code.length < 4) {
      toast('Digite o código de 4 caracteres da mesa.', 'error');
      input.focus();
      return;
    }
    socket.emit('join_table', { code });
    input.value = '';
  });

  $('#code-input').addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
  });

  $('#quick-btn').addEventListener('click', () => {
    ensureAudioUnlock();
    socket.emit('quick_match');
  });

  $$('#target-seg button').forEach((b) => {
    b.addEventListener('click', () => {
      $$('#target-seg button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      sfx.tick();
    });
  });

  $('#create-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = ($('#table-name').value || '').trim();
    const active = $('#target-seg .active');
    const target = parseInt(active ? active.dataset.target : '5', 10) || 5;
    ensureAudioUnlock();
    socket.emit('create_table', { name, target });
    $('#table-name').value = '';
  });

  $('#sound-toggle').addEventListener('click', () => {
    store.sound = !store.sound;
    localStorage.setItem(LS.sound, store.sound ? 'on' : 'off');
    applySoundToggle();
    if (store.sound) { ensureAudioUnlock(); sfx.tick(); }
  });

  $('#user-chip').addEventListener('click', () => {
    if (!store.nick) return;
    const raw = window.prompt('Novo nickname (2 a 16 caracteres):', store.nick);
    if (raw === null) return;
    const nick = raw.trim().replace(/[<>\u0000-\u001f]/g, '').slice(0, 16);
    if (nick.length < 2) {
      toast('Nickname inválido.', 'error');
      return;
    }
    store.nick = nick;
    saveSession();
    $('#user-nick').textContent = nick;
    socket.emit('hello', { nick, token: store.token || null });
  });

  const logout = () => {
    if (store.table) {
      const inGame = store.table.state && !store.table.state.game_over && !store.spectator;
      const question = inGame
        ? 'Sair da conta? A partida em andamento será encerrada.'
        : 'Sair da conta e voltar ao login?';
      if (!window.confirm(question)) return;
    }
    if (socket.connected) socket.emit('logout');
    try {
      localStorage.removeItem(LS.nick);
      localStorage.removeItem(LS.token);
    } catch (_) { /* modo privado */ }
    store.nick = '';
    store.token = '';
    store.pendingHello = false;
    store.pendingCode = null;
    store.loginBusy = false;
    const nickInput = $('#nick-input');
    if (nickInput) nickInput.value = '';
    const nickLabel = $('#user-nick');
    if (nickLabel) nickLabel.textContent = '';
    $('#user-chip').hidden = true;
    $('#logout-btn').hidden = true;
    resetTable();
    try { history.replaceState(null, '', location.pathname); } catch (_) {}
    showScreen('login');
    restoreLoginBtn();
  };

  $('#logout-btn').addEventListener('click', logout);

  $('#leave-btn').addEventListener('click', () => {
    if (!store.table) { resetTable(); showScreen('lobby'); return; }
    const inGame = store.table.state && !store.table.state.game_over && !store.spectator;
    const question = store.spectator
      ? 'Sair da mesa?'
      : inGame
        ? 'Sair da mesa? A partida em andamento será encerrada.'
        : 'Sair da mesa?';
    if (!window.confirm(question)) return;
    socket.emit('leave_table');
    resetTable();
    showScreen('lobby');
  });

  $('#brand').addEventListener('click', () => {
    if (store.screen === 'login') {
      const inp = $('#nick-input');
      if (inp) inp.focus();
    }
  });

  $('#copy-lan').addEventListener('click', () => copyText(baseUrl(), 'Link copiado.'));
  $('#invite-btn').addEventListener('click', () => {
    if (!store.table) return;
    copyText(`${baseUrl()}/?mesa=${store.table.code}`, `Convite da mesa ${store.table.code} copiado.`);
  });

  const copyText = async (text, okMessage) => {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      toast(okMessage || 'Copiado.', 'warn');
    } catch (_) {
      toast('Não foi possível copiar. Selecione manualmente: ' + text, 'error');
    }
  };

  const joinTable = (code) => {
    ensureAudioUnlock();
    socket.emit('join_table', { code });
  };

  const renderLobby = () => {
    const data = store.lobby || { tables: [], online: 0 };
    const online = $('#lobby-online');
    if (online) online.textContent = data.online || 0;
    const lan = $('#lan-url');
    if (lan) lan.textContent = (baseUrl() || 'http://127.0.0.1:5000') + '/';
    const loginLan = $('#login-lan');
    if (loginLan) loginLan.textContent = location.host || 'porta 5000';

    const list = $('#table-list');
    if (!list) return;
    list.innerHTML = '';
    const tables = data.tables || [];
    $('#empty-tables').hidden = tables.length > 0;

    tables.forEach((t) => {
      const row = el('div', 'table-row');
      row.dataset.code = t.code;
      row.title = `entrar na mesa ${t.code}`;

      const code = el('div', 'tr-code', t.code);
      const name = el('div', 'tr-name');
      name.appendChild(el('b', '', t.name || `Mesa ${t.code}`));
      const statusText = {
        waiting: 'aguardando',
        playing: 'em jogo',
        intermission: 'intervalo',
        finished: 'encerrada',
      }[t.status] || t.status;
      const small = el('small', '');
      const statusDot = el('span', 'p-dot ' + (t.status === 'waiting' ? 'empty' : t.status === 'finished' ? 's0' : 's1'));
      small.appendChild(statusDot);
      small.appendChild(document.createTextNode(' até ' + t.target + ' · ' + statusText));
      name.appendChild(small);

      const players = el('div', 'tr-players');
      const p0 = t.players && t.players[0];
      const p1 = t.players && t.players[1];
      players.appendChild(playerPill(p0, 0));
      players.appendChild(el('span', 'vs', 'vs'));
      players.appendChild(playerPill(p1, 1));

      const score = el('div', 'tr-score');
      if (t.scores) {
        score.appendChild(document.createTextNode(`${t.scores[0]} — ${t.scores[1]}`));
        score.appendChild(el('small', '', `jogo ${t.game_no || 0}`));
      } else {
        score.appendChild(document.createTextNode('—'));
        score.appendChild(el('small', '', `alvo ${t.target}`));
      }

      const action = el('div', 'tr-action');
      const full = (t.seated || 0) >= 2;
      const btn = el('button', 'btn', full ? 'assistir' : 'sentar');
      btn.type = 'button';
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        joinTable(t.code);
      });
      action.appendChild(btn);

      row.append(code, name, players, score, action);
      row.addEventListener('click', () => joinTable(t.code));
      list.appendChild(row);
    });
  };

  const playerPill = (p, seat) => {
    const wrap = el('span', 'tr-player');
    wrap.appendChild(el('span', 'p-dot s' + seat + (p ? '' : ' empty')));
    wrap.appendChild(el('span', '', p ? p.nick : 'livre'));
    return wrap;
  };

  // ─────────────────────────────────────────────────────────── jogo: helpers
  const ensureSelection = (st) => {
    if (store.selected === null) return;
    if (!st || !myTurn(st) || st.phase !== 'moving') {
      store.selected = null;
      return;
    }
    if (!st.legal.some((m) => m.from === store.selected)) store.selected = null;
  };

  const sendMove = (from, to) => {
    store.selected = null;
    socket.emit('move', { from, to });
  };

  const moveFromTo = (st, from, to) => {
    if (!st) return null;
    return st.legal.find((m) => m.from === from && m.to === to) || null;
  };

  const handlePointClick = (pt) => {
    const st = currentState();
    if (!st || st.game_over || st.phase !== 'moving' || !myTurn(st)) return;

    if (store.selected !== null && moveFromTo(st, store.selected, pt)) {
      sendMove(store.selected, pt);
      return;
    }

    const isSource = st.legal.some((m) => m.from === pt);
    if (isSource) {
      if (store.selected === pt) {
        if (moveFromTo(st, pt, 'off')) {
          sendMove(pt, 'off');
          return;
        }
        store.selected = null;
      } else {
        store.selected = pt;
        sfx.tick();
      }
      renderGame();
      return;
    }

    if (store.selected !== null) {
      store.selected = null;
      renderGame();
    }
  };

  const handleBarClick = (player) => {
    if (player !== store.seat) return;
    const st = currentState();
    if (!st || st.game_over || st.phase !== 'moving' || !myTurn(st)) return;
    if (!st.legal.some((m) => m.from === 'bar')) return;
    store.selected = store.selected === 'bar' ? null : 'bar';
    sfx.tick();
    renderGame();
  };

  const handleOffClick = (player) => {
    if (player !== store.seat) return;
    const st = currentState();
    if (!st || st.game_over || st.phase !== 'moving' || !myTurn(st)) return;
    const offMoves = st.legal.filter((m) => m.to === 'off');
    if (!offMoves.length) return;
    if (store.selected !== null) {
      if (moveFromTo(st, store.selected, 'off')) sendMove(store.selected, 'off');
      return;
    }
    // sem seleção: seleciona a primeira ficha que pode sair
    store.selected = offMoves[0].from;
    sfx.tick();
    renderGame();
  };

  // ─────────────────────────────────────────────────────────── tabuleiro
  const buildBoard = () => {
    const board = $('#board');
    if (!board) return;
    board.innerHTML = '';
    Object.keys(pointEls).forEach((k) => delete pointEls[k]);
    Object.keys(barEls).forEach((k) => delete barEls[k]);
    Object.keys(offEls).forEach((k) => delete offEls[k]);

    // Assento 1 vê o tabuleiro espelhado: a casa dele (19-24) fica embaixo à direita.
    const flip = Number.isInteger(store.seat) && store.seat === 1;
    const topPoints = flip
      ? [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]
      : [13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24];
    const bottomPoints = flip
      ? [13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24]
      : [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
    const topBarPlayer = flip ? 0 : 1;
    const bottomBarPlayer = flip ? 1 : 0;

    const makePoint = (pt, row, idx) => {
      const node = el('div', 'point ' + row + (idx % 2 === 1 ? ' alt' : ''));
      node.dataset.pt = String(pt);
      node.style.gridRow = row === 'top' ? '1' : '2';
      node.style.gridColumn = String(idx < 6 ? idx + 1 : idx + 2);
      board.appendChild(node);
      pointEls[pt] = node;
    };

    topPoints.forEach((pt, idx) => makePoint(pt, 'top', idx));
    bottomPoints.forEach((pt, idx) => makePoint(pt, 'bottom', idx));

    const bar = el('div', 'bar');
    const trayTop = el('div', 'bar-tray top');
    trayTop.dataset.bar = String(topBarPlayer);
    trayTop.title = 'fichas na barra';
    const trayBottom = el('div', 'bar-tray bottom');
    trayBottom.dataset.bar = String(bottomBarPlayer);
    trayBottom.title = 'fichas na barra';
    bar.append(trayTop, trayBottom, el('span', 'bar-label', 'barra'));
    board.appendChild(bar);
    barEls[topBarPlayer] = trayTop;
    barEls[bottomBarPlayer] = trayBottom;

    const makeOff = (player, cls) => {
      const node = el('div', 'off-tray ' + cls);
      node.dataset.off = String(player);
      node.style.gridColumn = '14';
      node.style.gridRow = cls === 'top' ? '1' : '2';
      node.title = 'fichas fora do tabuleiro';
      node.append(el('span', 'off-label', 'fora'), el('span', 'off-count', '0'));
      board.appendChild(node);
      offEls[player] = node;
    };
    makeOff(flip ? 0 : 1, 'top');
    makeOff(flip ? 1 : 0, 'bottom');

    board.onclick = (ev) => {
      const off = ev.target.closest('.off-tray');
      if (off) { handleOffClick(Number(off.dataset.off)); return; }
      const tray = ev.target.closest('.bar-tray');
      if (tray) { handleBarClick(Number(tray.dataset.bar)); return; }
      const point = ev.target.closest('.point');
      if (point) handlePointClick(Number(point.dataset.pt));
    };
  };

  const makeChecker = (owner, size) => {
    const c = el('div', 'checker p' + owner);
    c.style.width = size + 'px';
    c.style.height = size + 'px';
    return c;
  };

  const stackSize = (count) => {
    const board = $('#board');
    const boardH = (board && board.clientHeight) || 470;
    const available = Math.max(70, boardH / 2 - 34);
    const raw = count > 0 ? Math.floor(available / count) : 26;
    return Math.max(9, Math.min(26, raw));
  };

  const renderBoard = () => {
    const st = currentState();
    const points = st ? st.points : INITIAL_POINTS;
    const bar = st ? st.bar : [0, 0];
    const off = st ? st.off : [0, 0];
    const legal = (st && myTurn(st) && st.phase === 'moving') ? st.legal : [];
    const sources = new Set(legal.map((m) => m.from));
    const dests = new Set(
      store.selected !== null
        ? legal.filter((m) => m.from === store.selected).map((m) => m.to)
        : []
    );

    for (let pt = 1; pt <= 24; pt++) {
      const node = pointEls[pt];
      if (!node) continue;
      node.innerHTML = '';
      const val = points[pt] || 0;
      const count = Math.abs(val);
      const owner = val > 0 ? 0 : 1;
      node.classList.toggle('selected', store.selected === pt);
      node.classList.toggle('can-move', sources.has(pt));
      node.classList.toggle('valid', dests.has(pt));
      if (count > 0) {
        const cs = stackSize(count);
        for (let i = 0; i < count; i++) node.appendChild(makeChecker(owner, cs));
      }
      node.appendChild(el('span', 'pt-num', String(pt)));
    }

    [0, 1].forEach((player) => {
      const tray = barEls[player];
      if (!tray) return;
      tray.innerHTML = '';
      const count = bar[player] || 0;
      for (let i = 0; i < count; i++) tray.appendChild(makeChecker(player, 19));
      tray.classList.toggle('can-move', player === store.seat && sources.has('bar'));
      tray.classList.toggle('selected', player === store.seat && store.selected === 'bar');
      tray.classList.toggle('valid', player === store.seat && dests.has('bar'));
    });

    [0, 1].forEach((player) => {
      const tray = offEls[player];
      if (!tray) return;
      const count = off[player] || 0;
      tray.innerHTML = '';
      tray.appendChild(el('span', 'off-label', 'fora'));
      tray.appendChild(el('span', 'off-count', String(count)));
      const canOff = player === store.seat && legal.some((m) => m.to === 'off');
      const isValid = player === store.seat && dests.has('off');
      tray.classList.toggle('can-move', canOff);
      tray.classList.toggle('valid', isValid);
      tray.classList.toggle('selected', false);
      tray.title = player === store.seat && canOff
        ? 'clique para tirar a ficha selecionada'
        : `${count} ficha(s) fora`;
    });
  };

  // ─────────────────────────────────────────────────────────── jogadores / status
  const renderPlayers = (st) => {
    const wrap = $('#players');
    if (!wrap) return;
    wrap.innerHTML = '';
    const seats = (store.table && store.table.seats) || [null, null];
    const scores = st ? st.scores : [0, 0];
    const target = (st && st.target) || (store.table && store.table.target) || 5;

    for (let i = 0; i < 2; i++) {
      const p = seats[i];
      const active = !!st && !st.game_over && st.turn === i;
      const card = el('div', 'player-card seat' + i + (active ? ' active' : '') + (p ? '' : ' empty-slot'));

      const top = el('div', 'pc-top');
      top.appendChild(el('span', 'pc-dot'));
      const name = el('span', 'pc-name', p ? p.nick : 'assento livre');
      top.appendChild(name);

      const tags = el('div', 'pc-tags');
      if (Number.isInteger(store.seat) && store.seat === i) tags.appendChild(el('span', 'pc-tag you', 'você'));
      if (p && !p.connected) tags.appendChild(el('span', 'pc-tag off', 'offline'));
      if (active) tags.appendChild(el('span', 'pc-tag turn', 'na vez'));
      top.appendChild(tags);
      card.appendChild(top);

      if (p) {
        const stats = el('div', 'pc-stats');
        const add = (label, value, cls) => {
          const s = el('div', 'pc-stat');
          s.appendChild(el('span', '', label));
          s.appendChild(el('b', cls || '', String(value)));
          stats.appendChild(s);
        };
        add('pontos', scores[i] || 0, 'score');
        add('pips', st ? st.pips[i] : 167);
        add('barra', st ? st.bar[i] : 0);
        add('fora', st ? st.off[i] : 0);
        card.appendChild(stats);
      } else {
        card.appendChild(el('div', 'pc-wait', `aguardando · alvo ${target}`));
      }
      wrap.appendChild(card);
    }
  };

  const renderStatus = (st) => {
    const bar = $('#statusbar');
    const text = $('#status-text');
    const extra = $('#status-extra');
    if (!bar || !text) return;
    bar.classList.remove('mine', 'warn', 'win', 'lose');
    let msg = '';
    let tone = '';
    let extraText = '';

    if (!store.table) {
      msg = 'sem mesa';
    } else if (!st) {
      msg = 'aguardando o segundo jogador…';
      extraText = `mesa ${store.table.code} · alvo ${store.table.target}`;
    } else {
      extraText = `jogo ${st.game_no} · alvo ${st.target}`;
      if (store.spectator || !Number.isInteger(store.seat)) extraText += ' · assistindo';
      const winner = st.result ? st.result.winner : null;
      if (st.match_over) {
        msg = `match encerrado — ${winner !== null ? seatNick(winner, st) : '?'} venceu`;
        tone = !Number.isInteger(store.seat) ? 'win' : winner === store.seat ? 'win' : 'lose';
      } else if (st.game_over) {
        msg = `${winner !== null ? seatNick(winner, st) : '?'} venceu o jogo (+${st.result ? st.result.points : 0})`;
        tone = !Number.isInteger(store.seat) ? 'win' : winner === store.seat ? 'win' : 'lose';
      } else if (st.phase === 'double_offered') {
        if (st.double_offer === store.seat) {
          msg = 'aguardando a resposta do adversário…';
          tone = 'warn';
        } else if (Number.isInteger(store.seat)) {
          msg = `${seatNick(st.double_offer, st)} dobrou — aceitar?`;
          tone = 'warn';
        } else {
          msg = 'dobra em disputa…';
        }
      } else if (st.phase === 'to_roll') {
        if (myTurn(st)) {
          msg = 'sua vez — lance os dados';
          tone = 'mine';
        } else {
          msg = `${seatNick(st.turn, st)} vai lançar os dados`;
        }
      } else if (st.phase === 'moving') {
        if (myTurn(st)) {
          msg = `sua vez — ${st.legal.length} jogada(s) legal(is)`;
          tone = 'mine';
        } else {
          msg = `${seatNick(st.turn, st)} está movendo`;
        }
      } else if (st.phase === 'no_moves') {
        if (myTurn(st)) {
          msg = 'sem jogadas — passando a vez…';
          tone = 'warn';
        } else {
          msg = `${seatNick(st.turn, st)} não tem jogadas`;
        }
      }
      if (st.cube && st.cube.value > 1) extraText += ` · cubo ×${st.cube.value}`;
    }

    text.textContent = msg;
    if (extra) extra.textContent = extraText;
    if (tone) bar.classList.add(tone);
  };

  // ─────────────────────────────────────────────────────────── dados / ações
  const makeDie = (value, extraClass) => {
    const die = el('div', 'die' + (extraClass ? ' ' + extraClass : ''));
    const cells = PIP_CELLS[value] || [];
    for (let i = 0; i < 9; i++) {
      const cell = el('span', 'cell' + (cells.includes(i) ? ' on' : ''));
      die.appendChild(cell);
    }
    return die;
  };

  const renderDice = (st) => {
    const wrap = $('#dice');
    const meta = $('#dice-meta');
    if (!wrap) return;
    wrap.innerHTML = '';
    if (!st) {
      wrap.appendChild(el('span', 'dice-empty', '—'));
      if (meta) meta.textContent = 'aguardando oponente';
      return;
    }

    const showRemaining = (st.phase === 'moving' || st.phase === 'no_moves') && st.remaining.length > 0;
    const values = showRemaining ? st.remaining.slice(0, 4) : st.dice.slice(0, 2);
    const rolling = Date.now() < store.rollFxUntil;
    if (!values.length) {
      wrap.appendChild(el('span', 'dice-empty', '—'));
    } else {
      values.forEach((v) => wrap.appendChild(makeDie(v, showRemaining || rolling ? (rolling ? 'rolling' : '') : 'ghost')));
    }

    if (meta) {
      let text = '';
      if (st.game_over) text = 'jogo encerrado';
      else if (st.phase === 'double_offered') text = `dobra pendente · ×${st.cube.value * 2}`;
      else if (st.phase === 'no_moves') text = 'sem jogadas · passando';
      else if (st.phase === 'to_roll') {
        text = myTurn(st) ? 'lance os dados' : `aguardando ${seatNick(st.turn, st)}`;
      } else if (st.phase === 'moving') {
        const doubles = st.dice.length === 2 && st.dice[0] === st.dice[1];
        if (store.selected !== null) text = 'ficha selecionada · escolha o destino';
        else if (doubles) text = `duplo · ${st.remaining.length} jogada(s)`;
        else text = `${st.remaining.length} dado(s) na mão`;
      }
      meta.textContent = text;
    }
  };

  const actionButton = (label, cls, onClick) => {
    const b = el('button', 'btn ' + (cls || ''), label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  };

  const hint = (main, small) => {
    const d = el('div', 'action-hint');
    d.textContent = main;
    if (small) d.appendChild(el('span', 'mini', small));
    return d;
  };

  const renderActions = (st) => {
    const wrap = $('#actions');
    if (!wrap) return;
    wrap.innerHTML = '';

    if (!store.table) return;

    if (!st) {
      if (Number.isInteger(store.seat)) {
        wrap.appendChild(actionButton('copiar convite', 'primary', () => {
          copyText(`${baseUrl()}/?mesa=${store.table.code}`, 'Convite copiado. Mande para um amigo.');
        }));
        wrap.appendChild(hint('aguardando o segundo jogador…', `código ${store.table.code}`));
      } else {
        wrap.appendChild(el('span', 'spectator-note', 'modo espectador — aguardando jogadores'));
      }
      return;
    }

    if (st.game_over) {
      if (Number.isInteger(store.seat)) {
        if (st.match_over) {
          wrap.appendChild(actionButton('novo match', 'primary', () => socket.emit('new_match')));
        } else {
          wrap.appendChild(actionButton('próximo jogo', 'primary', () => socket.emit('next_game')));
        }
      } else {
        wrap.appendChild(hint('aguardando os jogadores…', 'assistindo'));
      }
      wrap.appendChild(actionButton('ver tabuleiro', '', () => {
        store.overlayDismissed = true;
        renderOverlay(st);
      }));
      return;
    }

    if (st.phase === 'double_offered') {
      if (Number.isInteger(store.seat) && st.double_offer !== store.seat) {
        wrap.appendChild(actionButton(`aceitar ×${st.cube.value * 2}`, 'amber', () => socket.emit('double_response', { accept: true })));
        wrap.appendChild(actionButton('recusar', 'danger', () => socket.emit('double_response', { accept: false })));
        wrap.appendChild(hint('o adversário ofereceu uma dobra', 'vale o valor atual se recusar'));
      } else if (Number.isInteger(store.seat)) {
        wrap.appendChild(hint('dobra enviada…', 'aguardando resposta'));
      } else {
        wrap.appendChild(hint('dobra em disputa…', 'assistindo'));
      }
      return;
    }

    if (!Number.isInteger(store.seat)) {
      wrap.appendChild(el('span', 'spectator-note', 'modo espectador — assista e converse'));
      return;
    }

    if (myTurn(st)) {
      if (st.phase === 'to_roll') {
        wrap.appendChild(actionButton('lançar dados', 'primary big', () => socket.emit('roll')));
        if (st.can_double) {
          wrap.appendChild(actionButton(`dobrar ×${st.cube.value * 2}`, 'amber', () => socket.emit('offer_double')));
        }
        wrap.appendChild(hint('seu turno', st.crawford ? 'crawford · dobra proibida' : 'dobre antes de lançar, se quiser'));
      } else if (st.phase === 'moving') {
        wrap.appendChild(hint(
          store.selected !== null ? 'escolha o destino iluminado' : 'selecione uma ficha para mover',
          `${st.legal.length} jogada(s) legal(is) · ${st.remaining.length} dado(s)`
        ));
      } else if (st.phase === 'no_moves') {
        wrap.appendChild(hint('sem jogadas possíveis', 'passando automaticamente…'));
      }
    } else {
      const who = seatNick(st.turn, st);
      if (st.phase === 'to_roll') wrap.appendChild(hint(`${who} vai lançar os dados…`, 'aguarde'));
      else if (st.phase === 'moving') wrap.appendChild(hint(`${who} está movendo…`, 'aguarde'));
      else if (st.phase === 'no_moves') wrap.appendChild(hint(`${who} não tem jogadas…`, 'aguarde'));
    }
  };

  // ─────────────────────────────────────────────────────────── overlay / log
  const renderOverlay = (st) => {
    const overlay = $('#board-overlay');
    if (!overlay) return;
    if (!st || !st.game_over || store.overlayDismissed) {
      overlay.hidden = true;
      if (!st || !st.game_over) store.overlayDismissed = false;
      return;
    }
    overlay.hidden = false;
    const card = overlay.querySelector('.overlay-card');
    const title = $('#overlay-title');
    const eyebrow = $('#overlay-eyebrow');
    const text = $('#overlay-text');
    const score = $('#overlay-score');
    const actions = $('#overlay-actions');
    const r = st.result || {};
    const winner = r.winner;
    const winnerNick = winner !== null && winner !== undefined ? seatNick(winner, st) : '?';
    const iWon = winner === store.seat;
    const spectator = !Number.isInteger(store.seat);

    card.classList.toggle('defeat', !iWon && !spectator);
    eyebrow.textContent = st.match_over ? 'fim do match' : `fim do jogo ${st.game_no}`;
    if (st.match_over) {
      title.textContent = spectator ? 'MATCH ENCERRADO' : iWon ? 'MATCH VENCIDO' : 'MATCH PERDIDO';
    } else {
      title.textContent = spectator ? 'FIM DE JOGO' : iWon ? 'VITÓRIA' : 'DERROTA';
    }

    let detail = `${winnerNick} venceu`;
    if (r.declined) detail += ' — o adversário recusou a dobra.';
    else {
      const m = r.multiplier === 2 ? ' (gammon)' : r.multiplier === 3 ? ' (backgammon)' : '';
      detail += `${m} e marcou ${r.points} ponto(s).`;
    }
    text.textContent = detail;

    score.innerHTML = '';
    score.appendChild(el('span', iWon ? 'win' : 'lose', String(st.scores[0])));
    score.appendChild(document.createTextNode('  —  '));
    score.appendChild(el('span', iWon ? 'lose' : 'win', String(st.scores[1])));
    score.appendChild(el('small', '', `jogo ${st.game_no} · alvo ${st.target}${st.crawford ? ' · crawford' : ''}`));

    actions.innerHTML = '';
    if (!spectator) {
      if (st.match_over) {
        actions.appendChild(actionButton('novo match', 'primary', () => socket.emit('new_match')));
      } else {
        actions.appendChild(actionButton('próximo jogo', 'primary', () => socket.emit('next_game')));
      }
    } else {
      actions.appendChild(hint('aguardando o próximo jogo…', 'assistindo'));
    }
  };

  const renderMiniLog = (st) => {
    const list = $('#mini-log');
    if (!list) return;
    list.innerHTML = '';
    if (!st || !st.log || !st.log.length) {
      list.appendChild(el('li', '', 'sem lances ainda'));
      return;
    }
    st.log.slice(-7).reverse().forEach((line) => list.appendChild(el('li', '', line)));
  };

  // ─────────────────────────────────────────────────────────── chat
  const chatBody = () => $('#chat-body');

  const scrollChat = (force) => {
    const body = chatBody();
    if (!body) return;
    const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 90;
    if (force || nearBottom) body.scrollTop = body.scrollHeight;
  };

  const appendChat = (msg) => {
    const body = chatBody();
    if (!body) return;
    const empty = body.querySelector('.chat-empty');
    if (empty) empty.remove();
    body.appendChild(chatNode(msg));
    scrollChat(msg.nick === store.nick);
  };

  const chatNode = (msg) => {
    if (msg.kind === 'system') {
      return el('div', 'msg-system', msg.text || '');
    }
    const wrap = el('div', 'msg' + (msg.nick === store.nick ? ' mine' : ''));
    const head = el('div', 'msg-head');
    const nick = el('span', 'msg-nick' + (msg.seat === 0 ? ' s0' : msg.seat === 1 ? ' s1' : ''), msg.nick || '?');
    const time = el('span', 'msg-time', fmtTime(msg.ts));
    head.append(nick, time);
    const text = el('div', 'msg-text', msg.text || '');
    wrap.append(head, text);
    return wrap;
  };

  const renderChatAll = () => {
    const body = chatBody();
    if (!body) return;
    body.innerHTML = '';
    if (!store.chat.length) {
      const empty = el('div', 'chat-empty');
      empty.innerHTML = 'nenhuma mensagem ainda.<br>diga algo para a mesa.';
      body.appendChild(empty);
      return;
    }
    store.chat.forEach((m) => body.appendChild(chatNode(m)));
    scrollChat(true);
  };

  $('#chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#chat-input');
    const text = (input.value || '').trim();
    if (!text) return;
    if (!store.table) {
      toast('Entre em uma mesa para conversar.', 'error');
      return;
    }
    socket.emit('chat', { text });
    input.value = '';
    input.focus();
  });

  // ─────────────────────────────────────────────────────────── render geral
  const renderGame = () => {
    if (!store.table) return;
    const st = currentState();
    const t = store.table;
    const codeEl = $('#game-code');
    if (codeEl) codeEl.textContent = t.code;
    const nameEl = $('#game-name');
    if (nameEl) nameEl.textContent = t.name || '';
    const matchEl = $('#match-badge');
    if (matchEl) matchEl.textContent = `match ${(st && st.target) || t.target || 5}`;
    const crawford = $('#crawford-badge');
    if (crawford) crawford.hidden = !(st && st.crawford);
    const cube = $('#cube-badge');
    if (cube) {
      if (st) {
        const owner = st.cube.owner === null ? 'livre' :
          st.cube.owner === store.seat ? 'seu' : seatNick(st.cube.owner, st);
        cube.textContent = `cubo ×${st.cube.value} · ${owner}`;
        cube.title = st.cube.owner === null
          ? 'cubo centralizado — qualquer jogador pode dobrar'
          : `cubo pertence a ${seatNick(st.cube.owner, st)}`;
      } else {
        cube.textContent = 'cubo ×1';
      }
    }
    const spec = $('#spectator-count');
    if (spec) {
      const n = (t.spectators || []).length;
      spec.textContent = n ? `${n} espectador${n > 1 ? 'es' : ''}` : '';
    }

    renderPlayers(st);
    renderStatus(st);
    renderBoard();
    renderDice(st);
    renderActions(st);
    renderMiniLog(st);
    renderOverlay(st);
  };

  const applyStateFx = (prev, next, silent) => {
    if (!next) {
      if (store.screen === 'game') document.title = 'Old Pirate Gammon';
      return;
    }
    const mine = myTurn(next) && store.screen === 'game';
    if (mine) {
      document.title = 'SUA VEZ · Old Pirate Gammon';
    } else if (store.screen === 'game') {
      document.title = 'Old Pirate Gammon';
    }

    if (silent) {
      lastStateForFx = next;
      return;
    }

    if (next.seq !== (prev && prev.seq)) {
      if (next.phase === 'to_roll' && prev && prev.phase !== 'to_roll') {
        // troca de turno
      }
      if ((next.phase === 'moving' || next.phase === 'no_moves') && (!prev || prev.phase === 'to_roll')) {
        store.rollFxUntil = Date.now() + 480;
        sfx.roll();
      } else if (prev && (next.used > prev.used || next.bar[0] !== prev.bar[0] || next.bar[1] !== prev.bar[1])) {
        sfx.move();
      }
    }
    if (mine && (!prev || prev.turn !== next.turn) && store.screen === 'game') {
      sfx.turn();
      toast('Sua vez.', 'warn');
    }
    if (next.phase === 'double_offered' && (!prev || prev.phase !== 'double_offered') &&
        next.double_offer !== store.seat) {
      sfx.warn();
    }
    if (next.game_over && (!prev || !prev.game_over)) {
      const won = next.result && next.result.winner === store.seat;
      if (won) sfx.win(); else sfx.lose();
    }
    lastStateForFx = next;
  };

  // ─────────────────────────────────────────────────────────── boot
  const ensureAudioUnlock = () => {
    const ctx = audio();
    if (ctx && ctx.state === 'suspended') ctx.resume();
  };

  const init = () => {
    try {
      const params = new URLSearchParams(location.search);
      if (params.get('sair') === '1') {
        localStorage.removeItem(LS.nick);
        localStorage.removeItem(LS.token);
        store.nick = '';
        store.token = '';
        store.pendingCode = null;
        history.replaceState(null, '', location.pathname);
      }
    } catch (_) { /* modo privado */ }
    buildBoard();
    applySoundToggle();
    $('#nick-input').value = store.nick || '';
    $('#lan-url').textContent = baseUrl() + '/';
    renderLobby();
    if (store.nick) {
      $('#user-nick').textContent = store.nick;
      $('#user-chip').hidden = false;
      showScreen('lobby');
    } else {
      showScreen('login');
    }
    renderBoard();
    document.addEventListener('pointerdown', ensureAudioUnlock, { once: true });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && store.selected !== null) {
        store.selected = null;
        renderGame();
      }
    });
    if (!store.pendingCode) {
      try {
        if (new URLSearchParams(location.search).has('mesa')) history.replaceState(null, '', location.pathname);
      } catch (_) {}
    }
    socket.connect();
  };

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (store.screen === 'game') renderBoard();
    }, 120);
  });

  init();
})();
