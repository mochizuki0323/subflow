#!/usr/bin/env bash
# Copy MinGW-built backend next to Linux build layout so electron-builder extraResources finds it.
# When the exe links dynamic OpenSSL/zlib/pthread DLLs, copy those from MINGW_SYSROOT so
# portable builds work on Windows hosts without MinGW installed (fixes 0xC0000135).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="${ROOT}/build-mingw/bin/subflow-backend.exe"
DST_DIR="${ROOT}/build/bin"
CACERT_SRC="${ROOT}/data/cacert.pem"
if [[ ! -f "$SRC" ]]; then
    echo "$SRC not found. Run first: npm run build:backend:mingw"
    exit 1
fi

if [[ -n "${MINGW_SYSROOT:-}" ]]; then
    :
elif [[ -d /usr/x86_64-w64-mingw32/sys-root/mingw ]]; then
    MINGW_SYSROOT=/usr/x86_64-w64-mingw32/sys-root/mingw
elif [[ -d /usr/x86_64-w64-mingw32 ]]; then
    MINGW_SYSROOT=/usr/x86_64-w64-mingw32
else
    MINGW_SYSROOT=""
fi

OBJDUMP="${OBJDUMP:-x86_64-w64-mingw32-objdump}"
if ! command -v "$OBJDUMP" &>/dev/null; then
    OBJDUMP="objdump"
fi

# List PE import DLL names (one per line, lower case basename).
list_pe_dll_imports() {
    local pe="$1"
    "$OBJDUMP" -p "$pe" 2>/dev/null | sed -n 's/.*DLL Name: \(.*\)/\1/p' | tr '[:upper:]' '[:lower:]'
}

# Resolve path to a dependency DLL inside MinGW sysroot (imports are matched lowercased).
resolve_sysroot_dll() {
    local name_lc="$1"
    local dir f
    for dir in "${MINGW_SYSROOT}/bin" "${MINGW_SYSROOT}/lib"; do
        [[ -d "$dir" ]] || continue
        f="$dir/$name_lc"
        if [[ -f "$f" ]]; then
            printf '%s\n' "$f"
            return 0
        fi
    done
    shopt -s nullglob nocaseglob
    for dir in "${MINGW_SYSROOT}/bin" "${MINGW_SYSROOT}/lib"; do
        [[ -d "$dir" ]] || continue
        local matches=("$dir/$name_lc")
        if [[ ${#matches[@]} -eq 1 && -f "${matches[0]}" ]]; then
            printf '%s\n' "${matches[0]}"
            shopt -u nullglob nocaseglob
            return 0
        fi
    done
    shopt -u nullglob nocaseglob
    return 1
}

copy_mingw_dll_chain() {
    [[ -n "$MINGW_SYSROOT" ]] || return 0
    local queue=("$1")
    local seen="|"
    local max_rounds=64
    local round=0
    while [[ ${#queue[@]} -gt 0 && round -lt max_rounds ]]; do
        round=$((round + 1))
        local next=()
        for pe in "${queue[@]}"; do
            local dll
            while IFS= read -r dll || [[ -n "$dll" ]]; do
                [[ -n "$dll" ]] || continue
                if [[ "$seen" == *"|${dll}|"* ]]; then
                    continue
                fi
                seen="${seen}${dll}|"
                local srcpath
                if srcpath=$(resolve_sysroot_dll "$dll"); then
                    local base
                    base=$(basename "$srcpath")
                    if [[ ! -f "${DST_DIR}/${base}" ]]; then
                        cp -f "$srcpath" "${DST_DIR}/${base}"
                        echo "Copied runtime dependency: ${base}"
                    fi
                    # Always enqueue to resolve transitive deps (e.g. libcrypto -> zlib)
                    next+=("${DST_DIR}/${base}")
                fi
            done < <(list_pe_dll_imports "$pe")
        done
        queue=("${next[@]}")
    done
}

mkdir -p "$DST_DIR"
cp -f "$SRC" "$DST_DIR/"
echo "Copied to ${DST_DIR}/subflow-backend.exe"

if [[ -f "$CACERT_SRC" ]]; then
    cp -f "$CACERT_SRC" "${DST_DIR}/cacert.pem"
    echo "Copied CA bundle: ${DST_DIR}/cacert.pem"
else
    echo "WARNING: CA bundle not found at ${CACERT_SRC}. Deepgram TLS may fail on Windows."
fi

shopt -s nullglob
rm -f "${DST_DIR}"/*.dll
shopt -u nullglob
if [[ -n "$MINGW_SYSROOT" ]]; then
    if copy_mingw_dll_chain "$DST_DIR/subflow-backend.exe"; then
        :
    fi
else
    echo "MINGW_SYSROOT not set, skipping DLL dependency copy (dynamically-linked OpenSSL may cause 0xC0000135 on Windows)."
fi
