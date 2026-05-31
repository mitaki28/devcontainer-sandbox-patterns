FROM mcr.microsoft.com/devcontainers/base:trixie@sha256:e389149057371298eaeb72e736fc2c4dcb79974de222dd471d2e6d675d2f61c4

# github.com への git transport (fetch / push / clone) を system-wide に
# git-gateway:8080 へ書き換える。詳細は workspace/gitconfig 参照。
COPY gitconfig /etc/gitconfig
