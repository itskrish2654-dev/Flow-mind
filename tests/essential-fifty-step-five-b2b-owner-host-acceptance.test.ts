import assert from "node:assert/strict";
import { createCipheriv, createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import * as fileSystem from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import test, { describe } from "node:test";
import { runInNewContext } from "node:vm";

import { bodyDigest, transportSignature } from "../services/connector-runner/src/runner.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const HARNESS_PATH = resolve(ROOT, "scripts/e50-step5b2b-runner-supervisor-host-acceptance.sh");
// Git's Windows checkout may use CRLF; the owner-host Bash script is evaluated as lines.
const HARNESS = readFileSync(HARNESS_PATH, "utf8").replace(/\r\n/g, "\n");

function section(start: string, end: string) {
  const startIndex = HARNESS.indexOf(start);
  const endIndex = HARNESS.indexOf(end, startIndex + start.length);
  assert.ok(startIndex >= 0, `missing section start: ${start}`);
  assert.ok(endIndex > startIndex, `missing section end: ${end}`);
  return HARNESS.slice(startIndex, endIndex);
}

describe("Essential 50 Step 5B.2B owner-host acceptance harness", () => {
  test("source gate pins the exact branch, parent, main, remote head, and clean checkout", () => {
    assert.match(HARNESS, /EXPECTED_BRANCH='codex\/e50-step5b2b-owner-host-acceptance-v6'/);
    assert.match(HARNESS, /ACCEPTED_PARENT='5b08c5ebad41cd1740df6aa6938bb42778412432'/);
    assert.match(HARNESS, /EXPECTED_ORIGIN_MAIN='20c23d7e85123eaa77a916ce43f4a9ef5ca8a5e7'/);
    assert.match(HARNESS, /E50_EXPECTED_COMMIT/);
    assert.match(HARNESS, /for attempt in 1 2 3/);
    assert.match(HARNESS, /refs\/heads\/main:refs\/remotes\/origin\/main/);
    assert.match(HARNESS, /refs\/heads\/\$EXPECTED_BRANCH:refs\/remotes\/origin\/\$EXPECTED_BRANCH/);
    assert.match(HARNESS, /git branch --show-current.*EXPECTED_BRANCH/);
    assert.match(HARNESS, /git rev-parse HEAD\).*E50_EXPECTED_COMMIT/);
    assert.match(HARNESS, /git rev-parse "origin\/\$EXPECTED_BRANCH"\).*E50_EXPECTED_COMMIT/);
    assert.match(HARNESS, /git rev-parse origin\/main\).*EXPECTED_ORIGIN_MAIN/);
    assert.match(HARNESS, /git rev-parse HEAD\^\).*ACCEPTED_PARENT/);
    assert.match(HARNESS, /git status --porcelain/);
    assert.match(HARNESS, /SOURCE_FILES\[0\].*scripts\/e50-step5b2b-runner-supervisor-host-acceptance\.sh/);
    assert.match(HARNESS, /SOURCE_FILES\[1\].*tests\/essential-fifty-step-five-b2b-owner-host-acceptance\.test\.ts/);
  });

  test("protected services are snapshot-only and health-checked before and after acceptance", () => {
    assert.match(HARNESS, /PROTECTED=\(crazyloops-connector-runner activepieces-app activepieces-worker-1 redis\)/);
    assert.match(HARNESS, /\.State\.Running.*\.RestartCount/);
    assert.equal((HARNESS.match(/snapshot_protected /g) ?? []).length, 2);
    assert.match(HARNESS, /cmp -s "\$ARTIFACT_DIR\/protected-before\.txt" "\$ARTIFACT_DIR\/protected-after\.txt"/);
    assert.match(HARNESS, /http:\/\/127\.0\.0\.1:8788\/v1\/execute/);
    assert.match(HARNESS, /docker exec redis redis-cli PING/);
    assert.doesNotMatch(HARNESS, /docker (?:rm|stop|kill|restart) (?:-f )?"?\$?\{?(?:PROTECTED|protected_name)/);
    assert.doesNotMatch(HARNESS, /docker compose|systemctl|service restart/);
  });

  test("all acceptance services are disposable and the production Runner is never replaced", () => {
    for (const name of [
      "cl-piece-step5b2b-supervisor",
      "cl-piece-step5b2b-runner",
      "cl-piece-step5b2b-redis",
      "cl-piece-step5b2b-request-client",
      "cl-piece-step5b2b-runner-net",
      "cl-piece-step5b2b-broker-control",
    ]) assert.match(HARNESS, new RegExp(name.replaceAll("-", "\\-")));
    assert.match(HARNESS, /OWNER_LABEL='crazyloops\.acceptance=e50-step5b2b-owner-host'/);
    assert.doesNotMatch(HARNESS, /--name crazyloops-connector-runner/);
    assert.doesNotMatch(HARNESS, /docker (?:rm|stop|kill|restart)[^\n]*crazyloops-connector-runner/);
    assert.doesNotMatch(HARNESS, /vercel|supabase db|production compose/i);
  });

  test("Runner receives only the read-only Supervisor UDS and supplemental group", () => {
    const runner = section('docker run -d --name "$RUNNER_NAME"', "RUNNER_CREATED=1");
    assert.match(runner, /--user=node --group-add 65532/);
    assert.match(runner, /src="\$CONTROL_DIR",dst=\/run\/crazyloops-piece,readonly/);
    assert.match(runner, /--network "\$RUNNER_NETWORK"/);
    assert.match(runner, /--read-only/);
    assert.match(runner, /--cap-drop=ALL/);
    assert.match(runner, /--security-opt=no-new-privileges/);
    assert.doesNotMatch(runner, /\/var\/run\/docker\.sock|crazyloops-egress-control|--privileged|--network host/);
    assert.doesNotMatch(runner, /--add-host|api\.hubapi\.com/);
    assert.doesNotMatch(runner, /(?:^|\s)(?:-p|--publish)(?:\s|=)/m);
    assert.doesNotMatch(HARNESS, /chmod 0777|chmod 0755 "\$CONTROL_DIR"|chmod 0666/);
    assert.match(HARNESS, /stat -c '%a' "\$CONTROL_DIR"\).*'750'/);
    const supervisorMetadataCheck = section(
      'docker exec "$SUPERVISOR_NAME" node -e \'\nconst fs = require("node:fs");',
      '[[ "$(stat -c \'%a\' "$CONTROL_DIR")" == \'750\' ]]',
    );
    assert.match(supervisorMetadataCheck, /\/run\/crazyloops-piece\/piece-supervisor\.sock/);
    assert.match(supervisorMetadataCheck, /fs\.lstatSync/);
    assert.match(supervisorMetadataCheck, /metadata\.isSocket\(\)/);
    assert.match(supervisorMetadataCheck, /\(metadata\.mode & 0o777\) !== 0o660/);
    assert.match(supervisorMetadataCheck, /metadata\.uid !== 65532/);
    assert.match(supervisorMetadataCheck, /metadata\.gid !== 65532/);
    assert.doesNotMatch(HARNESS, /stat -c '[^']*' "\$CONTROL_DIR\/piece-supervisor\.sock"/);
    assert.doesNotMatch(HARNESS, /--privileged/);
  });

  test("Runner and disposable Redis share one internal network with zero public ports", () => {
    assert.match(HARNESS, /docker network create --internal --label "\$OWNER_LABEL" "\$RUNNER_NETWORK"/);
    const redis = section('docker run -d --name "$REDIS_NAME"', "REDIS_CREATED=1");
    assert.match(redis, /--network "\$RUNNER_NETWORK" --network-alias replay-redis/);
    assert.match(redis, /--user="?\$REDIS_UID:\$REDIS_GID"?/);
    assert.match(redis, /--read-only/);
    assert.match(redis, /--cap-drop=ALL/);
    assert.match(redis, /--security-opt=no-new-privileges/);
    assert.match(redis, /--tmpfs "\/data:rw,noexec,nosuid,nodev,size=16m,uid=\$REDIS_UID,gid=\$REDIS_GID,mode=0700"/);
    assert.match(redis, /"\$PROTECTED_REDIS_IMAGE" redis-server/);
    assert.doesNotMatch(redis, /(?:^|\s)(?:-p|--publish)(?:\s|=)/m);
    assert.doesNotMatch(redis, /--cap-add|--privileged/);
    assert.match(HARNESS, /PROTECTED_REDIS_IMAGE="\$\(docker inspect --format '\{\{\.Image\}\}' redis\)"/);
    assert.match(HARNESS, /value\.Internal!==true/);
    assert.match(HARNESS, /RUNNER_PUBLIC_PORTS=0/);
    assert.match(HARNESS, /RUNNER_DOCKER_SOCKET=0/);
    assert.match(HARNESS, /RUNNER_BROKER_SOCKET=0/);
  });

  test("Redis identity comes from the protected PID 1 process and fails closed for root", () => {
    const identity = section('PROTECTED_REDIS_IMAGE="$(docker inspect', "trap - EXIT");
    assert.doesNotMatch(identity, /docker exec redis id -[ug]/);
    assert.match(identity, /docker exec redis sh -c/);
    assert.match(identity, /done <\/proc\/1\/status/);
    assert.match(identity, /Uid:\) redis_uid="\$first"/);
    assert.match(identity, /Gid:\) redis_gid="\$first"/);
    assert.match(identity, /\^\[0-9\]\+:\[0-9\]\+\$/);
    assert.match(identity, /REDIS_UID.*!= '0'.*REDIS_GID.*!= '0'/);
    assert.doesNotMatch(identity, /\b(?:chown|chmod|touch|truncate|rm|mv)\b|sed\s+-i|tee\s/);
  });

  test("fresh fake credentials and transport material never enter argv or labels", () => {
    assert.match(HARNESS, /randomBytes\(48\)/);
    assert.match(HARNESS, /randomBytes\(32\)/);
    assert.match(HARNESS, /pat-na1-/);
    assert.match(HARNESS, /umask 077/);
    assert.match(HARNESS, /mode: 0o600/);
    assert.match(HARNESS, /stat -c '%a' "\$secret_file"/);
    assert.match(HARNESS, /stat -c '%u:%g' "\$secret_file".*HOST_UID:\$HOST_GID/);
    const runner = section('docker run -d --name "$RUNNER_NAME"', "RUNNER_CREATED=1");
    assert.match(runner, /--env-file "\$SECRET_DIR\/runner\.env"/);
    assert.doesNotMatch(runner, /CANARY|credential|pat-na1|CONNECTOR_RUNNER_SECRET=/);
    const client = section("run_runner_request()", "expect_runner_error()");
    assert.doesNotMatch(client, /CANARY|pat-na1|credentialBase64|--env/);
    assert.doesNotMatch(HARNESS, /printf[^\n]*(?:CANARY|CONNECTOR_RUNNER_SECRET|WRAP_KEY)/);
  });

  test("request generator uses the exact signed Runner protocol and AES-GCM AAD", () => {
    const generator = section("node - \"$SECRET_DIR\" <<'NODE'", "CANARY=\"$(<\"$SECRET_DIR/canary.txt\")\"");
    for (const field of [
      "protocolVersion", "requestId", "executionId", "workflowVersionId", "stepId",
      "capabilityId", "capabilityVersion", "mode", "idempotencyKey", "input", "credentialCapsule",
    ]) assert.match(generator, new RegExp(`\\b${field}\\b`));
    assert.match(generator, /capabilityId: 'hubspot\.get_contact'/);
    assert.match(generator, /capabilityVersion: 1/);
    assert.match(generator, /createCipheriv\('aes-256-gcm'/);
    assert.match(generator, /namespace: 'crazyloops:connector-runner:credential-capsule:v1'/);
    assert.match(generator, /cipher\.setAAD\(aad\)/);
    assert.match(generator, /now \+ 90_000/);
    assert.match(generator, /createHash\('sha256'\)\.update\(body\)/);
    assert.match(generator, /createHmac\('sha256', transportSecret\)\.update\(`\$\{timestamp\}\.\$\{requestId\}\.\$\{digest\}`\)/);
    assert.match(generator, /x-crazyloops-signature/);
    assert.match(generator, /transportBytes\.fill\(0\); wrapping\.fill\(0\); credential\.fill\(0\)/);
  });

  test("one canonical transport secret signs every valid bundle and configures the Runner", () => {
    const generator = section("node - \"$SECRET_DIR\" <<'NODE'", "\nNODE\n");
    assert.match(generator, /const transportBytes = randomBytes\(48\);/);
    assert.match(generator, /const transportSecret = transportBytes\.toString\('base64url'\);/);
    assert.equal((generator.match(/transportBytes\.toString\(/g) ?? []).length, 1);
    assert.match(generator, /CONNECTOR_RUNNER_SECRET=\$\{transportSecret\}/);
    assert.doesNotMatch(generator, /createHmac\('sha256', transport(?:Bytes)?\)/);
    assert.match(generator, /const wrapping = randomBytes\(32\);/);
    for (const [kind, mode] of [["primary", "TEST"], ["live", "LIVE"], ["unavailable", "TEST"]]) {
      assert.ok(generator.includes(`writeBundle('${kind}', '${mode}');`));
    }
    assert.match(generator, /writeBundle\('badSignature', 'TEST', true\)/);
    assert.match(generator, /invalidSignature \? '0'\.repeat\(64\) : createHmac\('sha256', transportSecret\)/);
    assert.doesNotMatch(generator, /console\.|process\.(?:stdout|stderr)|ARTIFACT_DIR/);
    assert.doesNotMatch(HARNESS, /(?:printf|echo|console\.)[^\n]*(?:transportSecret|transportBytes)/);
  });

  test("generated bundles match the real Runner signing contract without host or provider I/O", () => {
    const opener = "node - \"$SECRET_DIR\" <<'NODE'\n";
    const generator = section(opener, "\nNODE\n").slice(opener.length);
    const files = new Map<string, { data: string; mode: number }>();
    const buffers: Buffer[] = [];
    const crypto = {
      createCipheriv, createHash, createHmac,
      // Public deterministic test material; never use production credentials.
      randomBytes(size: number) {
        const value = Buffer.alloc(size, buffers.length + 1);
        buffers.push(value);
        return value;
      },
    };
    const fs = {
      writeFileSync(path: string, value: string | Buffer, options: { mode: number }) {
        files.set(basename(path), { data: value.toString(), mode: options.mode });
      },
    };
    runInNewContext(generator, {
      Buffer,
      Date: { now: () => 1_800_000_000_000 },
      process: { argv: ["node", "-", "in-memory-test-secrets"] },
      require(name: string) {
        if (name === "node:fs") return fs;
        if (name === "node:path") return { join };
        if (name === "node:crypto") return crypto;
        throw new Error("Unexpected generator dependency.");
      },
      console: { log() { assert.fail("Generator must not log secret material."); } },
    }, { timeout: 1000 });

    const environment = Object.fromEntries(files.get("runner.env")!.data.trim().split("\n").map((line) => {
      const separator = line.indexOf("=");
      return [line.slice(0, separator), line.slice(separator + 1)];
    }));
    const secret = environment.CONNECTOR_RUNNER_SECRET;
    assert.match(secret, /^[A-Za-z0-9_-]{64}$/);
    assert.notEqual(secret, environment.CONNECTOR_RUNNER_WRAP_KEY_V1);
    for (const kind of ["primary", "live", "unavailable", "badSignature"]) {
      const bundle = JSON.parse(files.get(`${kind}.json`)!.data) as { body: string; headers: Record<string, string> };
      const digest = bodyDigest(bundle.body);
      assert.equal(bundle.headers["x-crazyloops-content-sha256"], digest);
      const signature = transportSignature({
        secret,
        timestamp: bundle.headers["x-crazyloops-timestamp"],
        requestId: bundle.headers["x-crazyloops-request-id"],
        digest,
      });
      if (kind === "badSignature") {
        assert.equal(bundle.headers["x-crazyloops-signature"], `v1=${"0".repeat(64)}`);
        assert.notEqual(bundle.headers["x-crazyloops-signature"], `v1=${signature}`);
      } else {
        assert.equal(bundle.headers["x-crazyloops-signature"], `v1=${signature}`);
      }
    }
    for (const [name, file] of files) {
      assert.equal(file.mode, 0o600);
      if (name !== "runner.env") assert.equal(file.data.includes(secret), false);
    }
    assert.ok(buffers[0].every((byte) => byte === 0), "Temporary transport bytes must be cleared.");
    assert.ok(buffers[1].every((byte) => byte === 0), "Independent wrapping bytes must be cleared.");
  });

  test("primary proof requires the real provider authentication failure and exactly one path", () => {
    const primary = section("STAGE='primary-real-provider-401'", "STAGE='replay-live-signature-matrix'");
    assert.match(primary, /primary-response\.json/);
    assert.match(primary, /expect_runner_error "\$ARTIFACT_DIR\/primary-response\.json" 200 DELEGATED_AUTH_FAILED false/);
    assert.match(primary, /count_supervisor_starts.*== '1'/);
    assert.match(primary, /count_broker_registrations.*== '1'/);
    assert.match(primary, /count_broker_connections.*== '1'/);
    assert.match(HARNESS, /piece_egress_broker_connection/);
    assert.match(HARNESS, /hostname===\?*"api\.hubapi\.com"|e\.hostname===\?*"api\.hubapi\.com"/);
    assert.match(HARNESS, /upstreamConnections===1/);
    assert.match(HARNESS, /outcome===\?*"PIECE_BROKER_SUCCEEDED"|e\.outcome===\?*"PIECE_BROKER_SUCCEEDED"/);
    assert.match(primary, /RUNNER_TO_SUPERVISOR_REAL_PROVIDER_401=PASS/);
    assert.match(primary, /ONE_RUNNER_TO_SUPERVISOR_REQUEST=PASS/);
    assert.match(primary, /ONE_SUPERVISOR_INVOCATION=PASS/);
    assert.match(primary, /ONE_PROVIDER_CONNECTION=PASS/);
    assert.match(primary, /NO_AUTOMATIC_RETRY=PASS/);
  });

  test("replay, LIVE, and bad signature are blocked before Supervisor or provider work", () => {
    const matrix = section("STAGE='replay-live-signature-matrix'", "STAGE='supervisor-unavailable'");
    assert.match(matrix, /primary\.json.*replay-response\.json/);
    assert.match(matrix, /DELEGATED_REPLAYED false/);
    assert.match(matrix, /live\.json.*live-response\.json/);
    assert.match(matrix, /DELEGATED_UNSUPPORTED_CAPABILITY false/);
    assert.match(matrix, /badSignature\.json.*bad-signature-response\.json/);
    assert.match(matrix, /DELEGATED_AUTH_FAILED false/);
    assert.match(matrix, /count_supervisor_starts.*LIVE_REQUEST_ID.*== '0'/);
    assert.match(matrix, /count_supervisor_starts.*BAD_SIGNATURE_REQUEST_ID.*== '0'/);
    assert.match(matrix, /count_broker_connections.*LIVE_REQUEST_ID.*== '0'/);
    assert.match(matrix, /count_broker_connections.*BAD_SIGNATURE_REQUEST_ID.*== '0'/);
    assert.match(matrix, /RUNNER_REPLAY_BLOCKED_BEFORE_SUPERVISOR=PASS/);
    assert.match(matrix, /RUNNER_LIVE_BLOCKED_BEFORE_SUPERVISOR=PASS/);
    assert.match(matrix, /RUNNER_BAD_SIGNATURE_BLOCKED=PASS/);
  });

  test("Supervisor unavailability is tested only after graceful disposable shutdown", () => {
    const unavailable = section("STAGE='supervisor-unavailable'", "STAGE='event-and-crossover-proof'");
    assert.match(unavailable, /docker stop --time 20 "\$SUPERVISOR_NAME"/);
    assert.match(unavailable, /unavailable\.json.*unavailable-response\.json/);
    assert.match(unavailable, /DELEGATED_UNAVAILABLE true/);
    assert.match(unavailable, /count_broker_connections.*UNAVAILABLE_REQUEST_ID.*== '0'/);
    assert.match(unavailable, /RUNNER_SUPERVISOR_UNAVAILABLE_FAIL_CLOSED=PASS/);
    assert.doesNotMatch(unavailable, /docker start|docker restart/);
  });

  test("Docker events prove one sandbox creation and no blocked-path creations", () => {
    assert.match(HARNESS, /docker events --since "\$EVENTS_SINCE" --until "\$EVENTS_UNTIL"/);
    assert.match(HARNESS, /--filter 'label=crazyloops\.resource=invocation'/);
    assert.match(HARNESS, /counts\.get\(ids\[0\]\)!==1/);
    assert.match(HARNESS, /counts\.get\(ids\[1\]\)!==0/);
    assert.match(HARNESS, /counts\.get\(ids\[2\]\)!==0/);
    assert.match(HARNESS, /counts\.get\(ids\[3\]\)!==0/);
  });

  test("credential crossover scans logs, Docker metadata, Redis, events, and control files", () => {
    const scan = section("STAGE='event-and-crossover-proof'", "STAGE='protected-service-proof'");
    for (const surface of ["runner.log", "supervisor.log", "broker.log", "redis-keys.txt", "redis-values.txt", "invocation-create-events.jsonl"]) {
      assert.match(scan, new RegExp(surface.replace(".", "\\.")));
    }
    assert.match(scan, /docker inspect "\$RUNNER_NAME" "\$SUPERVISOR_NAME" "\$BROKER_NAME" "\$REDIS_NAME"/);
    assert.match(scan, /docker inspect[^\n]*\| \\\n\s+timeout[^\n]*node -e "\$CROSSOVER_SCAN_SOURCE"[^\n]* stdin/);
    assert.match(scan, /stdin \\\n\s+\|\| fail 'Docker metadata credential scan failed or was incomplete\.'/);
    assert.match(scan, /tree "\$ARTIFACT_DIR" \\\n\s+\|\| fail 'Artifact credential scan failed or was incomplete\.'/);
    assert.doesNotMatch(scan, /< <\(find|grep -Fq -- "\$CANARY/);
    assert.doesNotMatch(HARNESS, /find "\$CONTROL_DIR"/);
    assert.match(scan, /CREDENTIAL_CROSSOVER=0/);
  });

  test("control crossover scanner is isolated, uses read-only comparison mounts, and gates success", () => {
    const scanner = section('timeout --kill-after=5s 30s docker run --rm --name "$CROSSOVER_SCAN_NAME"',
      'set_crossover_secret_owner "$HOST_UID:$HOST_GID" || fail');
    for (const flag of ["--user=65532:65532", "--network none", "--read-only", "--cap-drop=ALL",
      "--security-opt=no-new-privileges", "--pids-limit=32", "--memory=134217728", "--memory-swap=134217728", "--cpus=0.25"]) {
      assert.ok(scanner.includes(flag));
    }
    assert.match(scanner, /--label "\$OWNER_LABEL"/);
    assert.match(scanner, /src="\$CONTROL_DIR",dst=\/control,readonly/);
    assert.match(scanner, /src="\$SECRET_DIR\/canary\.txt",dst=\/secret\/canary\.txt,readonly/);
    assert.match(scanner, /src="\$SECRET_DIR\/canary-b64\.txt",dst=\/secret\/canary-b64\.txt,readonly/);
    assert.equal((scanner.match(/--mount /g) ?? []).length, 3);
    assert.match(scanner, /--entrypoint node "\$SUPERVISOR_IMAGE" -e "\$CROSSOVER_SCAN_SOURCE"/);
    const dockerOptions = scanner.slice(0, scanner.indexOf('--entrypoint node'));
    assert.doesNotMatch(dockerOptions, /--env|--cap-add|--privileged|\$CANARY|docker\.sock|--publish|(?:^|\s)-[pe](?:\s|=)/);
    assert.doesNotMatch(scanner, /\$CANARY(?:_B64)?/);
    assert.match(scanner, /\|\| fail 'Control directory credential scan failed or was incomplete\.'/);
    const proof = section("STAGE='control-directory-crossover-proof'", "STAGE='protected-service-proof'");
    assert.ok(proof.indexOf("|| fail 'Control directory credential scan failed") < proof.indexOf("CREDENTIAL_CROSSOVER=0"));
    assert.equal((HARNESS.match(/printf 'CREDENTIAL_CROSSOVER=0/g) ?? []).length, 1);
    assert.doesNotMatch(proof, /chmod|restore_control_ownership|chown.*\/control/);
  });

  test("scanner comparison ownership is narrowly transferred and restored before secure cleanup", () => {
    const handoff = section("set_crossover_secret_owner()", "credential_scan_source()");
    assert.match(handoff, /remove_owned_container "\$CONTROL_RESTORE_NAME" \|\| return 1/);
    assert.match(handoff, /--name "\$CONTROL_RESTORE_NAME" --label "\$OWNER_LABEL"/);
    assert.match(handoff, /--cap-drop=ALL --cap-add=CHOWN/);
    assert.equal((handoff.match(/--mount /g) ?? []).length, 2);
    assert.doesNotMatch(handoff, /src="\$CONTROL_DIR"|--env|\$CANARY|chmod|--privileged/);
    assert.match(handoff, /"\$owner" \/secret\/canary\.txt \/secret\/canary-b64\.txt/);
    const proof = section("STAGE='control-directory-crossover-proof'", "STAGE='protected-service-proof'");
    assert.match(proof, /CROSSOVER_SECRET_OWNERSHIP_CHANGED=1\nset_crossover_secret_owner '65532:65532' \|\| fail/);
    assert.match(proof, /set_crossover_secret_owner "\$HOST_UID:\$HOST_GID" \|\| fail/);
    const cleanup = section("cleanup()", "preflight_cleanup()");
    assert.match(cleanup, /remove_owned_container "\$CROSSOVER_SCAN_NAME" \|\| status=1/);
    assert.match(cleanup, /CROSSOVER_SECRET_OWNERSHIP_CHANGED.*== '1'/);
    assert.ok(cleanup.indexOf('set_crossover_secret_owner "$HOST_UID:$HOST_GID"') < cleanup.indexOf('secure_delete_directory "$SECRET_DIR"'));
    assert.match(cleanup, /for name in [^\n]*"\$CROSSOVER_SCAN_NAME"/);
    const preflight = section("command -v docker", "snapshot_protected \"$ARTIFACT_DIR/protected-before.txt\"");
    assert.match(preflight, /for name in [^\n]*"\$CROSSOVER_SCAN_NAME"/);
    assert.doesNotMatch(HARNESS, /docker(?: system| container| image| volume| network)? prune/);
  });

  describe("credential scanner logic with disposable filesystem fixtures", () => {
    const opener = "  cat <<'SCAN_NODE'\n";
    const source = section(opener, "\nSCAN_NODE\n").slice(opener.length);
    const canary = "public-test-canary-not-a-real-credential";
    function fixture() {
      const base = fileSystem.mkdtempSync(join(tmpdir(), "crazyloops-crossover-unit-"));
      const control = join(base, "control");
      fileSystem.mkdirSync(control);
      const plaintext = join(base, "canary.txt");
      const encoded = join(base, "canary-b64.txt");
      fileSystem.writeFileSync(plaintext, canary, { mode: 0o600 });
      fileSystem.writeFileSync(encoded, Buffer.from(canary).toString("base64"), { mode: 0o600 });
      return { base, control, plaintext, encoded };
    }
    function runScanner(value: ReturnType<typeof fixture>, overrides: Record<string, unknown> = {}) {
      const state = { argv: ["node", value.plaintext, value.encoded, "tree", value.control, "piece-supervisor.sock"], exitCode: 0 };
      const output: unknown[] = [];
      runInNewContext(source, {
        Buffer, process: state,
        console: { log: (...args: unknown[]) => output.push(args), error: (...args: unknown[]) => output.push(args) },
        require(name: string) {
          if (name === "node:fs") return { ...fileSystem, ...overrides };
          if (name === "node:path") return { join };
          throw new Error("Unexpected scanner dependency.");
        },
      }, { timeout: 2000 });
      assert.deepEqual(output, []);
      return state.exitCode;
    }
    test("clean nested regular files and empty directories succeed", () => {
      const value = fixture();
      try {
        fileSystem.mkdirSync(join(value.control, "nested"));
        fileSystem.writeFileSync(join(value.control, "nested", "clean.txt"), "No credential material.");
        assert.equal(runScanner(value), 0);
      } finally { fileSystem.rmSync(value.base, { recursive: true, force: true }); }
    });
    for (const [label, data] of [
      ["plaintext", canary],
      ["Base64", Buffer.from(canary).toString("base64")],
      ["cross-chunk plaintext", "x".repeat(65_530) + canary],
    ]) test(`${label} crossover fails without output`, () => {
      const value = fixture();
      try {
        fileSystem.writeFileSync(join(value.control, "leak.txt"), data);
        assert.equal(runScanner(value), 1);
      } finally { fileSystem.rmSync(value.base, { recursive: true, force: true }); }
    });
    test("directory traversal errors and unreadable regular files fail closed", () => {
      const value = fixture();
      try {
        const unreadable = join(value.control, "unreadable.txt");
        fileSystem.writeFileSync(unreadable, "safe contents");
        assert.equal(runScanner(value, { readdirSync() { throw new Error("EACCES"); } }), 1);
        assert.equal(runScanner(value, { openSync(file: string, flags: number) {
          if (file === unreadable) throw new Error("EACCES");
          return fileSystem.openSync(file, flags);
        } }), 1);
      } finally { fileSystem.rmSync(value.base, { recursive: true, force: true }); }
    });
    test("missing comparison data or scan root fails closed", () => {
      const value = fixture();
      try {
        assert.equal(runScanner({ ...value, control: join(value.base, "missing") }), 1);
        fileSystem.writeFileSync(value.plaintext, "");
        assert.equal(runScanner(value), 1);
      } finally { fileSystem.rmSync(value.base, { recursive: true, force: true }); }
    });
    test("only the expected root Unix socket is ignored; symlinks and other types fail", () => {
      const value = fixture();
      try {
        const entry = join(value.control, "piece-supervisor.sock");
        fileSystem.writeFileSync(entry, "socket fixture");
        const types = (type: "socket" | "symlink" | "other") => ({ lstatSync(file: string) {
          const actual = fileSystem.lstatSync(file);
          if (file !== entry) return actual;
          return Object.assign(Object.create(actual), {
            isFile: () => false, isDirectory: () => false,
            isSocket: () => type === "socket", isSymbolicLink: () => type === "symlink",
          });
        } });
        assert.equal(runScanner(value, types("socket")), 0);
        assert.equal(runScanner(value, types("symlink")), 1);
        assert.equal(runScanner(value, types("other")), 1);
        fileSystem.mkdirSync(join(value.control, "nested"));
        fileSystem.renameSync(entry, join(value.control, "nested", "piece-supervisor.sock"));
        assert.equal(runScanner(value, { lstatSync(file: string) {
          const actual = fileSystem.lstatSync(file);
          if (!file.endsWith("piece-supervisor.sock")) return actual;
          return Object.assign(Object.create(actual), { isFile: () => false, isSocket: () => true });
        } }), 1);
      } finally { fileSystem.rmSync(value.base, { recursive: true, force: true }); }
    });
  });

  test("failure evidence is bounded, sanitized, mode 0700, and secret files are destroyed", () => {
    const diagnostics = section("capture_failure_evidence()", "sanitize_failure_evidence()");
    assert.match(diagnostics, /docker logs --tail 500/);
    assert.match(diagnostics, /\.State\.Running.*\.RestartCount/);
    assert.match(diagnostics, /failure-summary\.txt/);
    assert.doesNotMatch(diagnostics, /docker inspect "\$name" >"\$ARTIFACT_DIR/);
    const sanitizer = section("sanitize_failure_evidence()", "read_invocation_meta()");
    assert.match(sanitizer, /grep -Fq -- "\$CANARY"/);
    assert.match(sanitizer, /grep -Fq -- "\$CANARY_B64"/);
    assert.match(HARNESS, /chmod 0700 "\$CONTROL_DIR" "\$ARTIFACT_DIR" "\$SECRET_DIR"/);
    assert.match(HARNESS, /shred -u -z -- "\$file"/);
    assert.match(HARNESS, /secure_delete_directory "\$SECRET_DIR"/);
    assert.match(HARNESS, /EVIDENCE_DIR=%s/);
  });

  test("cleanup is exact-resource and label scoped with zero-resource assertions", () => {
    const cleanup = section("cleanup()", "preflight_cleanup()");
    for (const helper of [
      "remove_owned_container", "remove_owned_network", "remove_owned_volume", "remove_owned_image",
      "cleanup_invocation_resources", "restore_control_ownership", "secure_delete_directory",
    ]) assert.match(cleanup, new RegExp(helper));
    assert.doesNotMatch(cleanup, /docker ps -aq.*xargs|docker network ls.*xargs|name=cl-piece-/);
    assert.match(cleanup, /remaining_containers/);
    assert.match(cleanup, /remaining_networks/);
    assert.match(cleanup, /remaining_volumes/);
    assert.match(cleanup, /remaining_images/);
    assert.match(cleanup, /STEP5B2B_CLEANUP=PASS/);
    assert.match(cleanup, /STEP5B2B HOST ACCEPTANCE=PASS/);
  });

  test("frozen runtime and product paths are guarded and no deployment path exists", () => {
    assert.match(HARNESS, /git diff --quiet "\$ACCEPTED_PARENT"\.\.HEAD -- services\/piece-runtime services\/connector-runner\/src app lib supabase/);
    assert.doesNotMatch(HARNESS, /git push|git merge|git checkout|git reset|vercel deploy|supabase db push/);
    assert.match(HARNESS, /PRODUCT_DEPLOYMENT=NOT_PERFORMED_BY_HARNESS/);
    assert.doesNotMatch(HARNESS, /FLOWMIND_CONNECTOR|NEXT_PUBLIC_|SERVICE_ROLE/);
  });
});
