---
id: configuration
---

# Configuration

## General configuration

There are plenty of settings you can adjust to your needs. Pingvin Share can be configured in two ways:

### UI

You can change the settings in the UI (`/admin/config`)

### YAML file

You can set the configuration via a YAML file. If you choose this way, you won't be able to change the settings in the UI.

If you use Docker you can create a `config.yml` file based on the [`config.example.yaml`](https://github.com/stonith404/pingvin-share/blob/main/config.example.yaml) and mount it to `/opt/app/config.yaml` in the container.

If you run Pingvin Share without Docker, you can create a `config.yml` file based on the [`config.example.yaml`](https://github.com/stonith404/pingvin-share/blob/main/config.example.yaml) in the root directory of the project.

---

### Environment variables

For installation specific configuration, you can use environment variables. The following variables are available:

#### Backend

| Variable         | Default Value                                      | Description                                                                                              |
| ---------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `BACKEND_PORT`   | `8080`                                             | The port on which the backend listens.                                                                   |
| `DATABASE_URL`   | `file:../data/pingvin-share.db?connection_limit=1` | The URL of the SQLite database.                                                                          |
| `DATA_DIRECTORY` | `./data`                                           | The directory where data is stored.                                                                      |
| `CONFIG_FILE`    | `../config.yaml`                                   | Path to the configuration file                                                                           |
| `CLAMAV_HOST`    | `127.0.0.1` or `clamav` when running with Docker   | The IP address of the ClamAV server. See the [ClamAV docs](integrations.md#clamav) for more information. |
| `CLAMAV_PORT`    | `3310`                                             | The port number of the ClamAV server.                                                                    |
#### Frontend

| Variable  | Default Value           | Description                              |
| --------- | ----------------------- | ---------------------------------------- |
| `PORT`    | `3000`                  | The port on which the frontend listens.  |
| `API_URL` | `http://localhost:8080` | The URL of the backend for the frontend. |

#### Docker specific

Environment variables that are only available when running Pingvin Share with Docker.

| Variable          | Default Value | Description                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TRUST_PROXY`     | `false`       | Whether Pingvin Share is behind a reverse proxy. If set to `true`, the `X-Forwarded-For` header is trusted.                                                                                                                                                                                                                                                                   |
| `CADDY_DISABLED`  | `false`       | Configures if Pingvin Share is starting built-in Caddy. If set to `true`, Caddy will not be started. If disabled, you must configure your reverse proxy to correctly map all paths. Refer to the [official Caddyfile](https://github.com/stonith404/pingvin-share/blob/main/reverse-proxy/Caddyfile) for guidance.                                                            |
| `PUID` and `PGID` | `1000`        | The user and group ID of the user who should run Pingvin Share inside the Docker container and owns the files that are mounted with the volume. You can get the `PUID` and `GUID` of your user on your host machine by using the command `id`. For more information see [this article](https://docs.linuxserver.io/general/understanding-puid-and-pgid/#using-the-variables). |

## Encrypted settings

Passwords, API secrets, signing keys, identifiers and service addresses of the configuration table can be encrypted with a key kept outside the database. Without `CONFIG_ENCRYPTION_KEY_FILE`, settings are stored as before.

1. Deploy this version on every instance, without the key.
2. Create the key and back it up away from the database dumps:

   ```bash
   mkdir -p data/secrets && chmod 700 data/secrets
   openssl rand -base64 32 > data/secrets/config.key
   chmod 600 data/secrets/config.key
   ```

3. Set `CONFIG_ENCRYPTION_KEY_FILE=/opt/app/backend/data/secrets/config.key` on every instance and restart them. The settings are encrypted at startup.
4. Rotate the secrets, since older database dumps still hold them in clear.

Account data is encrypted with the same key in a second step, because older versions cannot read it. This covers TOTP secrets, provider tokens, push subscriptions, link tokens, addresses and names, audit logs, IP addresses, and the names and descriptions of shares, files, teams, folders and signature requests. The application keeps working on both forms, and links already sent stay valid:

1. Deploy this version on every instance, keeping the key.
2. Set `CONFIG_ENCRYPTION_MODE=full` on every instance and restart them. New rows are encrypted when they are written. Secrets and tokens are converted at startup, other columns behind a serving instance, until the log line `Stored columns encrypted`. An interrupted conversion resumes at the next start.

Lost keys cannot be recovered: without the key, this data is gone, so keep a copy of it away from the database dumps. Encrypted columns can no longer be read or searched with SQL, and equal values of a searchable column stay equal once encrypted. Backups of earlier dates still hold them in clear.

An instance refuses to start when a setting is encrypted and the key is missing or wrong. Before going back to a version without this feature, set `CONFIG_ENCRYPTION_MODE=decrypt`, restart and wait for the log line `Stored columns decrypted` on an instance of this version: everything returns to plaintext.

## Certificates

`./scripts/certificates.sh status` lists the expiry of the PDF seal, its certificate authorities and the Entra ID certificate, and exits with 1 when one is due. `renew-signing` replaces the seal and keeps the previous file in a backup directory. Point `SIGNING_P12` to the active file and `CA_DIR` to the offline copy of the CA keys.
