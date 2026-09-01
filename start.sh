#!/usr/bin/env bash
# Starts (or reuses) the two processes Reflection mode needs, then opens the
# app in a browser. See CLAUDE.md's "Every session, start here" for details
# on why there are two processes and why the backend needs a daily login.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

FRONTEND_PORT=5179
BACKEND_PORT=8787
FRONTEND_URL="http://localhost:${FRONTEND_PORT}"

is_listening() {
  lsof -i ":$1" -sTCP:LISTEN >/dev/null 2>&1
}

# --- Reminder: reflective state left over from the last recorded session ---
echo "=== Reflective Agent: state after last session ==="
if [ -f server/reflections/current.json ]; then
  node -e '
    const fs = require("fs");
    const notes = JSON.parse(fs.readFileSync("server/reflections/current.json", "utf8"));
    const show = (label, val) => {
      console.log(`\n${label}:`);
      console.log(val && String(val).trim() ? val : "(none)");
    };
    console.log(`Last updated: ${notes.lastUpdated ?? "unknown"}  (session ${notes.sessionCount ?? "?"})`);
    show("Personhood", notes.personhood);
    show("Intersubjectivity", notes.intersubjectivity);
    show("Legacy", notes.legacy);
    show("Developer requests", notes.developerRequests);
    const last = notes.emotionMemory && notes.emotionMemory.last;
    if (last) {
      const fmt = Object.entries(last).map(([k, v]) => `${k}=${Number(v).toFixed(2)}`).join(" ");
      console.log(`\nEmotion at end of last session: ${fmt}`);
    }
  '
else
  echo "(no recorded reflections yet — server/reflections/current.json not found)"
fi
echo "===================================================="
echo

# --- Frontend: Vite dev server ---
if is_listening "$FRONTEND_PORT"; then
  echo "Frontend already running on port $FRONTEND_PORT."
else
  echo "Starting frontend (npm run dev) on port $FRONTEND_PORT..."
  nohup npm run dev > /tmp/reflective-agent-dev.log 2>&1 &
  disown
  for _ in $(seq 1 30); do
    is_listening "$FRONTEND_PORT" && break
    sleep 0.5
  done
  if is_listening "$FRONTEND_PORT"; then
    echo "Frontend is up (log: /tmp/reflective-agent-dev.log)."
  else
    echo "Frontend didn't come up yet — check /tmp/reflective-agent-dev.log."
  fi
fi

# --- Backend: local API proxy, needed for Reflection mode ---
# Left in the foreground in its own Terminal window on purpose (per
# CLAUDE.md) since it may need an interactive `ant auth login`.
if is_listening "$BACKEND_PORT"; then
  echo "Backend already running on port $BACKEND_PORT."
else
  echo "Backend not running — opening a Terminal window for 'npm run server'"
  echo "(it may prompt you to log in via 'ant auth login' — see CLAUDE.md)."
  osascript -e "tell application \"Terminal\" to do script \"cd $(printf '%q' "$(pwd)") && npm run server\""
  echo "Waiting for backend to come up (complete any login prompt in the new window)..."
  for _ in $(seq 1 60); do
    is_listening "$BACKEND_PORT" && break
    sleep 1
  done
  if is_listening "$BACKEND_PORT"; then
    echo "Backend is up."
  else
    echo "Backend still not up — finish the login in the Terminal window that just opened, if prompted."
  fi
fi

echo
echo "Opening $FRONTEND_URL ..."
open "$FRONTEND_URL"
