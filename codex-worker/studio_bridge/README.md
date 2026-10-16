# Studio 브리지

여러 에이전트가 함께 쓰는 로컬 파일 서버와 Studio 클라이언트입니다. 큰 스크립트를 고칠 때 Studio 소스를 로컬 사본으로 받고(pull), Edit 도구로 사본을 고치고, Studio에서 사본을 불러 테스트한 뒤(load), 마지막에 한 번만 Studio에 씁니다(push). 에이전트마다 HTTP 서버를 새로 만들지 않습니다.

언제 브리지를 쓰는지는 codex-worker의 `worker` 스킬에 있는 "Roblox Studio jobs" 섹션을 따릅니다. 프로젝트에 자체 `tools/studio_bridge`가 있으면 그쪽 규칙(CLAUDE.md 등)이 우선입니다. 몇 군데만 고치는 작은 수정은 브리지 없이 multi_edit로 합니다.

- `server.py`: Python 표준 라이브러리만 씁니다. `127.0.0.1:47600`에서만 받습니다.
- `bridge.lua`: 서버가 `/bridge.lua`로 내려 주는 Studio 쪽 클라이언트입니다.

## 1. 서버 시작

```bash
node ~/.codex-worker/cw.mjs bridge start
```

프로젝트에 `tools/studio_bridge/server.py`가 있으면 그걸, 없으면 플러그인에 들어 있는 사본을 실행합니다. 두 사본은 바이트 단위로 같아서(`SHA256SUMS.txt`) 같은 서버를 함께 씁니다. 직접 실행해도 됩니다: `python <이 폴더>/server.py`

- 이미 떠 있으면 그 서버를 그대로 쓰고 종료 코드 0으로 끝납니다. 그래서 작업을 시작할 때마다 실행해도 됩니다.
- 출력의 `READY` 줄에 주소와 루트 폴더가 나옵니다.
  `READY studio_bridge http://127.0.0.1:47600 root=C:\Users\junju\AppData\Local\Temp\studio_bridge pid=1234`
- 서버는 실행한 셸과 분리되어 떠 있으므로, 띄운 에이전트가 끝나도 계속 돌아갑니다. 6시간 동안 요청이 없으면 스스로 꺼집니다.
- 공유 서버이므로 에이전트는 `stop`을 부르지 않습니다. 다른 에이전트가 쓰고 있을 수 있습니다.

| 명령 | 하는 일 |
|---|---|
| `server.py` 또는 `server.py start` | 없으면 띄우고, 있으면 그대로 둡니다. `READY` 줄을 출력합니다. |
| `server.py status` | 떠 있으면 종료 코드 0, 없으면 3입니다. |
| `server.py stop` | 서버를 끕니다. 사용자나 메인 세션만 씁니다. |
| `server.py serve` | 포그라운드로 실행합니다. 디버깅용입니다. |

옵션은 `--port`(기본 47600), `--root`(기본 `%LOCALAPPDATA%\Temp\studio_bridge`), `--idle-hours`(기본 6, 0이면 꺼지지 않음)입니다.

## 2. 파일 위치

- 에이전트마다 루트 아래에 자기 하위 폴더를 하나 씁니다. 예: `ui-fix/`, `beggar-robot/`. 그래야 동시에 도는 에이전트 5개가 서로의 사본을 덮어쓰지 않습니다.
- `B.pull(inst, "ui-fix/ShopUI.lua")`로 받은 사본은 `<root>\ui-fix\ShopUI.lua`에 생깁니다. `B.file(rel)`이 전체 경로를 알려 줍니다.
- pull은 옆에 `ShopUI.lua.base.json`을 만듭니다. pull할 때의 해시와 원본 스크립트 경로가 들어 있고, push가 이것으로 충돌을 검사합니다. 지우지 않습니다.
- 서버 HTTP 경로: `GET /health`, `GET /bridge.lua`, `GET /file?name=<rel>`, `POST /file?name=<rel>`. 루트 밖을 가리키는 경로는 거부합니다.

## 3. 사용 예

execute_luau(Edit 모드)마다 첫 줄에서 클라이언트를 불러옵니다.

```lua
local B = loadstring(game:GetService("HttpService"):GetAsync("http://127.0.0.1:47600/bridge.lua", true))()
```

**① pull**: Studio 소스를 로컬 사본으로 받습니다. 반환값은 기준 해시입니다.

```lua
local B = loadstring(game:GetService("HttpService"):GetAsync("http://127.0.0.1:47600/bridge.lua", true))()
return B.pull(game.ReplicatedStorage.Modules.ShopUI, "ui-fix/ShopUI.lua")
```

**② 사본 수정**: `C:\Users\junju\AppData\Local\Temp\studio_bridge\ui-fix\ShopUI.lua`를 grep하고 필요한 부분만 Read한 뒤, Edit 도구로 정확한 문자열 치환을 합니다. 파일 전체를 Write하지 않고, Python 패치 스크립트도 쓰지 않습니다.

**③ load로 테스트**: 사본을 새로 컴파일해서 모듈을 돌려줍니다. 컴파일 오류가 있으면 `[bridge] compile error in ui-fix/ShopUI.lua: ui-fix/ShopUI.lua:12: ...` 형태로 실패합니다. 두 번째 인자로 원래 스크립트를 넘기면 사본 안의 `script`가 그 스크립트를 가리키므로 `script.Parent` 같은 참조가 동작합니다.

```lua
local B = loadstring(game:GetService("HttpService"):GetAsync("http://127.0.0.1:47600/bridge.lua", true))()
local s = game.ReplicatedStorage.Modules.ShopUI
local M = B.load("ui-fix/ShopUI.lua", s)
-- 스냅샷 → 실행 → 측정 → 정리 → 비교 (SUBAGENT_RULES §3)
return M.formatPrice(1200)
```

일반 Script처럼 실행하면 안 되는 코드는 `B.check(rel)`로 컴파일만 확인합니다. 결과는 `{ok = true}` 또는 `{ok = false, error = "..."}`입니다.

**④ push 한 번, 그리고 해시 확인**: 모든 수정이 끝난 뒤 한 번만 씁니다.

```lua
local B = loadstring(game:GetService("HttpService"):GetAsync("http://127.0.0.1:47600/bridge.lua", true))()
local s = game.ReplicatedStorage.Modules.ShopUI
local r = B.push(s, "ui-fix/ShopUI.lua")
return { push = r, final = B.status(s, "ui-fix/ShopUI.lua") }
```

- push는 쓰기 직전에 Studio 소스를 다시 읽습니다. pull 때 해시와 다르면 다른 세션이 고친 것이므로 아무것도 쓰지 않고 실패합니다.
- 사본이 컴파일되지 않거나, 다른 스크립트에서 pull한 사본이면 쓰지 않습니다.
- 쓰기는 `ScriptEditorService:UpdateSourceAsync`로 하고, 5초 안에 끝나지 않으면 `.Source`로 씁니다. 결과의 `method`에 실제로 쓴 방법이 나옵니다.
- 쓴 뒤 Studio 소스의 해시가 사본 해시와 같은지 확인하고, 다르면 실패합니다.
- 최종 확인은 `B.status`의 `same = true`이면 됩니다.

## 4. push가 중단되었을 때

`[bridge] push aborted: ... changed in Studio since pull`가 나오면 다른 세션이 그 사이에 스크립트를 고친 것입니다. Studio에는 아무것도 쓰이지 않았습니다.

1. 새 이름으로 다시 받습니다. 예: `B.pull(s, "ui-fix/ShopUI.v2.lua")`
2. 내 수정을 새 사본에 Edit로 옮깁니다. 다른 세션의 변경은 그대로 둡니다.
3. 새 사본으로 push합니다. `B.push(s, "ui-fix/ShopUI.v2.lua")`
4. 보고서에 다른 세션의 변경을 보존했다고 적습니다.

`pull refused: local copy ... has edits that were not pushed`는 아직 push하지 않은 사본을 pull이 덮어쓰려 할 때 나옵니다. 사본을 버려도 되면 `{force = true}`를 넘깁니다.

## 5. API

| 함수 | 반환 |
|---|---|
| `B.pull(inst, rel[, {force = true}])` | 기준 해시 문자열 |
| `B.load(rel[, scriptInst])` | 사본 청크가 반환하는 값 |
| `B.check(rel)` | `{ok, error}` (컴파일만 하고 실행하지 않음) |
| `B.push(inst, rel[, baseHash[, {timeout = 5, force = true}]])` | `{status = "pushed"/"unchanged", hash, method, bytes, target}` |
| `B.status(inst, rel)` | `{same, liveChanged, live, local, base, target}` |
| `B.read(rel)` / `B.write(rel, text)` | 사본 내용 / 저장한 해시 |
| `B.source(inst)` | Studio 소스 (열린 편집기 내용 우선) |
| `B.hash(s)` | `"%08x-<바이트 수>"` (FNV-1a 32비트, `server.py`의 `bridge_hash`와 같음) |
| `B.file(rel)` | 사본의 전체 로컬 경로 |
| `B.safe(s)` / `B.path(inst)` | UTF-8이 깨진 이름은 `"<bad>"`로 바꾼 문자열 |

- 실패는 모두 `[bridge]`로 시작하는 error입니다.
- execute_luau는 첫 번째 반환값만 보여 주고, 테이블은 JSON으로 보여 줍니다. 여러 값을 보려면 테이블 하나로 묶어 반환합니다.
- 사본이 CRLF로 바뀌었으면 push와 load가 LF로 되돌립니다. Studio 소스가 원래 CR을 쓰면 그대로 둡니다. 파일 앞의 UTF-8 BOM은 지웁니다.
