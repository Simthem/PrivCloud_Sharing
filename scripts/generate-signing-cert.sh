#!/usr/bin/env bash
# Build the PrivCloud signing PKI and the P12 used for PDF PAdES and evidence
# seals:
#
#   PrivCloud Root CA                (20 years, keep offline)
#     +-- PrivCloud Signing CA       (10 years)
#           +-- PrivCloud Sharing PDF Signing   (5 years, in certificate.p12)
#
# Usage: CA_KEY_PASSWORD=... ./scripts/generate-signing-cert.sh [output_dir] [p12_password]
#   output_dir:      destination directory (default: ./data/signing)
#   p12_password:    P12 export password (default: empty, then set
#                    SIGNING_CERTIFICATE_PASSWORD accordingly)
#   CA_KEY_PASSWORD: required, encrypts the Root CA and Signing CA keys
#
# An existing Root CA (root-ca.key + root-ca.pem in <output_dir>/ca) is
# reused, so the Signing CA and the seal certificate can be renewed without
# changing the trust anchor that verifiers already hold.

set -euo pipefail

CERT_DIR="${1:-./data/signing}"
CERT_PASSWORD="${2:-}"
CA_DIR="$CERT_DIR/ca"
ROOT_DAYS=7300
SIGNING_CA_DAYS=3650
LEAF_DAYS=1825

if [ -z "${CA_KEY_PASSWORD:-}" ]; then
  echo "CA_KEY_PASSWORD must be set to encrypt the certificate authority keys." >&2
  exit 1
fi

mkdir -p "$CA_DIR"
chmod 700 "$CA_DIR"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

cat > "$WORK_DIR/root.ext" <<'EOF'
basicConstraints = critical, CA:TRUE, pathlen:1
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
EOF

cat > "$WORK_DIR/signing-ca.ext" <<'EOF'
basicConstraints = critical, CA:TRUE, pathlen:0
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid, issuer
EOF

# emailProtection keeps PDF readers that predate RFC 9336 satisfied,
# 1.3.6.1.5.5.7.3.36 is id-kp-documentSigning.
cat > "$WORK_DIR/leaf.ext" <<'EOF'
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature, nonRepudiation
extendedKeyUsage = emailProtection, 1.3.6.1.5.5.7.3.36
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid, issuer
EOF

if [ -f "$CA_DIR/root-ca.key" ] && [ -f "$CA_DIR/root-ca.pem" ]; then
  echo "==> Reusing the existing PrivCloud Root CA"
else
  echo "==> Generating the PrivCloud Root CA (${ROOT_DAYS} days)..."
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:4096 \
    -aes-256-cbc -pass env:CA_KEY_PASSWORD -out "$CA_DIR/root-ca.key"
  openssl req -new -key "$CA_DIR/root-ca.key" -passin env:CA_KEY_PASSWORD \
    -subj "/CN=PrivCloud Root CA/O=PrivCloud/C=FR" -out "$WORK_DIR/root.csr"
  openssl x509 -req -in "$WORK_DIR/root.csr" \
    -signkey "$CA_DIR/root-ca.key" -passin env:CA_KEY_PASSWORD \
    -days "$ROOT_DAYS" -sha256 -extfile "$WORK_DIR/root.ext" \
    -out "$CA_DIR/root-ca.pem"
fi

echo "==> Generating the PrivCloud Signing CA (${SIGNING_CA_DAYS} days)..."
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:4096 \
  -aes-256-cbc -pass env:CA_KEY_PASSWORD -out "$CA_DIR/signing-ca.key"
openssl req -new -key "$CA_DIR/signing-ca.key" -passin env:CA_KEY_PASSWORD \
  -subj "/CN=PrivCloud Signing CA/O=PrivCloud/C=FR" -out "$WORK_DIR/signing-ca.csr"
openssl x509 -req -in "$WORK_DIR/signing-ca.csr" \
  -CA "$CA_DIR/root-ca.pem" -CAkey "$CA_DIR/root-ca.key" \
  -passin env:CA_KEY_PASSWORD -set_serial "0x$(openssl rand -hex 16)" \
  -days "$SIGNING_CA_DAYS" -sha256 -extfile "$WORK_DIR/signing-ca.ext" \
  -out "$CA_DIR/signing-ca.pem"

echo "==> Generating the PrivCloud Sharing PDF Signing certificate (${LEAF_DAYS} days)..."
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 \
  -out "$WORK_DIR/signing-key.pem"
openssl req -new -key "$WORK_DIR/signing-key.pem" \
  -subj "/CN=PrivCloud Sharing PDF Signing/O=PrivCloud/OU=Document Signing/C=FR" \
  -out "$WORK_DIR/signing.csr"
openssl x509 -req -in "$WORK_DIR/signing.csr" \
  -CA "$CA_DIR/signing-ca.pem" -CAkey "$CA_DIR/signing-ca.key" \
  -passin env:CA_KEY_PASSWORD -set_serial "0x$(openssl rand -hex 16)" \
  -days "$LEAF_DAYS" -sha256 -extfile "$WORK_DIR/leaf.ext" \
  -out "$WORK_DIR/signing-cert.pem"

echo "==> Checking the chain..."
openssl verify -CAfile "$CA_DIR/root-ca.pem" -untrusted "$CA_DIR/signing-ca.pem" \
  "$WORK_DIR/signing-cert.pem"

cat "$CA_DIR/signing-ca.pem" "$CA_DIR/root-ca.pem" > "$WORK_DIR/chain.pem"

echo "==> Exporting to PKCS#12 (.p12) [legacy format for node-forge compatibility]..."
# IMPORTANT: OpenSSL 3.x uses PBES2/AES by default for P12 encryption.
# node-forge (used by @signpdf/signer-p12) only supports legacy format
# (PBE-SHA1-3DES + SHA1 MAC). Without these flags, signing will fail with:
#   "PKCS#12 MAC could not be verified. Invalid password?"
# The whole chain goes in the P12 so every CMS seal carries it.
openssl pkcs12 -export \
  -in "$WORK_DIR/signing-cert.pem" \
  -inkey "$WORK_DIR/signing-key.pem" \
  -certfile "$WORK_DIR/chain.pem" \
  -out "$CERT_DIR/certificate.p12" \
  -name "PrivCloud Sharing PDF Signing" \
  -keypbe PBE-SHA1-3DES \
  -certpbe PBE-SHA1-3DES \
  -macalg SHA1 \
  -passout "pass:${CERT_PASSWORD}"

# Public trust anchor, handed to verifiers with --ca.
cp "$CA_DIR/root-ca.pem" "$CERT_DIR/root-ca.pem"

echo "==> Done"
echo "    Seal P12:       $CERT_DIR/certificate.p12"
echo "    Trust anchor:   $CERT_DIR/root-ca.pem (publish it, verifiers use --ca)"
echo "    Fingerprint:    $(openssl x509 -in "$CERT_DIR/root-ca.pem" -noout -fingerprint -sha256)"
echo "    CA keys:        $CA_DIR (encrypted, move root-ca.key offline)"
if [ -n "$CERT_PASSWORD" ]; then
  echo "    P12 password:   set SIGNING_CERTIFICATE_PASSWORD to the value given"
else
  echo "    P12 password:   (empty) - set SIGNING_CERTIFICATE_PASSWORD in docker-compose"
fi
echo ""
echo "Add this to your docker-compose.yaml environment:"
echo "  - SIGNING_CERTIFICATE_PATH=/opt/app/backend/data/signing/certificate.p12"
