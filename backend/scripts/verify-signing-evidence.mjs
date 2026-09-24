#!/usr/bin/env node
import { createHash, X509Certificate } from "node:crypto";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  cose,
  decodeCredentialPublicKey,
  verifySignature,
} from "@simplewebauthn/server/helpers";
import forge from "node-forge";
import xmlCrypto from "xml-crypto";
import xmldom from "@xmldom/xmldom";
import { PDFDocument, PDFDict, PDFName, PDFArray, PDFRawStream, PDFString, PDFHexString, decodePDFRawStream } from "pdf-lib";

const DOMAIN = "PrivCloud-Signature-v2";
const AUDIT_PROTOCOL = "privcloud-signing-audit-v1";
const ATTESTATION_ENVELOPE = "privcloud-signing-evidence-envelope-v1";
const ATTESTATION_FORMAT = "privcloud-evidence-attestation-v1";
const FORENSIC_ENVELOPE = "privcloud-forensic-evidence-envelope-v1";
const FORENSIC_FORMAT = "privcloud-forensic-evidence-v1";
const SOURCE_ATTACHMENT = "privcloud-source.pdf";
const OID_TIMESTAMP_TOKEN = "1.2.840.113549.1.9.16.2.14";
const HASH_BY_OID = {
  "1.3.14.3.2.26": "sha1",
  "2.16.840.1.101.3.4.2.1": "sha256",
  "2.16.840.1.101.3.4.2.2": "sha384",
  "2.16.840.1.101.3.4.2.3": "sha512",
};
const COSE_ALGORITHMS = { "-7": "ES256", "-8": "EdDSA", "-35": "ES384", "-257": "RS256" };
const digest = (value) => createHash("sha256").update(value).digest();
const hex = (value) => digest(value).toString("hex");
const normalized = (value) => {
  if (Array.isArray(value)) return value.map(normalized);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, normalized(child)]),
    );
  }
  return value;
};
const canonical = (value) => JSON.stringify(normalized(value));
const fail = (message) => {
  throw new Error(message);
};

// Detailed report, printed section by section with --verbose so an expert can
// follow every check without reading the code.
const report = [];
const note = (section, label, value) => report.push({ section, label, value });
let tsaCaFile = null;
let trustedListFile = null;
let lotlFile = null;
// Raw RFC 3161 exchanges joined to the envelopes, by message imprint.
const timestampExchanges = new Map();
let verbose = false;

// Reading order of the report, whatever the order the checks ran in.
const SECTION_RANK = [
  /^Attestation$/,
  /^Forensic$/,
  /^(WebAuthn|Manifest) /,
  /^CMS$/,
  /^Timestamp /,
  /^Trusted List$/,
  /^EU List of Trusted Lists$/,
];

function printReport() {
  const sections = new Map();
  for (const { section, label, value } of report) {
    if (!sections.has(section)) sections.set(section, []);
    sections.get(section).push({ label, value });
  }
  const rank = (section) => SECTION_RANK.findIndex((pattern) => pattern.test(section));
  const ordered = [...sections.keys()]
    .map((section, index) => ({ section, index }))
    .sort((left, right) => rank(left.section) - rank(right.section) || left.index - right.index);
  const width = Math.max(34, ...report.map(({ label }) => label.length + 4));
  for (const { section } of ordered) {
    console.log(`\n${section}\n${"-".repeat(section.length)}`);
    for (const { label, value } of sections.get(section)) {
      console.log(`${`${label} `.padEnd(width, ".")} ${value}`);
    }
  }
  console.log("");
}

function withTempDir(action) {
  const dir = mkdtempSync(join(tmpdir(), "privcloud-evidence-"));
  try {
    return action(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const asn1Of = (bytes) =>
  forge.asn1.fromDer(forge.util.createBuffer(bytes.toString("binary")), {
    strict: false,
    decodeBitStrings: false,
  });
const derOf = (node) => Buffer.from(forge.asn1.toDer(node).getBytes(), "binary");
const isContext = (node, type) =>
  node.tagClass === forge.asn1.Class.CONTEXT_SPECIFIC && node.type === type;
const octets = (node) =>
  Array.isArray(node.value)
    ? Buffer.concat(node.value.map(octets))
    : Buffer.from(node.value, "binary");

/** Subject, fingerprint, validity and extended key usage of a certificate. */
function certificateDetails(der) {
  return withTempDir((dir) => {
    writeFileSync(join(dir, "cert.der"), der);
    const result = spawnSync(
      "openssl",
      [
        "x509", "-inform", "DER", "-in", join(dir, "cert.der"), "-noout",
        "-subject", "-issuer", "-fingerprint", "-sha256", "-startdate", "-enddate",
        "-ext", "extendedKeyUsage",
      ],
      { encoding: "utf8" },
    );
    const text = result.stdout || "";
    const field = (pattern) => text.match(pattern)?.[1]?.trim() || null;
    const eku = text.match(/Extended Key Usage:\s*(critical)?\s*\n\s*(.+)/);
    return {
      der,
      subject: field(/^subject=\s*(.*)$/m) || "unknown",
      issuer: field(/^issuer=\s*(.*)$/m) || "unknown",
      fingerprint: field(/Fingerprint=(.*)$/m) || "unknown",
      notBefore: new Date(field(/^notBefore=(.*)$/m)),
      notAfter: new Date(field(/^notAfter=(.*)$/m)),
      eku: eku ? eku[2].trim() : "",
      ekuCritical: Boolean(eku?.[1]),
    };
  });
}

const commonName = (subject) => subject.match(/CN\s*=\s*([^,/]+)/)?.[1]?.trim() || subject;
const pemOf = (der) =>
  `-----BEGIN CERTIFICATE-----\n${der.toString("base64").match(/.{1,64}/g).join("\n")}\n-----END CERTIFICATE-----\n`;

/** Certificates of a PEM bundle, as DER. */
function pemCertificates(path) {
  return [...readFileSync(path, "utf8").matchAll(
    /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g,
  )].map((match) => Buffer.from(match[1].replace(/\s/g, ""), "base64"));
}

/** Integer node as hex, without the sign padding byte. */
const integerHex = (node) => Buffer.from(node.value, "binary").toString("hex").replace(/^00(?=[0-9a-f]{2})/, "");

/** Certificates, signature value and RFC 3161 token of a CMS SignedData. */
function cmsStructure(cms) {
  const signedData = asn1Of(cms).value[1].value[0];
  const certificates = (signedData.value.find((node) => isContext(node, 0))?.value || [])
    .map(derOf);
  const signerInfo = signedData.value[signedData.value.length - 1].value[0];
  const signatureValue = octets(
    signerInfo.value.find(
      (node) =>
        node.tagClass === forge.asn1.Class.UNIVERSAL &&
        node.type === forge.asn1.Type.OCTETSTRING,
    ),
  );
  let timestampToken = null;
  for (const attribute of signerInfo.value.find((node) => isContext(node, 1))?.value || []) {
    if (forge.asn1.derToOid(attribute.value[0].value) === OID_TIMESTAMP_TOKEN) {
      timestampToken = derOf(attribute.value[1].value[0]);
    }
  }
  return { certificates, signatureValue, timestampToken };
}

/** Fields of the TSTInfo carried by an RFC 3161 token. */
function timestampInfo(token) {
  const signedData = asn1Of(token).value[1].value[0];
  const certificates = (signedData.value.find((node) => isContext(node, 0))?.value || [])
    .map(derOf);
  const tstInfo = asn1Of(octets(signedData.value[2].value[1].value[0]));
  const imprint = tstInfo.value[2];
  const genTime = String(tstInfo.value[4].value);
  const nonceNode = tstInfo.value
    .slice(5)
    .find((node) => node.tagClass === forge.asn1.Class.UNIVERSAL && node.type === forge.asn1.Type.INTEGER);
  return {
    certificates,
    policy: forge.asn1.derToOid(tstInfo.value[1].value),
    algorithm: HASH_BY_OID[forge.asn1.derToOid(imprint.value[0].value[0].value)],
    hashed: octets(imprint.value[1]),
    serial: integerHex(tstInfo.value[3]),
    nonce: nonceNode ? integerHex(nonceNode) : null,
    time: new Date(
      `${genTime.slice(0, 4)}-${genTime.slice(4, 6)}-${genTime.slice(6, 8)}T${genTime.slice(8, 10)}:${genTime.slice(10, 12)}:${genTime.slice(12, 14)}Z`,
    ),
  };
}

/** Nonce of an archived TimeStampReq (.tsq). */
function requestNonce(request) {
  const node = asn1Of(request)
    .value.slice(2)
    .find((child) => child.tagClass === forge.asn1.Class.UNIVERSAL && child.type === forge.asn1.Type.INTEGER);
  return node ? integerHex(node) : null;
}

/** Token of an archived TimeStampResp (.tsr). */
const responseToken = (response) => derOf(asn1Of(response).value[1]);

/**
 * Services of an ETSI TS 119 612 Trusted List: type, name, certificates and
 * dated status history, read from the signed content only.
 */
function trustedListServices(xml) {
  const tag = (name) => new RegExp(`<(?:\\w+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${name}>`, "g");
  const first = (block, name) => tag(name).exec(block)?.[1]?.trim() || null;
  const services = [];
  for (const [, block] of xml.matchAll(tag("TSPService"))) {
    const history = [];
    const information = first(block, "ServiceInformation") || "";
    history.push({
      type: first(information, "ServiceTypeIdentifier"),
      status: first(information, "ServiceStatus"),
      start: new Date(first(information, "StatusStartingTime")),
    });
    for (const [, instance] of block.matchAll(tag("ServiceHistoryInstance"))) {
      history.push({
        type: first(instance, "ServiceTypeIdentifier"),
        status: first(instance, "ServiceStatus"),
        start: new Date(first(instance, "StatusStartingTime")),
      });
    }
    const certificates = [...information.matchAll(tag("X509Certificate"))]
      .map(([, base64]) => Buffer.from(base64.replace(/\s/g, ""), "base64"))
      .filter((der) => der.length > 0);
    services.push({
      name: (first(first(information, "ServiceName") || "", "Name") || "unnamed").replace(/\s+/g, " "),
      certificates,
      fingerprints: certificates.map((der) => hex(der)),
      history: history.sort((left, right) => left.start - right.start),
    });
  }
  return services;
}

const uriTail = (uri) => (uri || "").split("/").pop();

const XMLDSIG = "http://www.w3.org/2000/09/xmldsig#";
const ENVELOPED = "http://www.w3.org/2000/09/xmldsig#enveloped-signature";
const listTag = (name) => new RegExp(`<(?:\\w+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${name}>`, "g");
const listText = (block, name) => listTag(name).exec(block)?.[1]?.trim() || null;
const subjectOf = (certificate) => certificate.subject.split("\n").join(", ");

/**
 * Enveloped XAdES signature of a Trusted List or of the EU List of Trusted
 * Lists, checked with the certificate it carries. Only the content the
 * signature covers is returned, so nothing added around it can be read.
 */
function signedList(xml, label) {
  const root = new xmldom.DOMParser().parseFromString(xml, "text/xml").documentElement;
  const signatures = Array.from(root?.childNodes || []).filter(
    (node) => node.nodeType === 1 && node.localName === "Signature" && node.namespaceURI === XMLDSIG,
  );
  if (signatures.length !== 1) fail(`${label}: not exactly one enveloped XML signature`);
  const certificate = signatures[0].getElementsByTagNameNS(XMLDSIG, "X509Certificate")[0]?.textContent;
  if (!certificate) fail(`${label}: the XML signature carries no certificate`);
  const signer = new X509Certificate(Buffer.from(certificate.replace(/\s/g, ""), "base64"));
  const signature = new xmlCrypto.SignedXml({ publicCert: signer.toString(), getCertFromKeyInfo: () => null });
  signature.loadSignature(signatures[0]);
  let valid = false;
  try {
    valid = signature.checkSignature(xml);
  } catch {
    valid = false;
  }
  if (!valid) fail(`${label}: invalid XML signature, the list was modified or is not the published one`);
  const whole = signature
    .getReferences()
    .find((reference) => reference.uri === "" && reference.transforms.includes(ENVELOPED));
  if (!whole?.signedReference) fail(`${label}: the XML signature does not cover the whole list`);
  return {
    signedXml: whole.signedReference,
    signer,
    signerSha256: hex(signer.raw),
    algorithm: (signature.signatureAlgorithm || "unknown").split("#").pop(),
  };
}

function reportListHeader(section, raw, list) {
  note(section, "File SHA-256", hex(raw));
  note(section, "Territory", listText(list.signedXml, "SchemeTerritory") || "unknown");
  note(section, "Sequence number", listText(list.signedXml, "TSLSequenceNumber") || "unknown");
  note(section, "Issued", listText(list.signedXml, "ListIssueDateTime") || "unknown");
  note(section, "Next update", listText(listText(list.signedXml, "NextUpdate") || "", "dateTime") || "unknown");
  note(section, "Signature", `VALID (${list.algorithm}, enveloped, covers the whole list)`);
  note(section, "Signer", subjectOf(list.signer));
  note(section, "Signer certificate", `SHA-256 ${list.signerSha256}`);
  const issued = new Date(listText(list.signedXml, "ListIssueDateTime"));
  const validAtIssue =
    new Date(list.signer.validFrom) <= issued && issued <= new Date(list.signer.validTo);
  note(section, "Signer certificate at issue time", validAtIssue ? "VALID" : "NOT VALID");
  if (!validAtIssue) fail(`${section}: the signer certificate was not valid when the list was issued`);
}

/** Pointers of the EU List of Trusted Lists, with the certificates allowed to sign each list. */
const listPointers = (signedXml) =>
  [...signedXml.matchAll(listTag("OtherTSLPointer"))].map(([, pointer]) => ({
    territory: listText(pointer, "SchemeTerritory"),
    fingerprints: [...pointer.matchAll(listTag("X509Certificate"))]
      .map(([, base64]) => Buffer.from(base64.replace(/\s/g, ""), "base64"))
      .filter((der) => der.length > 0)
      .map((der) => hex(der)),
  }));

/** Checks that the EU List of Trusted Lists authorizes the national list signer. */
function reportListAnchoring(territory, list) {
  if (!lotlFile) {
    note("Trusted List", "Signer authorized by the EU List of Trusted Lists", "NOT CHECKED (use --lotl eu-lotl.xml)");
    return false;
  }
  const raw = readFileSync(lotlFile);
  const xml = raw.toString("utf8");
  if (!/PointersToOtherTSL/.test(xml)) fail(`${lotlFile} is not the EU List of Trusted Lists (https://ec.europa.eu/tools/lotl/eu-lotl.xml)`);
  const section = "EU List of Trusted Lists";
  const lotl = signedList(xml, lotlFile);
  reportListHeader(section, raw, lotl);
  const pointers = listPointers(lotl.signedXml);
  const selfListed = pointers.some(
    (pointer) => pointer.territory === "EU" && pointer.fingerprints.includes(lotl.signerSha256),
  );
  note(section, "Signer listed in its own EU pointer", selfListed ? "YES" : "NO");
  if (!selfListed) fail("the EU List of Trusted Lists is not signed by a certificate it lists for itself");
  const journal = [...new Set(lotl.signedXml.match(/https?:\/\/eur-lex\.europa\.eu\/[^<\s"]+/g) || [])];
  note(section, "Official Journal publication", journal.join(", ") || "reference not found");
  note(section, "Anchor", "compare the signer certificate above with the certificates published in the Official Journal");
  const authorized = pointers.some(
    (pointer) => pointer.territory === territory && pointer.fingerprints.includes(list.signerSha256),
  );
  note(
    "Trusted List",
    "Signer authorized by the EU List of Trusted Lists",
    authorized ? `YES (pointer for ${territory})` : "NO",
  );
  if (!authorized) fail(`the Trusted List signer is not authorized by the EU List of Trusted Lists for ${territory}`);
  return true;
}

let trustedListCache = null;
let trustedListAnchored = false;
function trustedList() {
  if (trustedListCache) return trustedListCache;
  const raw = readFileSync(trustedListFile);
  const xml = raw.toString("utf8");
  if (!/<(?:\w+:)?TSPService\b/.test(xml)) {
    fail(
      /PointersToOtherTSL/.test(xml)
        ? `${trustedListFile} is the EU List of Trusted Lists: it only points to the national lists. ` +
            "Give the national Trusted List of the TSA with --trusted-list (Sectigo: https://tsl.digital.gob.es/TSL.xml) " +
            "and this file with --lotl."
        : `${trustedListFile} lists no trust service: it is not an ETSI TS 119 612 Trusted List.`,
    );
  }
  const list = signedList(xml, trustedListFile);
  reportListHeader("Trusted List", raw, list);
  trustedListAnchored = reportListAnchoring(listText(list.signedXml, "SchemeTerritory"), list);
  const services = trustedListServices(list.signedXml);
  if (services.length === 0) fail(`${trustedListFile} lists no trust service in its signed content`);
  return (trustedListCache = services);
}

function reportTrustedList(section, genTime, chainDers) {
  if (!trustedListFile) {
    note(section, "Qualified trust service", "NOT CHECKED (use --trusted-list)");
    return;
  }
  const chainFingerprints = new Set(chainDers.map((der) => hex(der)));
  const service = trustedList().find((candidate) =>
    candidate.fingerprints.some((fingerprint) => chainFingerprints.has(fingerprint)),
  );
  if (!service) {
    note(section, "Qualified trust service", "NO (TSA not found in the Trusted List)");
    return;
  }
  const atGeneration = service.history.filter((entry) => entry.start <= genTime).pop();
  const qualified =
    uriTail(atGeneration?.type) === "QTST" && uriTail(atGeneration?.status) === "granted";
  note(section, "Qualified trust service", qualified ? "YES" : "NO");
  note(section, "Trusted List service", service.name);
  note(
    section,
    "Trusted List service type",
    uriTail(atGeneration?.type) === "QTST" ? "Qualified time stamp (QTST)" : uriTail(atGeneration?.type) || "unknown",
  );
  note(
    section,
    "Trusted List status at generation time",
    atGeneration ? uriTail(atGeneration.status).toUpperCase() : "NO STATUS BEFORE THAT DATE",
  );
  note(
    section,
    "Trusted List signature",
    trustedListAnchored
      ? "VALID, signer authorized by the EU List of Trusted Lists"
      : "VALID, signer not anchored (use --lotl)",
  );
}

/** Detailed check of the RFC 3161 token embedded in one CMS seal. */
function reportTimestamp(label, structure) {
  const section = `Timestamp ${label}`;
  if (!structure.timestampToken) {
    note(section, "RFC3161 token", "NOT PRESENT");
    return;
  }
  const token = structure.timestampToken;
  const info = timestampInfo(token);
  if (!info.algorithm) fail(`${label}: unsupported timestamp hash algorithm`);
  withTempDir((dir) => {
    writeFileSync(join(dir, "token.der"), token);
    const result = spawnSync(
      "openssl",
      ["cms", "-verify", "-noverify", "-inform", "DER", "-in", join(dir, "token.der"), "-out", "/dev/null"],
      { encoding: "utf8" },
    );
    if (result.status !== 0) fail(`${label}: RFC 3161 token signature is invalid`);
  });
  note(section, "RFC3161 token", "VALID (TSA signature)");
  const expected = createHash(info.algorithm).update(structure.signatureValue).digest();
  if (!expected.equals(info.hashed)) {
    fail(`${label}: RFC 3161 timestamp does not cover this signature`);
  }
  note(section, "Message imprint", "MATCH (signature value)");
  note(section, "Hash algorithm", info.algorithm.toUpperCase().replace("SHA", "SHA-"));

  const exchange = timestampExchanges.get(hex(structure.signatureValue));
  if (exchange) {
    const nonce = requestNonce(Buffer.from(exchange.requestBase64, "base64"));
    if (nonce !== info.nonce) fail(`${label}: timestamp nonce differs from the archived request`);
    note(section, "Nonce", `MATCH (${nonce})`);
    if (!responseToken(Buffer.from(exchange.responseBase64, "base64")).equals(token)) {
      fail(`${label}: archived TSA response differs from the embedded token`);
    }
    note(section, "Archived response (.tsr)", `token identical, from ${exchange.tsaUrl}`);
  } else {
    note(section, "Nonce", info.nonce ? `${info.nonce} (request not archived here)` : "ABSENT");
  }
  note(section, "Generation time", info.time.toISOString().replace(".000Z", "Z"));
  note(section, "Policy OID", info.policy);
  note(section, "Serial number", info.serial);

  const certificates = info.certificates.map(certificateDetails);
  const signer = certificates.find((certificate) => /Time Stamping/i.test(certificate.eku));
  if (!signer) {
    note(section, "TSA signer", "certificate not included in the token");
    return;
  }
  note(section, "TSA signer", signer.subject);
  note(section, "TSA certificate", `SHA-256 ${signer.fingerprint}`);
  if (!signer.ekuCritical) fail(`${label}: TSA certificate timeStamping usage is not critical`);
  note(section, "TSA EKU", "timeStamping (critical)");
  if (info.time < signer.notBefore || info.time > signer.notAfter) {
    fail(`${label}: TSA certificate was not valid at generation time`);
  }
  note(section, "TSA certificate validity at genTime", "VALID");

  // Trust anchors: the one given with --tsa-ca, or else the certificates the
  // Trusted List publishes for its services, which is how eIDAS designates the
  // anchors of a qualified TSA.
  const fromTrustedList = !tsaCaFile && Boolean(trustedListFile);
  const anchorDers = tsaCaFile
    ? pemCertificates(tsaCaFile)
    : fromTrustedList
      ? trustedList().flatMap((service) => service.certificates)
      : [];
  let anchor = null;
  if (anchorDers.length === 0) {
    note(section, "TSA intermediate chain", "NOT CHECKED (use --trusted-list or --tsa-ca)");
  } else {
    withTempDir((dir) => {
      writeFileSync(join(dir, "anchors.pem"), anchorDers.map(pemOf).join(""));
      writeFileSync(join(dir, "signer.pem"), pemOf(signer.der));
      writeFileSync(
        join(dir, "untrusted.pem"),
        certificates.filter((certificate) => certificate !== signer).map((certificate) => pemOf(certificate.der)).join("") || pemOf(signer.der),
      );
      const result = spawnSync(
        "openssl",
        [
          "verify", "-attime", String(Math.floor(info.time.getTime() / 1000)),
          "-purpose", "timestampsign",
          ...(fromTrustedList ? ["-partial_chain"] : []),
          "-CAfile", join(dir, "anchors.pem"),
          "-untrusted", join(dir, "untrusted.pem"), join(dir, "signer.pem"),
        ],
        { encoding: "utf8" },
      );
      if (result.status !== 0) {
        fail(`${label}: TSA certificate chain rejected (${(result.stdout + result.stderr).trim()})`);
      }
    });
    // The anchor that ends the chain: an anchor that is itself in the token
    // chain, or else the anchor that issued its last certificate.
    const tokenFingerprints = new Set(certificates.map((certificate) => hex(certificate.der)));
    const tokenX509 = certificates.map((certificate) => new X509Certificate(certificate.der));
    const issued = (der) => {
      try {
        const candidate = new X509Certificate(der);
        return tokenX509.some((certificate) => certificate.checkIssued(candidate));
      } catch {
        return false;
      }
    };
    const anchorDer =
      anchorDers.find((der) => tokenFingerprints.has(hex(der))) || anchorDers.find(issued);
    anchor = anchorDer ? certificateDetails(anchorDer) : null;
    note(section, "TSA intermediate chain", "VALID at generation time");
    note(
      section,
      "TSA trust anchor",
      `${anchor?.subject || "unknown"}${fromTrustedList ? " (from the Trusted List)" : ""}`,
    );
    note(section, "TSA trust anchor fingerprint", `SHA-256 ${anchor?.fingerprint || "unknown"}`);
  }
  reportTrustedList(
    section,
    info.time,
    [...info.certificates, ...(anchor ? [anchor.der] : [])],
  );
}

/**
 * Signer certificate chain and RFC 3161 timestamp of a CMS that already
 * verified. A timestamp that does not cover the signature, or that its TSA
 * trust anchor rejects, makes the evidence invalid.
 */
function inspectCms(cms, label, caFile) {
  let structure;
  try {
    structure = cmsStructure(cms);
  } catch {
    note("CMS", `${label} structure`, "unreadable by the report, signature itself VALID");
    return;
  }
  const certificates = structure.certificates.map(certificateDetails);
  if (certificates[0]) {
    note("CMS", `${label} certificate`, `SHA-256 ${certificates[0].fingerprint}`);
    note("CMS", `${label} chain`, certificates.map((certificate) => commonName(certificate.subject)).join(" > "));
  }
  if (caFile) {
    const anchors = new Set(pemCertificates(caFile).map(hex));
    const anchored = certificates.some((certificate) => anchors.has(hex(certificate.der)));
    note(
      "CMS",
      `${label} trust`,
      anchored ? "VALID, ends at the trust anchor" : "VALID against the trust anchor",
    );
  } else {
    note("CMS", `${label} trust`, "NOT CHECKED (use --ca)");
  }
  reportTimestamp(label, structure);
}

/**
 * Names the certificate that sealed a CMS rejected against the trust anchor,
 * typically a record sealed before the platform PKI was replaced.
 */
function cmsSignerHint(cmsPath, caFile) {
  if (!caFile) return "";
  try {
    const signer = certificateDetails(cmsStructure(readFileSync(cmsPath)).certificates[0]);
    const selfSigned = signer.subject === signer.issuer;
    return (
      `\nSealed by: ${signer.subject} (SHA-256 ${signer.fingerprint})` +
      (selfSigned ? ", a self-signed certificate" : `, issued by ${signer.issuer}`) +
      `\nThis certificate does not chain to ${caFile}. If it was the platform seal ` +
      "certificate when the record was made, add it to the --ca file."
    );
  } catch {
    return "";
  }
}

function verifyCms(content, cmsBase64, label, caFile) {
  const dir = mkdtempSync(join(tmpdir(), "privcloud-evidence-"));
  try {
    const contentPath = join(dir, "content.bin");
    const cmsPath = join(dir, "signature.der");
    writeFileSync(contentPath, content);
    writeFileSync(cmsPath, Buffer.from(cmsBase64, "base64"));
    const result = spawnSync(
      "openssl",
      [
        "cms",
        "-verify",
        "-binary",
        "-inform",
        "DER",
        "-content",
        contentPath,
        ...(caFile ? ["-CAfile", caFile, "-purpose", "any"] : ["-noverify"]),
        "-out",
        "/dev/null",
        "-in",
        cmsPath,
      ],
      { encoding: "utf8" },
    );
    if (result.status !== 0) {
      fail(`${label}: invalid CMS signature (${result.stderr.trim()})${cmsSignerHint(cmsPath, caFile)}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  note("CMS", `${label} signature`, "VALID");
  inspectCms(Buffer.from(cmsBase64, "base64"), label, caFile);
}

function exactDerObject(buffer, label) {
  if (buffer.length < 2 || buffer[0] !== 0x30) fail(`${label}: invalid DER sequence`);
  let headerLength = 2;
  let bodyLength = buffer[1];
  if ((bodyLength & 0x80) !== 0) {
    const lengthBytes = bodyLength & 0x7f;
    if (lengthBytes === 0 || lengthBytes > 4 || buffer.length < 2 + lengthBytes) {
      fail(`${label}: invalid DER length`);
    }
    headerLength += lengthBytes;
    bodyLength = 0;
    for (let index = 0; index < lengthBytes; index += 1) {
      bodyLength = bodyLength * 256 + buffer[2 + index];
    }
  }
  const totalLength = headerLength + bodyLength;
  if (totalLength > buffer.length) fail(`${label}: truncated DER object`);
  return buffer.subarray(0, totalLength);
}

function verifyPdfSeal(pdf, caFile) {
  const source = pdf.toString("latin1");
  const byteRangePattern =
    /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g;
  const ranges = [...source.matchAll(byteRangePattern)];
  if (ranges.length === 0) fail("PDF PAdES seal: ByteRange is missing");
  const match = ranges[ranges.length - 1];
  const [start1, length1, start2, length2] = match
    .slice(1)
    .map((value) => Number(value));
  if (
    start1 !== 0 ||
    !Number.isSafeInteger(length1) ||
    !Number.isSafeInteger(start2) ||
    !Number.isSafeInteger(length2) ||
    length1 <= 0 ||
    start2 <= length1 ||
    start2 + length2 !== pdf.length
  ) fail("PDF PAdES seal: invalid or incomplete ByteRange");
  const gap = pdf.subarray(length1, start2).toString("latin1");
  const contents = gap.match(/<([0-9A-Fa-f\s]+)>/);
  if (!contents) fail("PDF PAdES seal: Contents is missing");
  const hexCms = contents[1].replace(/\s/g, "");
  if (hexCms.length % 2 !== 0) fail("PDF PAdES seal: malformed Contents");
  const cms = exactDerObject(Buffer.from(hexCms, "hex"), "PDF PAdES seal");
  const signedBytes = Buffer.concat([
    pdf.subarray(start1, start1 + length1),
    pdf.subarray(start2, start2 + length2),
  ]);
  note("CMS", "PDF ByteRange", "VALID, covers the whole file except the seal");
  verifyCms(signedBytes, cms.toString("base64"), "PDF PAdES seal", caFile);
}

async function embeddedSource(pdf) {
  const doc = await PDFDocument.load(pdf, { ignoreEncryption: true, updateMetadata: false });
  const names = doc.catalog.lookupMaybe(PDFName.of("Names"), PDFDict);
  const tree = names?.lookupMaybe(PDFName.of("EmbeddedFiles"), PDFDict);
  const pending = tree ? [tree] : [];
  while (pending.length > 0) {
    const node = pending.pop();
    const kids = node.lookupMaybe(PDFName.of("Kids"), PDFArray);
    for (let index = 0; kids && index < kids.size(); index += 1) {
      pending.push(kids.lookup(index, PDFDict));
    }
    const entries = node.lookupMaybe(PDFName.of("Names"), PDFArray);
    for (let index = 0; entries && index + 1 < entries.size(); index += 2) {
      const name = entries.lookup(index);
      if (!(name instanceof PDFString || name instanceof PDFHexString)) continue;
      if (name.decodeText() !== SOURCE_ATTACHMENT) continue;
      const stream = entries
        .lookup(index + 1, PDFDict)
        .lookup(PDFName.of("EF"), PDFDict)
        .lookup(PDFName.of("F"));
      if (!(stream instanceof PDFRawStream)) fail("embedded source is not a stream");
      return Buffer.from(decodePDFRawStream(stream).decode());
    }
  }
  return null;
}

async function verifyWebAuthn(record, signer, sourceHash, documentId, caFile) {
  const applied = signer.appliedContribution;
  const id = record.evidenceId || record.recipientId;
  const evidence = record.authentication?.webauthn;
  const transaction = record.authentication?.transaction;
  if (!evidence || !transaction?.manifest) fail("missing WebAuthn evidence");
  const manifestBytes = Buffer.from(canonical(transaction.manifest));
  const manifestHash = hex(manifestBytes);
  if (manifestHash !== transaction.manifestSha256) fail("manifest hash mismatch");
  if (transaction.manifest.documentSha256 !== sourceHash) fail("source hash mismatch");
  if (transaction.manifest.documentId !== documentId) fail("document ID mismatch");
  if (transaction.manifest.recipientId !== record.recipientId) fail("recipient mismatch");
  if (transaction.manifest.action !== "SIGN") fail("signer action is not SIGN");
  if (transaction.manifest.signerAccountId !== record.signer?.privcloudUserId) {
    fail("account binding mismatch");
  }
  const consent = transaction.manifest.consent;
  if (
    !consent ||
    hex(Buffer.from(consent.text, "utf8")) !== consent.textSha256 ||
    consent.textSha256 !== signer.consentSha256
  ) fail("consent hash mismatch");
  if (!applied) fail("applied contribution is missing");
  if (transaction.manifest.signatureType !== applied.signatureType) {
    fail("applied signature type differs from the signed one");
  }
  if (transaction.manifest.signatureDataSha256 !== applied.signatureDataSha256) {
    fail("applied signature image differs from the signed one");
  }
  if (canonical(transaction.manifest.fieldValues) !== canonical(applied.fieldValues)) {
    fail("applied field values differ from the signed ones");
  }

  const nonce = Buffer.from(transaction.nonceBase64Url, "base64url");
  if (nonce.length !== 32) fail("invalid challenge nonce");
  const challenge = createHash("sha256")
    .update(DOMAIN, "utf8")
    .update(Buffer.from([0]))
    .update(Buffer.from(manifestHash, "hex"))
    .update(nonce)
    .digest("base64url");
  if (challenge !== transaction.challengeBase64Url) fail("challenge mismatch");

  const clientDataBytes = Buffer.from(evidence.clientDataJSONBase64Url, "base64url");
  const clientData = JSON.parse(clientDataBytes.toString("utf8"));
  if (clientData.type !== "webauthn.get") fail("invalid WebAuthn ceremony type");
  if (clientData.challenge !== challenge) fail("client challenge mismatch");
  if (clientData.origin !== evidence.origin) fail("origin mismatch");
  const originHost = new URL(evidence.origin).hostname;
  if (originHost !== evidence.rpId && !originHost.endsWith(`.${evidence.rpId}`)) {
    fail("origin outside the RP ID");
  }

  const authData = Buffer.from(evidence.authenticatorDataBase64Url, "base64url");
  if (authData.length < 37) fail("truncated authenticator data");
  if (!digest(evidence.rpId).subarray(0, 32).equals(authData.subarray(0, 32))) {
    fail("RP ID hash mismatch");
  }
  if ((authData[32] & 0x01) === 0) fail("user presence flag is absent");
  if ((authData[32] & 0x04) === 0) fail("user verification flag is absent");
  const signedBytes = Buffer.concat([authData, digest(clientDataBytes)]);
  const valid = await verifySignature({
    signature: Buffer.from(evidence.signatureBase64Url, "base64url"),
    data: signedBytes,
    credentialPublicKey: Buffer.from(evidence.publicKeyCoseBase64Url, "base64url"),
  });
  if (!valid) fail("invalid WebAuthn assertion signature");

  const enrollmentBytes = Buffer.from(canonical(evidence.enrollmentRecord));
  if (evidence.enrollmentRecord.credentialId !== evidence.credentialId) {
    fail("enrollment credential mismatch");
  }
  if (
    evidence.enrollmentRecord.publicKeyCoseBase64Url !==
    evidence.publicKeyCoseBase64Url
  ) fail("enrollment public key mismatch");
  // The signed enrollment is what ties the public key to the account.
  if (
    evidence.enrollmentRecord.identity?.privcloudUserId !==
    transaction.manifest.signerAccountId
  ) fail("enrollment account mismatch");
  if (evidence.enrollmentRecord.rpId && evidence.enrollmentRecord.rpId !== evidence.rpId) {
    fail("enrollment RP ID mismatch");
  }
  verifyCms(
    enrollmentBytes,
    evidence.enrollmentSignatureCmsBase64,
    `enrollment ${id}`,
    caFile,
  );

  const algorithm = decodeCredentialPublicKey(
    Buffer.from(evidence.publicKeyCoseBase64Url, "base64url"),
  ).get(cose.COSEKEYS.alg);
  const section = `WebAuthn ${id}`;
  note(section, "Credential ID", "present");
  note(section, "Public key", `valid (${COSE_ALGORITHMS[algorithm] || algorithm})`);
  note(section, "Enrollment record", "signature valid, same key and account");
  note(section, "RP ID", `${evidence.rpId} (expected)`);
  note(section, "Origin", `${evidence.origin} (expected)`);
  note(section, "Challenge", "recomputed from the manifest, MATCH");
  note(section, "User presence", "YES");
  note(section, "User verification", "YES");
  note(section, "Signature counter", String(authData.readUInt32BE(33)));
  note(section, "Assertion signature", "VALID");
  const manifestSection = `Manifest ${id}`;
  note(manifestSection, "Document hash", "MATCH");
  note(manifestSection, "Consent hash", "MATCH");
  note(manifestSection, "Account binding", "MATCH");
  note(manifestSection, "Manifest hash", "MATCH");
  note(manifestSection, "Recipient and document", "MATCH");
  note(manifestSection, "Applied contribution", "MATCH");
}

function verifyAudit(events) {
  let previous = null;
  for (const event of events) {
    if (event.previousEventHash !== previous) fail("broken audit-chain link");
    const canonicalEvent = JSON.stringify({
      protocol: AUDIT_PROTOCOL,
      id: event.id,
      documentId: event.documentId,
      eventType: event.type,
      actor: event.actor,
      ipAddress: event.ipAddress || null,
      userAgent: event.userAgent || null,
      metadata: event.metadata,
      createdAt: event.createdAt,
      previousEventHash: event.previousEventHash,
    });
    if (hex(canonicalEvent) !== event.eventHash) fail("invalid audit event hash");
    previous = event.eventHash;
  }
}

function readEnvelope(path, envelopeFormat, payloadFormat, caFile, label) {
  const envelope = JSON.parse(readFileSync(path, "utf8"));
  if (envelope.format !== envelopeFormat) fail(`${label}: unknown envelope format`);
  const bytes = Buffer.from(envelope.payloadCanonicalBase64, "base64");
  const payload = JSON.parse(bytes.toString("utf8"));
  if (canonical(payload) !== bytes.toString("utf8")) fail(`${label}: payload is not canonical`);
  if (payload.format !== payloadFormat) fail(`${label}: unknown payload format`);
  for (const exchange of envelope.timestampExchanges || []) {
    timestampExchanges.set(exchange.messageImprint, exchange);
  }
  verifyCms(bytes, envelope.platformSignatureCmsBase64, label, caFile);
  return { bytes, payload };
}

function takeOption(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return null;
  const value = args.splice(index, 2)[1];
  if (!value || value.startsWith("--")) fail(`${name} requires a path`);
  if (args.includes(name)) fail(`${name} is given more than once`);
  return value;
}

async function main() {
  const args = process.argv.slice(2);
  const caFile = takeOption(args, "--ca");
  const sourceFile = takeOption(args, "--source");
  const forensicFile = takeOption(args, "--forensic");
  tsaCaFile = takeOption(args, "--tsa-ca");
  trustedListFile = takeOption(args, "--trusted-list");
  lotlFile = takeOption(args, "--lotl");
  if (lotlFile && !trustedListFile) fail("--lotl requires --trusted-list");
  const verboseIndex = args.indexOf("--verbose");
  verbose = verboseIndex >= 0;
  if (verbose) args.splice(verboseIndex, 1);
  const [attestationPath, documentPath] = args;
  if (!attestationPath || !documentPath) {
    console.error(
      "Usage: npm run verify:evidence -- <attestation.json> <signed.pdf> [--forensic forensic.json] [--source source.pdf] [--ca root.pem] [--tsa-ca tsa-root.pem] [--trusted-list tl.xml] [--lotl eu-lotl.xml] [--verbose]",
    );
    process.exit(2);
  }

  if (caFile) {
    const anchors = pemCertificates(caFile).map(certificateDetails);
    if (anchors.length === 0) fail(`${caFile} holds no PEM certificate`);
    anchors.forEach((anchor, index) => {
      const suffix = anchors.length > 1 ? ` ${index + 1}` : "";
      note("CMS", `Trust anchor${suffix}`, anchor.subject);
      note("CMS", `Trust anchor${suffix} fingerprint`, `SHA-256 ${anchor.fingerprint}`);
    });
  }

  // 1. Attestation shared with every party.
  const { payload } = readEnvelope(
    attestationPath,
    ATTESTATION_ENVELOPE,
    ATTESTATION_FORMAT,
    caFile,
    "attestation",
  );
  const documentBytes = readFileSync(documentPath);
  if (hex(documentBytes) !== payload.document.finalSha256) {
    fail("final document hash mismatch");
  }
  note("Attestation", "Canonicalization", "VALID");
  note("Attestation", "Final PDF hash", `${payload.document.finalSha256} MATCH`);
  verifyPdfSeal(documentBytes, caFile);
  let previous = null;
  for (const event of payload.auditTrail) {
    if (event.previousEventHash !== previous) fail("broken audit-chain link");
    previous = event.eventHash;
  }
  note("Attestation", "Audit chain links", `${payload.auditTrail.length} events, VALID`);
  const tsaCheck = payload.tsaTrustedListCheck;
  note(
    "Attestation",
    "TSA Trusted List check",
    tsaCheck
      ? `${tsaCheck.result} on ${tsaCheck.checkedAt} (list ${tsaCheck.sequenceNumber || "?"}, SHA-256 ${tsaCheck.listSha256 || "?"})`
      : "none recorded",
  );
  if (trustedListFile && tsaCheck?.listSha256) {
    note(
      "Trusted List",
      "Same list as the platform check",
      hex(readFileSync(trustedListFile)) === tsaCheck.listSha256
        ? "YES"
        : "NO (another version of the list, both may be valid)",
    );
  }
  const pendingSigners = payload.signers.filter(
    (item) => item.role === "SIGNER" && item.status !== "SIGNED",
  );
  if (pendingSigners.length > 0) {
    fail(`${pendingSigners.length} signer(s) did not sign the final document`);
  }
  const signedSigners = payload.signers.filter(
    (item) => item.role === "SIGNER" && item.status === "SIGNED",
  );
  const reinforced = payload.document.signatureLevel === "REINFORCED";
  if (reinforced) {
    if (signedSigners.length === 0) fail("reinforced evidence has no signer");
    for (const signer of signedSigners) {
      if (signer.authenticationMethod !== "WEBAUTHN" || !signer.transactionBound) {
        fail(`signer ${signer.evidenceId || signer.recipientId} is not backed by a bound WebAuthn transaction`);
      }
      if (!signer.forensicRecordSha256) {
        fail(`signer ${signer.evidenceId || signer.recipientId} has no forensic record hash`);
      }
    }
  }

  const source = sourceFile
    ? readFileSync(sourceFile)
    : await embeddedSource(documentBytes);
  const sourceHash = source ? hex(source) : null;
  const expectedSourceHashes = new Set(
    reinforced
      ? signedSigners.map((signer) => signer.documentSha256)
      : payload.document.encryptedEndToEnd
        ? []
        : [payload.document.sourceSha256].filter(Boolean),
  );
  if (expectedSourceHashes.size > 1) fail("signers approved different source documents");
  if (sourceHash && expectedSourceHashes.size > 0 && !expectedSourceHashes.has(sourceHash)) {
    fail("source document does not match the hash approved by the signers");
  }
  note(
    "Attestation",
    "Signers",
    `${signedSigners.length}/${payload.signers.filter((item) => item.role === "SIGNER").length} signed`,
  );
  note(
    "Attestation",
    "Approved source document",
    !sourceHash
      ? "NOT PROVIDED"
      : expectedSourceHashes.size > 0
        ? `${sourceHash} MATCH`
        : `${sourceHash} (bound through the sealed PDF only)`,
  );

  // 2. Forensic dossier kept by PrivCloud, when it is disclosed.
  let forensicChecked = false;
  if (forensicFile) {
    const forensic = readEnvelope(
      forensicFile,
      FORENSIC_ENVELOPE,
      FORENSIC_FORMAT,
      caFile,
      "forensic dossier",
    );
    if (hex(forensic.bytes) !== payload.forensicEvidenceSha256) {
      fail("forensic dossier does not match the attestation");
    }
    note("Forensic", "Canonicalization", "VALID");
    note("Forensic", "Attestation hash", "MATCH");
    if (canonical(forensic.payload.document) !== canonical(payload.document)) {
      fail("forensic dossier describes another document");
    }
    const bySigner = new Map(
      forensic.payload.signers.map((item) => [item.recipientId, item]),
    );
    for (const signer of payload.signers) {
      if (!signer.forensicRecordSha256) continue;
      const item = bySigner.get(signer.recipientId);
      if (!item?.forensicRecord) fail(`forensic record missing for ${signer.evidenceId}`);
      const recordHash = hex(Buffer.from(canonical(item.forensicRecord)));
      if (
        recordHash !== item.forensicRecordSha256 ||
        recordHash !== signer.forensicRecordSha256
      ) fail(`forensic record of ${signer.evidenceId} does not match its hash`);
      if (item.forensicRecord.evidenceId !== signer.evidenceId) {
        fail(`forensic record of ${signer.evidenceId} carries another identifier`);
      }
      const authentication = item.forensicRecord.authentication || {};
      if (
        authentication.documentSha256 !== signer.documentSha256 ||
        authentication.intentSha256 !== signer.intentSha256
      ) fail(`forensic record of ${signer.evidenceId} differs from the attestation`);
      if (canonical(item.appliedContribution) !== canonical(signer.appliedContribution)) {
        fail(`applied contribution of ${signer.evidenceId} differs from the attestation`);
      }
      note("Forensic", `Record ${signer.evidenceId}`, "hash MATCH");
      note(
        "Forensic",
        `Network evidence ${signer.evidenceId}`,
        item.forensicRecord.network?.ipAddress ? "present" : "absent",
      );
      note(
        "Forensic",
        `Raw WebAuthn assertion ${signer.evidenceId}`,
        authentication.webauthn?.signatureBase64Url ? "present" : "not applicable",
      );
    }
    if (reinforced) {
      for (const signer of signedSigners) {
        const item = bySigner.get(signer.recipientId);
        await verifyWebAuthn(
          item.forensicRecord,
          signer,
          payload.document.sourceSha256,
          payload.document.id,
          caFile,
        );
      }
    }
    const forensicEvents = forensic.payload.auditTrail;
    if (
      canonical(forensicEvents.map((event) => event.eventHash)) !==
      canonical(payload.auditTrail.map((event) => event.eventHash))
    ) fail("forensic audit trail differs from the attestation");
    verifyAudit(forensicEvents.map((event) => ({ ...event, documentId: payload.document.id })));
    note("Forensic", "Audit chain", `${forensicEvents.length} events recomputed, VALID`);
    forensicChecked = true;
  }

  console.log("PrivCloud evidence: VALID");
  console.log(`Document SHA-256: ${payload.document.finalSha256}`);
  console.log(`Profile: ${payload.document.signatureLevel}`);
  for (const signer of signedSigners) {
    console.log(
      `  ${signer.name} (${signer.evidenceId || signer.recipientId}): ${
        forensicChecked && reinforced
          ? "WebAuthn assertion, account binding, source and contribution VALID"
          : "attested by PrivCloud"
      }`,
    );
  }
  console.log(
    !sourceHash
      ? "Source document: not provided (embedded copy absent, use --source to check it)"
      : expectedSourceHashes.size > 0
        ? `Source document SHA-256: ${sourceHash} (matches the signed manifests)`
        : `Source document SHA-256: ${sourceHash} (E2E standard profile, bound through the sealed PDF only)`,
  );
  console.log(
    forensicChecked
      ? "Forensic dossier: VALID and bound to the attestation"
      : "Forensic dossier: not provided, WebAuthn assertions not re-verified (use --forensic)",
  );
  if (payload.document.encryptedEndToEnd) {
    console.log(
      "Note: end-to-end encrypted request, the pages were rendered in the requester's browser. The approved content is the embedded source checked above against every signed manifest.",
    );
  }
  console.log(caFile
    ? `CMS signatures and certificate chain: VALID against ${caFile}`
    : "CMS signatures: mathematically valid (rerun with --ca to validate certificate trust)");
  if (verbose) printReport();
}

main().catch((error) => {
  // Everything checked before the failure helps locating it.
  if (verbose) printReport();
  console.error(`PrivCloud evidence: INVALID\n${error.message}`);
  process.exit(1);
});
