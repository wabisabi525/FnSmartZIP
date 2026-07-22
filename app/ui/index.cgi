#!/bin/bash

# 脚本名称: index.cgi
# 　　版本: 1.0.0
# 　　作者: FNOSP/xieguanru
# 　协作者: FNOSP/MR_XIAOBO
# 创建日期: 2025-11-18
# 最后修改: 2025-11-19
# 　　描述: 这个脚本用于演示Shell脚本的各种注释方式
# 使用方式: 文件重命名，从linux_shell_cgi_index.sh改成index.cgi,
# 　　　　　放置应用包/ui路径下，记得 chmod +x index.cgi 赋权
# 　许可证: MIT

APP_NAME="FnSmartZIP"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
BASE_PATH="${SCRIPT_DIR%/ui}/www"

if [ ! -d "$BASE_PATH" ]; then
    BASE_PATH="/var/apps/${APP_NAME}/target/www"
fi

send_text() {
    status="$1"
    body="$2"

    echo "Status: ${status}"
    echo "Content-Type: text/plain; charset=utf-8"
    echo "Cache-Control: no-cache"
    echo ""
    echo "${body}"
}

# 1. 从 REQUEST_URI 里拿到 index.cgi 后面的路径
#    例如：/cgi/ThirdParty/FnSmartZIP/index.cgi/index.html?foo=bar
#    先去掉 ? 后面的 query string
URI_NO_QUERY="${REQUEST_URI%%\?*}"

# 默认值（如果没匹配到 index.cgi）
REL_PATH="/"

# 用 index.cgi 作为切割点，取后面的部分
case "$URI_NO_QUERY" in
    *index.cgi*)
        # 去掉前面所有直到 index.cgi 为止的内容，保留后面的
        # /cgi/ThirdParty/FnSmartZIP/index.cgi/index.html -> /index.html
        REL_PATH="${URI_NO_QUERY#*index.cgi}"
        ;;
esac

# 如果为空或只有 /，就默认 /index.html
if [ -z "$REL_PATH" ] || [ "$REL_PATH" = "/" ]; then
    REL_PATH="/index.html"
fi

# 拼出真实文件路径：basePath + /ui + index.cgi 后面的路径
TARGET_FILE="${BASE_PATH}${REL_PATH}"

# 简单防御：禁止 .. 越级访问
case "$REL_PATH" in
    *..*)
        send_text "400 Bad Request" "Bad Request"
        exit 0
        ;;
esac

# 2. 判断文件是否存在
if [ ! -f "$TARGET_FILE" ]; then
    send_text "404 Not Found" "404 Not Found: ${REL_PATH}"
    exit 0
fi

# 3. 根据扩展名简单判断 Content-Type
ext="${TARGET_FILE##*.}"
case "$ext" in
    html|htm)
        mime="text/html; charset=utf-8"
        ;;
    css)
        mime="text/css; charset=utf-8"
        ;;
    js)
        mime="application/javascript; charset=utf-8"
        ;;
    jpg|jpeg)
        mime="image/jpeg"
        ;;
    png)
        mime="image/png"
        ;;
    gif)
        mime="image/gif"
        ;;
    svg)
        mime="image/svg+xml"
        ;;
    woff2)
        mime="font/woff2"
        ;;
    txt|log)
        mime="text/plain; charset=utf-8"
        ;;
    *)
        mime="application/octet-stream"
        ;;
esac

# 4. 输出头 + 文件内容
echo "Content-Type: $mime"
echo "Cache-Control: no-cache"
echo ""

cat "$TARGET_FILE"
