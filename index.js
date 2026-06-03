
const axios        = require('axios');
const https        = require('https');
const http         = require('http');
const fs           = require('fs');
const path         = require('path');
const { EventEmitter } = require('events');
const { execSync }     = require('child_process');

// ── lockfile 기반 LCU 커넥터 (wmic 없이 동작) ────────────────────
class LockfileConnector extends EventEmitter {
  constructor() { super(); this._connected = false; this._timer = null; this._curPort = null; }

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
        if (port && password) {
          // v1.1.31~ 롤 클라이언트 재시작 감지: 비정상 종료로 lockfile 이 남아있다가
          // 재시작 시 새 port 로 덮어써지는 경우, 이전엔 _connected=true 라서 새 port 를 무시했음.
          // → port 가 바뀌면 먼저 disconnect 후 새 정보로 재연결한다.
          if (this._connected && this._curPort !== port) {
            this._connected = false;
            this._curPort = null;
            this.emit('disconnect'); // 옛 연결 정리 (baseUrl/타이머 등)
          }
          if (!this._connected) {
            this._connected = true;
            this._curPort = port;
            this.emit('connect', { username: 'riot', password, port, protocol: protocol || 'https' });
          }
        }
        return;
      } catch (_) {}
    }
    if (this._connected) { this._connected = false; this._curPort = null; this.emit('disconnect'); }
  }

  // LCU 응답이 계속 없으면(죽은 lockfile 등) 외부에서 강제로 연결 해제 → 다음 _poll 이 재연결 시도 (v1.1.31~)
  forceReset() {
    if (this._connected) {
      this._connected = false;
      this._curPort = null;
      this.emit('disconnect');
    }
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
let gameInProgress = false; // InProgress 진입 시 true — 비정상 종료(Reconnect/점프) 시 EOG 캡처 판단용 (v1.1.29~)
let activeGameId   = null;  // 현재 진행 중 게임의 gameId — 이전 게임 통계 오저장 방지 (v1.1.29~)
let lastSavedGameId = null; // 마지막으로 저장한 게임 gameId — 직전 게임 재캡처 차단 (v1.1.30~)
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
body{font-family:'Segoe UI',system-ui,sans-serif;background:#0d1117;color:#e6edf3;display:flex;justify-content:center;padding:40px 16px;min-height:100vh}
.wrap{width:380px;display:flex;flex-direction:column;gap:12px}
.card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:24px}
.hdr{display:flex;align-items:center;gap:14px;margin-bottom:20px;padding-bottom:18px;border-bottom:1px solid #21262d}
.ico{font-size:34px}
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
.foot{margin-top:14px;font-size:11px;color:#484f58;text-align:center}
.info-card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:20px;font-size:12px;color:#8b949e;line-height:1.7}
.info-card b{color:#c9d1d9;font-size:12px}
.info-section{margin-bottom:14px}
.info-section:last-child{margin-bottom:0}
.info-title{font-size:11px;font-weight:700;color:#58a6ff;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px}
.stopbtn{width:100%;padding:10px;background:#21262d;border:1px solid #30363d;border-radius:8px;color:#f85149;font-size:13px;font-weight:600;cursor:pointer;margin-top:2px}
.stopbtn:hover{background:#2a1f1f;border-color:#f85149}
</style>
</head>
<body>
<div class="wrap">
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
    <button id="stopBtn" class="stopbtn" onclick="stopBridge()">브릿지 종료</button>
  </div>

  <div class="info-card">
    <div class="info-section">
      <div class="info-title">브릿지란?</div>
      롤 클라이언트(LCU)의 게임 데이터를 실시간으로 <b>ARAM 내전 사이트</b>에 전송하는 프로그램입니다.
      브릿지가 켜져 있어야 게임 페이즈 감지, 경기 자동 저장, EOG 투표 등이 정상 동작합니다.
    </div>
    <div class="info-section">
      <div class="info-title">누가 켜야 하나요?</div>
      <b>내전 진행자(방장) PC</b> 한 대에서만 실행하면 됩니다.
      롤 클라이언트가 켜진 상태에서 함께 실행해주세요.
    </div>
    <div class="info-section">
      <div class="info-title">다른 사람에게 넘기려면?</div>
      1. 이 페이지에서 <b>브릿지 종료</b> 버튼을 눌러 종료<br>
      2. 새 진행자 PC에 ZIP 파일 전달 후 <b>launcher.vbs</b> 실행<br>
      3. 브릿지가 연결되면 사이트가 자동으로 인식합니다
    </div>
  </div>
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
      document.getElementById('foot').textContent='브릿지가 종료되었습니다. 창을 닫으세요.';
      document.getElementById('stopBtn').style.display='none';
    }
  });
}
function stopBridge(){
  if(!confirm('브릿지를 종료할까요?')) return;
  fetch('/api/shutdown',{method:'POST'}).catch(function(){});
  document.getElementById('proc').innerHTML='<span class="dot red"></span>종료 중...';
  document.getElementById('stopBtn').disabled=true;
  setTimeout(function(){
    window.open('','_self');
    window.close();
    setTimeout(function(){
      document.getElementById('foot').textContent='브릿지가 종료되었습니다. 이 탭을 닫아주세요.';
    }, 500);
  }, 800);
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
    if (req.url === '/api/shutdown' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      setTimeout(() => process.exit(0), 300);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(STATUS_HTML);
  });
  server.on('error', () => {}); // 포트 충돌 시 무시 (이미 실행 중인 경우)
  server.listen(STATUS_PORT, () => {  // 0.0.0.0 — IPv4/IPv6 모두 바인딩
    log(`상태 페이지: http://127.0.0.1:${STATUS_PORT}`);
    try {
      require('child_process').spawn('cmd', ['/c', 'start', '', `http://127.0.0.1:${STATUS_PORT}`], {
        detached: true, windowsHide: true, stdio: 'ignore'
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

// ETag 기반 조건부 GET — 다른 브릿지 동시 실행 시 atomic CAS 용 (v1.1.26~)
async function fbGetWithEtag(path) {
  const res = await axios.get(`${FIREBASE_URL}/${path}.json`, {
    headers: { 'X-Firebase-ETag': 'true' },
    timeout: 3000,
  });
  return { data: res.data, etag: res.headers['etag'] };
}

// ETag 기반 조건부 PUT — If-Match 가 일치할 때만 쓰기 성공.
// 다른 브릿지가 먼저 쓴 경우 412 Precondition Failed 발생 → 호출자가 skip 처리.
// 반환: { ok: true } 성공 / { ok: false, conflict: true } 다른 브릿지 선점 / 그 외 throw
async function fbSetIfMatch(path, data, etag) {
  try {
    await axios.put(
      `${FIREBASE_URL}/${path}.json`,
      JSON.stringify(data === null ? null : data),
      {
        headers: {
          'Content-Type': 'application/json',
          'if-match': etag || 'null_etag',
        },
        timeout: 5000,
      }
    );
    fbErrorLogged = false;
    fbOk = true;
    return { ok: true };
  } catch (e) {
    if (e.response?.status === 412) {
      return { ok: false, conflict: true };
    }
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
    throw e;
  }
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
async function handleEndOfGame(abnormal = false) {
  if (eogSaved) return;

  try {
    const eog = await lcu('/lol-end-of-game/v1/eog-stats-block');
    if (!eog?.teams) return;

    const currentGameId = eog.gameId || null;

    // 이미 저장한 게임은 다시 잡지 않음 — 정상 경로 안전(새 게임은 gameId가 달라 통과),
    // 비정상 경로의 '직전 게임' 오저장도 차단 (gameId 캡처 실패해도 동작) (v1.1.30~)
    if (currentGameId && currentGameId === lastSavedGameId) return;

    // 비정상 경로(Reconnect/점프)에서만 추가 가드: eog-stats 가 '현재 진행 게임'이 아니면 무시.
    // 정상 종료 경로엔 적용 안 함 — 커스텀 게임에서 gameflow gameId ↔ eog gameId 불일치 시 정상 저장이 막히는 것 방지 (v1.1.30~)
    if (abnormal && activeGameId && currentGameId && currentGameId !== activeGameId) return;

    // 다른 브릿지가 이미 저장했는지 확인 (v1.1.26~)
    // gameId 가 동일하면 같은 게임 — 시간 무관 무조건 건너뜀.
    // gameId 가 다르면(서로 다른 게임) 새 게임이므로 진행.
    let _existingEtag = null;
    try {
      const { data: existing, etag } = await fbGetWithEtag(`${BRIDGE_ROOT}/eogStats`);
      _existingEtag = etag;
      if (existing && currentGameId && existing.gameId === currentGameId) {
        eogSaved = true;
        log('동일 gameId 데이터 이미 저장됨 — 건너뜀');
        return;
      }
      // gameId 가 없거나 다르더라도 30초 이내 stale 데이터면 다른 브릿지 진행 중일 수 있음
      if (existing?.savedAt && Date.now() - existing.savedAt < 30000 && !currentGameId) {
        eogSaved = true;
        log('게임 종료 데이터 이미 저장됨 (gameId 미상) — 건너뜀');
        return;
      }
    } catch (_) {}

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
          // 증강 (ARAM 프리즈매틱, 없으면 빈 배열 — 슬롯 수 동적 수집)
          augments: Object.keys(s).filter(k => /^PLAYER_AUGMENT_\d+$/.test(k)).sort((a,b) => parseInt(a.match(/\d+/)[0])-parseInt(b.match(/\d+/)[0])).map(k => s[k]).filter(i => i > 0),
          // 멀티킬 이벤트
          doubleKills: s.DOUBLE_KILLS || 0,
          tripleKills: s.TRIPLE_KILLS || 0,
          quadraKills: s.QUADRA_KILLS || 0,
          pentaKills:  s.PENTA_KILLS  || 0,
          firstBlood:  (s.FIRST_BLOOD_KILL || 0) === 1,
        });
      }
    }

    // ETag 조건부 PUT — 다른 브릿지가 우리 GET 이후 먼저 쓰면 412 발생 → skip (v1.1.26~)
    const _eogPayload = {
      players,
      winSide,
      gameId:   eog.gameId    || null,
      gameTime: eog.gameLength || 0,
      savedAt:  Date.now()
    };
    let _writeResult;
    try {
      _writeResult = await fbSetIfMatch(`${BRIDGE_ROOT}/eogStats`, _eogPayload, _existingEtag);
    } catch (e) {
      log('⚠️  EOG 저장 실패 — 일반 PUT 폴백');
      await fbSet(`${BRIDGE_ROOT}/eogStats`, _eogPayload);
      _writeResult = { ok: true };
    }
    if (_writeResult && _writeResult.conflict) {
      eogSaved = true;
      log('다른 브릿지가 먼저 저장 (ETag 충돌) — 건너뜀');
      return;
    }

    await fbSet(`${BRIDGE_ROOT}/voteStarted`, Date.now());

    eogSaved = true;
    lastSavedGameId = currentGameId;
    log(`게임 종료 저장 완료 ✅  승리: ${winSide === 'blue' ? '🔵 1팀' : '🔴 2팀'}`);
    log('투표 시작 신호 전송 완료 ✅');

  } catch (_) {}
}

// ── 게임 페이즈 폴링 (3초 간격) ───────────────────────────────────
let _pollFailCount = 0; // LCU 응답 연속 실패 카운트 (v1.1.31~)
async function poll() {
  if (!baseUrl) return;
  try {
    const phase = await lcu('/lol-gameflow/v1/gameflow-phase');
    _pollFailCount = 0; // 응답 성공 → 카운트 리셋

    if (phase !== lastPhase) {
      log(`페이즈 변경: ${lastPhase ?? '-'} → ${phase}`);
      lastPhase = phase;

      switch (phase) {
        case 'ChampSelect':
          await fbSet(`${BRIDGE_ROOT}/gamePhase`,'ChampSelect');
          break;

        case 'GameStart':
        case 'InProgress':
          gameInProgress = true;
          try {
            const _sess = await lcu('/lol-gameflow/v1/session');
            if (_sess?.gameData?.gameId) activeGameId = _sess.gameData.gameId;
          } catch (_) {}
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
          await handleEndOfGame();
          break;

        case 'EndOfGame':
          await fbSet(`${BRIDGE_ROOT}/gamePhase`,'EndOfGame');
          await handleEndOfGame();
          break;

        // 비정상 종료 — 게임 도중 튕김/창 닫힘 시 EndOfGame 을 안 거치고 Reconnect 로 빠질 수 있음 (v1.1.29~)
        // 게임이 진행 중이었다면 종료 통계를 시도. 아직 게임이 안 끝났으면 eog-stats 의 gameId 가 현재와 달라 자동 skip.
        case 'Reconnect':
          await fbSet(`${BRIDGE_ROOT}/gamePhase`, gameInProgress ? 'EndOfGame' : 'Reconnect');
          if (gameInProgress && !eogSaved) await handleEndOfGame(true);
          break;

        case 'None':
        case 'Lobby':
        case 'Matchmaking':
        case 'ReadyCheck':
          // InProgress 에서 EndOfGame 을 거치지 않고 바로 None/Lobby 로 점프한 경우, 마지막으로 한 번 통계 시도 (v1.1.29~)
          if (gameInProgress && !eogSaved && (phase === 'None' || phase === 'Lobby')) {
            await handleEndOfGame(true);
          }
          await fbSet(`${BRIDGE_ROOT}/gamePhase`,phase);
          await fbSet(`${BRIDGE_ROOT}/champSelect`, null);
          if (['None', 'Lobby'].includes(phase)) {
            eogSaved = false;
            gameInProgress = false;
            activeGameId = null;
          }
          break;
      }
    }

    if (phase === 'ChampSelect') {
      await handleChampSelect();
    }

    // EOG 통계 재시도 — 게임이 진행됐고 아직 저장 안 됐으면 종료 계열·비정상(Reconnect) 페이즈에서 계속 시도 (v1.1.29~)
    // Reconnect 는 비정상 경로이므로 gameId 가드 적용(abnormal=true), 정상 종료 계열은 미적용
    if (gameInProgress && !eogSaved &&
        ['EndOfGame','PreEndOfGame','WaitingForStats','Reconnect'].includes(phase)) {
      await handleEndOfGame(phase === 'Reconnect');
    }

  } catch (_) {
    // LCU 응답 없음 — 롤이 죽었는데 lockfile 이 stale 로 남은 경우 등.
    // 연속 4회(약 12초) 실패하면 강제 연결 해제 → 다음 _poll 이 lockfile 재확인 후 재연결 (v1.1.31~)
    _pollFailCount++;
    if (_pollFailCount >= 4) {
      _pollFailCount = 0;
      log('⚠️ LCU 응답 없음(연속) — 연결 재설정 시도');
      connector.forceReset();
    }
  }
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
  // 게임 진행 중 클라이언트가 완전히 닫히면 LCU 접근 불가 → 자동 저장 불가. 웹앱 수동 흐름으로 폴백 안내.
  if (gameInProgress && !eogSaved) {
    log('⚠️ 게임 진행 중 클라이언트 종료 — 자동 저장 불가. 웹앱에서 승리팀 수동 선택으로 진행하세요.');
  }
  baseUrl   = null;
  lastPhase = null;
  eogSaved  = false;
  gameInProgress = false;
  activeGameId = null;
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
