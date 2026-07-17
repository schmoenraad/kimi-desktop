#!/usr/bin/env bash
# Dev tool: create the demo workspaces used by the published screenshots.
#
#   ./scripts/seed-demo.sh && npm run screenshots
#
# The screenshot script only renders workspaces named landing-page / api-server
# and hard fails if any real workspace is visible, so this seeds those two with
# a small, generic project and one real conversation each.
#
# Costs a couple of cheap API calls. Remove the demo data afterwards with:
#   ./scripts/seed-demo.sh --clean
set -euo pipefail

DEMO_ROOT="${TMPDIR:-/tmp}/kimi-demo"
KIMI="${KIMI_BIN:-kimi}"
MODEL="${KIMI_MODEL:-kimi-code/kimi-for-coding-highspeed}"

if [[ "${1:-}" == "--clean" ]]; then
  rm -rf "$DEMO_ROOT"
  echo "removed $DEMO_ROOT — remove the workspaces in the app sidebar to finish"
  exit 0
fi

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

echo "seeding landing-page conversation…"
(cd "$DEMO_ROOT/landing-page" && "$KIMI" -m "$MODEL" -p \
  "Read src/components/PricingGrid.tsx and tell me briefly what it renders and how the tiers are structured. Keep it to 3 sentences, no code changes." >/dev/null)

echo "seeding api-server conversation…"
(cd "$DEMO_ROOT/api-server" && "$KIMI" -m "$MODEL" -p \
  "Read src/index.js and say in one sentence what endpoint this server exposes. No code changes." >/dev/null)

echo "demo data ready at $DEMO_ROOT — now run: npm run screenshots"
