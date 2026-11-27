#!/usr/bin/env bash
# Tests for bin/outside-voice. Stubs agy/codex/claude on PATH and checks the
# command each provider is given, the output file, failure handling and the log.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OV="$HERE/../bin/outside-voice"
ORIG_PATH="$PATH"
failures=0
passes=0

setup() {
  T="$(mktemp -d)"
  mkdir -p "$T/bin" "$T/config"
  export HOME="$T/home" XDG_CONFIG_HOME="$T/config" XDG_STATE_HOME="$T/state"
  export PATH="$T/bin:$ORIG_PATH"
  unset OUTSIDE_VOICE_PROVIDER
  cat > "$T/config/outside-voice.conf" <<'EOF'
PROVIDER=antigravity
ANTIGRAVITY_HEAVY=agy-heavy
ANTIGRAVITY_MID=agy-mid
ANTIGRAVITY_LIGHT=agy-light
CODEX_HEAVY=codex-heavy
CODEX_LIGHT=codex-light
CLAUDE_MID=claude-mid
EOF
  # agy stub: records args and cwd, prints a JSON result chosen by AGY_STUB_MODE.
  cat > "$T/bin/agy" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@" > "$STUB_DIR/agy.args"
pwd > "$STUB_DIR/agy.cwd"
case "${AGY_STUB_MODE:-ok}" in
  ok) echo '{"status":"SUCCESS","response":"the answer\n","usage":{"input_tokens":10,"output_tokens":2}}' ;;
  schema) echo '{"status":"SUCCESS","response":"{}","structured_output":{"commits":["a"]},"usage":{}}' ;;
  empty) echo "jetski: no output produced — a tool required the \"write_file\" permission" >&2 ;;
  quota) echo '{"status":"ERROR","response":"","error":"quota exhausted"}'; exit 1 ;;
  crash) echo "panic: boom" >&2; exit 3 ;;
esac
EOF
  cat > "$T/bin/codex" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@" > "$STUB_DIR/codex.args"
cat > /dev/null
prev=""; for a in "$@"; do [ "$prev" = "-o" ] && echo "codex answer" > "$a"; prev="$a"; done
echo '{"usage":1} then plain text'
EOF
  cat > "$T/bin/claude" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@" > "$STUB_DIR/claude.args"
cat > /dev/null
echo '{"type":"result","is_error":false,"result":"claude answer"}'
EOF
  chmod +x "$T/bin/"*
  export STUB_DIR="$T"
}

check() {
  local name="$1"; shift
  if "$@"; then passes=$((passes + 1)); else failures=$((failures + 1)); echo "FAIL: $name"; fi
}

has_arg() { grep -qxF -- "$2" "$T/$1.args"; }
lacks_arg() { ! grep -qxF -- "$2" "$T/$1.args"; }
arg_after() { grep -A1 -xF -- "$2" "$T/$1.args" | tail -1; }

test_antigravity_read_review() {
  setup
  "$OV" -o "$T/out.txt" "review this" || { echo "FAIL: exit"; failures=$((failures + 1)); return; }
  check "read mode never skips permissions" lacks_arg agy --dangerously-skip-permissions
  check "read mode passes an allow-list" grep -q 'command(git diff)' "$T/agy.args"
  check "read mode denies file writes" grep -qF '"deny":["write_file(*)"' "$T/agy.args"
  check "writes final answer" [ "$(cat "$T/out.txt")" = "the answer" ]
  check "prompt reaches agy" grep -q "review this" "$T/agy.args"
  check "no-delegation line" grep -qi "do not delegate" "$T/agy.args"
  check "logs the run" grep -q '"model":"agy-heavy"' "$XDG_STATE_HOME/outside-voice/runs.jsonl"
}

test_antigravity_write_mode() {
  setup
  "$OV" --tier mid --write "open the PR" >/dev/null
  check "mid model" [ "$(arg_after agy --model)" = "agy-mid" ]
  check "write mode skips permissions" has_arg agy --dangerously-skip-permissions
}

test_cwd_flag() {
  setup
  mkdir -p "$T/repo"
  "$OV" -C "$T/repo" "x" >/dev/null
  check "runs in -C dir" [ "$(cat "$T/agy.cwd")" = "$(cd "$T/repo" && pwd -P)" ]
}

test_stdout_when_no_output_file() {
  setup
  out="$("$OV" "hello")"
  check "prints to stdout" [ "$out" = "the answer" ]
  check "default tier is heavy" [ "$(arg_after agy --model)" = "agy-heavy" ]
}

test_prompt_from_stdin() {
  setup
  echo "from stdin" | "$OV" - >/dev/null
  check "reads prompt from stdin" grep -q "from stdin" "$T/agy.args"
}

test_schema_output() {
  setup
  echo '{"type":"object"}' > "$T/schema.json"
  AGY_STUB_MODE=schema "$OV" --schema "$T/schema.json" -o "$T/out.json" "x"
  check "passes schema" [ "$(arg_after agy --json-schema)" = "$T/schema.json" ]
  check "writes structured output" [ "$(jq -c . "$T/out.json")" = '{"commits":["a"]}' ]
}

test_empty_answer_fails() {
  setup
  AGY_STUB_MODE=empty "$OV" -o "$T/out.txt" "x" 2>"$T/err"
  check "empty answer exits nonzero" [ $? -ne 0 ]
  check "explains failure" grep -qi "no answer" "$T/err"
  check "logs failure" grep -q '"ok":false' "$XDG_STATE_HOME/outside-voice/runs.jsonl"
}

test_provider_error_fails() {
  setup
  AGY_STUB_MODE=quota "$OV" "x" 2>"$T/err" >/dev/null
  check "provider error exits nonzero" [ $? -ne 0 ]
  check "surfaces provider error" grep -q "quota exhausted" "$T/err"
}

test_agy_crash_fails() {
  setup
  AGY_STUB_MODE=crash "$OV" "x" 2>"$T/err" >/dev/null
  check "crash exits nonzero" [ $? -ne 0 ]
  check "reports agy exit code" grep -q "agy exited with 3" "$T/err"
}

test_unknown_option_fails() {
  setup
  "$OV" --tire mid "x" 2>"$T/err" >/dev/null
  check "unknown option exits nonzero" [ $? -ne 0 ]
  check "names the option" grep -q -- "--tire" "$T/err"
}

test_second_prompt_fails() {
  setup
  "$OV" review this 2>"$T/err" >/dev/null
  check "unquoted prompt exits nonzero" [ $? -ne 0 ]
}

test_missing_schema_fails() {
  setup
  "$OV" --schema "$T/nope.json" "x" 2>"$T/err" >/dev/null
  check "missing schema exits nonzero" [ $? -ne 0 ]
  check "names the schema" grep -q "nope.json" "$T/err"
}

test_output_dir_fails() {
  setup
  "$OV" -o "$T" "x" 2>"$T/err" >/dev/null
  check "-o directory exits nonzero" [ $? -ne 0 ]
}

test_claude_error_subtype_fails() {
  setup
  printf '#!/usr/bin/env bash\ncat >/dev/null\necho '"'"'{"type":"result","is_error":false,"subtype":"error_max_turns","result":"partial"}'"'"'\n' > "$T/bin/claude"
  OUTSIDE_VOICE_PROVIDER=claude "$OV" --tier mid "x" 2>"$T/err" >/dev/null
  check "error subtype exits nonzero" [ $? -ne 0 ]
  check "reports the subtype" grep -q "error_max_turns" "$T/err"
}

test_codex_provider() {
  setup
  OUTSIDE_VOICE_PROVIDER=codex "$OV" --tier light -o "$T/out.txt" "x"
  check "codex exec" [ "$(head -1 "$T/codex.args")" = "exec" ]
  check "codex model" [ "$(arg_after codex -m)" = "codex-light" ]
  check "codex read-only" [ "$(arg_after codex --sandbox)" = "read-only" ]
  check "codex answer" [ "$(cat "$T/out.txt")" = "codex answer" ]
  check "codex run logged" grep -q '"provider":"codex"' "$XDG_STATE_HOME/outside-voice/runs.jsonl"
  OUTSIDE_VOICE_PROVIDER=codex "$OV" --write -o "$T/out.txt" "x"
  check "codex write" [ "$(arg_after codex --sandbox)" = "danger-full-access" ]
}

test_claude_provider() {
  setup
  OUTSIDE_VOICE_PROVIDER=claude "$OV" --tier mid -o "$T/out.txt" "x"
  check "claude model" [ "$(arg_after claude --model)" = "claude-mid" ]
  check "claude read-only tools" grep -q "Bash(git diff:\*)" "$T/claude.args"
  check "claude read-only never prompts" [ "$(arg_after claude --permission-mode)" = "dontAsk" ]
  check "claude ignores user settings" grep -qxF -- "--setting-sources" "$T/claude.args"
  check "with no sources" [ "$(arg_after claude --setting-sources)" = "" ]
  check "claude read-only blocks edits" [ "$(arg_after claude --disallowedTools)" = "Edit,Write,NotebookEdit" ]
  check "claude answer" [ "$(cat "$T/out.txt")" = "claude answer" ]
}

test_config_provider_switch() {
  setup
  sed 's/^PROVIDER=.*/PROVIDER=codex/' "$T/config/outside-voice.conf" > "$T/config/outside-voice.conf.tmp" && mv "$T/config/outside-voice.conf.tmp" "$T/config/outside-voice.conf"
  "$OV" -o "$T/out.txt" "x"
  check "config file picks provider" [ -f "$T/codex.args" ]
}

test_unknown_provider_fails() {
  setup
  OUTSIDE_VOICE_PROVIDER=nope "$OV" "x" 2>"$T/err" >/dev/null
  check "unknown provider exits nonzero" [ $? -ne 0 ]
  check "names the provider" grep -q "nope" "$T/err"
}

test_missing_model_fails() {
  setup
  sed '/^ANTIGRAVITY_LIGHT=/d' "$T/config/outside-voice.conf" > "$T/config/outside-voice.conf.tmp" && mv "$T/config/outside-voice.conf.tmp" "$T/config/outside-voice.conf"
  "$OV" --tier light "x" 2>"$T/err" >/dev/null
  check "missing model exits nonzero" [ $? -ne 0 ]
  check "names the setting" grep -q "ANTIGRAVITY_LIGHT" "$T/err"
}

for t in $(declare -F | awk '{print $3}' | grep '^test_'); do "$t"; done
echo "$passes passed, $failures failed"
[ "$failures" -eq 0 ]
