import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { makeFixture, rechaining } from "./fixture.mjs";
const directory=mkdtempSync(join(tmpdir(),"privcloud-public-proof-"));
let fixture;
before(()=>{fixture=makeFixture(directory);});
after(()=>rmSync(directory,{recursive:true,force:true}));
const verifier=fileURLToPath(new URL("../verifier.py",import.meta.url));
function verify(edit=()=>{},args=[],env={}) {
  const evidence=structuredClone(fixture.evidence); edit(evidence);
  writeFileSync(join(directory,"preuve.json"),JSON.stringify(evidence));
  return spawnSync("python3",["-I",verifier,join(directory,"preuve.json"),"--strict","--ca",join(directory,"ca.pem"),"--expected-origin","https://proof.example.test","--rp-id","proof.example.test","--original",join(directory,"original.txt"),"--checkpoint",join(directory,"checkpoint.json"),...args],{encoding:"utf8",timeout:30000,env:{...process.env,...env}});
}
test("real ES256 signature and RFC3161 issuance and checkpoint verify offline",()=>{
  const result=verify();assert.equal(result.status,0,result.stdout+result.stderr);
  assert.match(result.stdout,/tout est vérifié/);
});
for(const [name,edit] of [
 ["modified signed manifest",e=>{const m=JSON.parse(e.issuance.manifest);m.contractor.email="other@example.test";e.issuance.manifest=JSON.stringify(m);} ],
 ["modified WebAuthn signature",e=>{e.issuance.webauthn.signatureBase64Url="AAAA";}],
 ["modified event",e=>{e.journal.events[2].pageIndex=9;}],
 ["rewritten and rehashed entire chain",e=>{e.journal.events[0].actorEmail="attacker@example.test";rechaining(e);e.journal.anchors[0].hash=e.journal.links.at(-1).hash;}],
 ["truncated and locally resealed journal",e=>{e.journal.events.pop();rechaining(e);e.journal.anchors=[];}],
 ["removed timestamps",e=>{e.issuance.rfc3161TimeStampRespBase64=null;e.journal.anchors=[];}],
 ["duplicate chain sequence",e=>{e.journal.links.push(e.journal.links[1]);}],
 ["swapped timestamp imprint",e=>{e.journal.anchors[0].rfc3161TimeStampRespBase64=e.issuance.rfc3161TimeStampRespBase64;}],
 ["swapped TSA request",e=>{e.issuance.rfc3161TimeStampReqBase64=e.journal.anchors[0].rfc3161TimeStampReqBase64;}],
])test("rejects "+name,()=>{const result=verify(edit);assert.equal(result.status,name === "removed timestamps" ? 3 : 1,result.stdout+result.stderr);});
test("a byte-modified original is rejected",()=>{
  const changed=join(directory,"changed.txt");writeFileSync(changed,"a compromised replacement");
  const result=verify(()=>{},["--original",changed]);assert.equal(result.status,1,result.stdout);
});
test("an untrusted self-issued TSA is rejected even with a valid token signature",()=>{
  const result=verify(()=>{},["--ca",join(directory,"unrelated-ca.pem")]);assert.equal(result.status,1,result.stdout+result.stderr);
});
test("explicit TSA root cannot fall back to default trust files or directories",()=>{
  const rehash=spawnSync("openssl",["rehash",directory],{encoding:"utf8",timeout:20000});
  assert.equal(rehash.status,0,rehash.stderr);
  const result=verify(()=>{},["--ca",join(directory,"unrelated-ca.pem")],{
    SSL_CERT_FILE:join(directory,"ca.pem"),SSL_CERT_DIR:directory,
  });
  assert.equal(result.status,1,result.stdout+result.stderr);
});
test("an independently chosen WebAuthn origin is enforced",()=>{
  const result=verify(()=>{},["--expected-origin","https://different.example.test"]);assert.equal(result.status,1,result.stdout);
});
test("an independently chosen RP ID is enforced",()=>{
  const result=verify(()=>{},["--rp-id","different.example.test"]);
  assert.equal(result.status,1,result.stdout);
  assert.match(result.stdout,/autre site/);
});
for (const [flags, reason] of [[4,"sans vérification"],[1,"sans vérification"],[0x15,"BS sans BE"]]) {
  test(`authenticator flags ${flags} fail closed`,()=>{
    const result=verify(e=>{
      const auth=Buffer.from(e.issuance.webauthn.authenticatorDataBase64Url,"base64url");
      auth[32]=flags;
      e.issuance.webauthn.authenticatorDataBase64Url=auth.toString("base64url");
    });
    assert.equal(result.status,1,result.stdout);
    assert.ok(result.stdout.includes(reason),result.stdout);
  });
}
for (const [name, edit] of [
  ["origin",c=>{c.origin="https://other.example.test";}],
  ["cross origin",c=>{c.crossOrigin=true;}],
  ["challenge replay",c=>{c.challenge=Buffer.alloc(32,9).toString("base64url");}],
  ["ceremony type",c=>{c.type="webauthn.create";}],
]) test(`rejects substituted client data: ${name}`,()=>{
  const result=verify(e=>{
    const client=JSON.parse(Buffer.from(e.issuance.webauthn.clientDataJSONBase64Url,"base64url"));
    edit(client);
    e.issuance.webauthn.clientDataJSONBase64Url=Buffer.from(JSON.stringify(client)).toString("base64url");
  });
  assert.equal(result.status,1,result.stdout);
});
for (const [name, edit] of [
  ["team",m=>{m.team.id="other-team";}],
  ["issuer",m=>{m.issuer.userId="other-issuer";}],
  ["seat",m=>{m.contractor.seatId="other-seat";}],
  ["expiry",m=>{m.accessExpiresAt="2030-01-01T00:00:00.000Z";}],
  ["copy",m=>{m.copy.previewId="other-copy";}],
  ["source",m=>{m.copy.sourceFileId="other-source";}],
  ["mark",m=>{m.copy.markId="f".repeat(32);}],
  ["page pixels",m=>{m.copy.pages[0].plainSha256="f".repeat(64);}],
  ["page ciphertext",m=>{m.copy.pages[0].cipherSha256="f".repeat(64);}],
  ["page dimensions",m=>{m.copy.pages[0].width++;}],
]) test(`signed manifest binds ${name}`,()=>{
  const result=verify(e=>{const manifest=JSON.parse(e.issuance.manifest);edit(manifest);e.issuance.manifest=JSON.stringify(manifest);});
  assert.equal(result.status,1,result.stdout);
  assert.match(result.stdout,/manifeste a été modifié/);
});
test("malformed authenticator data fails closed",()=>{
  const result=verify(e=>{e.issuance.webauthn.authenticatorDataBase64Url="AA";});assert.notEqual(result.status,0,result.stdout);
});
test("strict mode rejects missing independently supplied verification inputs",()=>{
  writeFileSync(join(directory,"preuve.json"),JSON.stringify(fixture.evidence));
  const result=spawnSync("python3",["-I",verifier,join(directory,"preuve.json"),"--strict"],{encoding:"utf8",timeout:30000});
  assert.equal(result.status,3,result.stdout+result.stderr);
  assert.match(result.stdout,/exige --expected-origin/);
  assert.match(result.stdout,/exige --checkpoint/);
});
test("non-strict mode visibly warns about every missing independent input",()=>{
  writeFileSync(join(directory,"preuve.json"),JSON.stringify(fixture.evidence));
  const result=spawnSync("python3",["-I",verifier,join(directory,"preuve.json")],{encoding:"utf8",timeout:30000});
  assert.equal(result.status,0,result.stdout+result.stderr);
  assert.match(result.stdout,/exige --expected-origin/);
  assert.match(result.stdout,/exige --original/);
  assert.match(result.stdout,/exige --checkpoint/);
  assert.doesNotMatch(result.stdout,/RÉSULTAT : tout est vérifié/);
});

test("JSON reports distinguish invalid, valid and indeterminate evidence",()=>{
  const valid=verify(()=>{},["--json"]);
  assert.equal(JSON.parse(valid.stdout).status,"VALID");
  assert.equal(JSON.parse(valid.stdout).qualifiedTimestamp,"NOT_CHECKED");
  const invalid=verify(e=>{e.issuance.webauthn.signatureBase64Url="AAAA";},["--json"]);
  assert.equal(JSON.parse(invalid.stdout).status,"INVALID");
  const unknown=verify(e=>{e.issuance.rfc3161TimeStampRespBase64=null;e.journal.anchors=[];},["--json"]);
  assert.equal(unknown.status,3);
  assert.equal(JSON.parse(unknown.stdout).status,"INDETERMINATE");
});
test("ambiguous JSON with duplicate keys is rejected",()=>{
  const serialized=JSON.stringify(fixture.evidence);
  writeFileSync(join(directory,"preuve.json"),'{"format":"ambiguous",'+serialized.slice(1));
  const result=spawnSync("python3",["-I",verifier,join(directory,"preuve.json")],{encoding:"utf8",timeout:30000});
  assert.equal(result.status,2,result.stdout+result.stderr);
  assert.match(result.stdout,/clé JSON dupliquée/);
});
test("untrusted evidence text cannot inject terminal control sequences",()=>{
  const result=verify(e=>{const m=JSON.parse(e.issuance.manifest);m.team.name="unsafe\u001b[2J\u202Espoof";e.issuance.manifest=JSON.stringify(m);});
  assert.equal(result.status,1,result.stdout+result.stderr);
  assert.ok(!result.stdout.includes("\u001b"),result.stdout);
  assert.ok(!result.stdout.includes("\u202E"),result.stdout);
});
