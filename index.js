// ── 도스창 숨기기: 2번째 인스턴스를 숨겨서 실행, 브라우저는 여기서 염 ──
if (process.platform === 'win32' && !process.argv.includes('--hidden')) {
  const { spawn, spawnSync } = require('child_process');
  spawn(process.execPath, ['--hidden'], {
    detached: true, windowsHide: true, stdio: 'ignore'
  }).unref();
  // 서버 준비 대기 (~1초) 후 브라우저 오픈 (첫 번째 인스턴스에서 열어야 동작)
  spawnSync('ping', ['-n', '4', '127.0.0.1'], { stdio: 'ignore', windowsHide: true }); // ~3초 대기
  spawn('cmd', ['/c', 'start', '', 'http://127.0.0.1:7654'], {
    detached: true, windowsHide: true, stdio: 'ignore'
  }).unref();
  process.exit(0);
}

const axios        = require('axios');
const https        = require('https');
const http         = require('http');
const fs           = require('fs');
const path         = require('path');
const { EventEmitter } = require('events');
const { execSync }     = require('child_process');

// ── lockfile 기반 LCU 커넥터 (wmic 없이 동작) ────────────────────
class LockfileConnector extends EventEmitter {
  constructor() { super(); this._connected = false; this._timer = null; }

  start() { this._poll(); this._timer = setInterval(() => this._poll(), 3000); }

  _findLockfile() {
    const candidates = [
      'C:\\Riot Games\\League of Legends\\lockfile',
      'D:\\Riot Games\\League of Legends\\lockfile',
      path.join(process.env.LOCALAPPDATA || '', '..\\Local\\Riot Games\\League of Legends\\lockfile'),
    ];
    for (const p of candidates) {
      try { if (fs.existsSync(p)) return p; } catch (_) {}
    }
    try {
      const out = execSync(
        'powershell -NoProfile -Command "try{(Get-Process LeagueClientUx -EA Stop)[0].Path}catch{\'\'}"',
        { timeout: 4000, encoding: 'utf8' }
      ).trim();
      if (out) {
        const lf = path.join(path.dirname(out), 'lockfile');
        try { if (fs.existsSync(lf)) return lf; } catch (_) {}
      }
    } catch (_) {}
    return null;
  }

  _poll() {
    const lfPath = this._findLockfile();
    if (lfPath) {
      try {
        const [, , port, password, protocol] = fs.readFileSync(lfPath, 'utf8').trim().split(':');
        if (port && password && !this._connected) {
          this._connected = true;
          this.emit('connect', { username: 'riot', password, port, protocol: protocol || 'https' });
        }
        return;
      } catch (_) {}
    }
    if (this._connected) { this._connected = false; this.emit('disconnect'); }
  }
}

// ── Firebase 설정 ───────────────────────────────────────────────
const FIREBASE_URL  = 'https://aramchaos-ca022-default-rtdb.asia-southeast1.firebasedatabase.app';
const BRIDGE_ROOT   = 'bridge'; // session/ 과 분리된 전용 경로

// ── LCU axios (자체 서명 인증서 무시) ───────────────────────────
const lcuClient = axios.create({
  httpsAgent: new https.Agent({ rejectUnauthorized: false }),
  timeout: 4000
});

// ── 상태 변수 ────────────────────────────────────────────────────
const connector    = new LockfileConnector();
let baseUrl        = null;
let lastPhase      = null;
let pollTimer      = null;
let heartbeatTimer = null;
let eogSaved       = false;
let fbErrorLogged  = false; // Firebase 오류 중복 경고 방지
let fbOk           = null;  // null=확인중, true=정상, false=오류

// ── 로컬 상태 페이지 ──────────────────────────────────────────────
const STATUS_HTML = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ARAM 브릿지</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',system-ui,sans-serif;background:#0d1117;color:#e6edf3;display:flex;justify-content:center;align-items:center;min-height:100vh}
.card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:32px;width:360px}
.hdr{display:flex;align-items:center;gap:14px;margin-bottom:24px;padding-bottom:20px;border-bottom:1px solid #21262d}
.ico{font-size:36px}
.title{font-size:18px;font-weight:700}
.sub{font-size:12px;color:#8b949e;margin-top:2px}
.rows{display:flex;flex-direction:column;gap:8px}
.row{display:flex;justify-content:space-between;align-items:center;padding:10px 14px;background:#0d1117;border-radius:8px}
.lbl{font-size:12px;color:#8b949e}
.val{font-size:13px;font-weight:600;display:flex;align-items:center;gap:6px}
.dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
.green{background:#3fb950;box-shadow:0 0 6px #3fb95080}
.gray{background:#484f58}
.red{background:#f85149}
.foot{margin-top:16px;font-size:11px;color:#484f58;text-align:center}
</style>
</head>
<body>
<div class="card">
  <div class="hdr">
    <div class="ico">🎮</div>
    <div>
      <div class="title">ARAM 브릿지</div>
      <div class="sub" id="ver">로딩 중...</div>
    </div>
  </div>
  <div class="rows">
    <div class="row">
      <span class="lbl">브릿지 프로세스</span>
      <span class="val" id="proc"><span class="dot green"></span>실행 중</span>
    </div>
    <div class="row">
      <span class="lbl">롤 클라이언트</span>
      <span class="val" id="lcu"><span class="dot gray"></span>대기 중</span>
    </div>
    <div class="row">
      <span class="lbl">게임 페이즈</span>
      <span class="val" id="phase" style="color:#8b949e">-</span>
    </div>
    <div class="row">
      <span class="lbl">Firebase 연결</span>
      <span class="val" id="fb"><span class="dot gray"></span>확인 중</span>
    </div>
  </div>
  <div class="foot" id="foot">연결 중...</div>
</div>
<script>
var fails=0;
function refresh(){
  fetch('/api/status').then(function(r){return r.json();}).then(function(d){
    fails=0;
    document.getElementById('ver').textContent='v'+d.version;
    var lcu=document.getElementById('lcu');
    lcu.innerHTML=d.connected?'<span class="dot green"></span>연결됨':'<span class="dot gray"></span>대기 중';
    var ph=document.getElementById('phase');
    ph.textContent=d.phase||'-';
    ph.style.color=d.phase?'#e6edf3':'#8b949e';
    var fb=document.getElementById('fb');
    fb.innerHTML=d.fbOk===null?'<span class="dot gray"></span>확인 중':d.fbOk?'<span class="dot green"></span>정상':'<span class="dot red"></span>오류';
    document.getElementById('foot').textContent='마지막 갱신: '+new Date(d.now).toLocaleTimeString('ko-KR');
  }).catch(function(){
    if(++fails>=3){
      document.getElementById('proc').innerHTML='<span class="dot red"></span>종료됨';
      document.getElementById('foot').textContent='⚠️ 브릿지가 종료되었습니다. 창을 닫으세요.';
    }
  });
}
refresh();
setInterval(refresh,3000);
</script>
</body>
</html>`;

const STATUS_PORT = 7654;

function startStatusServer() {
  const ver = require('./package.json').version;
  const server = http.createServer((req, res) => {
    if (req.url === '/api/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        version:   ver,
        connected: !!baseUrl,
        phase:     lastPhase || null,
        fbOk,
        now:       Date.now()
      }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(STATUS_HTML);
  });
  server.on('error', () => {}); // 포트 충돌 시 무시 (이미 실행 중인 경우)
  server.listen(STATUS_PORT, () => {  // 0.0.0.0 — IPv4/IPv6 모두 바인딩
    log(`상태 페이지: http://127.0.0.1:${STATUS_PORT}`);
    try {
      const { spawn } = require('child_process');
      spawn('rundll32.exe', ['url.dll,FileProtocolHandler', `http://127.0.0.1:${STATUS_PORT}`], {
        detached: true, stdio: 'ignore'
      }).unref();
    } catch (_) {}
  });
}

// ── 유틸 ─────────────────────────────────────────────────────────
const LOG_PATH = path.join(
  process.pkg ? path.dirname(process.execPath) : __dirname,
  'aram-bridge.log'
);
const _logStream = (() => {
  try { return fs.createWriteStream(LOG_PATH, { flags: 'a' }); } catch (_) { return null; }
})();

function log(msg) {
  const line = `[${new Date().toLocaleTimeString('ko-KR')}] ${msg}`;
  if (_logStream) try { _logStream.write(line + '\n'); } catch (_) {}
  try { process.stdout.write(line + '\n'); } catch (_) {}
}

// ── Firebase 헬퍼 ─────────────────────────────────────────────────
async function fbSet(path, data) {
  try {
    await axios.put(
      `${FIREBASE_URL}/${path}.json`,
      JSON.stringify(data === null ? null : data),
      { headers: { 'Content-Type': 'application/json' }, timeout: 5000 }
    );
    fbErrorLogged = false;
    fbOk = true;
  } catch (e) {
    fbOk = false;
    if (!fbErrorLogged) {
      const status = e.response?.status;
      if (status === 401 || status === 403) {
        log('⛔ Firebase 권한 오류 — Firebase 보안 규칙을 확인하세요.');
      } else {
        log('⚠️  Firebase 전송 실패 — 인터넷 연결 또는 방화벽을 확인하세요.');
      }
      fbErrorLogged = true;
    }
  }
}

async function fbGet(path) {
  const res = await axios.get(`${FIREBASE_URL}/${path}.json`, { timeout: 3000 });
  return res.data;
}

// ── LCU 요청 ─────────────────────────────────────────────────────
async function lcu(path) {
  const res = await lcuClient.get(`${baseUrl}${path}`);
  return res.data;
}

// ── 하트비트 ──────────────────────────────────────────────────────
// 브릿지 프로세스 자체의 생존 신호. LCU 연결 여부와 무관하게 실행되어야 한다.
function startHeartbeat() {
  if (heartbeatTimer) return;
  fbSet(`${BRIDGE_ROOT}/heartbeat`, Date.now());
  heartbeatTimer = setInterval(() => fbSet(`${BRIDGE_ROOT}/heartbeat`, Date.now()), 5000);
}

function stopHeartbeat() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  fbSet(`${BRIDGE_ROOT}/heartbeat`, null).catch(() => {});
}

// ── 종료 정리 ─────────────────────────────────────────────────────
async function cleanup() {
  if (pollTimer)      { clearInterval(pollTimer);      pollTimer      = null; }
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  try {
    await Promise.all([
      axios.put(`${FIREBASE_URL}/${BRIDGE_ROOT}/connected.json`,  JSON.stringify(false), { timeout: 2000 }),
      axios.put(`${FIREBASE_URL}/${BRIDGE_ROOT}/heartbeat.json`,  JSON.stringify(null),  { timeout: 2000 }),
    ]);
  } catch (_) {}
}

process.on('SIGINT',  async () => { log('브릿지 종료 중...'); await cleanup(); process.exit(0); });
process.on('SIGTERM', async () => { log('브릿지 종료 중...'); await cleanup(); process.exit(0); });

// ── Firebase 시작 점검 ────────────────────────────────────────────
async function checkFirebase() {
  try {
    await axios.put(
      `${FIREBASE_URL}/${BRIDGE_ROOT}/connected.json`,
      'false',
      { headers: { 'Content-Type': 'application/json' }, timeout: 5000 }
    );
    fbOk = true;
    log('Firebase 연결 확인 ✅');
    return true;
  } catch (e) {
    fbOk = false;
    const status = e.response?.status;
    if (status === 401 || status === 403) {
      log('⛔ Firebase 권한 오류 — Firebase 보안 규칙을 확인하세요.');
    } else {
      log('⛔ Firebase 연결 실패 — 인터넷 연결 또는 방화벽을 확인하세요.');
    }
    return false;
  }
}

// ── 중복 실행 감지 (heartbeat 쓰기 전에 호출해야 자기 자신 오탐 방지) ──
async function checkDuplicateBridge() {
  try {
    const hb = await fbGet(`${BRIDGE_ROOT}/heartbeat`);
    if (hb && Date.now() - hb < 10000) {
      log('⚠️  다른 브릿지가 이미 실행 중입니다. 기존 브릿지를 먼저 종료하세요.');
    }
  } catch (_) {}
}

// ── 챔피언 선택 데이터 수집 ───────────────────────────────────────
async function handleChampSelect() {
  try {
    const session = await lcu('/lol-champ-select/v1/session');

    const mapPlayer = p => ({
      cellId:    p.cellId,
      champId:   p.championId,
      name:      p.riotIdGameName || p.summonerName || '',
      position:  p.assignedPosition || '',
      rerolls:   p.allowedRerolls ?? 2,
      isSelf:    !!p.isSelf
    });

    await fbSet(`${BRIDGE_ROOT}/champSelect`, {
      myTeam:         (session.myTeam    || []).map(mapPlayer),
      theirTeam:      (session.theirTeam || []).map(mapPlayer),
      benchChampions: (session.benchChampions || []).map(c => ({ champId: c.championId })),
      timerPhase:     session.timer?.phase || '',
      updatedAt:      Date.now()
    });

  } catch (_) {}
}

// ── 게임 종료 데이터 수집 ─────────────────────────────────────────
async function handleEndOfGame() {
  if (eogSaved) return;

  try {
    // 다른 브릿지가 이미 저장했는지 확인 (30초 이내 저장 기록 있으면 건너뜀)
    try {
      const existing = await fbGet(`${BRIDGE_ROOT}/eogStats`);
      if (existing?.savedAt && Date.now() - existing.savedAt < 30000) {
        eogSaved = true;
        log('게임 종료 데이터 이미 저장됨 — 건너뜀');
        return;
      }
    } catch (_) {}

    const eog = await lcu('/lol-end-of-game/v1/eog-stats-block');
    if (!eog?.teams) return;

    const winTeam  = eog.teams.find(t => t.isWinningTeam);
    const winSide  = winTeam?.teamId === 100 ? 'blue' : 'red';

    // 챔피언 선택 시점에 저장한 champId→name 맵을 이름 보완용으로 활용
    let champPickNames = {};
    try { champPickNames = (await fbGet(`${BRIDGE_ROOT}/lastChampPicks`)) || {}; } catch (_) {}

    const players = [];
    for (const team of eog.teams) {
      for (const p of (team.players || [])) {
        const s = p.stats || {};
        players.push({
          summonerName: p.riotIdGameName || p.summonerName || champPickNames[p.championId] || '',
          championId:   p.championId,
          championName: p.championName || p.skinName || '',
          kills:        s.CHAMPIONS_KILLED                || 0,
          deaths:       s.NUM_DEATHS                      || 0,
          assists:      s.ASSISTS                         || 0,
          damage:       s.TOTAL_DAMAGE_DEALT_TO_CHAMPIONS || 0,
          gold:         s.GOLD_EARNED                     || 0,
          cs:           (s.MINIONS_KILLED || 0) + (s.NEUTRAL_MINIONS_KILLED || 0),
          teamId:       team.teamId,
          isWin:        !!team.isWinningTeam,
          // 아이템 (6슬롯, 0 제외)
          items:    [s.ITEM0,s.ITEM1,s.ITEM2,s.ITEM3,s.ITEM4,s.ITEM5].filter(i => i > 0),
          // 증강 (ARAM 프리즈매틱, 없으면 빈 배열)
          augments: [s.PLAYER_AUGMENT_1,s.PLAYER_AUGMENT_2,s.PLAYER_AUGMENT_3,s.PLAYER_AUGMENT_4].filter(i => i > 0),
          // 멀티킬 이벤트
          doubleKills: s.DOUBLE_KILLS || 0,
          tripleKills: s.TRIPLE_KILLS || 0,
          quadraKills: s.QUADRA_KILLS || 0,
          pentaKills:  s.PENTA_KILLS  || 0,
          firstBlood:  (s.FIRST_BLOOD_KILL || 0) === 1,
        });
      }
    }

    await fbSet(`${BRIDGE_ROOT}/eogStats`, {
      players,
      winSide,
      gameId:   eog.gameId    || null,
      gameTime: eog.gameLength || 0,
      savedAt:  Date.now()
    });

    await fbSet(`${BRIDGE_ROOT}/voteStarted`, Date.now());

    eogSaved = true;
    log(`게임 종료 저장 완료 ✅  승리: ${winSide === 'blue' ? '🔵 1팀' : '🔴 2팀'}`);
    log('투표 시작 신호 전송 완료 ✅');

  } catch (_) {}
}

// ── 게임 페이즈 폴링 (3초 간격) ───────────────────────────────────
async function poll() {
  if (!baseUrl) return;
  try {
    const phase = await lcu('/lol-gameflow/v1/gameflow-phase');

    if (phase !== lastPhase) {
      log(`페이즈 변경: ${lastPhase ?? '-'} → ${phase}`);
      lastPhase = phase;

      switch (phase) {
        case 'ChampSelect':
          await fbSet(`${BRIDGE_ROOT}/gamePhase`,'ChampSelect');
          break;

        case 'GameStart':
        case 'InProgress':
          await fbSet(`${BRIDGE_ROOT}/gamePhase`,'InProgress');
          try {
            const picks = await fbGet(`${BRIDGE_ROOT}/champSelect`);
            if (picks) {
              const pickMap = {};
              for (const p of [...(picks.myTeam||[]), ...(picks.theirTeam||[])]) {
                if (p.champId && p.name) pickMap[p.champId] = p.name;
              }
              await fbSet(`${BRIDGE_ROOT}/lastChampPicks`, pickMap);
            }
          } catch (_) {}
          await fbSet(`${BRIDGE_ROOT}/champSelect`, null);
          break;

        case 'PreEndOfGame':
        case 'WaitingForStats':
          await fbSet(`${BRIDGE_ROOT}/gamePhase`,'EndOfGame');
          break;

        case 'EndOfGame':
          await fbSet(`${BRIDGE_ROOT}/gamePhase`,'EndOfGame');
          await handleEndOfGame();
          break;

        case 'None':
        case 'Lobby':
        case 'Matchmaking':
        case 'ReadyCheck':
          await fbSet(`${BRIDGE_ROOT}/gamePhase`,phase);
          await fbSet(`${BRIDGE_ROOT}/champSelect`, null);
          if (['None', 'Lobby'].includes(phase)) {
            eogSaved = false;
          }
          break;
      }
    }

    if (phase === 'ChampSelect') {
      await handleChampSelect();
    }

    if ((phase === 'EndOfGame' || phase === 'PreEndOfGame') && !eogSaved) {
      await handleEndOfGame();
    }

  } catch (_) {}
}

// ── LCU 연결 이벤트 ──────────────────────────────────────────────
connector.on('connect', async data => {
  baseUrl = `https://${data.username}:${data.password}@127.0.0.1:${data.port}`;
  log('롤 클라이언트 연결됨 ✅');

  try {
    const me = await lcu('/lol-summoner/v1/current-summoner');
    log(`접속 계정: ${me.displayName}`);
  } catch (_) {}

  // 중복 감지는 startup에서 처리 (여기서 하면 자기 heartbeat 오탐)

  await fbSet(`${BRIDGE_ROOT}/connected`, true);

  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(poll, 3000);
  poll();
});

connector.on('disconnect', async () => {
  log('롤 클라이언트 종료됨. 재연결 대기 중...');
  baseUrl   = null;
  lastPhase = null;
  eogSaved  = false;
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  // heartbeat는 브릿지 프로세스 생존 신호이므로 LCU 연결과 무관하게 유지
  await fbSet(`${BRIDGE_ROOT}/connected`, false).catch(() => {});
});

// ── 시작 ─────────────────────────────────────────────────────────
startStatusServer();
log(`ARAM 브릿지 v${require('./package.json').version} 시작`);
log(`로그 파일: ${LOG_PATH}`);

checkFirebase().then(async (ok) => {
  if (ok) {
    await checkDuplicateBridge(); // heartbeat 쓰기 전에 먼저 체크
    startHeartbeat();
  }
  connector.start();
});
