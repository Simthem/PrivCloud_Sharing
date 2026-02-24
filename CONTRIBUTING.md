_Read this in another language: [Spanish](/docs/CONTRIBUTING.es.md), [English](/CONTRIBUTING.md), [Simplified Chinese](/docs/CONTRIBUTING.zh-cn.md)_

---

# Contributing

We would love for you to contribute to PrivCloud_Sharing and help make it better! All contributions are welcome, including issues, suggestions, pull requests and more.

## Getting started

You've found a bug, have a suggestion or something else, just create an issue on GitHub and we can get in touch.

## Submit a Pull Request

Before you submit the pull request for review please ensure that

- The pull request naming follows the [Conventional Commits specification](https://www.conventionalcommits.org):

  `<type>[optional scope]: <description>`

  example:

  ```
  feat(share): add password protection
  ```

  When `TYPE` can be:

  - **feat** - is a new feature
  - **doc** - documentation only changes
  - **fix** - a bug fix
  - **refactor** - code change that neither fixes a bug nor adds a feature

- Your pull request has a detailed description
- You run `npm run format` to format the code

<details>
  <summary>Don't know how to create a pull request? Learn how to create a pull request</summary>

1. Create a fork of the repository by clicking on the `Fork` button in the PrivCloud_Sharing repository

2. Clone your fork to your machine with `git clone`

```
$ git clone https://github.com/[your_username]/PrivCloud_Sharing.git
```

3. Work - commit - repeat

4. Push changes to GitHub

```
$ git push origin [name_of_your_new_branch]
```

5. Submit your changes for review
   If you go to your repository on GitHub, you'll see a `Compare & pull request` button. Click on that button.
6. Start a Pull Request
7. Now submit the pull request and click on `Create pull request`.
8. Get a code review approval/reject

</details>

## Setup project

PrivCloud_Sharing consists of a frontend and a backend.

### Backend

The backend is built with [NestJS 11](https://nestjs.com) and uses TypeScript.

- **ORM**: Prisma 6 with SQLite
- **Runtime**: Node 22 (Alpine in Docker)

#### Setup

1. Open the `backend` folder
2. Install the dependencies with `npm install`
3. Push the database schema to the database by running `npx prisma db push`
4. Seed the database with `npx prisma db seed`
5. Start the backend with `npm run dev`

### Frontend

The frontend is built with [Next.js 15](https://nextjs.org) and uses TypeScript.

- **UI**: Mantine 6
- **PWA**: `@ducanh2912/next-pwa`
- **State**: React Query (`@tanstack/react-query`)

#### Setup

1. Start the backend first
2. Open the `frontend` folder
3. Install the dependencies with `npm install`
4. Start the frontend with `npm run dev`

You're all set!

### Testing

At the moment we only have system tests for the backend. To run these tests, run `npm run test:system` in the backend folder.

## Architecture

### Docker

The production Docker image uses a multi-stage build:

1. **base** - Node 22 Alpine with Caddy, su-exec, and build tools
2. **frontend-deps** / **frontend-builder** - Installs dependencies and builds the Next.js standalone output
3. **backend-deps** / **backend-builder** - Installs dependencies, generates Prisma client, builds NestJS, and prunes dev dependencies
4. **runner** - Final image with Caddy as reverse proxy (port 3000 -> frontend:3333 + backend:8080)

Proxy environment variables are **not hardcoded** in the image. If you need a proxy at build time, pass `--build-arg HTTP_PROXY=...` and `--build-arg HTTPS_PROXY=...`. At runtime, set them in `docker-compose.yaml` (see the commented examples).

### End-to-End Encryption

The E2E encryption system uses AES-256-GCM via the Web Crypto API. All cryptographic operations happen client-side in the browser.

Key files:

- `frontend/src/utils/crypto.util.ts` - Core crypto functions (key generation, encrypt/decrypt, wrap/unwrap, key storage, URL fragment handling)
- `frontend/src/pages/upload/index.tsx` - Encrypts files before upload
- `frontend/src/pages/share/[shareId]/index.tsx` - Decrypts files on the share view page

#### Regular shares

1. On first upload, a per-user master key (`K_master`) is generated and stored in `localStorage`
2. A SHA-256 hash of `K_master` is sent to the server for key verification
3. Files are encrypted with `K_master` before upload
4. The share link includes `#key=<K_master_base64url>` - the fragment is never sent to the server
5. Recipients use the key from the URL fragment to decrypt files in-browser

#### Reverse shares (E2E)

1. When creating a reverse share, a per-share key (`K_rs`) is generated
2. `K_rs` is encrypted ("wrapped") with `K_master` and the encrypted blob is stored in the database
3. The reverse share link includes `#key=<K_rs_base64url>`
4. An anonymous sender reads `K_rs` from the URL fragment and encrypts files with it
5. The reverse share owner decrypts `K_rs` using their `K_master` to view/download received files

#### Encrypted file format

```
[IV (12 bytes)][ciphertext + GCM auth tag (16 bytes)]
```

### CVE Remediation

All three `package-lock.json` files (backend, frontend, docs) have been audited and patched to **zero known vulnerabilities**:

- **Backend**: `nodemailer` upgraded, 13 dependency overrides for transitive CVEs
- **Frontend**: Next.js 14 -> 15 migration, `next-pwa` replaced with `@ducanh2912/next-pwa`, overrides for `minimatch`/`glob`
- **Docs**: Docusaurus 3.5 -> 3.9, `minimatch` override

### Prisma 6 Compatibility

Prisma 6 enforces stricter types for query parameters. All `request.params` values used in Prisma queries are wrapped with `String()` to avoid runtime type errors. Affected guard files:

- `shareOwner.guard.ts`
- `shareSecurity.guard.ts`
- `shareTokenSecurity.guard.ts`
- `reverseShareOwner.guard.ts`
- `reverseShareToken.pipe.ts`
