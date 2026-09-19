#!/usr/bin/env bash
# LBV2-29/LBV2-27 — static check of Authentik blueprints (no stack needed; Docker parses the YAML).
# Rules and implementation: tests/blueprint-check.ts. Usage: tests/blueprint-check.sh [blueprint.yaml ...]
set -uo pipefail
cd "$(dirname "$0")/.."
(( $# )) || set -- authentik/blueprints/*.yaml
exec node tests/blueprint-check.ts "$@"
