#!/bin/bash

APP_NAME="FnSmartZIP"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
API_SCRIPT="${SCRIPT_DIR%/ui}/server/api.js"
export PATH=/var/apps/nodejs_v22/target/bin:$PATH

if [ ! -f "$API_SCRIPT" ]; then
    API_SCRIPT="/var/apps/${APP_NAME}/target/server/api.js"
fi

send_json_error() {
    msg="$1"

    echo "Content-Type: application/json; charset=utf-8"
    echo "Cache-Control: no-store"
    printf '\n'
    printf '{"success":false,"code":500,"msg":"%s"}\n' "$msg"
}

if [ ! -f "$API_SCRIPT" ]; then
    send_json_error "API 脚本不存在"
    exit 0
fi

if ! command -v node >/dev/null 2>&1; then
    send_json_error "未找到 node 运行环境"
    exit 0
fi

exec node "$API_SCRIPT"
