#!/bin/bash
# 独立部署构建：把 src/ 里 DSH 无关的服务端图编译到 dist/（不依赖 DSH checkout，只用 typescript）。
# 产物：dist/server.js —— 可脱离 DSH 直接 `node dist/server.js` 运行。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

find_tsc() {
  if [ -x "node_modules/.bin/tsc" ]; then echo "$ROOT/node_modules/.bin/tsc"; return; fi
  local checkout="${DSH_CHECKOUT:-}"
  if [ -z "$checkout" ]; then
    for candidate in "/Users/tsbj/feyanggit/deepseek-harness" "$HOME/deepseek-harness" "$HOME/feyanggit/deepseek-harness"; do
      if [ -x "$candidate/node_modules/.bin/tsc" ]; then checkout="$candidate"; break; fi
    done
  fi
  if [ -n "$checkout" ] && [ -x "$checkout/node_modules/.bin/tsc" ]; then echo "$checkout/node_modules/.bin/tsc"; return; fi
  return 1
}

TSC="$(find_tsc || true)"
if [ -z "$TSC" ]; then
  echo "=== 本地未安装 typescript，尝试 npx（需要网络） ==="
  npx --yes typescript@5 tsc -p tsconfig.server.json
else
  echo "=== Compiling standalone service (tsc: $TSC) ==="
  "$TSC" -p tsconfig.server.json
fi

# 内联脚本语法关卡：三个页面（控制台/投屏/登录）的 <script> 必须能通过 node --check。
# web-ui 等页面源码位于 TS 模板字符串内，\n 等转义一旦漏写双写就会让整页 JS 断裂（历史故障两次）。
node --input-type=module -e "
import { renderWebUi } from './dist/web-ui.js';
import { renderMonitorUi } from './dist/monitor-ui.js';
import { renderLoginUi } from './dist/login-ui.js';
import { writeFileSync } from 'node:fs';
const checks = {
  console: renderWebUi('/onenat-workbuddy', { version: '0.0.0-check' }),
  monitor: renderMonitorUi('/onenat-workbuddy', '0.0.0-check'),
  login: renderLoginUi('/onenat-workbuddy', undefined, '0.0.0-check'),
};
let i = 0;
for (const [name, html] of Object.entries(checks)) {
  const m = html.match(/<script>([\\s\\S]*)<\\/script>/);
  if (!m) continue;
  writeFileSync('dist/.page-check-' + name + '.js', m[1]);
  i++;
}
console.log('page scripts extracted: ' + i);
"
page_ok=1
for f in dist/.page-check-*.js; do
  [ -e "$f" ] || continue
  if ! node --check "$f" 2>/tmp/wb-page-check-err; then
    echo "build:standalone 失败：页面内联脚本语法错误 —— 检查模板字符串内换行/引号转义是否双写" >&2
    cat /tmp/wb-page-check-err >&2
    rm -f /tmp/wb-page-check-err
    exit 1
  fi
  rm -f /tmp/wb-page-check-err
done
if [ "$page_ok" != "1" ]; then exit 1; fi

if [ ! -f dist/server.js ]; then
  echo "build:standalone 失败：dist/server.js 未生成" >&2
  exit 1
fi

# 独立运行只需要 ssh2（可选）与 undici（可选）；dist 里不应出现 DSH 依赖
if grep -rqE "from '(@deepseek-ai|cordis|schemastery)'|require\('(@deepseek-ai|cordis|schemastery)'\)" dist/*.js 2>/dev/null; then
  echo "build:standalone 失败：dist/ 里检测到 DSH 依赖引用" >&2
  exit 1
fi

echo "=== Standalone build complete: dist/server.js ==="
