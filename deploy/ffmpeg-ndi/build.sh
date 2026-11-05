#!/usr/bin/env bash
# Builds a separate ffmpeg with NDI input (libndi_newtek) into $PREFIX (default /opt/ffmpeg-ndi).
#
# Upstream ffmpeg removed NDI in 2019 and the NDI SDK is proprietary, so the result is a
# "nonfree" build: fine to build and use on your own server, NOT allowed to redistribute.
# Never push an image or binary built with this script to a public registry.
#
# Usage (Debian/Ubuntu, as root; apps/live-gateway/Dockerfile runs it with FOYER_NDI=1):
#   NDI_LICENSE=accept deploy/ffmpeg-ndi/build.sh
#
# NDI_LICENSE=accept means: you have read and accept the NDI SDK licence
# (https://docs.ndi.video/docs/sdk/licensing). The installer's own licence prompt is answered with it.
set -euo pipefail

PREFIX="${PREFIX:-/opt/ffmpeg-ndi}"
FFMPEG_REF="${FFMPEG_REF:-n5.1.9}"                                  # the patch targets ffmpeg 5.1
PATCH_COMMIT="${PATCH_COMMIT:-8875a4d6526bf2a2846e241ffacdf7108dc64f10}" # lplassman/FFMPEG-NDI, pinned
NDI_SDK_URL="${NDI_SDK_URL:-https://downloads.ndi.tv/SDK/NDI_SDK_Linux/Install_NDI_SDK_v6_Linux.tar.gz}"
NDI_SDK_FILE="${NDI_SDK_FILE:-}"                                    # alternatively a local copy of the tarball

if [ "${NDI_LICENSE:-}" != "accept" ]; then
  echo "NDI-SDK-Lizenz nicht bestätigt. Lizenz lesen (https://docs.ndi.video/docs/sdk/licensing) und mit NDI_LICENSE=accept erneut starten." >&2
  exit 1
fi

case "$(uname -m)" in
  x86_64) NDI_ARCH=x86_64-linux-gnu ;;
  aarch64) NDI_ARCH=aarch64-rpi4-linux-gnueabi ;;
  *) echo "Architektur $(uname -m) wird nicht unterstützt" >&2; exit 1 ;;
esac

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cd "$WORK"

if command -v apt-get >/dev/null; then
  apt-get update
  apt-get install -y --no-install-recommends ca-certificates curl git build-essential nasm pkg-config libx264-dev libopus-dev libavahi-client-dev
fi

# --- NDI SDK -----------------------------------------------------------------
if [ -n "$NDI_SDK_FILE" ]; then cp "$NDI_SDK_FILE" sdk.tar.gz; else curl -fsSL -o sdk.tar.gz "$NDI_SDK_URL"; fi
tar -xzf sdk.tar.gz
# Self-extracting installer: it shows the licence and asks for "y" (accepted above).
{ yes y || true; } | bash ./Install_NDI_SDK_v*_Linux.sh >/dev/null  # yes ends with SIGPIPE
SDK="$(find . -maxdepth 1 -type d -name 'NDI SDK for Linux' | head -n1)"
[ -d "$SDK/lib/$NDI_ARCH" ] || { echo "NDI-SDK enthält keine Bibliotheken für $NDI_ARCH (vorhanden: $(ls "$SDK/lib"))" >&2; exit 1; }
mkdir -p "$PREFIX/lib" "$PREFIX/include" "$PREFIX/share/ndi"
cp -a "$SDK/lib/$NDI_ARCH/." "$PREFIX/lib/"
cp -a "$SDK/include/." "$PREFIX/include/"
cp -a "$SDK"/*.txt "$SDK"/*.pdf "$PREFIX/share/ndi/" 2>/dev/null || true  # licence texts travel with the binary

# --- ffmpeg + NDI patch ------------------------------------------------------
git clone --quiet --depth 1 --branch "$FFMPEG_REF" https://git.ffmpeg.org/ffmpeg.git ffmpeg
git clone --quiet https://github.com/lplassman/FFMPEG-NDI.git patch
git -C patch checkout --quiet "$PATCH_COMMIT"
cd ffmpeg
git apply ../patch/libndi.patch
cp ../patch/libavdevice/libndi_newtek_* libavdevice/

# Only what live ingest needs: NDI in, H.264 + Opus out to the gateway (RTSP).
./configure \
  --prefix="$PREFIX" \
  --enable-gpl --enable-nonfree \
  --enable-libx264 --enable-libopus --enable-libndi_newtek \
  --extra-cflags="-I$PREFIX/include" \
  --extra-ldflags="-L$PREFIX/lib -Wl,-rpath,$PREFIX/lib" \
  --disable-doc --disable-ffplay --disable-debug
make -j"$(nproc)"
make install

"$PREFIX/bin/ffmpeg" -hide_banner -devices 2>/dev/null | grep -q libndi_newtek
echo "ffmpeg mit NDI liegt in $PREFIX/bin/ffmpeg"
