#!/usr/bin/env bash
# Dev tool: create the demo workspaces used by the published screenshots.
#
#   ./scripts/seed-demo.sh && npm run screenshots
#
# The screenshot script only renders workspaces named landing-page / api-server
# and hard fails if any real workspace is visible, so this seeds those two with
# a small, generic project and one real conversation each.
#
# Sessions are created through the local server's REST API (not `kimi -p`), so
# they are server-native: titled, with full transcripts the web UI can render.
# Costs a couple of cheap API calls. Remove the demo data afterwards with:
#   ./scripts/seed-demo.sh --clean
set -euo pipefail

DEMO_ROOT="${TMPDIR:-/tmp}/kimi-demo"
PORT="${KIMI_PORT:-58627}"
BASE="http://127.0.0.1:${PORT}/api/v1"
TOKEN_FILE="$HOME/.kimi-code/server.token"
MODEL="${KIMI_MODEL:-kimi-code/kimi-for-coding-highspeed}"

if [[ "${1:-}" == "--clean" ]]; then
  rm -rf "$DEMO_ROOT"
  echo "removed $DEMO_ROOT — remove the workspaces in the app sidebar to finish"
  exit 0
fi

TOKEN=$(tr -d '[:space:]' < "$TOKEN_FILE")
auth=(-H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json")

curl -sf -m 5 -H "Authorization: Bearer $TOKEN" "$BASE/healthz" >/dev/null || {
  echo "kimi server not responding on port $PORT — start the app or: kimi web --no-open --port $PORT" >&2
  exit 1
}

rm -rf "$DEMO_ROOT"
mkdir -p "$DEMO_ROOT/landing-page/src/components" "$DEMO_ROOT/api-server/src"

cat > "$DEMO_ROOT/landing-page/package.json" <<'EOF'
{ "name": "landing-page", "version": "1.0.0", "private": true }
EOF

cat > "$DEMO_ROOT/landing-page/src/components/Hero.tsx" <<'EOF'
export function Hero() {
  return (
    <section className="hero">
      <h1>Ship faster with Acme</h1>
      <p>The all-in-one toolkit for modern teams.</p>
      <button className="cta">Start free trial</button>
    </section>
  );
}
EOF

cat > "$DEMO_ROOT/landing-page/src/components/PricingGrid.tsx" <<'EOF'
const TIERS = [
  { name: "Starter", price: 0, seats: 1 },
  { name: "Team", price: 29, seats: 10 },
  { name: "Business", price: 99, seats: 50 },
];

export function PricingGrid() {
  return (
    <section className="pricing">
      {TIERS.map((t) => (
        <div key={t.name} className="tier">
          <h3>{t.name}</h3>
          <p className="price">${t.price}/mo</p>
          <p className="seats">Up to {t.seats} seats</p>
        </div>
      ))}
    </section>
  );
}
EOF

cat > "$DEMO_ROOT/api-server/package.json" <<'EOF'
{ "name": "api-server", "version": "1.0.0", "private": true }
EOF

cat > "$DEMO_ROOT/api-server/src/index.js" <<'EOF'
const express = require("express");
const app = express();

app.get("/health", (req, res) => res.json({ ok: true }));

app.listen(3000);
EOF

json_get() { python3 -c "import json,sys; print(json.load(sys.stdin)$1)"; }

seed_conversation() {
  local dir="$1" prompt="$2"
  local sid payload
  payload=$(DIR="$dir" python3 -c 'import json,os;print(json.dumps({"metadata":{"cwd":os.environ["DIR"]}}))')
  sid=$(curl -sf -m 15 "${auth[@]}" -X POST "$BASE/sessions" -d "$payload" | json_get "['data']['id']")
  payload=$(PROMPT="$prompt" MODEL="$MODEL" python3 -c 'import json,os;print(json.dumps({"content":[{"type":"text","text":os.environ["PROMPT"]}],"model":os.environ["MODEL"],"permission_mode":"auto"}))')
  curl -sf -m 15 "${auth[@]}" -X POST "$BASE/sessions/$sid/prompts" -d "$payload" >/dev/null
  # Wait for the turn to finish (busy flips false with a last_turn_reason).
  for _ in $(seq 1 60); do
    sleep 3
    local state
    state=$(curl -sf -m 10 -H "Authorization: Bearer $TOKEN" "$BASE/sessions/$sid")
    if [[ $(echo "$state" | json_get "['data'].get('busy')") == "False" ]] && \
       [[ $(echo "$state" | json_get "['data'].get('last_turn_reason')") != "None" ]]; then
      echo "  done: $sid"
      return 0
    fi
  done
  echo "  WARNING: $sid still busy after 3 min — continuing anyway" >&2
}

echo "seeding landing-page conversation…"
seed_conversation "$DEMO_ROOT/landing-page" \
  "Read src/components/PricingGrid.tsx and tell me briefly what it renders and how the tiers are structured. Keep it to 3 sentences, no code changes."

echo "seeding api-server conversation…"
seed_conversation "$DEMO_ROOT/api-server" \
  "Read src/index.js and say in one sentence what endpoint this server exposes. No code changes."

echo "demo data ready at $DEMO_ROOT — now run: npm run screenshots"
