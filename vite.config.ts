import { defineConfig } from "vite";

// Fixed port (never silently shifts to another one — fails loudly instead
// via strictPort if it's ever unavailable) and a forced full-page reload on
// every source change, since this app's plain-TS modules (no framework)
// often don't accept Vite's granular HMR updates cleanly, leaving stale
// state on screen until a manual reload.
export default defineConfig({
  server: {
    port: 5179,
    strictPort: true,
    // The backend (server/) writes its own runtime artifacts under this
    // directory tree while the app is in use (journal HTML pages, reflection
    // JSON, usage counters) — without this, Vite's default watcher treats
    // every one of those writes as a frontend source change and (with the
    // force-full-reload plugin below) reloads the page mid-conversation.
    // Only server/*.ts source itself needs watching, and that already
    // requires a manual `npm run server` restart to take effect (no
    // hot-reload there — see CLAUDE.md), so excluding the whole tree costs
    // nothing.
    watch: {
      ignored: ["**/server/**"],
    },
  },
  plugins: [
    {
      name: "force-full-reload",
      handleHotUpdate({ server }) {
        server.ws.send({ type: "full-reload" });
        return [];
      },
    },
  ],
});
