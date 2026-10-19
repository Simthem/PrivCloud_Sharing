#!/usr/bin/env python3
"""Vérifie un dossier de preuve PrivCloud, sans PrivCloud.

Utilisation, dans le dossier extrait du ZIP :

    python3 verifier.py
    python3 verifier.py --original fichier-d-origine.pdf
    python3 verifier.py --ca racine-autorite.pem

Le script lit preuve.json, refait chaque contrôle et affiche OK, ATTENTION ou
ÉCHEC avec sa raison. Il n'a besoin que de Python 3.8 ou plus et de la
commande openssl. Il ne contacte aucun serveur et ne modifie aucun fichier.

Code de sortie : 0 sans aucun ÉCHEC, 1 sinon, 2 si le dossier est illisible.
--strict refuse aussi les contrôles incomplets. --checkpoint compare une
preuve à un checkpoint conservé indépendamment avant une compromission.
"""

import argparse
import base64
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import contextlib
import io
import sys
import tempfile
import unicodedata
import zipfile
from datetime import datetime, timezone
from urllib.parse import urlparse

FORMAT = "privcloud-contractor-issuance-evidence-v1"

# Un dossier de preuve pèse quelques mégaoctets : au-delà, ce n'en est pas un, et
# rien n'est chargé en mémoire.
TAILLE_MAX_PREUVE = 64 * 1024 * 1024
TAILLE_MAX_ARCHIVE = 128 * 1024 * 1024
TAILLE_MAX_JETON = 4 * 1024 * 1024
TAILLE_MAX_COSE = 16 * 1024
DELAI_OPENSSL = 20


def texte_terminal(valeur):
    """Neutralise les contrôles ANSI et Unicode dans les données affichées."""
    return "".join(
        caractere
        if unicodedata.category(caractere) not in ("Cc", "Cf")
        else "�"
        for caractere in str(valeur)
    )


class Rapport:
    courant = None

    def __init__(self):
        Rapport.courant = self
        self.controles = []
        self.echecs = 0
        self.alertes = 0
        self.racine_expliquee = False

    def titre(self, texte):
        print()
        print(texte_terminal(texte))
        print("-" * len(texte))

    def ok(self, texte):
        self.controles.append({"status": "VALID", "message": texte_terminal(texte)})
        print("  [OK]        " + texte_terminal(texte))

    def echec(self, texte):
        self.controles.append({"status": "INVALID", "message": texte_terminal(texte)})
        self.echecs += 1
        print("  [ÉCHEC]     " + texte_terminal(texte))

    def attention(self, texte):
        self.controles.append({"status": "INDETERMINATE", "message": texte_terminal(texte)})
        self.alertes += 1
        print("  [ATTENTION] " + texte_terminal(texte))

    def info(self, texte):
        print("              " + texte_terminal(texte))


# ---------------------------------------------------------------------------
# Outils
# ---------------------------------------------------------------------------


def sha256_hex(donnees):
    return hashlib.sha256(donnees).hexdigest()


def b64url_decode(texte, taille_max=TAILLE_MAX_PREUVE):
    if not isinstance(texte, str) or not texte or not re.fullmatch(r"[A-Za-z0-9_-]+", texte):
        raise ValueError("base64url invalide")
    if len(texte) > ((taille_max + 2) // 3) * 4:
        raise ValueError("valeur base64url trop volumineuse")
    return base64.b64decode(
        texte + "=" * (-len(texte) % 4), altchars=b"-_", validate=True
    )


def b64url_encode(donnees):
    return base64.urlsafe_b64encode(donnees).decode().rstrip("=")


def cle_de_tri(cle):
    # Même ordre que le serveur pour ces clés : alphabétique sans tenir
    # compte de la casse, la minuscule d'abord à égalité.
    return (cle.lower(), cle.swapcase())


def json_canonique(valeur):
    """JSON déterministe : clés triées, aucun espace. C'est ce texte qui est
    haché, donc deux calculs du même contenu donnent la même empreinte."""
    if isinstance(valeur, dict):
        return (
            "{"
            + ",".join(
                json.dumps(cle, ensure_ascii=False) + ":" + json_canonique(valeur[cle])
                for cle in sorted(valeur, key=cle_de_tri)
            )
            + "}"
        )
    if isinstance(valeur, list):
        return "[" + ",".join(json_canonique(element) for element in valeur) + "]"
    return json.dumps(valeur, ensure_ascii=False)


def empreinte_json(valeur):
    return sha256_hex(json_canonique(valeur).encode("utf-8"))


def json_strict(valeur):
    """Parse du JSON UTF-8 sans doublons, NaN ni Infinity.

    Ces formes sont rejetées pour éviter que deux outils interprètent une même
    preuve différemment.
    """
    if isinstance(valeur, bytes):
        valeur = valeur.decode("utf-8")

    def objet(paires):
        resultat = {}
        for cle, contenu in paires:
            if cle in resultat:
                raise ValueError("clé JSON dupliquée : " + cle)
            resultat[cle] = contenu
        return resultat

    def constante(texte):
        raise ValueError("constante JSON non standard : " + texte)

    return json.loads(valeur, object_pairs_hook=objet, parse_constant=constante)


def date_lisible(valeur):
    if isinstance(valeur, str):
        valeur = datetime.fromisoformat(valeur.replace("Z", "+00:00"))
    return valeur.astimezone().strftime("%d/%m/%Y %H:%M:%S %Z")


def openssl(*arguments, entree=None):
    try:
        with tempfile.TemporaryDirectory() as vide:
            environnement = os.environ.copy()
            if "-CAfile" in arguments:
                # An explicit trust file must not acquire additional roots from
                # the machine's default certificate directory/store.
                environnement["SSL_CERT_FILE"] = arguments[arguments.index("-CAfile") + 1]
                environnement["SSL_CERT_DIR"] = vide
            resultat = subprocess.run(
                ["openssl", *arguments],
                input=entree,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                timeout=DELAI_OPENSSL,
                env=environnement,
            )
        return resultat.returncode, resultat.stdout.decode("utf-8", "replace")
    except subprocess.TimeoutExpired:
        return 124, "openssl a dépassé le délai de %d secondes" % DELAI_OPENSSL


# ---------------------------------------------------------------------------
# Clé publique de la passkey
# ---------------------------------------------------------------------------


def cbor(donnees, position=0):
    """Décodeur CBOR minimal, juste ce qu'il faut pour une clé COSE."""
    if position >= len(donnees):
        raise ValueError("CBOR tronqué")
    octet = donnees[position]
    majeur, info = octet >> 5, octet & 0x1F
    position += 1
    if info < 24:
        argument = info
    elif info in (24, 25, 26, 27):
        taille = 1 << (info - 24)
        if position + taille > len(donnees):
            raise ValueError("CBOR tronqué")
        argument = int.from_bytes(donnees[position : position + taille], "big")
        position += taille
    else:
        raise ValueError("CBOR non pris en charge")
    if majeur == 0:
        return argument, position
    if majeur == 1:
        return -1 - argument, position
    if majeur in (2, 3):
        if position + argument > len(donnees):
            raise ValueError("CBOR tronqué")
        brut = donnees[position : position + argument]
        return (bytes(brut) if majeur == 2 else brut.decode()), position + argument
    if majeur == 5:
        table = {}
        for _ in range(argument):
            cle, position = cbor(donnees, position)
            if cle in table:
                raise ValueError("clé CBOR dupliquée")
            table[cle], position = cbor(donnees, position)
        return table, position
    raise ValueError("CBOR non pris en charge")


def der(etiquette, contenu):
    taille = len(contenu)
    if taille < 0x80:
        longueur = bytes([taille])
    else:
        octets = taille.to_bytes((taille.bit_length() + 7) // 8, "big")
        longueur = bytes([0x80 | len(octets)]) + octets
    return bytes([etiquette]) + longueur + contenu


def der_entier(valeur):
    if valeur[0] & 0x80:
        valeur = b"\x00" + valeur
    return der(0x02, valeur)


def cle_publique_pem(cose):
    """Convertit la clé COSE de la passkey au format PEM lu par openssl."""
    if len(cose) > TAILLE_MAX_COSE:
        raise ValueError("clé COSE trop volumineuse")
    cle, position = cbor(cose)
    if position != len(cose):
        raise ValueError("données après la clé COSE")
    if cle.get(1) == 2 and cle.get(-1) == 1 and cle.get(3) == -7:
        # Courbe P-256 (algorithme -7, ES256).
        algorithme = der(
            0x30,
            der(0x06, bytes.fromhex("2a8648ce3d0201"))
            + der(0x06, bytes.fromhex("2a8648ce3d030107")),
        )
        point = b"\x04" + cle[-2] + cle[-3]
    elif cle.get(1) == 3 and cle.get(3) == -257:
        # RSA (algorithme -257, RS256).
        algorithme = der(0x30, der(0x06, bytes.fromhex("2a864886f70d010101")) + b"\x05\x00")
        point = der(0x30, der_entier(cle[-1]) + der_entier(cle[-2]))
    else:
        raise ValueError("type de clé ou algorithme COSE non pris en charge")
    spki = der(0x30, algorithme + der(0x03, b"\x00" + point))
    corps = base64.encodebytes(spki).decode()
    return cle.get(3), "-----BEGIN PUBLIC KEY-----\n" + corps + "-----END PUBLIC KEY-----\n"


# ---------------------------------------------------------------------------
# Jetons d'horodatage RFC 3161
# ---------------------------------------------------------------------------

MOIS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split()


def verifier_jeton(rapport, dossier, jeton_b64, empreinte, racine, requete_b64=None):
    """Contrôle un jeton et renvoie sa date, ou None s'il n'est pas valable.

    1. Le jeton porte bien sur l'empreinte attendue et sa signature est celle
       du certificat de l'autorité qu'il contient.
    2. Ce certificat remonte à une racine de confiance : celle du système, ou
       celle donnée avec --ca.
    """
    # Un sous-dossier neuf par jeton, aux noms de fichiers fixes : rien de ce
    # que contient le dossier de preuve ne sert à nommer un fichier.
    travail = tempfile.mkdtemp(dir=dossier)
    chemin = os.path.join(travail, "reponse.tsr")
    with open(chemin, "wb") as fichier:
        if not isinstance(jeton_b64, str) or len(jeton_b64) > ((TAILLE_MAX_JETON + 2) // 3) * 4:
            raise ValueError("jeton d'horodatage trop volumineux")
        fichier.write(base64.b64decode(jeton_b64, validate=True))
    _, texte = openssl("ts", "-reply", "-in", chemin, "-text")
    trouve = re.search(
        r"Time stamp: (\w{3}) +(\d+) (\d\d):(\d\d):(\d\d)(?:\.\d+)? (\d{4}) GMT", texte
    )
    if "Status: Granted" not in texte or not trouve:
        rapport.echec("Le jeton d'horodatage est illisible.")
        return None
    mois, jour, heure, minute, seconde, annee = trouve.groups()
    date = datetime(
        int(annee), MOIS.index(mois) + 1, int(jour),
        int(heure), int(minute), int(seconde), tzinfo=timezone.utc,
    )
    autorite = re.search(r"TSA: DirName:(.*)", texte)
    moment = str(int(date.timestamp()))

    jeton = os.path.join(travail, "jeton.der")
    certificats = os.path.join(travail, "certificats.pem")
    openssl("ts", "-reply", "-in", chemin, "-token_out", "-out", jeton)
    openssl("pkcs7", "-inform", "DER", "-in", jeton, "-print_certs", "-out", certificats)
    code, sortie = openssl(
        "ts", "-verify", "-digest", empreinte, "-token_in", "-in", jeton,
        "-CAfile", certificats, "-partial_chain", "-attime", moment,
    )
    if code != 0 or "Verification: OK" not in sortie:
        if "FAILED" in sortie:
            rapport.echec(
                "Le jeton ne correspond pas à cette empreinte, ou sa signature est fausse."
            )
        else:
            rapport.attention("openssl n'a pas pu contrôler ce jeton : " + sortie.strip()[-200:])
        return None
    rapport.ok("Jeton authentique, signé par l'autorité, sur cette empreinte exacte.")
    if requete_b64:
        if not isinstance(requete_b64, str) or len(requete_b64) > ((TAILLE_MAX_JETON + 2) // 3) * 4:
            raise ValueError("requête d'horodatage trop volumineuse")
        requete = os.path.join(travail, "requete.tsq")
        with open(requete, "wb") as fichier:
            fichier.write(base64.b64decode(requete_b64, validate=True))
        code, sortie = openssl("ts", "-verify", "-queryfile", requete,
            "-in", chemin, "-CAfile", certificats, "-partial_chain", "-attime", moment)
        if code != 0:
            rapport.echec("La requête TSA et la réponse diffèrent (nonce, empreinte ou politique).")
            return None
        rapport.ok("La réponse TSA correspond aussi à la requête historique et à son nonce.")
    else:
        rapport.info("Requête TSA historique absente : nonce de la requête non contrôlé.")
    if autorite:
        rapport.info("Autorité : " + autorite.group(1).strip())
    rapport.info("Date certifiée : " + date_lisible(date))

    options = ["-CAfile", racine] if racine else []
    code, sortie = openssl(
        "ts", "-verify", "-digest", empreinte, "-in", chemin,
        "-untrusted", certificats, "-attime", moment, *options,
    )
    if code == 0 and "Verification: OK" in sortie:
        rapport.ok("Le certificat de l'autorité remonte à une racine de confiance.")
    elif racine:
        rapport.echec("Le jeton TSA ne remonte pas à la racine explicitement approuvée.")
        return None
    elif rapport.racine_expliquee:
        rapport.attention("Racine de l'autorité inconnue de ce système, comme ci-dessus.")
    else:
        rapport.racine_expliquee = True
        rapport.attention(
            "La racine de l'autorité n'est pas connue de ce système. Le jeton reste"
            " authentique, mais il faut confirmer l'autorité elle-même."
        )
        # La racine est l'émetteur qu'aucun certificat du jeton ne représente.
        _, details = openssl(
            "pkcs7", "-inform", "DER", "-in", jeton, "-print_certs", "-text", "-noout"
        )
        blocs = details.split("Certificate:")[1:]
        sujets = [re.search(r"Subject: (.*)", bloc) for bloc in blocs]
        sujets = {trouve.group(1).strip() for trouve in sujets if trouve}
        for bloc in blocs:
            emetteur = re.search(r"Issuer: (.*)", bloc)
            if not emetteur or emetteur.group(1).strip() in sujets:
                continue
            rapport.info("Racine attendue : " + emetteur.group(1).strip())
            adresse = re.search(r"CA Issuers - URI:(\S+)", bloc)
            if adresse:
                rapport.info("Elle se télécharge ici : " + adresse.group(1))
            break
        rapport.info(
            "Comparer son empreinte avec la liste de confiance européenne (EU Trusted"
            " List), puis relancer avec : --ca FICHIER"
        )
    return date


# ---------------------------------------------------------------------------
# Lecture du dossier
# ---------------------------------------------------------------------------


def preparer_racine(fichier, dossier):
    """Accepte la racine en PEM ou telle que téléchargée (DER), et affiche son
    empreinte pour la comparer à la liste de confiance européenne."""
    if os.path.getsize(fichier) > TAILLE_MAX_JETON:
        raise ValueError("certificat racine trop volumineux")
    racine = os.path.join(dossier, "racine.pem")
    code, _ = openssl("x509", "-in", fichier, "-out", racine)
    if code != 0:
        code, _ = openssl("x509", "-inform", "DER", "-in", fichier, "-out", racine)
    if code != 0:
        raise ValueError("certificat racine illisible : " + fichier)
    _, sujet = openssl("x509", "-in", racine, "-noout", "-subject")
    _, empreinte = openssl("x509", "-in", racine, "-noout", "-fingerprint", "-sha256")
    print(texte_terminal("Racine fournie : " + sujet.strip().replace("subject=", "", 1)))
    print(texte_terminal("Son empreinte SHA-256 : " + empreinte.strip().split("=", 1)[-1]))
    return racine


def fichier_ordinaire(chemin):
    """Le chemin réel d'un fichier ordinaire donné en argument.

    Liens résolus, et ni dossier, ni périphérique, ni tube : la lecture de
    /dev/zero ne finirait jamais et celle d'un tube resterait bloquée.
    """
    reel = os.path.realpath(chemin)
    if not os.path.exists(reel):
        raise ValueError("fichier introuvable : " + chemin)
    if not os.path.isfile(reel):
        raise ValueError("ce n'est pas un fichier ordinaire : " + chemin)
    return reel


def ouvrir_fichier(chemin):
    """Ouvre en lecture un fichier ordinaire, contrôlé une fois ouvert.

    Le contrôle porte sur ce qui a réellement été ouvert (fstat), pas sur le
    chemin vu un instant plus tôt. L'ouverture ne bloque pas sur un tube.
    """
    sans_blocage = getattr(os, "O_NONBLOCK", 0)
    descripteur = os.open(chemin, os.O_RDONLY | getattr(os, "O_BINARY", 0) | sans_blocage)
    try:
        if not stat.S_ISREG(os.fstat(descripteur).st_mode):
            raise ValueError("ce n'est pas un fichier ordinaire : " + chemin)
        if sans_blocage:
            os.set_blocking(descripteur, True)
        return os.fdopen(descripteur, "rb")
    except BaseException:
        os.close(descripteur)
        raise


def lire_json(chemin):
    with ouvrir_fichier(chemin) as contenu:
        donnees = contenu.read(TAILLE_MAX_PREUVE + 1)
    if len(donnees) > TAILLE_MAX_PREUVE:
        raise ValueError("fichier trop volumineux pour un dossier de preuve : " + chemin)
    return json_strict(donnees)


def charger(chemin):
    """Le contenu de preuve.json, depuis le dossier extrait, le ZIP ou le
    fichier lui-même."""
    reel = os.path.realpath(chemin)
    if os.path.isdir(reel):
        fichier = os.path.join(reel, "preuve.json")
        if not os.path.exists(fichier):
            raise ValueError("preuve.json est introuvable dans " + chemin)
        return lire_json(fichier)
    reel = fichier_ordinaire(reel)
    if os.path.getsize(reel) > TAILLE_MAX_ARCHIVE:
        raise ValueError("archive trop volumineuse : " + chemin)
    if zipfile.is_zipfile(reel):
        with zipfile.ZipFile(reel) as archive:
            preuves = [entree for entree in archive.infolist() if entree.filename == "preuve.json"]
            if not preuves:
                raise ValueError("preuve.json est introuvable dans " + chemin)
            if len(preuves) != 1:
                raise ValueError("plusieurs entrées preuve.json dans " + chemin)
            entree = preuves[0]
            # La taille annoncée est vérifiée avant de décompresser, la taille
            # réelle pendant : une archive piégée ne remplit pas la mémoire.
            if entree.file_size > TAILLE_MAX_PREUVE:
                raise ValueError("preuve.json est trop volumineux dans " + chemin)
            with archive.open(entree) as contenu:
                donnees = contenu.read(TAILLE_MAX_PREUVE + 1)
            if len(donnees) > TAILLE_MAX_PREUVE:
                raise ValueError("preuve.json est trop volumineux dans " + chemin)
            return json_strict(donnees)
    return lire_json(reel)


# ---------------------------------------------------------------------------
# Contrôles
# ---------------------------------------------------------------------------


def controler_manifeste(rapport, enregistrement):
    rapport.titre("1. Ce qui a été validé")
    texte = enregistrement["manifest"]
    empreinte = sha256_hex(texte.encode("utf-8"))
    manifeste = json_strict(texte)
    if manifeste.get("protocol") != "privcloud-contractor-issuance-v1":
        rapport.echec("Protocole de manifeste inconnu.")
    if empreinte == enregistrement["manifestHash"]:
        rapport.ok("L'empreinte du manifeste correspond à celle de l'enregistrement.")
    else:
        rapport.echec("Le manifeste a été modifié : son empreinte ne correspond plus.")
    if json_canonique(manifeste) != texte:
        rapport.attention("Le manifeste n'est pas sous sa forme canonique.")
    copie = manifeste["copy"]
    pages = copie["pages"]
    champs_hex = [copie["sourceSha256"], copie["markId"]]
    champs_hex.extend(
        empreinte
        for page in pages
        for empreinte in (page["plainSha256"], page["cipherSha256"])
    )
    if (
        not isinstance(copie["pageCount"], int)
        or isinstance(copie["pageCount"], bool)
        or copie["pageCount"] != len(pages)
        or not pages
        or not re.fullmatch(r"[a-f0-9]{64}", copie["sourceSha256"])
        or not re.fullmatch(r"[a-f0-9]{32}", copie["markId"])
        or any(not re.fullmatch(r"[a-f0-9]{64}", valeur) for valeur in champs_hex[2:])
        or any(
            not isinstance(page[dimension], int)
            or isinstance(page[dimension], bool)
            or page[dimension] <= 0
            for page in pages
            for dimension in ("width", "height")
        )
    ):
        rapport.echec("Le manifeste ne respecte pas le schéma de copie attendu.")
    prestataire = manifeste["contractor"]
    rapport.info("Équipe : " + manifeste["team"]["name"])
    rapport.info("Validé par : " + manifeste["issuer"]["email"])
    rapport.info("Le : " + date_lisible(manifeste["issuedAt"]))
    rapport.info(
        "Pour le prestataire : "
        + (prestataire["name"] + " - " if prestataire.get("name") else "")
        + prestataire["email"]
    )
    rapport.info("Accès jusqu'au : " + date_lisible(manifeste["accessExpiresAt"]))
    rapport.info("Fichier d'origine (SHA-256) : " + copie["sourceSha256"])
    rapport.info("Marquage invisible : " + copie["markId"])
    rapport.info("Pages : " + str(copie["pageCount"]))
    return manifeste, empreinte


def controler_passkey(rapport, dossier, enregistrement, empreinte, origine_attendue=None, rp_id=None):
    rapport.titre("2. Qui l'a validé (passkey)")
    webauthn = enregistrement["webauthn"]
    client_brut = b64url_decode(webauthn["clientDataJSONBase64Url"])
    client = json_strict(client_brut)
    donnees = b64url_decode(webauthn["authenticatorDataBase64Url"])
    if len(donnees) < 37:
        raise ValueError("authenticatorData tronqué")

    # Le défi que la passkey a signé est l'empreinte du manifeste lui-même.
    if client.get("type") == "webauthn.get" and client.get("challenge") == b64url_encode(
        bytes.fromhex(empreinte)
    ):
        rapport.ok("La passkey a signé exactement ce manifeste.")
    else:
        rapport.echec("La passkey n'a pas signé ce manifeste.")

    origine = client.get("origin", "")
    if origine_attendue and origine != origine_attendue:
        rapport.echec("L'origine signée ne correspond pas à l'origine attendue.")
    if client.get("crossOrigin"):
        rapport.echec("La validation annonce une origine croisée.")
    analysee = urlparse(origine)
    origine_web = analysee.scheme in ("https", "http")
    origine_android = bool(
        re.fullmatch(r"android:apk-key-hash:[A-Za-z0-9_-]{43}", origine)
    )
    if origine_web:
        valide = bool(
            analysee.hostname
            and not analysee.username
            and not analysee.password
            and not analysee.path
            and not analysee.params
            and not analysee.query
            and not analysee.fragment
            and origine == "%s://%s" % (analysee.scheme, analysee.netloc)
            and (
                analysee.scheme == "https"
                or analysee.hostname in ("localhost", "127.0.0.1", "::1")
            )
        )
    else:
        valide = origine_android and bool(rp_id)
    if not valide:
        rapport.echec("L'origine WebAuthn n'a pas un format sûr reconnu.")
    site = rp_id or analysee.hostname or ""
    if (
        origine_web
        and rp_id
        and analysee.hostname
        and analysee.hostname != rp_id
        and not analysee.hostname.endswith("." + rp_id)
    ):
        rapport.echec("Le RP ID n'est pas le site de l'origine ni un de ses parents.")
    rapport.info("Site : " + origine)
    if donnees[:32] == hashlib.sha256(site.encode()).digest():
        rapport.ok("L'empreinte du RP ID correspond au site annoncé ou fourni.")
    else:
        rapport.echec("La passkey a été utilisée pour un autre site.")
    drapeaux = donnees[32]
    if drapeaux & 0x10 and not drapeaux & 0x08:
        rapport.echec("L'état de sauvegarde WebAuthn est incohérent (BS sans BE).")
    if drapeaux & 0x01 and drapeaux & 0x04:
        rapport.ok(
            "L'authentificateur déclare la présence et la vérification de l'utilisateur"
            " (code, empreinte ou visage)."
        )
    else:
        rapport.echec("La validation a eu lieu sans vérification de la personne.")

    if not shutil.which("openssl"):
        rapport.attention("openssl est introuvable : signature non contrôlée.")
        return
    try:
        algorithme, pem = cle_publique_pem(
            b64url_decode(webauthn["publicKeyCoseBase64Url"], TAILLE_MAX_COSE)
        )
    except (ValueError, KeyError, IndexError):
        rapport.echec("La clé publique de la passkey est illisible.")
        return
    if algorithme != webauthn["algorithm"]:
        rapport.echec("L'algorithme annoncé ne correspond pas à la clé.")
    cle = os.path.join(dossier, "passkey.pem")
    signe = os.path.join(dossier, "signe.bin")
    signature = os.path.join(dossier, "signature.bin")
    with open(cle, "w") as fichier:
        fichier.write(pem)
    # Une passkey signe ses données d'authentification suivies de l'empreinte
    # SHA-256 du clientDataJSON (spécification WebAuthn).
    with open(signe, "wb") as fichier:
        fichier.write(donnees + hashlib.sha256(client_brut).digest())
    with open(signature, "wb") as fichier:
        fichier.write(b64url_decode(webauthn["signatureBase64Url"]))
    code, sortie = openssl(
        "dgst", "-sha256", "-verify", cle, "-signature", signature, signe
    )
    if code == 0 and "Verified OK" in sortie:
        rapport.ok("La signature de la passkey est valide.")
        rapport.info("Identifiant de la passkey : " + webauthn["credentialId"])
    else:
        rapport.echec("La signature de la passkey est fausse.")


def controler_horodatage(rapport, dossier, enregistrement, manifeste, racine):
    rapport.titre("3. Quand (horodatage de l'enregistrement)")
    webauthn = enregistrement["webauthn"]
    # L'empreinte horodatée couvre le manifeste et toute la signature : rien
    # ne peut être remplacé après coup.
    recalculee = empreinte_json(
        {
            "protocol": manifeste["protocol"],
            "manifest": enregistrement["manifest"],
            "credentialId": webauthn["credentialId"],
            "credentialPublicKey": webauthn["publicKeyCoseBase64Url"],
            "credentialAlgorithm": webauthn["algorithm"],
            "authenticatorData": webauthn["authenticatorDataBase64Url"],
            "clientDataJSON": webauthn["clientDataJSONBase64Url"],
            "signature": webauthn["signatureBase64Url"],
        }
    )
    if recalculee == enregistrement["recordHash"]:
        rapport.ok("L'empreinte de l'enregistrement est exacte.")
    else:
        rapport.echec("L'enregistrement a été modifié : son empreinte ne correspond plus.")
    jeton = enregistrement.get("rfc3161TimeStampRespBase64")
    if not jeton:
        rapport.attention("Pas encore de jeton d'horodatage (l'autorité était indisponible).")
        return
    if not shutil.which("openssl"):
        rapport.attention("openssl est introuvable : horodatage non contrôlé.")
        return
    verifier_jeton(rapport, dossier, jeton, recalculee, racine, enregistrement.get("rfc3161TimeStampReqBase64"))


def controler_original(rapport, manifeste, original):
    rapport.titre("4. Quel fichier")
    attendue = manifeste["copy"]["sourceSha256"]
    if not original:
        rapport.info("Pour vérifier le fichier d'origine : --original FICHIER")
        return
    empreinte = hashlib.sha256()
    with ouvrir_fichier(original) as fichier:
        for bloc in iter(lambda: fichier.read(1 << 20), b""):
            empreinte.update(bloc)
    if empreinte.hexdigest() == attendue:
        rapport.ok("Ce fichier est exactement celui à partir duquel la copie a été faite.")
    else:
        rapport.echec("Ce fichier n'est pas celui à partir duquel la copie a été faite.")


ACTIONS = {
    "ISSUED": "copie remise",
    "OPENED": "copie ouverte",
    "REVOKED": "accès révoqué",
    "DELETED": "copie supprimée",
    "VAULT": "preuves consultées depuis le coffre-fort de la plateforme",
}


def controler_journal(rapport, dossier, journal, manifeste, racine):
    rapport.titre("5. Ce que le prestataire a consulté (journal)")
    protocole = journal["protocol"]
    if protocole != "privcloud-contractor-journal-v1":
        rapport.echec("Protocole de journal inconnu.")
        return
    liste_liens = journal.get("links", [])
    liens = {lien["seq"]: lien for lien in liste_liens}
    if len(liens) != len(liste_liens):
        rapport.echec("Le journal contient des numéros de maillon dupliqués.")
        return
    evenements = journal.get("events", [])
    if not evenements:
        rapport.attention("Aucun événement détaillé à vérifier.")

    if len({e["seq"] for e in evenements}) != len(evenements):
        rapport.echec("Le journal contient des événements dupliqués.")
        return
    # Chaque événement de cette copie : son contenu donne son empreinte.
    contenu_exact = True
    formats_evenements = {}
    for evenement in evenements:
        lien = liens.get(evenement["seq"])
        objet_contenu = {
                "protocol": protocole,
                "teamId": journal["teamId"],
                "at": evenement["at"],
                "kind": evenement["kind"],
                "previewId": evenement["previewId"],
                "seatId": evenement["seatId"],
                "actorEmail": evenement["actorEmail"],
                "pageIndex": evenement["pageIndex"],
            }
        contenu = empreinte_json(objet_contenu)
        historique = empreinte_json({**objet_contenu, "seq": evenement["seq"], "prevHash": evenement["prevHash"]})
        actuel = empreinte_json({"protocol": protocole, "seq": evenement["seq"], "prevHash": evenement["prevHash"], "contentHash": contenu})
        formats_evenements[evenement["seq"]] = (
            "split-v1" if evenement["hash"] == actuel else
            "legacy-flat-v1" if evenement["hash"] == historique else None
        )
        if (
            not lien
            or lien["contentHash"] != contenu
            or lien["hash"] != evenement["hash"]
            or lien["prevHash"] != evenement["prevHash"]
            or evenement["previewId"] != manifeste["copy"]["previewId"]
            or journal["teamId"] != manifeste["team"]["id"]
            or formats_evenements[evenement["seq"]] is None
        ):
            contenu_exact = False
            rapport.echec("L'événement n°%d a été modifié." % evenement["seq"])
    if contenu_exact:
        rapport.ok("Les %d événements de cette copie sont intacts." % len(evenements))

    # La chaîne : chaque maillon contient l'empreinte du précédent. Les
    # événements des autres copies n'y figurent que par leurs empreintes.
    precedent = None
    chaine_exacte = True
    format_actuel_vu = False
    format_historique_vu = False
    for numero in sorted(liens):
        lien = liens[numero]
        calcule = empreinte_json(
            {
                "protocol": protocole,
                "seq": lien["seq"],
                "prevHash": lien["prevHash"],
                "contentHash": lien["contentHash"],
            }
        )
        format_declare = lien.get("hashFormat")
        if format_declare not in (None, "split-v1", "legacy-flat-v1"):
            chaine_exacte = False
            rapport.echec("Format de maillon inconnu au n°%d." % numero)
            break
        format_detail = formats_evenements.get(numero)
        if format_declare is not None and format_detail is not None and format_declare != format_detail:
            chaine_exacte = False
            rapport.echec("Le format déclaré contredit l'événement détaillé au n°%d." % numero)
            break
        historique = (format_declare == "legacy-flat-v1" or format_detail == "legacy-flat-v1" or (
            format_declare is None and format_historique_vu and not format_actuel_vu
            and numero not in formats_evenements and calcule != lien["hash"]
        ))
        if historique:
            if format_actuel_vu or format_detail == "split-v1":
                chaine_exacte = False
                rapport.echec("Retour à l'ancien format interdit au maillon n°%d." % numero)
                break
            format_historique_vu = True
            if numero not in formats_evenements:
                rapport.attention("Le maillon historique n°%d masque le contenu d'une autre copie. Son empreinte ne peut pas être recalculée indépendamment depuis cet export." % numero)
        else:
            format_actuel_vu = True
        if (not historique and calcule != lien["hash"]) or (
            numero == 1 and lien["prevHash"] != "0" * 64
        ) or (
            precedent
            and (lien["seq"] != precedent["seq"] + 1 or lien["prevHash"] != precedent["hash"])
        ):
            chaine_exacte = False
            rapport.echec("La chaîne est rompue au maillon n°%d." % lien["seq"])
            break
        precedent = lien
    if format_historique_vu:
        rapport.info("Ancien format à empreinte unique reconnu, sans réécriture des événements ni des ancrages.")
    if chaine_exacte and liens:
        rapport.ok(
            "La chaîne est continue sur les %d maillons fournis." % len(liens)
        )
    elif not liens:
        rapport.attention("Aucun maillon de journal à vérifier.")

    # Les ancrages : une autorité a horodaté un maillon, et donc tout ce qui
    # le précède dans la chaîne.
    dates = {}
    for ancrage in journal.get("anchors", []):
        print()
        print("  Ancrage du maillon n°%d" % ancrage["seq"])
        lien = liens.get(ancrage["seq"])
        if not lien or lien["hash"] != ancrage["hash"]:
            rapport.echec("Cet ancrage ne correspond à aucun maillon de la chaîne.")
            continue
        if not shutil.which("openssl"):
            rapport.attention("openssl est introuvable : ancrage non contrôlé.")
            continue
        date = verifier_jeton(
            rapport, dossier,
            ancrage["rfc3161TimeStampRespBase64"], ancrage["hash"], racine,
            ancrage.get("rfc3161TimeStampReqBase64"),
        )
        if date and chaine_exacte:
            dates[ancrage["seq"]] = date

    # Le journal est ancré une fois par heure : les derniers événements ne le
    # sont qu'au prochain passage.
    recents = [
        evenement
        for evenement in evenements
        if not any(numero >= evenement["seq"] for numero in dates)
    ]
    if recents:
        rapport.attention(
            "%d événement(s) pas encore horodaté(s) : leur date ne repose que sur"
            " le serveur. Le journal est horodaté une fois par heure, retélécharger"
            " le dossier après le prochain passage pour les couvrir." % len(recents)
        )

    print()
    print("  Événements de cette copie :")
    for evenement in evenements:
        if evenement["kind"] == "PAGE":
            action = "demande de page %d autorisée (affichage humain non établi)" % ((evenement["pageIndex"] or 0) + 1)
        else:
            action = ACTIONS.get(evenement["kind"], evenement["kind"])
        couverts = [numero for numero in sorted(dates) if numero >= evenement["seq"]]
        preuve = (
            "horodaté au plus tard le " + date_lisible(dates[couverts[0]])
            if couverts
            else "pas encore horodaté"
        )
        print(
            texte_terminal(
                "    %s  %s, par %s (%s)"
                % (date_lisible(evenement["at"]), action, evenement["actorEmail"], preuve)
            )
        )


def controler_checkpoint(rapport, dossier, preuve, checkpoint, racine):
    rapport.titre("6. Checkpoint conservé indépendamment")
    if checkpoint.get("format") != "privcloud-contractor-checkpoint-v1":
        rapport.echec("Format du checkpoint inconnu.")
        return
    if not racine:
        rapport.attention("Le checkpoint exige une racine choisie indépendamment avec --ca.")
    if checkpoint["issuance"]["recordHash"] != preuve["issuance"]["recordHash"]:
        rapport.echec("L'enregistrement ne correspond plus au checkpoint conservé.")
    if shutil.which("openssl"):
        verifier_jeton(rapport, dossier, checkpoint["issuance"]["rfc3161TimeStampRespBase64"],
                       checkpoint["issuance"]["recordHash"], racine,
                       checkpoint["issuance"].get("rfc3161TimeStampReqBase64"))
    else:
        rapport.attention("openssl est introuvable : checkpoint non horodaté.")
    journal = checkpoint["journal"]
    lien = next((l for l in preuve["journal"].get("links", [])
                 if l["seq"] == journal["seq"]), None)
    if (journal["teamId"] != preuve["journal"]["teamId"] or
            not lien or lien["hash"] != journal["hash"]):
        rapport.echec("La chaîne a été réécrite ou tronquée depuis le checkpoint conservé.")
    else:
        rapport.ok("La chaîne contient toujours le maillon conservé indépendamment.")
    if shutil.which("openssl"):
        verifier_jeton(rapport, dossier, journal["rfc3161TimeStampRespBase64"], journal["hash"], racine,
                       journal.get("rfc3161TimeStampReqBase64"))


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(
        description="Vérifie un dossier de preuve PrivCloud, sans PrivCloud."
    )
    parser.add_argument(
        "dossier",
        nargs="?",
        default=os.path.dirname(os.path.abspath(__file__)),
        help="dossier extrait, ZIP ou preuve.json (par défaut : le dossier du script)",
    )
    parser.add_argument("--original", help="le fichier d'origine, pour le comparer")
    parser.add_argument(
        "--ca", help="certificat racine de l'autorité d'horodatage (PEM ou DER)"
    )
    parser.add_argument("--expected-origin", help="origine WebAuthn exacte choisie indépendamment")
    parser.add_argument("--rp-id", help="RP ID attendu, si différent du nom d'hôte de l'origine")
    parser.add_argument("--strict", action="store_true", help="refuser aussi tout contrôle incomplet")
    parser.add_argument("--checkpoint", help="checkpoint conservé hors du serveur avant compromission")
    arguments = parser.parse_args()

    try:
        original = fichier_ordinaire(arguments.original) if arguments.original else None
        autorite = fichier_ordinaire(arguments.ca) if arguments.ca else None
    except ValueError as erreur:
        print(texte_terminal(erreur))
        return 2
    try:
        preuve = charger(arguments.dossier)
        enregistrement = preuve["issuance"]
    except (OSError, ValueError, KeyError) as erreur:
        print(texte_terminal("Dossier illisible : %s" % erreur))
        return 2
    try:
        checkpoint = lire_json(fichier_ordinaire(arguments.checkpoint)) if arguments.checkpoint else None
    except (OSError, ValueError) as erreur:
        print(texte_terminal("Checkpoint illisible : %s" % erreur))
        return 2
    if preuve.get("format") != FORMAT:
        print("Ce fichier n'est pas un dossier de preuve PrivCloud.")
        return 2

    rapport = Rapport()
    print(texte_terminal("Dossier de preuve PrivCloud, enregistrement " + enregistrement["id"]))
    if not shutil.which("openssl"):
        print("openssl est introuvable : signature et horodatages ne seront pas contrôlés.")
    for present, message in [
        (autorite, "Une vérification complète exige --ca avec une racine choisie indépendamment."),
        (arguments.expected_origin, "Une vérification complète exige --expected-origin choisi indépendamment."),
        (arguments.rp_id, "Une vérification complète exige --rp-id choisi indépendamment."),
        (original, "Une vérification complète exige --original pour contrôler le fichier."),
        (checkpoint, "Une vérification complète exige --checkpoint conservé indépendamment."),
    ]:
        if not present:
            rapport.attention(message)
    with tempfile.TemporaryDirectory() as dossier:
        racine = None
        if autorite:
            try:
                racine = preparer_racine(autorite, dossier)
            except ValueError as erreur:
                print(texte_terminal(erreur))
                return 2
        manifeste, empreinte = controler_manifeste(rapport, enregistrement)
        controler_passkey(rapport, dossier, enregistrement, empreinte, arguments.expected_origin, arguments.rp_id)
        controler_horodatage(rapport, dossier, enregistrement, manifeste, racine)
        controler_original(rapport, manifeste, original)
        controler_journal(rapport, dossier, preuve["journal"], manifeste, racine)
        if checkpoint:
            controler_checkpoint(rapport, dossier, preuve, checkpoint, racine)

    print()
    if rapport.echecs:
        print(
            "RÉSULTAT : %d contrôle(s) en ÉCHEC. Ce dossier ne doit pas être tenu"
            " pour fiable." % rapport.echecs
        )
        return 1
    if rapport.alertes:
        print(
            "RÉSULTAT : aucun ÉCHEC. %d point(s) en ATTENTION, à lire ci-dessus."
            % rapport.alertes
        )
        if arguments.strict:
            return 3
    else:
        print("RÉSULTAT : tout est vérifié dans le périmètre technique demandé.")
    print("La signature ne prouve pas l'identité civile. Le statut eIDAS qualifié et la révocation historique des certificats ne sont pas établis par ce contrôle.")
    return 0


if __name__ == "__main__":
    sortie_json = "--json" in sys.argv
    if sortie_json:
        sys.argv.remove("--json")
    compte_rendu = io.StringIO()
    try:
        with contextlib.redirect_stdout(compte_rendu) if sortie_json else contextlib.nullcontext():
            code = main()
    except (ValueError, KeyError, IndexError, TypeError, OverflowError, OSError, RecursionError) as erreur:
        message = texte_terminal("Dossier de preuve malformé : %s" % erreur)
        if sortie_json:
            compte_rendu.write(message)
        else:
            print(message)
        code = 2
    if sortie_json:
        rapport = Rapport.courant
        statut = "INVALID" if code in (1, 2) else "INDETERMINATE" if code == 3 or (rapport and rapport.alertes) else "VALID"
        print(json.dumps({"format": "privcloud-verification-report-v1", "status": statut,
            "exitCode": code, "checks": rapport.controles if rapport else [],
            "legalIdentity": "NOT_ESTABLISHED", "qualifiedTimestamp": "NOT_CHECKED",
            "historicalRevocation": "NOT_CHECKED", "details": compte_rendu.getvalue()}, ensure_ascii=False))
    sys.exit(code)
