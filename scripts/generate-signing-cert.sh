#!/usr/bin/env bash
# Generate a self-signed P12 certificate for PDF PAdES signing.
# Usage: ./scripts/generate-signing-cert.sh [output_dir] [password]
#   output_dir: directory for the certificate (default: ./data/signing)
#   password:   P12 export password (default: empty - set SIGNING_CERTIFICATE_PASSWORD in env)

set -euo pipefail

CERT_DIR="${1:-./data/signing}"
CERT_PASSWORD="${2:-}"
CERT_DAYS=3650  # 10 years

mkdir -p "$CERT_DIR"

echo "==> Generating RSA 4096 private key..."
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:4096 \
  -out "$CERT_DIR/signing-key.pem" 2>/dev/null

echo "==> Generating self-signed X.509 certificate (${CERT_DAYS} days)..."
openssl req -new -x509 \
  -key "$CERT_DIR/signing-key.pem" \
  -out "$CERT_DIR/signing-cert.pem" \
  -days "$CERT_DAYS" \
  -subj "/CN=PrivCloud Sharing PDF Signing/O=PrivCloud/OU=Document Signing/C=FR" \
  -addext "keyUsage=digitalSignature,nonRepudiation" \
  -addext "extendedKeyUsage=emailProtection" 2>/dev/null

echo "==> Exporting to PKCS#12 (.p12) [legacy format for node-forge compatibility]..."
# IMPORTANT: OpenSSL 3.x uses PBES2/AES by default for P12 encryption.
# node-forge (used by @signpdf/signer-p12) only supports legacy format
# (PBE-SHA1-3DES + SHA1 MAC). Without these flags, signing will fail with:
#   "PKCS#12 MAC could not be verified. Invalid password?"
openssl pkcs12 -export \
  -in "$CERT_DIR/signing-cert.pem" \
  -inkey "$CERT_DIR/signing-key.pem" \
  -out "$CERT_DIR/certificate.p12" \
  -name "PrivCloud Signing" \
  -keypbe PBE-SHA1-3DES \
  -certpbe PBE-SHA1-3DES \
  -macalg SHA1 \
  -passout "pass:${CERT_PASSWORD}"

# Clean up PEM intermediates
rm -f "$CERT_DIR/signing-key.pem" "$CERT_DIR/signing-cert.pem"

echo "==> Certificate generated: $CERT_DIR/certificate.p12"
echo "    Validity: ${CERT_DAYS} days"
echo "    Subject:  CN=PrivCloud Sharing PDF Signing, O=PrivCloud, C=FR"
if [ -n "$CERT_PASSWORD" ]; then
  echo "    Password protected: yes"
else
  echo "    Password: (empty) - set SIGNING_CERTIFICATE_PASSWORD in docker-compose"
fi
echo ""
echo "Add these to your docker-compose.yaml environment:"
echo "  - SIGNING_CERTIFICATE_PATH=/opt/app/backend/data/signing/certificate.p12"
if [ -n "$CERT_PASSWORD" ]; then
  echo "  - SIGNING_CERTIFICATE_PASSWORD=${CERT_PASSWORD}"
fi
