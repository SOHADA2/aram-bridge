# ARAM 브릿지 (aram-bridge)

## 프로젝트 개요
롤 클라이언트(LCU)의 게임 데이터를 Firebase로 전송하는 Windows 백그라운드 프로그램.
ARAM 내전 웹앱(https://github.com/SOHADA2/aram)과 연동됨.

## 기술 스택
- **런타임**: Node.js (단일 파일 `index.js`)
- **패키징**: `pkg` → Windows exe (node18-win-x64)
- **배포**: GitHub Releases (ZIP + exe)
- **HTTP 상태 페이지**: http://127.0.0.1:7654 (exe 실행 시 자동 오픈)

## 빌드 방법
```
node node_modules\pkg\lib-es5\bin.js . --targets node18-win-x64 --output dist/aram-bridge-vX.X.X.exe
```
- `npm run build`는 PATH 문제로 직접 실행 필요
- 빌드 전 `package.json`의 version 먼저 올릴 것

## 배포 방법
```
# ZIP 생성 (exe + VBS 런처 동봉)
Compress-Archive -Path dist/aram-bridge-vX.X.X.exe, "이 파일을 실행해 주세요.vbs" -DestinationPath dist/aram-bridge-vX.X.X.zip

# GitHub 릴리즈 생성
gh release create vX.X.X dist/aram-bridge-vX.X.X.zip dist/aram-bridge-vX.X.X.exe --repo SOHADA2/aram-bridge --title "vX.X.X — 변경내용"
```

## 현재 구조 (v1.1.25)
- `index.js` — 메인 로직 (LCU 폴링, Firebase 전송, HTTP 서버)
- `이 파일을 실행해 주세요.vbs` — 런처 (콘솔창 없이 exe 백그라운드 실행, Zone.Identifier 자동 해제)
- `launcher.vbs` — 위 파일의 원본 (동일 내용)
- `package.json` — 버전 관리
- `dist/` — 빌드 결과물 (gitignore)

## VBS 런처 주의사항
- **인코딩**: CP949(ANSI)로 저장해야 한글 팝업 정상 표시
- 저장 후 인코딩 변환: `[System.IO.File]::WriteAllText(path, content, [System.Text.Encoding]::GetEncoding(949))`
- Zone.Identifier 해제: exe 실행 전 PowerShell `Remove-Item -Stream Zone.Identifier` 호출

## HTTP 상태 페이지 기능
- `/` — 상태 페이지 HTML (브릿지/LCU/Firebase 상태, 종료 버튼, 브릿지 안내)
- `/api/status` — JSON 상태 (version, connected, phase, fbOk, now)
- `/api/shutdown` — POST → process.exit(0), 브라우저 탭 자동 닫기

## LCU API 주요 경로
- 게임페이즈: `/lol-gameflow/v1/gameflow-phase`
- 챔피언선택: `/lol-champ-select/v1/session`
- 소환사정보: `/lol-summoner/v1/current-summoner`
- 게임종료통계: `/lol-end-of-game/v1/eog-stats-block`
- lockfile 위치: `C:\Riot Games\League of Legends\lockfile` (D드라이브 등 후보도 자동 탐색)

## Firebase 연동
- 웹앱 리포의 Firebase 설정과 동일한 프로젝트 사용
- `bridge/` 경로에 게임 상태 실시간 기록

## 버전 이력 요약
| 버전 | 주요 변경 |
|------|-----------|
| v1.1.2 | wmic 없이 lockfile 직접 파싱 (Windows 11 대응) |
| v1.1.19 | self-restart 제거, 단일 프로세스로 HTTP 서버 운영 |
| v1.1.21 | VBS 런처 배포 방식 전환, Zone.Identifier 자동 해제 |
| v1.1.22 | 상태 페이지 종료 버튼 + /api/shutdown |
| v1.1.23 | 상태 페이지 브릿지 안내 카드 추가 |
| v1.1.24 | VBS 파일명 → '이 파일을 실행해 주세요.vbs' |
| v1.1.25 | 종료 후 브라우저 탭 자동 닫기 |
