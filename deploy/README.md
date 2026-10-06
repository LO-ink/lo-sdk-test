# Deploying LO SDK Test

The ci.yml workflow verifies pull requests. A main-branch merge publishes the tested container and deploys it by immutable digest. Manual deployment workflows also require main.

## Server setup

1. Install Docker Compose, git, curl, Python 3 and flock. Configure the traefik-public network and DNS/TLS for the hostname in compose.vps.yml.
2. Create /opt/lo-sdk-test/runtime.env from .env.example with administrator-only access. This file never passes through GitHub.
3. Install compose.vps.yml as /opt/lo-sdk-test/compose.yml and release.sh as root-owned /usr/local/sbin/lo-sdk-test-deploy, mode 0755. An administrator reviews and installs updates to this script.
4. Create lo-sdk-deploy with a locked password and no Docker group membership. Grant sudo only for /usr/local/sbin/lo-sdk-test-deploy.
5. Restrict the dedicated deployment key in authorized_keys:

```text
restrict,command="sudo -n /usr/local/sbin/lo-sdk-test-deploy \"$SSH_ORIGINAL_COMMAND\"" ssh-ed25519 <public key>
```

6. Restrict the repository's production environment to main. Configure DEPLOY_SSH_KEY and verified DEPLOY_KNOWN_HOSTS secrets, plus DEPLOY_HOST and DEPLOY_USER variables.
7. Before the first automatic deployment, start the web container in the lo-sdk-test Compose project. Record its image as SDK_TEST_IMAGE in deployment.env so recovery has a known previous image.

GHCR may remain private. A short-lived GITHUB_TOKEN with package-read permission travels over encrypted stdin; the temporary Docker configuration is removed after pulling. The OCI source label associates the package with its repository.

## Verification and recovery

The script accepts only `deploy sha256:<digest> <40-character commit> <GitHub actor>`. It verifies main and image labels, skips stale jobs and serializes container replacement with a lock. A GitHub failure stops deployment before replacement.

The new container must pass health checks and report the expected revision over public HTTPS. Failure restores the previous image. Successful digest and commit are recorded in /opt/lo-sdk-test/current-release.json; deployment.env records the current image. Use that environment file for administrative Compose commands:

```sh
cd /opt/lo-sdk-test
docker compose --env-file deployment.env -f compose.yml ps
```

For emergency recovery, set SDK_TEST_IMAGE to a saved digest or previous local image and run `docker compose -p lo-sdk-test -f compose.yml up -d --no-deps --wait web`. Update deployment.env and check /release.json afterwards.

DNS, runtime.env, Traefik and the root-owned deployment script are infrastructure settings. Retain the previous image until the new deployment is confirmed.
