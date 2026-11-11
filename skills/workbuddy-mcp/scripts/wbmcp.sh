#!/usr/bin/env bash
# OneNat WorkBuddy MCP 客户端（Streamable HTTP，JSON-RPC over POST）
# 用法:
#   wbmcp.sh tools                          # 列出全部工具(name+描述)
#   wbmcp.sh call <toolName> '<json-arguments>'
#   wbmcp.sh raw  '<完整 JSON-RPC 请求体>'
#   wbmcp.sh putfile <本地文件> <taskId> [远端文件名]   # 大文件分片直传(≤2GB, 断点续传)
# 带大文件的任务标准流程（顺序不能反！）:
#   ① wbmcp.sh call workbuddy_task_manage '{"action":"create",...不带 message...}'  → draft 拿 taskId
#   ② wbmcp.sh putfile <文件> <taskId>                                            → 落盘工作区
#   ③ wbmcp.sh call workbuddy_task_manage '{"action":"send","taskId":"...","message":"引用路径的指令"}' → 才开始执行
#   create 带 message 会立即执行——文件没传任务就开跑，执行者读不到附件
# 配置: 环境变量 WORKBUDDY_BASE_URL / WORKBUDDY_TOKEN > ~/.workbuddy-skill.json（一键安装脚本写入）；
#       MCP 地址 = $BASE_URL/mcp。缺配置时脚本会提示安装命令。
# 会话自动握手并缓存于 $TMPDIR/workbuddy-mcp.sid；失败清缓存，下次显式调用重新握手。
# 请求绝不自动重放（包括超时/会话过期），避免重复执行 create/send/dispatch。
# WORKBUDDY_TIMEOUT_SECONDS 可调整单次 HTTP 超时（默认 300 秒）。
set -uo pipefail

CFG="${WORKBUDDY_CONFIG:-$HOME/.workbuddy-skill.json}"
_cfg() { python3 -c 'import sys,json;print(json.load(open(sys.argv[1])).get(sys.argv[2]) or "")' "$CFG" "$1" 2>/dev/null; }
BASE_URL="${WORKBUDDY_BASE_URL:-$(_cfg baseUrl)}"
TOKEN="${WORKBUDDY_TOKEN:-$(_cfg token)}"
if [[ -z "$BASE_URL" || -z "$TOKEN" ]]; then
  echo "缺少 WorkBuddy 配置（baseUrl/token）。二选一：" >&2
  echo "  ① 一键安装: curl -fsSL <工作台地址>/install-skill.sh | bash -s -- --base-url <工作台地址> --token <APIKEY>" >&2
  echo "  ② 环境变量: export WORKBUDDY_BASE_URL=<...> WORKBUDDY_TOKEN=<APIKEY>（配置文件: ${CFG}）" >&2
  exit 1
fi
URL="${BASE_URL%/}/mcp"
SID_FILE="${TMPDIR:-/tmp}/workbuddy-mcp.sid"

# 只打印固定诊断，不回显远端错误文本、响应头或 curl 详情（可能含凭据）。
_rpc_response() { # $1=request $2=HTTP status；stdin=JSON/SSE，stdout=单个匹配的 RPC 响应
  python3 -c '
import json, sys
request, status = json.loads(sys.argv[1]), int(sys.argv[2])
raw = sys.stdin.read()
def fail(message):
    print("wbmcp: " + message, file=sys.stderr)
    sys.exit(1)
try:
    messages = []
    if raw.strip():
        try:
            decoded = json.loads(raw)
            messages = decoded if isinstance(decoded, list) else [decoded]
        except ValueError:
            # SSE: 按事件边界组装多行 data；解析每一帧，不能吞掉损坏帧。
            data = []
            for line in raw.replace("\r\n", "\n").split("\n") + [""]:
                if not line:
                    if data:
                        messages.append(json.loads("\n".join(data)))
                        data = []
                elif line.startswith(":"):
                    continue
                else:
                    field, sep, value = line.partition(":")
                    if field not in ("data", "event", "id", "retry"):
                        raise ValueError()
                    if field == "data":
                        data.append(value[1:] if value.startswith(" ") else value)
    if any(not isinstance(m, dict) or m.get("jsonrpc") != "2.0" for m in messages):
        raise ValueError()
    if "id" not in request:
        if not 200 <= status < 300: fail("HTTP request failed (status %d)" % status)
        if any("error" in m for m in messages): fail("RPC notification failed")
        sys.exit(0)
    matches = [m for m in messages if "id" in m and m["id"] == request["id"]]
    if len(matches) != 1: raise ValueError()
    response = matches[0]
    if ("result" in response) == ("error" in response): raise ValueError()
    print(json.dumps(response, ensure_ascii=False))
    if not 200 <= status < 300: fail("HTTP request failed (status %d)" % status)
    if "error" in response: fail("RPC request failed")
    result = response["result"]
    if isinstance(result, dict):
        failed = result.get("isError") is True or result.get("ok") is False
        for content in result.get("content", []):
            if isinstance(content, dict) and content.get("type") == "text":
                try:
                    business = json.loads(content.get("text", ""))
                    failed |= isinstance(business, dict) and business.get("ok") is False
                except (ValueError, TypeError):
                    pass
        structured = result.get("structuredContent")
        failed |= isinstance(structured, dict) and structured.get("ok") is False
        if failed: fail("tool reported failure")
except (ValueError, TypeError, KeyError, AttributeError):
    fail("invalid or incomplete JSON/SSE RPC response (HTTP %d)" % status)
' "$1" "$2"
}

post() { # 一次 HTTP 请求；无 curl 重试，无业务请求重放。
  local body="$1" hdr response status rc sid
  hdr=$(mktemp) || return 1
  response=$(mktemp) || { rm -f "$hdr"; return 1; }
  local sess_args=()
  if [[ -s "$SID_FILE" ]]; then
    sess_args=(-H "Mcp-Session-Id: $(<"$SID_FILE")")
  fi
  status=$(curl -q -sS -D "$hdr" -o "$response" -w '%{http_code}' -X POST "$URL" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -H "Authorization: Bearer $TOKEN" \
    "${sess_args[@]+${sess_args[@]}}" \
    -d "$body" --max-time "${WORKBUDDY_TIMEOUT_SECONDS:-300}" 2>/dev/null)
  rc=$?
  if [[ "$rc" -eq 0 ]]; then
    _rpc_response "$body" "$status" < "$response"
    rc=$?
  else
    echo "wbmcp: HTTP transport failed (curl exit $rc); request was not retried" >&2
  fi
  if [[ "$rc" -eq 0 ]]; then
    sid=$({ grep -i '^mcp-session-id:' "$hdr" || true; } | tr -d '\r' | awk 'NR==1{print $2}')
    if [[ -n "$sid" ]]; then
      (umask 077; printf '%s' "$sid" > "$SID_FILE") || rc=1
    fi
  fi
  if [[ "$rc" -ne 0 ]]; then rm -f "$SID_FILE"; fi
  rm -f "$hdr" "$response"
  return "$rc"
}

handshake() {
  rm -f "$SID_FILE"
  post '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"workbuddy-mcp-skill","version":"1.0"}}}' >/dev/null || return $?
  post '{"jsonrpc":"2.0","method":"notifications/initialized"}' >/dev/null
}

call_json() { post "$1"; }

ensure_session() { [[ -s "$SID_FILE" ]] || handshake; }

_print_call() { # 始终输出 JSON；RPC 错误保留信封，业务结果取 text/structuredContent。
  python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
    if "error" in d:
        print(json.dumps(d, ensure_ascii=False))
    else:
        result = d["result"]
        texts = [c["text"] for c in result.get("content", []) if c.get("type") == "text"]
        values = []
        for text in texts:
            try: values.append(json.loads(text))
            except ValueError: values.append(text)
        value = (values[0] if len(values) == 1 else values) if texts else result.get("structuredContent", result)
        print(json.dumps(value, ensure_ascii=False))
except (ValueError, TypeError, KeyError, AttributeError):
    print("wbmcp: invalid tool result", file=sys.stderr)
    sys.exit(1)
'
}

cmd="${1:-help}"
case "$cmd" in
  tools)
    ensure_session || exit $?
    out=$(call_json '{"jsonrpc":"2.0","id":1,"method":"tools/list"}') || exit $?
    printf '%s\n' "$out" \
      | python3 -c '
import sys, json
for t in json.load(sys.stdin)["result"]["tools"]:
    desc = (t.get("description") or "").split("\n")[0]
    print("- %s: %s" % (t["name"], desc))'
    ;;
  call)
    tool="${2:-}"; args="${3:-{\}}"
    [[ -n "$tool" ]] || { echo 'wbmcp: missing tool name' >&2; exit 1; }
    body=$(python3 -c 'import sys,json
try:
    args = json.loads(sys.argv[2])
    if not isinstance(args, dict): raise ValueError()
    print(json.dumps({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":sys.argv[1],"arguments":args}}))
except ValueError:
    sys.exit("wbmcp: arguments must be a JSON object")' "$tool" "$args") || exit $?
    ensure_session || exit $?
    rc=0
    out=$(call_json "$body") || rc=$?
    if [[ -n "$out" ]]; then printf '%s\n' "$out" | _print_call || exit $?; fi
    exit "$rc"
    ;;
  raw)
    [[ -n "${2:-}" ]] || { echo 'wbmcp: missing JSON-RPC request' >&2; exit 1; }
    python3 -c 'import json,sys
try:
    d=json.loads(sys.argv[1])
    if not isinstance(d, dict) or d.get("jsonrpc") != "2.0" or not isinstance(d.get("method"), str): raise ValueError()
except ValueError: sys.exit("wbmcp: invalid JSON-RPC request")' "$2" || exit $?
    ensure_session || exit $?
    call_json "$2"
    ;;
  putfile)
    # 大文件 P2P 直传: wbmcp.sh putfile <本地文件> <taskId> [远端文件名]
    # 流程: workbuddy init 拿节点直连配方(地址+密钥+会话) → 直连 DSH 节点分片上传 → 节点 complete
    #       → workbuddy upload_register 登记（返回跨节点下载 URL）
    src="$2"; taskId="$3"; nameArg="${4:-$(basename "$2")}"
    [[ -f "$src" ]] || { echo "no such file: $src" >&2; exit 1; }
    sz=$(stat -f%z "$src" 2>/dev/null || stat -c%s "$src")
    # 强制新 MCP 会话：同参数 init 在 10 分钟幂等回放窗口内会返回旧 uploadId（可能已被上次运行消费）
    rm -f "$SID_FILE"
    # 宿主中断时把 python 子进程一并带走，避免孤儿继续跑完造成状态错乱
    trap 'pkill -P $$ 2>/dev/null' EXIT INT TERM
    handshake || exit $?
    body=$(python3 -c 'import sys,json; print(json.dumps({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"workbuddy_file_manage","arguments":{"action":"upload_resumable_init","taskId":sys.argv[1],"name":sys.argv[2],"size":int(sys.argv[3]),"mimeType":"application/octet-stream"}}}))' "$taskId" "$nameArg" "$sz") || exit $?
    init_file=$(mktemp) || exit 1
    rc=0
    call_json "$body" > "$init_file" || rc=$?
    if [[ "$rc" -ne 0 ]]; then rm -f "$init_file"; exit "$rc"; fi
    STATE_KEY=$(python3 -c 'import sys,hashlib;print(hashlib.sha1("\x00".join(sys.argv[1:]).encode()).hexdigest()[:16])' "$taskId" "$src" "$sz")
    WB_TOKEN="$TOKEN" WB_STATE_FILE="${TMPDIR:-/tmp}/wb-putfile-$STATE_KEY.json" python3 - "$src" "$sz" "$init_file" "$taskId" "$TOKEN" "$URL" "$nameArg" <<'PYEOF'
import sys, os, json, time, mimetypes
import urllib.parse
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

src, size, initfile = sys.argv[1], int(sys.argv[2]), sys.argv[3]
task_id, wb_token, wb_mcp_url, name_arg = sys.argv[4], sys.argv[5], sys.argv[6], sys.argv[7]
init = json.load(open(initfile))
if "error" in init: sys.exit("RPC error: %s" % init["error"])
init = json.loads(init["result"]["content"][0]["text"])   # 剥信封取工具结果
if not init.get("ok"): sys.exit("init failed: %s" % init.get("error"))
print("taskStatus=%s" % init.get("taskStatus", "?"), file=sys.stderr)
if init.get("warning"):
    print("⚠ %s" % init["warning"], file=sys.stderr)
    print("  （仍将继续上传；如任务尚不需要开始，建议 delete 后按「create 不带 message → putfile → send」重来）", file=sys.stderr)

d = init.get("direct") or {}
base, node_key, sid = d.get("baseUrl", "").rstrip("/"), d.get("apiKey", ""), d.get("sessionId", "")
up_id = init.get("uploadId", "")
if not (base and node_key and sid and up_id): sys.exit("init 返回缺直传配方字段: %s" % list(init.keys()))

# 断点续传状态：节点分片会话持久化到本地状态文件；putfile 中断（宿主超时/断网）后重跑从断点续传，不必整传
state_file = os.environ.get("WB_STATE_FILE", "")
def load_state():
    try: return json.load(open(state_file))
    except Exception: return None
def save_state(s):
    try: open(state_file, "w").write(json.dumps(s))
    except Exception: pass
def clear_state():
    try: os.remove(state_file)
    except Exception: pass

def node_req(method, url, data=None, timeout=600):
    r = Request(url, data=data, method=method,
                headers={"Authorization": "Bearer " + node_key,
                         "Content-Type": "application/octet-stream"})
    with urlopen(r, timeout=timeout) as resp:
        return json.loads(resp.read().decode())

def node_put_chunk(url, part, offset):
    # 409 = 节点已收字节与 offset 不一致 → 对账后续传本片剩余
    for _ in range(5):
        try:
            j = node_req("PUT", url + "?offset=%d" % offset, part)
            return int(j.get("data", {}).get("received") or (offset + len(part)))
        except HTTPError as e:
            if e.code != 409: raise
            st = node_req("GET", url)
            recv = int(st.get("data", {}).get("received") or 0)
            print("  对账: 节点已收 %d" % recv, file=sys.stderr)
            if recv >= offset + len(part): return recv
            part = part[recv - offset:]; offset = recv
    sys.exit("put_chunk: 重试耗尽")

# ① 直传通道优选：内网/本机基址优先（会话自证——init 是会话作用域接口，sessionId 只有目标任务节点认识，
#    返回 uploadId 即证明通向的就是它），失败/超时回退公网隧道；断点续传优先复用状态文件里的节点会话
mt = mimetypes.guess_type(src)[0] or "application/octet-stream"
intranet = (d.get("baseUrlIntranet") or "").rstrip("/")
saved = load_state() if state_file else None
nid = nreceived = 0
used_base = None
if saved and saved.get("size") == size and saved.get("apiKey") == node_key and saved.get("nid") and saved.get("nodeBase"):
    try:
        st = node_req("GET", saved["nodeBase"] + "/sessions/" + sid + "/files/resumable/" + saved["nid"], timeout=10)
        nreceived = int(st.get("data", {}).get("received") or 0)
        if 0 < nreceived <= size:
            nid = saved["nid"]; used_base = saved["nodeBase"]; up_id = saved.get("upId") or up_id
            print("断点续传: 节点已收 %d/%d（复用上次会话 %s）" % (nreceived, size, saved["nodeBase"]), file=sys.stderr)
    except Exception:
        pass
if not nid:
    candidates = []
    if intranet: candidates.append((intranet, "内网/本机直连", 6))
    candidates.append((base, "公网隧道", 60))
    last_err = None
    for cb, tag, to in candidates:
        try:
            ninit = node_req("POST", cb + "/sessions/" + sid + "/files/resumable?name=" + urllib.parse.quote(name_arg) + "&size=%d&mimeType=%s" % (size, urllib.parse.quote(mt)), timeout=to)
            nid = ninit["data"]["uploadId"]
            nreceived = int(ninit["data"].get("received") or 0)
            used_base = cb
            print("直传通道: %s（%s）" % (cb, tag), file=sys.stderr)
            break
        except Exception as e:
            last_err = e
            print("  候选不可达(%s): %s" % (tag, e), file=sys.stderr)
    if not nid: sys.exit("所有直传通道均失败: %s" % last_err)
chunk_url = used_base + "/sessions/" + sid + "/files/resumable/" + nid
save_state({"nodeBase": used_base, "sid": sid, "nid": nid, "apiKey": node_key, "upId": up_id, "taskId": task_id, "size": size})
print("sessionId=%s nodeUploadId=%s" % (sid[:12] + "…", nid[:12] + "…"), file=sys.stderr)

# ② 分片直连节点
CHUNK = 4 * 1024 * 1024
offset, n = nreceived, 0
with open(src, "rb") as f:
    while offset < size:
        f.seek(offset)
        part = f.read(min(CHUNK, size - offset))
        n += 1
        offset = node_put_chunk(chunk_url, part, offset)
        print("  片%02d -> received=%d/%d" % (n, offset, size))

# ③ 节点侧 complete → 落盘路径
cdone = node_req("POST", chunk_url + "/complete")
files = (cdone.get("data") or {}).get("files") or []
if not files: sys.exit("节点 complete 未返回 files: %s" % cdone)
dest_path = files[0].get("path")
print("落盘: %s" % dest_path, file=sys.stderr)

# ④ workbuddy 登记附件（返回跨节点下载 URL）
def wb_call(tool, args, rpc_id=4):
    body = json.dumps({"jsonrpc": "2.0", "id": rpc_id, "method": "tools/call", "params": {"name": tool, "arguments": args}})
    r = Request(wb_mcp_url, data=body.encode(), method="POST",
                headers={"Authorization": "Bearer " + wb_token, "Content-Type": "application/json", "Accept": "application/json"})
    with urlopen(r, timeout=120) as resp:
        d = json.loads(resp.read().decode())
    if "error" in d: sys.exit("RPC error: %s" % d["error"])
    return json.loads(d["result"]["content"][0]["text"])

reg = wb_call("workbuddy_file_manage", {"action": "upload_register", "taskId": task_id, "uploadId": up_id, "path": dest_path, "size": size, "mimeType": mt})
if not reg.get("ok"):
    # 自愈：报「不存在或已登记过」可能是前次中断的孤儿运行已完成登记 → 查任务附件确认
    if "不存在或已登记过" in (reg.get("error") or ""):
        try:
            stt = wb_call("workbuddy_task_status", {"taskId": task_id, "detail": "full"}, rpc_id=5)
            atts = (stt.get("task") or {}).get("attachments") or []
            hit = [a for a in atts if a.get("path") == dest_path or (a.get("name") == name_arg and a.get("size") == size)]
            if hit:
                a = hit[-1]
                clear_state()
                print("OK %s  %s bytes  -> %s（附件已由前次运行登记）" % (a.get("name"), a.get("size", size), a.get("path")))
                print("跨节点下载: %s" % (base + "/fs/download?path=" + urllib.parse.quote(a.get("path") or dest_path)))
                raise SystemExit(0)
        except SystemExit:
            raise
        except Exception:
            pass
    sys.exit("register failed: %s" % reg)
clear_state()
att = reg.get("attachment") or {}
print("OK %s  %d bytes  -> %s" % (att.get("name"), att.get("size"), att.get("path")))
if reg.get("downloadUrl"):
    print("跨节点下载: %s" % reg["downloadUrl"])
    print('（请求头 Authorization: Bearer <节点apiKey>；多成员协作把它写进 send 的 message）')
PYEOF
    rc=$?
    rm -f "$init_file"
    exit "$rc"
    ;;
  *)
    sed -n '2,15p' "$0"
    ;;
esac
