#!/usr/bin/env bash
# Re-export the PDF seal P12 to the only profile the backend reads: PBES2
# AES-256-CBC (PBKDF2-HMAC-SHA256) for the key and the certificates, and a
# SHA-256 MAC. Files from earlier versions of generate-signing-cert.sh
# (PBE-SHA1-3DES with a SHA-1 MAC) and older OpenSSL or Windows exports (RC2)
# are refused by the backend until they are converted.
#
# Usage: SIGNING_CERTIFICATE_PASSWORD=... ./scripts/convert-signing-p12.sh <input.p12> <output.p12>
#   The output keeps the same password, key and certificate chain. The private
#   key only goes through pipes, it is never written to disk in clear. The
#   input file is left untouched and an existing output is never overwritten.

set -euo pipefail

INPUT="${1:-}"
OUTPUT="${2:-}"
if [ -z "$INPUT" ] || [ -z "$OUTPUT" ]; then
  echo "Usage: SIGNING_CERTIFICATE_PASSWORD=... $0 <input.p12> <output.p12>" >&2
  exit 1
fi
if [ -z "${SIGNING_CERTIFICATE_PASSWORD+set}" ]; then
  echo "SIGNING_CERTIFICATE_PASSWORD must be set (an empty value is allowed)." >&2
  exit 1
fi
if [ ! -f "$INPUT" ]; then
  echo "Input file not found: $INPUT" >&2
  exit 1
fi
if [ -e "$OUTPUT" ]; then
  echo "Refusing to overwrite $OUTPUT" >&2
  exit 1
fi
export SIGNING_CERTIFICATE_PASSWORD

# OpenSSL 3 only reads RC2 through its legacy provider.
LEGACY=()
if ! openssl pkcs12 -in "$INPUT" -passin env:SIGNING_CERTIFICATE_PASSWORD \
  -noout 2>/dev/null; then
  LEGACY=(-legacy)
  if ! openssl pkcs12 -legacy -in "$INPUT" \
    -passin env:SIGNING_CERTIFICATE_PASSWORD -noout 2>/dev/null; then
    echo "Cannot read $INPUT: wrong password or unsupported file." >&2
    exit 1
  fi
fi
read_input() {
  openssl pkcs12 ${LEGACY[@]+"${LEGACY[@]}"} -in "$INPUT" \
    -passin env:SIGNING_CERTIFICATE_PASSWORD -nodes "$@"
}
certificates() {
  openssl pkcs12 "$@" -nokeys -passin env:SIGNING_CERTIFICATE_PASSWORD 2>/dev/null \
    | awk '/-----BEGIN CERTIFICATE-----/{c=""; on=1} on{c=c $0} /-----END CERTIFICATE-----/{print c; on=0}' \
    | sort
}

umask 077
TMP="$(mktemp "$(dirname "$OUTPUT")/.signing-p12.XXXXXX")"
trap 'rm -f "$TMP"' EXIT

echo "==> Re-exporting $INPUT with PBES2 AES-256-CBC and a SHA-256 MAC..."
openssl pkcs12 -export \
  -inkey <(read_input -nocerts) \
  -in <(read_input -nokeys) \
  -out "$TMP" \
  -name "PrivCloud Sharing PDF Signing" \
  -keypbe AES-256-CBC \
  -certpbe AES-256-CBC \
  -macalg SHA256 \
  -passout env:SIGNING_CERTIFICATE_PASSWORD

echo "==> Checking the new file..."
INFO="$(openssl pkcs12 -in "$TMP" -passin env:SIGNING_CERTIFICATE_PASSWORD \
  -info -noout 2>&1)"
if ! grep -qi '^MAC: *sha256' <<<"$INFO" ||
  ! grep -q 'Shrouded Keybag: PBES2, PBKDF2, AES-256-CBC' <<<"$INFO" ||
  ! grep -q 'PKCS7 Encrypted data: PBES2, PBKDF2, AES-256-CBC' <<<"$INFO" ||
  grep -q 'hmacWithSHA1\b' <<<"$INFO"; then
  echo "The re-exported file does not use the expected protection:" >&2
  echo "$INFO" >&2
  exit 1
fi
if [ "$(certificates ${LEGACY[@]+"${LEGACY[@]}"} -in "$INPUT")" != \
  "$(certificates -in "$TMP")" ]; then
  echo "The certificate chain changed during the conversion." >&2
  exit 1
fi

mv "$TMP" "$OUTPUT"
trap - EXIT
echo "==> Done: $OUTPUT"
echo "    Same password, key and chain. Point SIGNING_CERTIFICATE_PATH at this"
echo "    file (or replace the old one with it), then restart the backend."
