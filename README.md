# Value Archive 로컬 퍼포먼스 서버

Windows 노트북에서 대시보드, REST API, Quest WebSocket 연결, UDP 서버
발견을 함께 실행하는 Node.js 서버입니다. 실제 Quest가 없어도 두 개의 mock
클라이언트로 역할 배정, 상태, 시퀀스, 프리뷰 릴레이를 점검할 수 있습니다.

## 설치와 실행

Node.js **22.x**가 필요합니다. 먼저 버전을 확인합니다.

```powershell
node --version
```

출력이 `v22.`로 시작해야 합니다. 프로젝트 폴더에서 의존성을 설치하고 서버를
시작합니다.

```powershell
npm install
npm start
```

브라우저에서 <http://localhost:8765>를 열면 운영 대시보드가 표시됩니다.

| 프로토콜 | 포트 | 용도 |
|---|---:|---|
| TCP | 8765 | HTTP 대시보드, REST API, `/ws` WebSocket |
| UDP | 47800 | `VA_DISCOVER?` 서버 발견 요청/응답 |

기본 TCP 포트를 바꾸려면 서버를 시작하기 전에 `VA_PORT`를 설정합니다.

```powershell
$env:VA_PORT = '9000'
npm start
```

`VA_PORT`는 십진수 숫자로만 이루어진 `1`~`65535` 정수여야 하며, 값이
잘못되면 서버가 오류와 함께 시작을 중단합니다. 코드에서 서버를 생성할 때는
`httpPort`, `port`, `VA_PORT`, 기본값 `8765` 순서로 우선합니다. 명시적인
`httpPort` 또는 `port` 값이 `null`/`undefined`가 아니면 `VA_PORT`는
검사하지 않습니다.

이 문서의 대시보드 URL, REST API, TCP 방화벽 및 포트 확인 예제에 적힌
`8765`는 기본값입니다. `VA_PORT`를 설정했다면 해당 예제의 TCP 포트를
선택한 값으로 바꿉니다. UDP 발견 응답은 실제로 바인딩된 HTTP 포트를
광고합니다.

## Quest 없이 두 대로 점검하기

서버를 실행한 창은 그대로 두고 PowerShell 창 두 개를 더 엽니다. 각 창에서
아래 명령을 하나씩 정확히 실행합니다. `deviceId`는 서로 달라야 합니다.

```powershell
node tools/mock-quest.js mock-quest-a
```

```powershell
node tools/mock-quest.js mock-quest-b
```

두 mock은 UDP 브로드캐스트로 서버를 찾습니다. 발견이 차단된 환경에서는 같은
노트북의 서버에 직접 연결할 수 있습니다.

```powershell
node tools/mock-quest.js mock-quest-a --direct 127.0.0.1
node tools/mock-quest.js mock-quest-b --direct 127.0.0.1
```

mock의 `--direct` 모드는 서버의 `VA_PORT`를 상속하지 않고 항상 `8765`를
사용하는 고정 fallback이며, 직접 연결 포트를 지정하는 CLI 옵션은 없습니다.
`VA_PORT`를 바꿨다면 `--direct` 대신 UDP 발견 모드를 사용합니다.

mock은 welcome 이후 1초마다 health를 전송합니다. 대시보드에서 역할 A 또는
B를 받은 뒤에는 3초마다 역할별 색상의 JPEG 프레임을 보내며, 프레임 요청에는
즉시 응답합니다. 연결이 끊기면 2초 뒤 재연결을 시도합니다. 로그 앞의
`[mock:mock-quest-a]` 같은 접두사로 두 창을 구분할 수 있습니다.

대시보드의 장치 목록에서 `mock-quest-a`와 `mock-quest-b`에 A/B 역할을
배정합니다. 같은 역할을 다른 장치에 다시 배정하면 새 장치가 역할을
가져가고 이전 장치는 `role: null`이 되어 즉시 프레임 전송을 멈춥니다.
역할 매핑은 `data/devices.json`에 저장되므로 서버를 다시 시작해도
유지됩니다.

연결 중 마지막 활동 또는 health가 5초 넘게 갱신되지 않으면 장치는
`offline`으로 표시됩니다. WebSocket이 실제로 끊긴 경우에는 더 일찍
offline으로 표시될 수 있습니다. mock은 정상 연결 중 1 Hz로 health를
보내므로 offline 전환은 연결/프로세스 문제를 찾는 신호로 사용할 수 있습니다.

## REST API로 상태와 제어 확인하기

PowerShell의 `Invoke-RestMethod`로 대시보드와 같은 서버 상태를 점검할 수
있습니다.

```powershell
Invoke-RestMethod -Method Get -Uri 'http://localhost:8765/api/state'
```

역할을 직접 배정하는 예:

```powershell
$body = @{ deviceId = 'mock-quest-a'; role = 'A' } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri 'http://localhost:8765/api/assign' -ContentType 'application/json' -Body $body
```

시퀀스를 시작하거나 다음 단계로 이동하는 예:

```powershell
$body = @{ action = 'start' } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri 'http://localhost:8765/api/seq' -ContentType 'application/json' -Body $body

$body = @{ action = 'next' } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri 'http://localhost:8765/api/seq' -ContentType 'application/json' -Body $body
```

`action`은 `start`, `stop`, `next`, `prev`, `goto`를 지원하며 `goto`에는
`stepIndex`를 함께 보냅니다. 현재 버전은 `data/sequence.json`의
`timer`/`condition` 구조를 읽을 수 있지만 **자동 전환은 구현하지 않았습니다**.
mock의 거리가 조건을 만족해도 단계가 자동으로 넘어가지 않으므로 대시보드
버튼이나 `/api/seq` 호출로만 진행해야 합니다.

## 프리뷰 소스

대시보드에서 역할별 프리뷰 소스를 `eye` 또는 `pca`로 선택할 수 있습니다.
서버는 선택 메시지를 현재 역할의 Quest에 전달하고 Quest가 보낸 JPEG 바이트를
대시보드로 그대로 통과시킵니다. 서버 자체는 소스를 캡처하거나 이미지를
변환하지 않습니다.

mock은 선택된 `eye`/`pca` 값을 기록하고 로그에 남기지만, 실제 카메라가
없으므로 두 소스 모두 동일한 역할별 단색 이미지(A와 B는 서로 다른 색)를
보냅니다. 따라서 소스 선택 배선과 릴레이는 검증할 수 있지만 실제 eye/PCA
화질이나 카메라 구도는 검증할 수 없습니다.

## Windows 방화벽과 네트워크

실제 Quest가 접속할 노트북의 네트워크 프로필을 **Private**로 설정하고,
관리자 PowerShell에서 다음 인바운드 규칙을 추가합니다. TCP 규칙은 기본
포트 `8765` 기준이며, `VA_PORT`를 설정했다면 선택한 포트로 바꿉니다.

```powershell
New-NetFirewallRule -DisplayName 'Value Archive TCP 8765' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8765 -Profile Private
New-NetFirewallRule -DisplayName 'Value Archive UDP 47800' -Direction Inbound -Action Allow -Protocol UDP -LocalPort 47800 -Profile Private
```

노트북에 Wi-Fi, Ethernet, VPN처럼 IPv4 인터페이스가 여러 개 있으면 서버가
잘못된 주소를 광고할 수 있습니다. Quest와 같은 LAN에 있는 노트북 IPv4를
지정한 뒤 서버를 시작합니다.

```powershell
$env:VA_ADVERTISE_IP = '192.168.50.10'
npm start
```

`VA_ADVERTISE_IP`는 유효한 IPv4여야 하며 UDP 발견 응답에 실릴 주소를
고정합니다. 현재 PowerShell 창에서만 적용됩니다.

발견 또는 연결이 되지 않으면 다음 순서로 확인합니다.

1. 노트북과 Quest가 같은 서브넷인지 확인하고 VPN을 잠시 끕니다.
2. 공유기/AP의 **client isolation(AP isolation)** 기능을 끕니다.
3. 게스트 Wi-Fi, 기업망처럼 UDP 브로드캐스트를 차단하는 망이면 직접 연결을
   사용합니다. 다른 장치에서 실행하는 mock 또는 실제 Quest에는
   `127.0.0.1` 대신 노트북 LAN IPv4를 사용합니다.

   ```powershell
   node tools/mock-quest.js mock-quest-a --direct 192.168.50.10
   ```

4. `VA_ADVERTISE_IP`가 VPN이나 사용하지 않는 어댑터 주소가 아닌지 확인합니다.
5. 포트 충돌을 확인합니다. 아래 TCP 명령의 `8765`는 기본값이므로
   `VA_PORT`를 설정했다면 선택한 포트로 바꿉니다.

   ```powershell
   Get-NetTCPConnection -LocalPort 8765 -ErrorAction SilentlyContinue
   Get-NetUDPEndpoint -LocalPort 47800 -ErrorAction SilentlyContinue
   ```

   다른 프로세스가 점유 중이면 그 프로그램을 정상 종료한 뒤 서버를 다시
   시작합니다. 서버 TCP는 기본 `8765` 또는 `VA_PORT`로 선택한 포트를,
   mock 직접 연결은 항상 TCP `8765`를, 발견은 UDP `47800`을 사용합니다.
   충돌한 상태에서 다른 포트로 자동 우회하지 않습니다.

## 운영 보안 경계와 종료

이 서버는 현장 **전용 신뢰 LAN**을 전제로 하며 인증, 사용자 권한, TLS가
없습니다. 같은 네트워크의 다른 사용자가 대시보드와 REST/WS 제어에 접근할 수
있으므로 공용 Wi-Fi, 인터넷 공개, 공유기 포트 포워딩 환경에서 실행하지
마십시오.

서버와 각 mock 창에서 `Ctrl+C`를 누르면 WebSocket, UDP 소켓과 모든
재연결/health/frame 타이머를 정리하고 종료합니다. 창을 강제로 닫기보다
`Ctrl+C`를 사용하십시오.
