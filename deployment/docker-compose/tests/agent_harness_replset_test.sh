#!/usr/bin/env bash
set -euo pipefail

compose_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
project_name="pipeshub-agent-harness-rs-${RANDOM}-${RANDOM}"
mongo_password="agent-harness-test-password"

compose=(
  docker compose
  --env-file /dev/null
  --project-name "${project_name}"
  --file "${compose_dir}/docker-compose.yml"
  --file "${compose_dir}/docker-compose.agent-harness.yml"
  --file "${compose_dir}/tests/docker-compose.agent-harness.test.yml"
)

cleanup() {
  "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

export MONGO_PASSWORD="${mongo_password}"
export MONGO_USERNAME=admin
export REDIS_PASSWORD=agent-harness-test-redis-password
# SEC-D-06: Compose renders only with every store's credential.
export QDRANT_API_KEY=agent-harness-test-qdrant-key KAFKA_PASSWORD=agent-harness-test-kafka-password

"${compose[@]}" config --quiet
"${compose[@]}" up --detach --wait mongodb

transaction_script='const s=db.getMongo().startSession(); const d=s.getDatabase("agent_harness_compose_test"); s.startTransaction(); d.a.insertOne({_id:1}); d.b.insertOne({_id:1}); s.commitTransaction(); const ok=d.a.countDocuments({_id:1})===1 && d.b.countDocuments({_id:1})===1; d.dropDatabase(); s.endSession(); quit(ok ? 0 : 1);'

run_transaction() {
  "${compose[@]}" exec --no-TTY mongodb mongosh \
    --quiet \
    --host localhost \
    --username "${MONGO_USERNAME}" \
    --password "${MONGO_PASSWORD}" \
    --authenticationDatabase admin \
    --eval "${transaction_script}"
}

run_transaction

if [[ "${AGENT_HARNESS_RUN_NODE_ADMISSION_TEST:-false}" == "true" ]]; then
  mongo_endpoint=$("${compose[@]}" port mongodb 27017)
  mongo_port=${mongo_endpoint##*:}
  repo_dir=$(cd "${compose_dir}/../.." && pwd)
  (
    cd "${repo_dir}/backend/nodejs/apps"
    AGENT_HARNESS_TEST_MONGO_URI="mongodb://${MONGO_USERNAME}:${MONGO_PASSWORD}@127.0.0.1:${mongo_port}/?authSource=admin&replicaSet=rs0&directConnection=true" \
      TS_NODE_PROJECT=tsconfig.test.json \
      npx mocha --no-config \
        --require reflect-metadata \
        --require ts-node/register \
        --timeout 30000 \
        --extension ts \
        --exit \
        tests/integration/agent-harness/mongo-admission.integration.test.ts \
        'tests/modules/agent-harness/*.mongo.itest.ts' \
        'tests/modules/control-plane/*.mongo.itest.ts'
  )
fi

# The healthcheck that initiated the set keeps running; after a restart the
# persisted config and key must bring the member back as primary.
"${compose[@]}" restart mongodb
"${compose[@]}" up --detach --wait mongodb
run_transaction

primary=$(
  "${compose[@]}" exec --no-TTY mongodb mongosh \
    --quiet \
    --host localhost \
    --username "${MONGO_USERNAME}" \
    --password "${MONGO_PASSWORD}" \
    --authenticationDatabase admin \
    --eval 'db.hello().isWritablePrimary'
)

if [[ "${primary}" != "true" ]]; then
  echo "MongoDB replica set did not become writable primary" >&2
  exit 1
fi

echo "Agent harness MongoDB replica-set transaction test passed"
