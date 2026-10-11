#!/bin/bash
# Publishes BrightBulb's PKGBUILD to the AUR as brightbulb-git.
#
# Usage:
#   ./aur-publish.sh [commit message]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AUR_PKGNAME="brightbulb-git"
REPO="ssh://aur@aur.archlinux.org/${AUR_PKGNAME}.git"
WORKDIR="${SCRIPT_DIR}/.aur-repo-${AUR_PKGNAME}"
MESSAGE="${1:-Update to latest}"

if ! command -v makepkg &>/dev/null; then
    echo "Error: makepkg is required but not found."
    exit 1
fi

if [ -d "${WORKDIR}/.git" ]; then
    echo "Pulling latest from AUR..."
    git -C "${WORKDIR}" pull --rebase || true
else
    echo "Cloning AUR repo..."
    git clone "${REPO}" "${WORKDIR}" 2>/dev/null || {
        echo "AUR repo not found remotely. Initializing new repo..."
        mkdir -p "${WORKDIR}"
        git -C "${WORKDIR}" init
        git -C "${WORKDIR}" remote add origin "${REPO}"
    }
fi

cp "${SCRIPT_DIR}/PKGBUILD" "${WORKDIR}/PKGBUILD"

# makepkg --printsrcinfo cannot run pkgver() here because $srcdir does not
# exist yet, so resolve the version from this repo's history instead.
VERSION=$(printf "r%s.%s" \
    "$(git -C "${SCRIPT_DIR}" rev-list --count HEAD)" \
    "$(git -C "${SCRIPT_DIR}" rev-parse --short HEAD)")
echo "Package version: ${VERSION}"
sed -i "s/^pkgver=.*/pkgver=${VERSION}/" "${WORKDIR}/PKGBUILD"

echo "Generating .SRCINFO..."
(cd "${WORKDIR}" && makepkg --printsrcinfo > .SRCINFO)

(
    cd "${WORKDIR}"
    git add PKGBUILD .SRCINFO
    if git diff --cached --quiet; then
        echo "No changes to publish."
    else
        git commit -m "${MESSAGE}"
        git push origin master
        echo "Published ${AUR_PKGNAME} to AUR."
    fi
)

rm -rf "${WORKDIR}"
