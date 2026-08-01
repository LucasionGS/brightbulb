#!/bin/bash
# Publishes BrightBulb's PKGBUILDs to the AUR.
#
# Usage:
#   ./aur-publish.sh [commit message]            # publish brightbulb-git
#   ./aur-publish.sh --deps [commit message]     # publish the dependency packages
#   ./aur-publish.sh --all  [commit message]     # dependencies first, then the app
#
# aiohue and asyncio-throttle are not in the Arch repos or the AUR, and Arch
# guidelines rule out vendoring them into brightbulb, so they ship as their own
# packages. They are versioned releases that rarely change; --deps only needs
# running when their pkgver moves.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AUR_PKGNAME="brightbulb-git"
DEP_PKGNAMES=(python-asyncio-throttle python-aiohue)

if ! command -v makepkg &>/dev/null; then
    echo "Error: makepkg is required but not found."
    exit 1
fi

# Publishes one package directory. $1 = AUR package name, $2 = PKGBUILD dir,
# $3 = commit message, $4 = "git" to patch pkgver from the repo history.
publish() {
    local pkgname="$1" pkgdir="$2" msg="$3" versioning="${4:-static}"
    local repo="ssh://aur@aur.archlinux.org/${pkgname}.git"
    local workdir="${SCRIPT_DIR}/.aur-repo-${pkgname}"

    if [ ! -f "${pkgdir}/PKGBUILD" ]; then
        echo "Error: PKGBUILD not found in ${pkgdir}"
        return 1
    fi

    if [ -d "${workdir}/.git" ]; then
        echo "Pulling latest from AUR (${pkgname})..."
        git -C "${workdir}" pull --rebase || true
    else
        echo "Cloning AUR repo (${pkgname})..."
        git clone "${repo}" "${workdir}" 2>/dev/null || {
            echo "AUR repo not found remotely. Initializing new repo..."
            mkdir -p "${workdir}"
            git -C "${workdir}" init
            git -C "${workdir}" remote add origin "${repo}"
        }
    fi

    cp "${pkgdir}/PKGBUILD" "${workdir}/PKGBUILD"

    if [ "${versioning}" = "git" ]; then
        # The static pkgver=r0.0000000 in the source PKGBUILD is intentional;
        # makepkg --printsrcinfo cannot run pkgver() here because $srcdir does
        # not exist yet, so resolve the version from this repo's history.
        local version
        version=$(printf "r%s.%s" \
            "$(git -C "${SCRIPT_DIR}" rev-list --count HEAD)" \
            "$(git -C "${SCRIPT_DIR}" rev-parse --short HEAD)")
        echo "Package version: ${version}"
        sed -i "s/^pkgver=.*/pkgver=${version}/" "${workdir}/PKGBUILD"
    fi

    echo "Generating .SRCINFO..."
    (cd "${workdir}" && makepkg --printsrcinfo > .SRCINFO)

    (
        cd "${workdir}"
        git add PKGBUILD .SRCINFO
        if git diff --cached --quiet; then
            echo "No changes to publish for ${pkgname}."
        else
            git commit -m "${msg}"
            git push origin master
            echo "Published ${pkgname} to AUR."
        fi
    )

    rm -rf "${workdir}"
}

MODE="app"
case "${1:-}" in
    --deps) MODE="deps"; shift ;;
    --all)  MODE="all";  shift ;;
esac
COMMIT_MSG="${1:-Update PKGBUILD}"

if [ "${MODE}" = "deps" ] || [ "${MODE}" = "all" ]; then
    # Order matters: python-aiohue depends on python-asyncio-throttle.
    for dep in "${DEP_PKGNAMES[@]}"; do
        publish "${dep}" "${SCRIPT_DIR}/${dep}" "${COMMIT_MSG}" static
    done
fi

if [ "${MODE}" = "app" ] || [ "${MODE}" = "all" ]; then
    publish "${AUR_PKGNAME}" "${SCRIPT_DIR}" "${COMMIT_MSG}" git
fi

echo "Done."
