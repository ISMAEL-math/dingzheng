#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
if [ -n "$(git status --porcelain)" ]; then echo '工作目录有未提交改动；请先完成并行工作再发布。' >&2; exit 1; fi
npm ci
npm test
version=$(git rev-parse HEAD)
docker build --build-arg "APP_VERSION=$version" -t "dingzheng:$version" .
printf '已构建固定版本：dingzheng:%s\n请在 deploy/.env 设置 APP_IMAGE 后执行 docker compose --env-file deploy/.env -f deploy/compose.yaml up -d\n' "$version"
