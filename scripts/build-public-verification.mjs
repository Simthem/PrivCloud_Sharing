import { readFile, mkdir, rm, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import path from "node:path"
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const require = createRequire(path.join(root, "frontend/package.json"))
const { zipSync } = require("fflate")
const source = path.join(root, "verification/contractor"),
  output = path.join(root, "frontend/public/verification/contractor")
const files = [
  "README.md",
  "FORMAT.md",
  "RESULTS.md",
  "results.json",
  "extended-results.json",
  "corpus.mjs",
  "real-corpus.mjs",
  "corpus-results.json",
  "candidate-scale.mjs",
  "candidate-scale-results.json",
  "decision-evaluation.mjs",
  "decision-evaluation-results.json",
  "photo-results.json",
  "visible-copy-mark.ts",
  "forensic-decision.ts",
  "fragment-copy-mark.ts",
  "fragment-benchmark.mjs",
  "fragment-results.json",
  "preproduction-results.json",
  "test/fragment.test.mjs",
  "visible-mark-benchmark.mjs",
  "visible-mark-results.json",
  "multiscale-copy-mark.ts",
  "multiscale-benchmark.mjs",
  "multiscale-results.json",
  "test/multiscale.test.mjs",
  "test/visible-mark.test.mjs",
  "ocr-recreation.mjs",
  "ocr-results.json",
  "register-photo.py",
  "requirements-photo.txt",
  "watermark.ts",
  "verifier.py",
  "benchmark.mjs",
  "screenshot.mjs",
  "screenshot-preflight.mjs",
  "chrome-protocol-pipe.cjs",
  "read-only.mjs",
  "package.json",
  "package-lock.json",
  "test/evidence.test.mjs",
  "test/elapsed-notice.mjs",
  "test/execution.test.mjs",
  "test/fixture.mjs",
  "test/watermark.test.mjs",
  "test/read-only.test.mjs",
  "test/attribution.test.mjs",
  "test/chrome-protocol.test.mjs",
  "test/photo-registration.py",
  "test/ocr.test.mjs",
  "test/legacy-journal.test.mjs",
].sort()
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex")
const deployed = await readFile(
  path.join(root, "frontend/src/utils/forensicMark.util.ts"),
)
if (!deployed.equals(await readFile(path.join(source, "watermark.ts"))))
  throw new Error("Watermark snapshot differs from the deployed source")
if (
  !(
    await readFile(
      path.join(root, "backend/src/teamExternal/evidence-verifier.py"),
    )
  ).equals(await readFile(path.join(source, "verifier.py")))
)
  throw new Error("Evidence verifier snapshot differs from the deployed source")
const report = JSON.parse(
  await readFile(path.join(source, "results.json"), "utf8"),
)
const reports = {}
for (const file of [
  "results.json",
  "extended-results.json",
  "corpus-results.json",
  "candidate-scale-results.json",
  "decision-evaluation-results.json",
  "ocr-results.json",
]) {
  const measured = JSON.parse(await readFile(path.join(source, file), "utf8"))
  if (measured.algorithmSha256 !== hash(deployed))
    throw new Error(`${file} does not identify the deployed watermark`)
  reports[file] = measured
}
const photo = JSON.parse(
  await readFile(path.join(source, "photo-results.json"), "utf8"),
)
const ocr = reports["ocr-results.json"]
if (
  ocr.harnessSha256 !==
    hash(await readFile(path.join(source, "ocr-recreation.mjs"))) ||
  ocr.multiscaleAlgorithmSha256 !==
    hash(await readFile(path.join(source, "multiscale-copy-mark.ts")))
)
  throw new Error("OCR report does not identify the measured harness")
if (
  photo.algorithmSha256 !== hash(deployed) ||
  photo.registrationSha256 !==
    hash(await readFile(path.join(source, "register-photo.py")))
)
  throw new Error("Photo report does not identify the deployed sources")
const visibleMarker = JSON.parse(
  await readFile(path.join(source, "visible-mark-results.json"), "utf8"),
)
if (
  visibleMarker.markerSha256 !==
    hash(await readFile(path.join(source, "visible-copy-mark.ts"))) ||
  visibleMarker.harnessSha256 !==
    hash(await readFile(path.join(source, "visible-mark-benchmark.mjs"))) ||
  (await readFile(path.join(source, "visible-copy-mark.ts"), "utf8")) !==
    (
      await readFile(
        path.join(root, "frontend/src/utils/visibleCopyMark.util.ts"),
        "utf8",
      )
    ).replace('"./forensicMark.util"', '"./watermark.ts"') ||
  (await readFile(path.join(source, "forensic-decision.ts"), "utf8")) !==
    (
      await readFile(
        path.join(root, "frontend/src/utils/forensicDecision.util.ts"),
        "utf8",
      )
    ).replace('"./forensicMark.util"', '"./watermark.ts"')
)
  throw new Error(
    "Visible marker reports or snapshots differ from the application",
  )
const matrix = (measured) => ({
  generatedAt: measured.generatedAt,
  caseCount: measured.cases.length,
  negativeControls: {
    trials: measured.cases.filter((c) => c.negativeControl).length,
    falseMatches: measured.cases.filter(
      (c) => c.negativeControl && c.matched !== null,
    ).length,
  },
  transformations: [
    ...new Set(
      measured.cases
        .filter((c) => !c.negativeControl)
        .map((c) => c.transformation),
    ),
  ].map((name) => {
    const cases = measured.cases.filter((c) => c.transformation === name)
    return {
      name,
      correct: cases.filter((c) => c.detected).length,
      total: cases.length,
      ambiguous: cases.filter((c) => c.status === "ambiguous_multiple_sources")
        .length,
      safeAbstentions: cases.filter((c) => c.safeDecision).length,
    }
  }),
})
const multiscale = JSON.parse(
  await readFile(path.join(source, "multiscale-results.json"), "utf8"),
)
const multiscaleSnapshot = await readFile(
  path.join(source, "multiscale-copy-mark.ts"),
)
if (
  multiscale.algorithmSha256 !== hash(multiscaleSnapshot) ||
  multiscale.watermarkSha256 !== hash(deployed) ||
  multiscale.harnessSha256 !==
    hash(await readFile(path.join(source, "multiscale-benchmark.mjs"))) ||
  multiscale.fixtureSha256 !==
    hash(await readFile(path.join(source, "benchmark.mjs"))) ||
  multiscaleSnapshot.toString() !==
    (
      await readFile(
        path.join(root, "frontend/src/utils/robustCopyMark.util.ts"),
        "utf8",
      )
    ).replace('"./forensicMark.util"', '"./watermark.ts"')
)
  throw new Error("Multiscale report or snapshot differs from the application")
const corpus = reports["corpus-results.json"]
const fragment = JSON.parse(await readFile(path.join(source, "fragment-results.json"), "utf8"))
const fragmentSnapshot = await readFile(path.join(source, "fragment-copy-mark.ts"))
if (
  fragment.algorithmSha256 !== hash(fragmentSnapshot) ||
  fragment.watermarkSha256 !== hash(deployed) ||
  fragment.harnessSha256 !== hash(await readFile(path.join(source, "fragment-benchmark.mjs"))) ||
  fragmentSnapshot.toString() !== (await readFile(path.join(root, "frontend/src/utils/fragmentCopyMark.util.ts"), "utf8")).replace('"./forensicMark.util"', '"./watermark.ts"')
) throw new Error("Fragment report or snapshot differs from the application")
const preproduction = JSON.parse(await readFile(path.join(source, "preproduction-results.json"), "utf8"))
for (const [field, name] of Object.entries({
  fragmentSha256: "frontend/src/utils/fragmentCopyMark.util.ts",
  registrationCoreSha256: "frontend/src/utils/photoRegistrationCore.util.ts",
  registrationBuilderSha256: "frontend/scripts/build-photo-registration.mjs",
})) if (preproduction[field] !== hash(await readFile(path.join(root, name))))
  throw new Error("Preproduction report differs from the measured sources")
const candidateScale = reports["candidate-scale-results.json"]
const summary = {
  format: "privcloud-public-verification-summary-v1",
  algorithmSha256: hash(deployed),
  fragments: { decisionThreshold: fragment.decisionThreshold, compatibilityThreshold: fragment.compatibilityThreshold, fixedScales: fragment.fixedScales, candidateCount: fragment.candidateCount, negativeControls: fragment.negativeControls, cases: fragment.cases.length },
  preproduction,
  baseline: matrix(report),
  extended: matrix(reports["extended-results.json"]),
  corpus: {
    generatedAt: corpus.generatedAt,
    trials: corpus.trials,
    falseMatches: corpus.falseMatches,
    candidateCount: corpus.candidateCount,
    zeroFailureOneSided95Upper: corpus.zeroFailureOneSided95Upper,
  },
  candidateScale: {
    generatedAt: candidateScale.generatedAt,
    cases: candidateScale.cases.map((c) => ({
      count: c.count,
      control: c.control,
      width: c.width,
      height: c.height,
      correct: c.correct,
    })),
    maxPatternBytes: Math.max(
      ...candidateScale.cases.map((c) => c.patternBytes),
    ),
  },
  decisionEvaluation: {
    generatedAt: reports["decision-evaluation-results.json"].generatedAt,
    groups: reports["decision-evaluation-results.json"].groups,
    caseCount: reports["decision-evaluation-results.json"].cases.length,
    correct: reports["decision-evaluation-results.json"].cases.filter(
      (c) => c.correct,
    ).length,
    safe: reports["decision-evaluation-results.json"].cases.filter(
      (c) => c.safeDecision,
    ).length,
  },
  photos: {
    measuredAt: photo.measuredAt,
    total: photo.cases.length,
    rawMatches: photo.cases.filter((c) => c.rawStatus === "match").length,
    referenceAssistedMatches: photo.cases.filter((c) => c.correctLaboratoryCopy)
      .length,
    preproduction: photo.preproductionCase,
  },
  visibleMarker: {
    generatedAt: visibleMarker.generatedAt,
    algorithm: visibleMarker.algorithm,
    controls: visibleMarker.cases.length,
    correct: visibleMarker.cases.filter((c) => c.correct).length,
    physicalPhotoTested: Boolean(visibleMarker.physicalPhotoCase),
    physicalPhoto: {
      markerRecovered: visibleMarker.physicalPhotoCase.markerRecovered,
      matchesWithoutExpectedCandidate:
        visibleMarker.physicalPhotoCase.matchesWithoutExpectedCandidate,
    },
  },
  multiscale: {
    generatedAt: multiscale.generatedAt,
    algorithm: multiscale.algorithm,
    cases: multiscale.cases.length,
    positiveTrials: multiscale.cases.filter((item) => item.expected !== null)
      .length,
    recovered: multiscale.cases.filter(
      (item) => item.expected !== null && item.correct,
    ).length,
    negativeTrials: multiscale.negatives.length,
    falseMatches: multiscale.falseMatches,
    reductions: [1000, 800, 640, 480, 320].map((width) => {
      const cases = multiscale.cases.filter(
        (item) => item.name === `resize-to-${width}-no-visible-code`,
      )
      return {
        width,
        total: cases.length,
        correct: cases.filter((item) => item.correct).length,
      }
    }),
    zoom: {
      total: multiscale.cases.filter(
        (item) => item.name === "zoom-3.4-central-capture-no-visible-code",
      ).length,
      correct: multiscale.cases.filter(
        (item) =>
          item.name === "zoom-3.4-central-capture-no-visible-code" &&
          item.correct,
      ).length,
    },
    physicalPhoto: {
      topScore: multiscale.physicalPhotoCase.topScore,
      runnerUpScore: multiscale.physicalPhotoCase.runnerUpScore,
      visibleCodePresent: multiscale.physicalPhotoCase.visibleCodePresent,
      registrationUsed: multiscale.physicalPhotoCase.registrationUsed,
      correctLaboratoryCopy: multiscale.physicalPhotoCase.correctLaboratoryCopy,
      matchesWithoutExpectedCandidate:
        multiscale.physicalPhotoCase.matchesWithoutExpectedCandidate,
      matchesWithWrongTeamKey:
        multiscale.physicalPhotoCase.matchesWithWrongTeamKey,
    },
  },
  ocr: {
    generatedAt: ocr.generatedAt,
    total: ocr.cases.length,
    recovered: ocr.cases.filter((c) => c.matched !== null).length,
    safeAbstentions: ocr.cases.filter((c) => c.safeDecision).length,
    engine: ocr.tools.tesseract,
  },
}
// This directory is generated and publicly served. Recreate it so an obsolete
// or accidentally copied file cannot survive outside the explicit allowlist.
await rm(output, { recursive: true, force: true })
await mkdir(output, { recursive: true })
const archive = {},
  checksums = []
for (const file of [...files, "LICENSE"]) {
  const bytes = await readFile(
    file === "LICENSE" ? path.join(root, "LICENSE") : path.join(source, file),
  )
  const target = path.join(output, file)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, bytes)
  archive[file] = [bytes, { mtime: new Date("2026-10-09T00:00:00Z") }]
  checksums.push(`${hash(bytes)}  ${file}`)
}
const summaryBytes = Buffer.from(JSON.stringify(summary) + "\n")
await writeFile(path.join(output, "summary.json"), summaryBytes)
archive["summary.json"] = [
  summaryBytes,
  { mtime: new Date("2026-10-09T00:00:00Z") },
]
checksums.push(`${hash(summaryBytes)}  summary.json`)
const zip = zipSync(archive, { level: 9 })
await writeFile(path.join(output, "verification.zip"), zip)
checksums.push(`${hash(zip)}  verification.zip`)
await writeFile(
  path.join(output, "checksums.sha256"),
  checksums.join("\n") + "\n",
)
const transformations = [
  ...new Set(
    report.cases.filter((c) => !c.negativeControl).map((c) => c.transformation),
  ),
]
const escape = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  )
const labels = {
  "screenshot-100-percent": "Capture Chrome à 100 %",
  "crop-20-percent-area-offset-0":
    "Recadrage : 20 % de surface retirée (coin 1)",
  "crop-20-percent-area-offset-1":
    "Recadrage : 20 % de surface retirée (coin 2)",
  "crop-50-percent-area-offset-0":
    "Recadrage : 50 % de surface retirée (coin 1)",
  "crop-50-percent-area-offset-1":
    "Recadrage : 50 % de surface retirée (coin 2)",
  "jpeg-q90": "JPEG Q90",
  "jpeg-q60": "JPEG Q60",
  "resize-1920-to-800": "Redimensionnement 1920 vers 800 pixels",
  "rotation-2-degrees": "Rotation de 2°",
  "contrast-plus-30-percent-clipped": "Contraste +30 % avec écrêtage",
  "background-whitening-and-dark-threshold":
    "Blanchiment du fond et seuil sur les pixels sombres",
  "pixel-recreation-from-source":
    "Recréation des pixels depuis la source (sans OCR)",
}
const rows = transformations
  .map((name) => {
    const cases = report.cases.filter((c) => c.transformation === name)
    return `<tr><td>${escape(labels[name] || name)}</td><td>${cases.filter((c) => c.detected).length}/${cases.length}</td></tr>`
  })
  .join("\n")
await writeFile(
  path.join(output, "index.html"),
  `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Vérification publique des copies PrivCloud</title><meta name="description" content="Format de preuve, vérificateur hors ligne et tests destructifs reproductibles des copies en consultation seule."><link rel="stylesheet" href="/verification/contractor/style.css"></head>
<body><main><a href="/">PrivCloud</a><h1>Vérification publique des copies</h1>
<p><a href="/blog/verifier-preuves-partage-fichiers">Comprendre les preuves et les résultats dans notre article</a></p>
<p>Spécification, outils hors ligne et tests reproductibles pour vérifier l'intégrité des preuves et mesurer la détection du watermark des copies en consultation seule.</p>
<p><a class="download" href="/verification/contractor/verification.zip" download>Télécharger les outils et tests</a> <a href="/verification/contractor/checksums.sha256">Empreintes SHA-256</a></p>
<p><a href="/verification/contractor/FORMAT.md">Format de preuve</a> · <a href="/verification/contractor/README.md">Instructions et limites</a> · <a href="/verification/contractor/RESULTS.md">Détail des mesures</a> · <a href="/verification/contractor/results.json">Résultats JSON</a> · <a href="/verification/contractor/verifier.py" download>Vérificateur Python</a></p>
<h2>Trois verdicts, pas une certification générale</h2>
<ul><li><code>VALID</code> : les contrôles demandés passent dans leur périmètre.</li><li><code>INVALID</code> : au moins un contrôle révèle une incohérence.</li><li><code>INDETERMINATE</code> : une preuve indépendante requise manque. Ce résultat n'est ni une validation complète ni une falsification détectée.</li></ul>
<p>Utilisez <code>--strict --json</code>. Les codes de sortie sont 0 pour les contrôles réussis, 1 pour une preuve invalide, 2 pour une entrée illisible ou malformée et 3 pour une vérification stricte indéterminée. Le mode non strict peut sortir avec 0 tout en signalant des preuves manquantes.</p>
<h2>Résultats mesurés du watermark</h2><p>Trois pages synthétiques de 1920 × 1440 pixels, huit copies candidates. Les chiffres indiquent le nombre de détections correctes dans cet échantillon. Ils ne garantissent pas la résistance à toutes les images. La capture a réellement été prise dans Chrome.</p>
<div class="table"><table><thead><tr><th>Transformation</th><th>Détection correcte</th></tr></thead><tbody>${rows}<tr><td>Photos de laboratoire (mesure distincte)</td><td>${summary.photos.rawMatches}/${summary.photos.total} directement, ${summary.photos.referenceAssistedMatches}/${summary.photos.total} avec la référence</td></tr><tr><td>Capture puis OCR et recréation</td><td>${summary.ocr.recovered}/${summary.ocr.total} récupérations après OCR, ${summary.ocr.safeAbstentions}/${summary.ocr.total} abstentions sûres</td></tr></tbody></table></div>
<p>La rotation de 2° est reconnue sur les trois pages après recalage. Le blanchiment supprime le marquage de la page à fond blanc, mais celui des deux autres fonds survit. La recréation depuis la source efface le marquage. Six contrôles négatifs, dont les mauvaises clés, n'ont donné aucune correspondance. Cet échantillon ne calibre pas une probabilité d'attribution. Consultez aussi les rapports du corpus négatif, des transformations étendues et des recherches à 100 et 1 000 candidats.</p>
<ul><li><a href="/verification/contractor/extended-results.json">Matrice étendue</a> : ${summary.extended.caseCount} cas synthétiques. Les échecs de réduction extrême et de binarisation restent publiés. Les six mélanges sont ambigus, sans copie unique désignée.</li><li><a href="/verification/contractor/corpus-results.json">Corpus négatif distinct</a> : ${summary.corpus.falseMatches} correspondance sur ${summary.corpus.trials} essais synthétiques avec ${summary.corpus.candidateCount} candidats. Ce n'est pas un taux de faux positifs de production.</li><li><a href="/verification/contractor/candidate-scale-results.json">Recherche à 100 et 1 000 candidats</a> : ${summary.candidateScale.cases.filter((c) => c.correct).length}/${summary.candidateScale.cases.length} contrôles conformes. Pas une calibration statistique ni une garantie de performance mobile.</li><li><a href="/verification/contractor/decision-evaluation-results.json">Évaluation à 8, 100 et 1 000 candidats</a> : ${summary.decisionEvaluation.correct}/${summary.decisionEvaluation.caseCount} détections attendues, ${summary.decisionEvaluation.safe}/${summary.decisionEvaluation.caseCount} décisions sans attribution trompeuse dans ces essais. Trois moyennes restent indéterminées.</li></ul>
<p>Suivi du 14 octobre : une nouvelle photo privée de préproduction passe dans Chrome après recalage local sur le PDF exact, score 17,53 contre 4,44. Deux fragments auparavant inconclusifs passent à 17,99 et 12,86 avec un seuil renforcé à 10. Sans le bon candidat ou avec une autre clé, aucune attribution n'est retenue dans les trois essais. Un candidat réel et sept candidats synthétiques ne constituent pas un registre complet ni une validation indépendante. <a href="/verification/contractor/preproduction-results.json">Agrégats privés</a> et <a href="/verification/contractor/fragment-results.json">banc séparé de 100 négatifs</a>. Les cas historiques et limites OCR restent conservés.</p>
<p><a href="/verification/contractor/photo-results.json">Deux photos réelles d’écran</a> sont reconnues après recalage hors ligne avec la page originale non marquée, mais pas directement. Ces images de développement ne constituent pas une validation indépendante. Toutes les hypothèses sont combinées et plusieurs motifs plausibles interdisent une attribution unique. Voir les instructions et limites dans le README.</p>
<p>Une autre photo de préproduction à texte dense reste inconclusive, brute et après recalage. Cette limite est conservée dans le rapport photo. Les nouvelles pages marquées utilisent le PNG sans perte, sans promesse de réparer les anciennes copies.</p>
<p><a href="/verification/contractor/visible-mark-results.json">Repère visible supplémentaire</a> : sept contrôles synthétiques et une photo réelle de développement reconnue directement. Le verdict distingue ce code du motif invisible, car un code authentique peut être transplanté.</p>
<p><a href="/verification/contractor/multiscale-results.json">Motif grossier réparti sur toute la page</a> : une photo réelle de développement sans code visible est reconnue sans recalage, score ${summary.multiscale.physicalPhoto.topScore.toFixed(2)}, contre ${summary.multiscale.physicalPhoto.runnerUpScore.toFixed(2)} pour le second candidat. Retirer la copie attendue ou changer la clé produit une abstention. Le décodeur révisé passe ${summary.multiscale.recovered}/${summary.multiscale.positiveTrials} cas positifs synthétiques, dont les recadrages JPEG Q20, les réductions jusqu'à 320 pixels et le zoom ×3,4. Aucun des ${summary.multiscale.negativeTrials} contrôles négatifs synthétiques ne désigne une copie. La même photo de développement passe à neuf tailles, avec abstention sans le candidat attendu ou avec une autre clé. Un cas historique distinct, signalé le 13 octobre, reste inconclusif et n'a pas été vérifié localement sans son motif dérivé exact, malgré un zoom géométrique autour de ×3,2 à ×3,5. Ce nouveau canal ne répare pas les anciennes copies et la borne statistique du corpus v1 ne s'applique pas au système combiné. Les photos sont des essais de développement, pas une validation indépendante.</p>
<p><a href="/verification/contractor/ocr-results.json">Six passages OCR réels, trois en v1 et trois en v1 + v2,</a> récupèrent 330 mots par capture avec Tesseract, puis reconstruisent de nouveaux pixels. Aucun motif invisible ne subsiste. Une reconstruction depuis la source non marquée ne porte aucune information spécifique au destinataire. Ces abstentions ne sont pas des récupérations réussies.</p>
<h2>Intégrité, horodatage et compromission</h2><p>Les tests génèrent de vraies signatures ES256 et réponses RFC 3161 avec une autorité locale de test. Ils rejettent les modifications du fichier d'origine, du manifeste, de la signature, des événements, les journaux réécrits ou tronqués et les horodatages invalides. Cette autorité locale ne constitue pas une preuve d'heure indépendante ni une autorité qualifiée.</p>
<p>La lecture des journaux reconnaît les empreintes historiques sans réécriture des événements. Un retour à l'ancien format après la transition est refusé. Un maillon historique masquant le contenu d'une autre copie reste indéterminé en mode strict.</p>
<p>Pour vérifier une preuve réelle, choisissez la racine de confiance de l'autorité indépendamment et conservez le checkpoint hors du serveur avant une compromission. Un checkpoint reçu après coup ne prouve pas l'état antérieur. La chaîne garantit la continuité des maillons fournis, pas l'exhaustivité de tous les événements possibles.</p>
<p>L'horodatage de l'émission ne couvre pas automatiquement les événements ultérieurs. Le scellement horaire peut laisser une fin de journal non ancrée. Un checkpoint présent dans le même ZIP n'établit pas sa conservation indépendante. Un nouveau scellement protège l'état actuel, sans certifier rétroactivement les dates déclarées des événements.</p>
<p>Une racine TSA reconnue ne suffit pas à établir l'identité physique, le statut qualifié historique ou l'absence de révocation. Le vérificateur ne délivre pas de certification juridique.</p>
<h2>Consultation seule</h2><p>Un test HTTPS autonome vérifie les refus d'accès à l'original, aux clés et aux copies révoquées, expirées ou d'un autre prestataire. Il se lance avec deux sessions de test distinctes et des ressources préparées. Les tests locaux de cet outil ne constituent pas un audit réussi du site de production.</p>
<p>Une page affichée peut être capturée ou photographiée. Le watermark permet de rechercher une copie compatible. Il ne prouve pas qui a diffusé le document, et l'absence de marquage n'exclut pas cette origine.</p>
<p class="small">Mesures : ${escape(report.generatedAt)}. Algorithme SHA-256 : <code>${escape(report.algorithmSha256)}</code>. Aucun document personnel, secret de production ou clé d'équipe réelle n'est inclus.</p>
</main></body></html>`,
)
await writeFile(
  path.join(output, "style.css"),
  `body{margin:0;background:#f6f8fb;color:#172235;font:17px/1.65 system-ui,sans-serif}main{max-width:1000px;margin:auto;padding:32px 20px 64px}h1,h2{line-height:1.25}h2{margin-top:40px}a{color:#134aa1}a:focus-visible{outline:3px solid #172235;outline-offset:3px}.download{display:inline-block;padding:10px 16px;background:#134aa1;color:white;border-radius:6px}.table{overflow:auto}table{width:100%;border-collapse:collapse;background:white}th,td{padding:10px 14px;border:1px solid #d6dce5;text-align:left}.small{font-size:14px}code{overflow-wrap:anywhere}`,
)
console.log(
  "Public verification assets built, with exact source snapshots and checksums.",
)
