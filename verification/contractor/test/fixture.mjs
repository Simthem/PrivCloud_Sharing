import { createHash, generateKeyPairSync, sign, randomBytes } from "node:crypto";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
export const sha = value => createHash("sha256").update(value).digest("hex");
export function canonical(value) {
  if(Array.isArray(value))return "["+value.map(canonical).join(",")+"]";
  if(value && typeof value==="object")return "{"+Object.keys(value).sort((a,b)=>a.localeCompare(b)).map(k=>JSON.stringify(k)+":"+canonical(value[k])).join(",")+"}";
  return JSON.stringify(value);
}
const digest=value=>sha(canonical(value));
const b64=value=>Buffer.from(value).toString("base64url");
const cborInteger=n=>{const m=n<0?1:0,v=n<0?-1-n:n;return v<24?Buffer.from([(m<<5)|v]):v<256?Buffer.from([(m<<5)|24,v]):Buffer.from([(m<<5)|25,v>>8,v&255]);};
const cborBytes=b=>Buffer.concat([Buffer.from([0x58,b.length]),b]);
export function rechaining(evidence, legacyCount = 0) {
  let previous="0".repeat(64);
  evidence.journal.links=evidence.journal.events.map(event=>{
    const {seq,prevHash,hash,...content}=event;
    const contentHash=digest({protocol:evidence.journal.protocol,teamId:evidence.journal.teamId,...content});
    const next=seq <= legacyCount
      ? digest({protocol:evidence.journal.protocol,teamId:evidence.journal.teamId,...content,seq,prevHash:previous})
      : digest({protocol:evidence.journal.protocol,seq,prevHash:previous,contentHash});
    event.prevHash=previous; event.hash=next;
    const link={seq,prevHash:previous,contentHash,hash:next,...(seq <= legacyCount ? {hashFormat:"legacy-flat-v1"} : {})};previous=next;return link;
  });
}

export function makeFixture(directory, { legacyCount = 0 } = {}) {
  const run=(...args)=>execFileSync("openssl",args,{cwd:directory,stdio:"pipe",timeout:20000});
  run("req","-x509","-newkey","rsa:2048","-nodes","-days","2","-subj","/CN=Public test CA - never production","-addext","basicConstraints=critical,CA:TRUE","-addext","keyUsage=critical,keyCertSign,cRLSign","-keyout","ca.key","-out","ca.pem");
  run("req","-new","-newkey","ec","-pkeyopt","ec_paramgen_curve:P-256","-nodes","-subj","/CN=Public local test TSA","-keyout","tsa.key","-out","tsa.csr");
  writeFileSync(join(directory,"tsa.ext"),"basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=critical,timeStamping\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\n");
  run("x509","-req","-in","tsa.csr","-CA","ca.pem","-CAkey","ca.key","-set_serial","2","-days","2","-extfile","tsa.ext","-out","tsa.pem");
  run("req","-x509","-newkey","ec","-pkeyopt","ec_paramgen_curve:P-256","-nodes","-days","2","-subj","/CN=Unrelated public test CA","-keyout","unrelated-ca.key","-out","unrelated-ca.pem");
  writeFileSync(join(directory,"serial"),"01\n");
  writeFileSync(join(directory,"tsa.cnf"),`[tsa]\ndefault_tsa=tsa_config1\n[tsa_config1]\nserial=${directory}/serial\ncrypto_device=builtin\nsigner_cert=${directory}/tsa.pem\ncerts=${directory}/ca.pem\nsigner_key=${directory}/tsa.key\nsigner_digest=sha256\ndefault_policy=1.2.3.4.1\ndigests=sha256\naccuracy=secs:1\nordering=yes\ntsa_name=yes\ness_cert_id_chain=no\ness_cert_id_alg=sha256\n`);
  const timestamp=hash=>{
    run("ts","-query","-digest",hash,"-sha256","-cert","-out","request.tsq");
    run("ts","-reply","-config","tsa.cnf","-queryfile","request.tsq","-out","response.tsr");
    return readFileSync(join(directory,"response.tsr")).toString("base64");
  };
  const original=Buffer.from("Public synthetic original document. No production data.\n");
  writeFileSync(join(directory,"original.txt"),original);
  const now=new Date(Date.now()-60000).toISOString();
  const manifest={protocol:"privcloud-contractor-issuance-v1",nonce:b64(randomBytes(32)),issuedAt:now,team:{id:"public-team",name:"Public test"},issuer:{userId:"public-issuer",email:"issuer@example.test"},contractor:{seatId:"public-seat",email:"contractor@example.test",name:null},accessExpiresAt:new Date(Date.now()+86400000).toISOString(),copy:{previewId:"public-copy",sourceFileId:"public-source",sourceSha256:sha(original),markId:"0123456789abcdef0123456789abcdef",pageCount:1,pages:[{plainSha256:sha("synthetic page"),cipherSha256:sha("synthetic encrypted page"),width:1920,height:1440}]}};
  const manifestText=canonical(manifest),manifestHash=sha(manifestText);
  const {privateKey,publicKey}=generateKeyPairSync("ec",{namedCurve:"P-256"});
  const jwk=publicKey.export({format:"jwk"});
  const cose=Buffer.concat([Buffer.from([0xa5]),...[[1,2],[3,-7],[-1,1],[-2,Buffer.from(jwk.x,"base64url")],[-3,Buffer.from(jwk.y,"base64url")]].flatMap(([k,v])=>[cborInteger(k),Buffer.isBuffer(v)?cborBytes(v):cborInteger(v)])]);
  const client=Buffer.from(JSON.stringify({type:"webauthn.get",challenge:b64(Buffer.from(manifestHash,"hex")),origin:"https://proof.example.test",crossOrigin:false}));
  const auth=Buffer.concat([Buffer.from(sha("proof.example.test"),"hex"),Buffer.from([5,0,0,0,1])]);
  const webauthn={credentialId:b64(randomBytes(16)),publicKeyCoseBase64Url:b64(cose),algorithm:-7,authenticatorDataBase64Url:b64(auth),clientDataJSONBase64Url:b64(client),signatureBase64Url:b64(sign("sha256",Buffer.concat([auth,Buffer.from(sha(client),"hex")]),privateKey)),userHandleBase64Url:null};
  const recordHash=digest({protocol:manifest.protocol,manifest:manifestText,credentialId:webauthn.credentialId,credentialPublicKey:webauthn.publicKeyCoseBase64Url,credentialAlgorithm:webauthn.algorithm,authenticatorData:webauthn.authenticatorDataBase64Url,clientDataJSON:webauthn.clientDataJSONBase64Url,signature:webauthn.signatureBase64Url});
  const evidence={format:"privcloud-contractor-issuance-evidence-v1",generatedAt:now,issuance:{id:"public-issuance",manifest:manifestText,manifestHash,webauthn,recordHash,rfc3161TimeStampRespBase64:timestamp(recordHash)},journal:{protocol:"privcloud-contractor-journal-v1",teamId:manifest.team.id,chainValidAtGeneration:true,events:["ISSUED","OPENED","PAGE"].map((kind,i)=>({seq:i+1,at:now,kind,previewId:manifest.copy.previewId,seatId:manifest.contractor.seatId,actorEmail:kind==="ISSUED"?manifest.issuer.email:manifest.contractor.email,pageIndex:kind==="PAGE"?0:null,prevHash:"",hash:""})),links:[],anchors:[]}};
  evidence.issuance.rfc3161TimeStampReqBase64=readFileSync(join(directory,"request.tsq")).toString("base64");
  rechaining(evidence, legacyCount);
  const anchor={seq:3,hash:evidence.journal.links.at(-1).hash,rfc3161TimeStampRespBase64:timestamp(evidence.journal.links.at(-1).hash)};
  anchor.rfc3161TimeStampReqBase64=readFileSync(join(directory,"request.tsq")).toString("base64");
  evidence.journal.anchors=[anchor];
  const checkpoint={format:"privcloud-contractor-checkpoint-v1",issuance:{recordHash,rfc3161TimeStampRespBase64:evidence.issuance.rfc3161TimeStampRespBase64},journal:{teamId:manifest.team.id,...anchor}};
  writeFileSync(join(directory,"checkpoint.json"),JSON.stringify(checkpoint));
  return {evidence,checkpoint};
}
