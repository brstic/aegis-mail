#!/bin/sh
# Starts a local server speaking the AWS KMS protocol, for packages/cryptography/src/aws-kms.live.test.ts.
# It's moto, an emulator, so a pass means the requests are well formed. It says nothing about IAM, key policies or real AWS behaviour.
#   infra/local/kms-server.sh start <dir>   then:   KMS_TEST_ENDPOINT=http://127.0.0.1:3241 npx vitest run packages/cryptography/src/aws-kms.live
#   infra/local/kms-server.sh stop <dir>
set -eu
cmd=${1:?start or stop}
dir=${2:?a working directory}
case "$cmd" in
  start)
    mkdir -p "$dir"
    [ -x "$dir/moto-venv/bin/moto_server" ] || { python3 -m venv "$dir/moto-venv"; "$dir/moto-venv/bin/pip" install -q 'moto[server]'; }
    "$dir/moto-venv/bin/moto_server" -H 127.0.0.1 -p 3241 > "$dir/moto.log" 2>&1 &
    echo $! > "$dir/moto.pid"
    ;;
  stop)
    [ -f "$dir/moto.pid" ] && kill "$(cat "$dir/moto.pid")" 2>/dev/null || true
    rm -f "$dir/moto.pid"
    ;;
  *) echo "usage: $0 start|stop <dir>" >&2; exit 1 ;;
esac
