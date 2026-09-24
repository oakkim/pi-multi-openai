# pi-openai-pool

pi에서 **OpenAI 계정 여러 개를 우선순위로 묶어 쓰는 확장**입니다. 상위 계정의
사용량이 차거나 레이트 리밋에 걸리면 자동으로 다음 계정으로 넘어가고, 그것도
차면 다시 다음 계정으로 넘어갑니다. 계정이 복구되면 다시 우선순위대로 사용합니다.

```
 요청 ──► 1순위 계정 (사용량 소진) ──► 2순위 계정 (사용량 소진) ──► 3순위 계정 ✓
                │ 쿨다운 등록              │ 쿨다운 등록
                └─ 복구되면 자동으로 다시 1순위
```

## 지원 계정 종류

| kind | 계정 | 모델 프로바이더 | 인증 |
|---|---|---|---|
| `chatgpt` | ChatGPT Plus/Pro 등 플랜 계정 | `chatgpt-pool/*` (Codex 모델) | Codex `auth.json` 또는 refresh token |
| `apiKey` | OpenAI API 키 (또는 OpenAI 호환 엔드포인트) | `openai-pool/*` (OpenAI 모델) | API 키 |

두 종류를 한 설정에 섞어 둘 수 있습니다. 각 프로바이더의 요청은 해당 종류의
계정 안에서만 우선순위 failover 됩니다.

## 설치

```bash
# 방법 1) pi 패키지로 설치 (settings.json 에 자동 등록)
pi install git:github.com/oakkim/pi-multi-openai

# 방법 2) 직접 링크
ln -s ~/Projects/pi-multi-openai ~/.pi/agent/extensions/openai-pool
```

프로젝트 단위로 쓰려면 `.pi/extensions/` 에 링크하거나 `settings.json` 의
`extensions` 배열에 경로를 추가해도 됩니다. 설치 후 설정 파일을 생성합니다:

```
# pi 안에서: /openai-pool init   (샘플 설정 생성)
# 또는 직접: ~/.pi/agent/openai-pool.json 작성
```

## 설정

`~/.pi/agent/openai-pool.json` (환경변수 `OPENAI_POOL_CONFIG` 로 변경 가능)

```json
{
  "accounts": [
    { "name": "main",    "kind": "chatgpt", "authFile": "~/.codex/auth.json" },
    { "name": "sub-1",   "kind": "chatgpt", "refreshToken": "..." },
    { "name": "sub-2",   "kind": "chatgpt", "refreshToken": "...", "models": ["gpt-5.4*"] },
    { "name": "api-key", "kind": "apiKey",  "apiKey": "$OPENAI_API_KEY" }
  ],
  "strategy": "priority",
  "models": {
    "include": ["*"],
    "exclude": [],
    "custom": [
      { "id": "my-proxy-model", "name": "Proxy Model", "api": "openai-completions",
        "baseUrl": "https://proxy.example.com/v1", "contextWindow": 128000, "maxTokens": 8192 }
    ]
  },
  "policy": {
    "rateLimitCooldownMs": 60000,
    "usageLimitCooldownMs": 18000000,
    "transientCooldownMs": 30000,
    "attemptRetries": 0
  }
}
```

- **`accounts` 배열 순서가 곧 우선순위입니다.** 1번이 항상 먼저 쓰이고, 막히면
  2번, 3번으로 내려갑니다.
- `apiKey`: 리터럴, `$ENV` / `${ENV}`, `!command` (명령 출력 사용) 지원.
- `chatgpt` 인증: `authFile`(Codex CLI 의 `~/.codex/auth.json` 등)을 쓰면 pi가
  직접 토큰을 갱신하고 파일에도 기록합니다. `refreshToken`/`accessToken`을 직접
  넣으면 갱신된 토큰이 상태 파일에 저장됩니다.
- `models`: 계정별 모델 필터(`*` 글롭). 예: `["gpt-5.4*"]`면 해당 계정은
  `gpt-5.4` 계열 요청만 담당.
- `models.custom`: 카탈로그에 없는 모델(프록시, 파인튜닝) 정의. 같은 id면
  내장 모델을 대체합니다.
- `strategy`: `priority`(기본, 항상 최상위 가용 계정) | `rotate`(계정별로
  로드를 분산, 소진 시 failover 동일).

### 소진 판정과 쿨다운

| 실패 종류 | 예 | 처리 |
|---|---|---|
| 사용량/쿼터 | `insufficient_quota`, `usage limit`, billing | `usageLimitCooldownMs`(기본 5시간) 동안 소진 처리. 에러에 reset 시각이 있으면 그 시각 사용 |
| 레이트 리밋 | 429, `rate limit`, `Retry-After` | `Retry-After` 헤더 또는 `rateLimitCooldownMs`(기본 60초) |
| 인증 | 401, `invalid api key`, `invalid_grant` | 계정 비활성화 (`/openai-pool enable` 전까지 제외) |
| 일시 오류 | 5xx, 네트워크 | `transientCooldownMs`(기본 30초) |

상태(쿨다운/소진/사용량)는 `~/.pi/agent/openai-pool.state.json`에 영속화되어
pi를 재시작해도 유지됩니다.

## 사용

```bash
/model openai-pool/gpt-5.4       # API 키 계정 풀 사용
/model chatgpt-pool/gpt-5.4      # ChatGPT 계정 풀 사용
```

이후에는 평소처럼 쓰면 됩니다. 계정이 소진되면 알아서 다음 계정으로 전환되고
알림(`openai-pool: main 사용량 소진 → sub-1(으)로 전환`)과 상태바가 갱신됩니다.

### `/openai-pool` 명령

| 명령 | 설명 |
|---|---|
| `/openai-pool` | 계정별 상태·사용량·최근 오류 표시 |
| `/openai-pool init` | 설정 파일이 없으면 샘플 생성 |
| `/openai-pool test [name]` | 계정별 실제 인증/사용 가능 여부 점검 |
| `/openai-pool reset [name\|all]` | 쿨다운/소진/비활성 상태 초기화 |
| `/openai-pool enable\|disable <name>` | 계정 수동 활성/비활성 |
| `/openai-pool use [name]` | 계정 고정 (인자 없으면 고정 해제) |
| `/openai-pool reload` | 설정 다시 읽기 |

## 설계 메모

- **모든 계정이 소진이면**: 요청은 `openai-pool: 모든 계정 시도 실패 (...)`
  형태로 실패합니다. pi의 자동 재시도가 이 오류로 다시 시도하면 복구된 계정이
  있으면 그 계정으로 처리됩니다.
- **이미 출력이 스트리밍된 뒤의 실패**는 failover 하지 않고 그대로 전달합니다
  (중복 출력 방지). 사용량 소진 오류는 거의 항상 요청 시작 시 발생하므로
  실제 사용에서 투명하게 전환됩니다.
- 모델 메타데이터(비용·컨텍스트 창·호환 플래그)는 pi-ai 내장 카탈로그를
  그대로 사용하므로 토큰/비용 계산이 정확합니다.

## 테스트

```bash
node --test test/unit.test.mjs   # 분류/선택/쿨다운 로직 단위 테스트
./test/e2e.sh                    # mock 서버 + 실제 pi 로 failover 검증
```
