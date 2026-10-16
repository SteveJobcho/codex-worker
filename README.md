# codex-worker

Claude Code에서 **Claude가 Codex(OpenAI)를 워커로 직접 부리게** 해 주는 플러그인입니다. [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) 1.0.4를 포크해서 고쳤어요.

원본은 사람이 `/codex:rescue` 같은 명령을 입력해야 움직입니다. 이 포크에서는 Claude가 스스로 판단해서 일을 나눠 맡기고, 여러 Codex를 동시에 돌리고, 결과를 직접 검증한 뒤 합칩니다.

## 할 수 있는 것

- **스스로 위임:** Claude가 Bash로 Codex를 바로 실행합니다. 중간에 거치는 에이전트가 없어요. 언제 맡길지는 `worker` 스킬을 보고 Claude가 판단합니다.
- **병렬 워커:** `--worktree <이름>`을 주면 워커마다 `codex/<이름>` 브랜치로 따로 작업 폴더(git worktree)가 생깁니다. 여러 Codex가 동시에 코드를 고쳐도 서로 겹치지 않고, 원래 작업 폴더도 건드리지 않아요.
- **권한 지정:** `--sandbox read-only | write | full`
- **이어서 지시:** `--thread <jobId>`로 같은 작업 대화를 이어 갑니다. 작업하던 폴더, worktree, 권한이 그대로 유지돼요.
- **검증 가능한 결과:** `--json`으로 최종 답변, 바뀐 파일, 실행한 명령과 종료 코드, 오류를 돌려줍니다.
- **Sol용 프롬프트 작성법:** `sol-prompting` 스킬은 OpenAI 최신 모델 가이드를 바탕으로, GPT-6 계열이 일을 중간에 멈추거나 테스트·서식을 과하게 하는 버릇을 막는 프롬프트 틀을 담고 있어요.
- **모델 나눠 쓰기:** 기본은 `gpt-6.1-sol`이에요. 수치 바꾸기, 이름 바꾸기, 파일 구조 파악 같은 단순한 일은 빠르고 저렴한 `gpt-6-luna`로 보냅니다. 사소한 일도 적극적으로 맡겨요.
- **위임 규칙:** UI·프론트엔드 작업은 Codex에 맡기지 않습니다. 맡길 때는 이름, 함수 형식, 예외 동작, 오류 문구까지 Claude가 미리 다 정해서, 한 번에 제대로 된 결과가 나오게 지시합니다.

## 필요한 것

- [Claude Code](https://claude.com/claude-code)
- Node.js 18 이상
- Codex CLI **0.159 이상** (`gpt-6.1-sol`을 쓰려면 필요해요)
  ```bash
  npm install -g @openai/codex@latest
  ```
- Codex 로그인
  ```bash
  codex login
  ```

## 설치

```bash
claude plugin marketplace add SteveJobcho/codex-worker
```

```bash
claude plugin install codex-worker@neohee-local
```

설치한 뒤 Claude Code를 다시 시작하세요. 같은 기능이 겹치지 않도록, 원본 `codex@openai-codex` 플러그인을 쓰고 있었다면 꺼 두는 게 좋습니다.

```bash
claude plugin disable codex@openai-codex
```

준비가 됐는지는 Claude Code에서 `/codex-worker:setup`을 실행하면 확인할 수 있어요.

## 사용법

평소처럼 Claude에게 일을 시키면 됩니다. Claude가 맡길 만하다고 판단하면 알아서 Codex를 부릅니다. 꼭 맡기고 싶을 때는 이렇게 하세요.

- "codex한테 시켜" 또는 "워커로 돌려"라고 말하기
- `/codex-worker:rescue <할 일>` 입력하기
- `/codex-worker:review`, `/codex-worker:adversarial-review`: 변경 사항을 Codex에게 리뷰받기
- `/codex-worker:status`, `/codex-worker:result`, `/codex-worker:cancel`: 작업 상태 보기, 결과 보기, 취소

Bash에서 직접 실행할 수도 있어요.

```bash
node ~/.codex-worker/cw.mjs task --json --worktree fix-login --prompt-file brief.md
```

## 설정 (환경 변수)

| 변수 | 기본값 | 설명 |
|---|---|---|
| `CODEX_WORKER_MODEL` | `gpt-6.1-sol` | 워커가 쓰는 기본 모델 |
| `CODEX_WORKER_LUNA_MODEL` | `gpt-6-luna` | 단순한 일에 쓰는 모델 (`--model luna`) |
| `CODEX_WORKER_STATE_DIR` | `~/.codex-worker/state` | 작업 기록을 저장하는 곳 |
| `CODEX_WORKER_WORKTREE_DIR` | `~/.codex-worker/worktrees` | worktree를 만드는 곳 |
| `CODEX_WORKER_BROKER` | (꺼짐) | `1`이면 워커마다 Codex를 따로 띄우지 않고, 하나를 함께 씁니다 |

## 문제 해결

- **`'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account`**: Codex CLI가 오래된 버전이에요. `npm install -g @openai/codex@latest`로 업데이트하세요 ([openai/codex#49396](https://github.com/openai/codex/issues/49396)). 그래도 안 되면 `CODEX_WORKER_MODEL=gpt-6-sol`로 바꿔 보세요.
- **`--worktree`에서 "no commits yet" 오류**: 저장소에 커밋이 하나 이상 있어야 worktree를 만들 수 있어요.

## 라이선스

Apache License 2.0. 원본 저작권은 OpenAI에 있습니다. 바뀐 내용은 [`codex-worker/NOTICE`](codex-worker/NOTICE)와 [`codex-worker/CHANGELOG.md`](codex-worker/CHANGELOG.md)에 적혀 있어요.
