#!/bin/bash

# =============================================================================
# Nova 绘图工作台（abu-api 集成版）Docker 多架构构建和推送脚本
# 用途：构建 AMD64 + ARM64 Docker 镜像并推送到 Docker Hub
# 注意：NEXT_PUBLIC_BASE_PATH=/nova-app 等集成参数为构建期烧入，与 Dockerfile 的 ARG 对应。
#       独立版（自填 key 形态）请勿用本脚本，直接 docker build（不传集成 build args）。
# 参考：chatgpt-web-midjourney-proxy/build-and-push.sh
# =============================================================================

set -e

cd "$(dirname "$0")"

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# 配置变量
DOCKER_USERNAME="abu116"
IMAGE_NAME="nova-image-studio"
FULL_IMAGE_NAME="${DOCKER_USERNAME}/${IMAGE_NAME}"
BUILDER_NAME="newapi-multi-arch"

# 集成版构建参数（与 Dockerfile 的 ARG NEXT_PUBLIC_INTEGRATED_MODE/NEXT_PUBLIC_BASE_PATH 对应）
NEXT_PUBLIC_INTEGRATED_MODE="true"
NEXT_PUBLIC_BASE_PATH="/nova-app"

# 获取版本信息（日期-短SHA，可用 VERSION 环境变量覆盖）
GIT_COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
VERSION=${VERSION:-"$(date +'%Y%m%d')-${GIT_COMMIT}"}
BUILD_TIME=$(date -u '+%Y-%m-%d_%H:%M:%S')

# 架构选择：支持 --amd64 / --arm64 / --all（默认）
SINGLE_ARCH=""
case "${1}" in
    --amd64)  PLATFORMS="linux/amd64";  SINGLE_ARCH="amd64" ;;
    --arm64)  PLATFORMS="linux/arm64";  SINGLE_ARCH="arm64" ;;
    --all|"") PLATFORMS="linux/amd64,linux/arm64" ;;
    *)
        echo "用法: $0 [--amd64|--arm64|--all]"
        echo "  --amd64  仅构建 AMD64（推送到 tag 带 -amd64 后缀，不影响 latest）"
        echo "  --arm64  仅构建 ARM64（推送到 tag 带 -arm64 后缀，不影响 latest）"
        echo "  --all    分架构依次构建推送，再合并 manifest（默认，发版用）"
        exit 1
        ;;
esac

# 根据架构模式决定 tag
if [ -n "${SINGLE_ARCH}" ]; then
    TAG_VERSION="${VERSION}-${SINGLE_ARCH}"
    TAG_LATEST="latest-${SINGLE_ARCH}"
else
    TAG_VERSION="${VERSION}"
    TAG_LATEST="latest"
fi

echo -e "${GREEN}==============================================================================${NC}"
echo -e "${GREEN}Nova 绘图工作台（abu-api 集成版）Docker 多架构构建脚本${NC}"
echo -e "${GREEN}==============================================================================${NC}"
echo ""
echo -e "${YELLOW}镜像信息:${NC}"
echo -e "  完整镜像名: ${FULL_IMAGE_NAME}"
echo -e "  版本: ${VERSION}"
echo -e "  构建时间: ${BUILD_TIME}"
echo -e "  Git Commit: ${GIT_COMMIT}"
echo -e "  目标架构: ${PLATFORMS}"
echo -e "  NEXT_PUBLIC_BASE_PATH: ${NEXT_PUBLIC_BASE_PATH} (集成模式: ${NEXT_PUBLIC_INTEGRATED_MODE})"
echo ""

# 检查 Docker
if ! command -v docker &> /dev/null; then
    echo -e "${RED}错误: Docker 未安装${NC}"
    exit 1
fi

if ! docker info &> /dev/null; then
    echo -e "${RED}错误: Docker 守护进程未运行${NC}"
    exit 1
fi

# 检查登录
echo -e "${YELLOW}步骤 1/4: 检查 Docker Hub 登录状态...${NC}"
if ! docker info | grep -q "Username: ${DOCKER_USERNAME}"; then
    echo -e "${YELLOW}未登录，请登录 Docker Hub...${NC}"
    docker login
    if [ $? -ne 0 ]; then
        echo -e "${RED}错误: 登录失败${NC}"
        exit 1
    fi
else
    echo -e "${GREEN}✓ 已登录 (${DOCKER_USERNAME})${NC}"
fi
echo ""

# 初始化 buildx
echo -e "${YELLOW}步骤 2/4: 初始化 Docker Buildx...${NC}"
if ! docker buildx inspect "${BUILDER_NAME}" &> /dev/null; then
    echo -e "${YELLOW}创建 builder: ${BUILDER_NAME}${NC}"
    BUILDER_CREATE_ARGS=(--name "${BUILDER_NAME}" --use --bootstrap)
    if [ -n "${HTTPS_PROXY:-}" ]; then
        BUILDER_CREATE_ARGS+=(--driver-opt "env.HTTPS_PROXY=${HTTPS_PROXY}")
        BUILDER_CREATE_ARGS+=(--driver-opt "env.HTTP_PROXY=${HTTP_PROXY:-${HTTPS_PROXY}}")
    fi
    docker buildx create "${BUILDER_CREATE_ARGS[@]}"
else
    echo -e "${GREEN}✓ 使用已有 builder: ${BUILDER_NAME}${NC}"
    docker buildx use "${BUILDER_NAME}"
fi
echo ""

MAX_RETRIES=${PUSH_RETRIES:-5}
RETRY_DELAY=${PUSH_RETRY_DELAY:-30}

build_and_push_with_retry() {
    local platforms=$1
    local tag_version=$2
    local tag_latest=$3
    local attempt=1
    local delay=${RETRY_DELAY}
    local exit_code=1

    echo -e "${YELLOW}构建并推送: ${platforms} -> ${tag_version}, ${tag_latest}${NC}"

    set +e
    while [ ${attempt} -le ${MAX_RETRIES} ]; do
        echo -e "${YELLOW}  尝试 ${attempt}/${MAX_RETRIES}...${NC}"
        docker buildx build \
            --platform "${platforms}" \
            --build-arg NEXT_PUBLIC_INTEGRATED_MODE="${NEXT_PUBLIC_INTEGRATED_MODE}" \
            --build-arg NEXT_PUBLIC_BASE_PATH="${NEXT_PUBLIC_BASE_PATH}" \
            --provenance=false \
            --sbom=false \
            -t "${FULL_IMAGE_NAME}:${tag_version}" \
            -t "${FULL_IMAGE_NAME}:${tag_latest}" \
            --push \
            .
        exit_code=$?
        if [ ${exit_code} -eq 0 ]; then
            echo -e "${GREEN}  ✓ 推送成功: ${platforms}${NC}"
            break
        fi
        if [ ${attempt} -lt ${MAX_RETRIES} ]; then
            echo -e "${YELLOW}  失败，${delay}秒后重试（buildx 会复用层缓存，通常仅重推）...${NC}"
            sleep ${delay}
            delay=$((delay * 2))
        fi
        attempt=$((attempt + 1))
    done
    set -e

    return ${exit_code}
}

create_manifest_with_retry() {
    local manifest_tag=$1
    shift
    local attempt=1
    local delay=${RETRY_DELAY}
    local exit_code=1

    echo -e "${YELLOW}合并 manifest: ${manifest_tag}${NC}"

    set +e
    while [ ${attempt} -le ${MAX_RETRIES} ]; do
        echo -e "${YELLOW}  尝试 ${attempt}/${MAX_RETRIES}...${NC}"
        docker buildx imagetools create -t "${FULL_IMAGE_NAME}:${manifest_tag}" "$@"
        exit_code=$?
        if [ ${exit_code} -eq 0 ]; then
            echo -e "${GREEN}  ✓ manifest 创建成功: ${manifest_tag}${NC}"
            break
        fi
        if [ ${attempt} -lt ${MAX_RETRIES} ]; then
            echo -e "${YELLOW}  失败，${delay}秒后重试...${NC}"
            sleep ${delay}
            delay=$((delay * 2))
        fi
        attempt=$((attempt + 1))
    done
    set -e

    return ${exit_code}
}

echo -e "${YELLOW}步骤 3/4: 构建镜像并推送到 Docker Hub（最多 ${MAX_RETRIES} 次尝试/步骤）...${NC}"
echo -e "${YELLOW}前端为 Next.js 静态导出、后端含 better-sqlite3 原生编译，请耐心等待...${NC}"
if [ -z "${SINGLE_ARCH}" ]; then
    echo -e "${YELLOW}双架构模式：依次推送 amd64 / arm64，降低 Docker Hub TLS 超时风险${NC}"
fi
if [ -n "${HTTPS_PROXY:-}" ]; then
    echo -e "${YELLOW}检测到 HTTPS_PROXY=${HTTPS_PROXY}${NC}"
fi
echo ""

BUILD_EXIT=0
if [ -z "${SINGLE_ARCH}" ]; then
    build_and_push_with_retry "linux/amd64" "${VERSION}-amd64" "latest-amd64" || BUILD_EXIT=$?
    if [ ${BUILD_EXIT} -eq 0 ]; then
        build_and_push_with_retry "linux/arm64" "${VERSION}-arm64" "latest-arm64" || BUILD_EXIT=$?
    fi
    if [ ${BUILD_EXIT} -eq 0 ]; then
        create_manifest_with_retry "${TAG_VERSION}" \
            "${FULL_IMAGE_NAME}:${VERSION}-amd64" \
            "${FULL_IMAGE_NAME}:${VERSION}-arm64" || BUILD_EXIT=$?
    fi
    if [ ${BUILD_EXIT} -eq 0 ]; then
        create_manifest_with_retry "${TAG_LATEST}" \
            "${FULL_IMAGE_NAME}:latest-amd64" \
            "${FULL_IMAGE_NAME}:latest-arm64" || BUILD_EXIT=$?
    fi
else
    build_and_push_with_retry "${PLATFORMS}" "${TAG_VERSION}" "${TAG_LATEST}" || BUILD_EXIT=$?
fi

if [ ${BUILD_EXIT} -ne 0 ]; then
    echo -e "${RED}错误: 构建/推送失败，已达最大重试次数 (${MAX_RETRIES})${NC}"
    echo -e "${YELLOW}提示:${NC}"
    echo -e "  1. 增加重试: PUSH_RETRIES=8 PUSH_RETRY_DELAY=60 $0 ${1:-}"
    echo -e "  2. 开代理后重试: HTTPS_PROXY=http://127.0.0.1:7890 $0 ${1:-}"
    echo -e "  3. 分架构推送: $0 --amd64  或  $0 --arm64"
    exit 1
fi
echo -e "${GREEN}✓ 镜像构建并推送成功${NC}"
echo ""

# 验证
echo -e "${YELLOW}步骤 4/4: 验证镜像架构...${NC}"
docker buildx imagetools inspect "${FULL_IMAGE_NAME}:${TAG_LATEST}" 2>/dev/null | head -20 || echo -e "${YELLOW}(可通过 docker buildx imagetools inspect 查看详情)${NC}"
echo ""

# 完成
echo -e "${GREEN}==============================================================================${NC}"
echo -e "${GREEN}✓ 多架构构建和推送完成！${NC}"
echo -e "${GREEN}==============================================================================${NC}"
echo ""
echo -e "${YELLOW}镜像已推送到:${NC}"
echo -e "  ${FULL_IMAGE_NAME}:${TAG_VERSION}"
echo -e "  ${FULL_IMAGE_NAME}:${TAG_LATEST}"
echo ""
echo -e "${YELLOW}支持架构:${NC}"
echo -e "  - linux/amd64 (x86_64 服务器)"
echo -e "  - linux/arm64 (Apple Silicon / AWS Graviton / Oracle ARM)"
echo ""
echo -e "${YELLOW}使用方法（与 abu-api 同机部署）:${NC}"
echo -e "  1. docker-compose.abu.yml 已配 image: ${FULL_IMAGE_NAME}:latest"
echo -e "  2. docker compose -f docker-compose.abu.yml up -d"
echo -e "  3. abu-api 后台「集成应用 → Nova 绘图工作台 → 服务地址」填 http://nova-image-studio:3000"
echo -e "  （容器内前端静态资源+后端由 node 单进程托管，监听 3000）"
echo ""
