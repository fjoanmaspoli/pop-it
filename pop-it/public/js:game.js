(() => {
  const $ = (s) => document.querySelector(s);
  const fmt = new Intl.NumberFormat('en-US');
  const COOLDOWN = 1000;

  /* identité persistante */
  let pid = localStorage.getItem('pop_pid');
  if (!pid) {
    pid = (crypto.randomUUID?.() || Math.random().toString(36).slice(2) + Date.now().toString(36));
    localStorage.setItem('pop_pid', pid);
  }
  const name = localStorage.getItem('pop_name') || 'guest-' + pid.slice(0, 4);
  localStorage.setItem('pop_name', name);
  const flag = (() => {
    const r = (navigator.language || 'en').split('-')[1];
    return r ? String.fromCodePoint(...[...r.toUpperCase()].map(c => 0x1F1E6 + c.charCodeAt(0) - 65)) : '🏳️';
  })();

  /* websocket */
  const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
  ws.onopen = () => ws.send(JSON.stringify({ t: 'ident', id: pid, name, flag }));
  ws.onmessage = (e) => route(JSON.parse(e.data));

  let myTaps = 0, readyAt = 0;

  function route(m) {
    switch (m.t) {
      case 'init':
        myTaps = m.you.tapsRound; setCounter(m.round.taps);
        $('#roundId').textContent = '#' + m.round.id;
        $('#range').textContent = fmt.format(m.round.range[0]) + ' and ' + fmt.format(m.round.range[1]);
        $('#commit').textContent = 'fairness commit: ' + m.round.commit.slice(0, 16) + '…';
        $('#prizeLine').textContent = '🎁 inside: ' + m.round.prize;
        renderBoard(m.board); m.chat.forEach(addChat); youLine(); break;
      case 'count': setCounter(m.n); break;
      case 'board': renderBoard(m.rows); $('#here').textContent = m.here; $('#tapping').textContent = m.tapping; break;
      case 'chat': addChat(m); break;
      case 'rejected': myTaps = Math.max(0, myTaps - 1); youLine(); break;
      case 'popped': onPop(m); break;
      case 'round': onNewRound(m); break;
    }
  }

  const stage = $('#stage'), counterEl = $('#counter'), wrap = $('#balloonWrap');
  function setCounter(n) {
    counterEl.textContent = fmt.format(n);
    // taille = f(taps publics) uniquement → ne révèle JAMAIS le nombre secret
    stage.style.setProperty('--inflate', (1 + Math.min(0.55, Math.log10(1 + n) / 10)).toFixed(3));
  }

  /* tap — throttle client 1/s + anneau de cooldown */
  function tryTap() {
    const now = performance.now();
    if (now < readyAt) { wrap.classList.remove('squash'); void wrap.offsetWidth; return; }
    readyAt = now + COOLDOWN;
    if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'tap' }));
    myTaps++; youLine(); squash(); runRing(COOLDOWN);
  }
  wrap.addEventListener('pointerdown', tryTap);
  $('#tapBtn').addEventListener('pointerdown', (e) => { e.preventDefault(); tryTap(); });
  $('#tapBtn').addEventListener('click', tryTap); // clavier / accessibilité (le cooldown dédoublonne)

  function squash() { wrap.classList.remove('squash'); void wrap.offsetWidth; wrap.classList.add('squash'); }
  const ring = $('#ring');
  function runRing(ms) {
    const t0 = performance.now();
    (function tick() {
      const p = Math.min(1, (performance.now() - t0) / ms);
      ring.style.background = `conic-gradient(#ffd23f ${p * 360}deg, rgba(255,255,255,.12) 0deg)`;
      if (p < 1) requestAnimationFrame(tick);
    })();
  }
  const youLine = () => $('#youLine').textContent = `you: ${fmt.format(myTaps)} taps this round · max 1 / sec`;

  /* leaderboard + chat */
  function renderBoard(rows) {
    $('#board').innerHTML = '';
    rows.forEach((r) => {
      const li = document.createElement('li');
      const who = document.createElement('span'); who.textContent = `${r.flag} ${r.name}`;
      const t = document.createElement('span'); t.className = 't'; t.textContent = fmt.format(r.taps);
      li.append(who, t); $('#board').appendChild(li);
    });
  }
  function addChat(m) {
    const li = document.createElement('li');
    const who = document.createElement('span'); who.className = 'who'; who.textContent = `${m.flag} ${m.name} · `;
    li.append(who, document.createTextNode(m.text));
    const log = $('#chatLog'); log.appendChild(li);
    while (log.children.length > 50) log.firstChild.remove();
    log.parentElement.scrollTop = 1e9;
  }
  $('#chatForm').onsubmit = (e) => {
    e.preventDefault();
    const v = $('#chatInput').value.trim(); if (!v) return;
    ws.send(JSON.stringify({ t: 'chat', text: v })); $('#chatInput').value = '';
  };

  /* tabs (bottom sheet mobile) */
  document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => {
    document.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('on', x === b));
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.id === 'tab-' + b.dataset.tab));
  });

  /* pop + vérif provably fair */
  function onPop(m) {
    $('#popOverlay').hidden = false;
    $('#popTaps').textContent = fmt.format(m.taps) + ' TAPS';
    $('#popWinner').textContent = `🏆 ${m.flag} @${m.winner} won ${m.prize}`;
    $('#popVerify').innerHTML = '';
    const span = document.createElement('span');
    span.textContent = `target ${fmt.format(m.reveal.target)} · salt ${m.reveal.salt.slice(0, 12)}… `;
    const btn = document.createElement('button'); btn.textContent = 'verify fairness';
    btn.onclick = async () => {
      const buf = await crypto.subtle.digest('SHA-256',
        new TextEncoder().encode(`${m.round}:${m.reveal.target}:${m.reveal.salt}`));
      const hex = [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
      span.textContent += hex === m.reveal.commit ? ' ✅ commit matches' : ' ❌ MISMATCH';
      btn.remove();
    };
    $('#popVerify').append(span, btn);
    confettiBurst();
    let left = 25;
    const iv = setInterval(() => {
      $('#popNext').textContent = `next balloon in ${left--}s…`;
      if (left < 0) clearInterval(iv);
    }, 1000);
  }
  function onNewRound(m) {
    $('#popOverlay').hidden = true;
    myTaps = 0; setCounter(0); youLine();
    $('#roundId').textContent = '#' + m.id;
    $('#commit').textContent = 'fairness commit: ' + m.commit.slice(0, 16) + '…';
  }

  function confettiBurst() {
    const cv = $('#confetti'), ctx = cv.getContext('2d');
    cv.width = innerWidth; cv.height = innerHeight;
    const P = [...Array(160)].map(() => ({
      x: innerWidth / 2, y: innerHeight / 2.4,
      vx: (Math.random() - .5) * 14, vy: Math.random() * -12 - 3,
      s: Math.random() * 7 + 3, c: `hsl(${Math.random() * 360},90%,60%)`,
      r: Math.random() * Math.PI, vr: (Math.random() - .5) * .3, life: 1 }));
    (function frame() {
      ctx.clearRect(0, 0, cv.width, cv.height); let alive = false;
      for (const p of P) {
        p.vy += .35; p.x += p.vx; p.y += p.vy; p.r += p.vr; p.life -= .008;
        if (p.life > 0 && p.y < cv.height + 20) {
          alive = true;
          ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r);
          ctx.globalAlpha = Math.max(0, p.life); ctx.fillStyle = p.c;
          ctx.fillRect(-p.s / 2, -p.s / 2, p.s, p.s * .6); ctx.restore();
        }
      }
      if (alive) requestAnimationFrame(frame);
    })();
  }
})();