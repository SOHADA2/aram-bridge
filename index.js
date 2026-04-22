const LCUConnector = require('lcu-connector');
const axios        = require('axios');
const https        = require('https');

// ── Firebase 설정 ───────────────────────────────────────────────
const FIREBASE_URL = 'https://aramchaos-ca022-default-rtdb.asia-southeast1.firebasedatabase.app';

// ── LCU axios (자체 서명 인증서 무시) ───────────────────────────
const lcuClient = axios.create({
  httpsAgent: new https.Agent({ rejectUnauthorized: false }),
  timeout: 4000
});

// ── 상태 변수 ────────────────────────────────────────────────────
const connector    = new LCUConnector();
let baseUrl        = null;
let lastPhase      = null;
let pollTimer      = null;
let heartbeatTimer = null;
let eogSaved       = false;

// ── 유틸 ─────────────────────────────────────────────────────────
function log(msg) {
  const t = new Date().toLocaleTimeString('ko-KR');
  console.log(`[${t}] ${msg}`);
}

// ── Firebase 헬퍼 ─────────────────────────────────────────────────
async function fbSet(path, data) {
  try {
    await axios.put(
      `${FIREBASE_URL}/${path}.json`,
      JSON.stringify(data === null ? null : data),
      { headers: { 'Content-Type': 'application/json' }, timeout: 5000 }
    );
  } catch (e) {}
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
// 5초마다 타임스탬프 갱신 → 사이트에서 10초 이상 미갱신 시 "없음" 표시
// 강제 종료되어도 10초 안에 자동으로 "브릿지 없음"으로 전환됨
function startHeartbeat() {
  fbSet('session/bridgeHeartbeat', Date.now());
  heartbeatTimer = setInterval(() => fbSet('session/bridgeHeartbeat', Date.now()), 5000);
}

function stopHeartbeat() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  fbSet('session/bridgeHeartbeat', null).catch(() => {});
}

// ── 챔피언 선택 데이터 수집 ───────────────────────────────────────
async function handleChampSelect() {
  try {
    const session = await lcu('/lol/champ-select/v1/session');

    const mapPlayer = p => ({
      cellId:    p.cellId,
      champId:   p.championId,
      name:      p.summonerName || '',
      position:  p.assignedPosition || '',
      rerolls:   p.allowedRerolls ?? 2,
      isSelf:    !!p.isSelf
    });

    await fbSet('session/champSelect', {
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
      const existing = await fbGet('session/eogStats');
      if (existing?.savedAt && Date.now() - existing.savedAt < 30000) {
        eogSaved = true;
        log('게임 종료 데이터 이미 저장됨 — 건너뜀');
        return;
      }
    } catch (_) {}

    const eog = await lcu('/lol/end-of-game/v1/eog-stats-block');
    if (!eog?.teams) return;

    const winTeam  = eog.teams.find(t => t.isWinningTeam);
    const winSide  = winTeam?.teamId === 100 ? 'blue' : 'red';

    const players = [];
    for (const team of eog.teams) {
      for (const p of (team.players || [])) {
        const s = p.stats || {};
        players.push({
          summonerName: p.summonerName,
          championId:   p.championId,
          championName: p.skinName || '',
          kills:        s.CHAMPIONS_KILLED         || 0,
          deaths:       s.NUM_DEATHS               || 0,
          assists:      s.ASSISTS                  || 0,
          damage:       s.TOTAL_DAMAGE_DEALT_TO_CHAMPIONS || 0,
          gold:         s.GOLD_EARNED              || 0,
          cs:           (s.MINIONS_KILLED || 0) + (s.NEUTRAL_MINIONS_KILLED || 0),
          teamId:       team.teamId,
          isWin:        !!team.isWinningTeam
        });
      }
    }

    await fbSet('session/eogStats', {
      players,
      winSide,
      gameId:    eog.gameId || null,
      savedAt:   Date.now()
    });

    await fbSet('session/voteStarted', Date.now());

    eogSaved = true;
    log(`게임 종료 저장 완료 ✅  승리: ${winSide === 'blue' ? '🔵 1팀' : '🔴 2팀'}`);
    log('투표 시작 신호 전송 완료 ✅');

  } catch (_) {}
}

// ── 게임 페이즈 폴링 (3초 간격) ───────────────────────────────────
async function poll() {
  if (!baseUrl) return;
  try {
    const phase = await lcu('/lol/gameflow/v1/phase');

    if (phase !== lastPhase) {
      log(`페이즈 변경: ${lastPhase ?? '-'} → ${phase}`);
      lastPhase = phase;

      switch (phase) {
        case 'ChampSelect':
          await fbSet('session/gamePhase', 'ChampSelect');
          break;

        case 'GameStart':
        case 'InProgress':
          await fbSet('session/gamePhase', 'InProgress');
          await fbSet('session/champSelect', null);
          break;

        case 'PreEndOfGame':
        case 'WaitingForStats':
          await fbSet('session/gamePhase', 'EndOfGame');
          break;

        case 'EndOfGame':
          await fbSet('session/gamePhase', 'EndOfGame');
          await handleEndOfGame();
          break;

        case 'None':
        case 'Lobby':
        case 'Matchmaking':
        case 'ReadyCheck':
          await fbSet('session/gamePhase', phase);
          await fbSet('session/champSelect', null);
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
    const me = await lcu('/lol/summoner/v1/current-summoner');
    log(`접속 계정: ${me.displayName}`);
  } catch (_) {}

  // 다른 브릿지가 이미 실행 중인지 경고
  try {
    const hb = await fbGet('session/bridgeHeartbeat');
    if (hb && Date.now() - hb < 10000) {
      log('⚠️  다른 브릿지가 이미 실행 중입니다. 기존 브릿지를 먼저 종료하세요.');
    }
  } catch (_) {}

  await fbSet('session/bridgeConnected', true);
  startHeartbeat();

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
  stopHeartbeat();
  await fbSet('session/bridgeConnected', false).catch(() => {});
});

// ── 시작 ─────────────────────────────────────────────────────────
console.log('');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('  ARAM 브릿지 v1.0.1');
console.log('  롤 클라이언트를 기다리는 중...');
console.log('  이 창을 닫지 마세요.');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('');

connector.start();
