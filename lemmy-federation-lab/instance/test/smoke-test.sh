#!/usr/bin/env bash
# Smoke test for the federation lab. Run: bash smoke-test.sh
# Against local dev servers: `BRIDGE=http://127.0.0.1:8787 FROGS=http://127.0.0.1:8788 bash smoke-test.sh`
# Needs curl and python3. It adds a few "Smoke" comments to both instances and leaves both online.
BRIDGE=${BRIDGE:-https://bridge-cinema.ellbi3.workers.dev}
FROGS=${FROGS:-https://gourmet-frogs.ellbi3.workers.dev}
FAILS=0

state()   { curl -s "$1/api/state"; }
has()     { state "$1" | grep -q "$2"; }                       # does this instance's state contain this text?
not()     { ! "$@"; }
is_code() { [ "$(curl -s -o /dev/null -w '%{http_code}' "${@:2}")" = "$1" ]; }   # is_code 401 <curl args>
set_online() { printf '{"online":%s}' "$2" | curl -s -X POST "$1/api/online" --data-binary @- >/dev/null; }
send()    { printf '{"author":"Smoke","community":"%s","body":"%s"}' "$2" "$3" | curl -s -X POST "$1/api/comments" --data-binary @-; }
id_of()   { python3 -c "import sys,json;print(json.load(sys.stdin)['id'])"; }
status_of() { state "$1" | python3 -c "import sys,json;s=json.load(sys.stdin);print(next((d['status']+' '+(d['detail'] or '') for d in s['deliveries'] if d['comment_id']=='$2'),'none'))"; }

check() { local d=$1; shift; if "$@"; then echo "PASS  $d"; else echo "FAIL  $d"; FAILS=$((FAILS+1)); fi; }
wait_for() { local d=$1 t=$2; shift 2; for ((i=0;i<t;i+=2)); do if "$@"; then echo "PASS  $d"; return; fi; sleep 2; done; echo "FAIL  $d (waited ${t}s)"; FAILS=$((FAILS+1)); }

MARK="smoke-$(date +%s)"
set_online "$BRIDGE" true; set_online "$FROGS" true

echo "== Basic checks"
check "unsigned inbox request is rejected (401)" is_code 401 -X POST "$FROGS/inbox" --data-binary '{"type":"Create"}'
check "malformed JSON is rejected cleanly (400)" is_code 400 -X POST "$BRIDGE/api/comments" --data-binary 'not json'

echo "== Federation, both directions"
send "$BRIDGE" gourmet_frogs "$MARK-a" >/dev/null
wait_for "bridge -> frogs delivery" 45 has "$FROGS" "$MARK-a"
send "$FROGS" bridge_cinema "$MARK-b" >/dev/null
wait_for "frogs -> bridge delivery" 45 has "$BRIDGE" "$MARK-b"

echo "== Offline, queue, retry"
set_online "$FROGS" false
ID=$(send "$BRIDGE" gourmet_frogs "$MARK-off" | id_of)
retrying_503() { status_of "$BRIDGE" "$ID" | grep -q 'retrying.*503'; }
wait_for "delivery is retrying with a 503 while frogs are offline" 60 retrying_503
check "frogs have not received it yet" not has "$FROGS" "$MARK-off"
check "bridge stayed online" has "$BRIDGE" '"online":true'
set_online "$FROGS" true
wait_for "queued comment arrives after frogs come back" 240 has "$FROGS" "$MARK-off"

echo "  last offline-test status: $(status_of "$BRIDGE" "$ID")"
echo
if [ "$FAILS" -eq 0 ]; then echo "All checks passed"; else echo "$FAILS check(s) failed"; exit 1; fi