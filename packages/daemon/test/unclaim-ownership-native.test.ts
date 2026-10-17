import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import { createTestApp } from "./helpers/test-app.js";

let nativeAvailable = process.platform !== "win32";
try { execFileSync("tmux", ["-V"], { timeout: 2000, stdio: "ignore" }); } catch { nativeAvailable = false; }

describe.skipIf(!nativeAvailable)("claimed-session custody with native tmux", () => {
  let db: Database.Database;
  let setup: ReturnType<typeof createTestApp>;
  let run: (...args: string[]) => Promise<string>;

  beforeEach(async () => {
    const socket = `openrig-unclaim-test-${process.pid}-${Date.now()}`;
    const execute = promisify(execFile);
    run = async (...args) => (await execute("tmux", ["-L", socket, "-f", "/dev/null", ...args], { timeout: 5000 })).stdout;
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    const adapter = new TmuxAdapter(async () => { throw new Error("expected argv transport"); }, undefined,
      async argv => run(...argv.slice(1)));
    adapter.deliveryGuard = new SeatDeliveryGuard(db, target => resolveGuardTarget(db, target));
    setup = createTestApp(db, { tmux: adapter });
    await run("new-session", "-d", "-s", "manual-adoption", "cat");
  });
  afterEach(async () => {
    await run("kill-server").catch(() => {});
    db.close();
  });

  async function claimSeat() {
    const rig = setup.rigRepo.createRig("native-adoption");
    const node = setup.rigRepo.addNode(rig.id, "external.helper", { runtime: "terminal" });
    const pane = (await run("display-message", "-p", "-t", "=manual-adoption", "#{pane_id}")).trim();
    const discovered = setup.discoveryRepo.upsertDiscoveredSession({
      tmuxSession: "manual-adoption", tmuxPane: pane, cwd: "/tmp",
      activeCommand: "cat", runtimeHint: "terminal", confidence: "high",
    });
    const bind = () => setup.claimService.bind({ discoveredId: discovered.id, rigId: rig.id, logicalId: node.logicalId });
    const first = await bind();
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.error);
    return { node, discovered, first, bind };
  }

  it("preserves the physical session and its new metadata after an old-ID retry", async () => {
    const { node, first, bind } = await claimSeat();
    expect((await setup.rigLifecycleService.unclaimSession(first.sessionId)).ok).toBe(true);
    expect((await bind()).ok).toBe(true);
    const before = await run("show-options", "-qv", "-t", "=manual-adoption:", "@rigged_node_id");
    expect(before.trim()).toBe(node.id);
    const pid = await run("display-message", "-p", "-t", "=manual-adoption", "#{pane_pid}");
    const response = await setup.app.request(`/api/sessions/${first.sessionId}/unclaim`, { method: "POST" });
    expect(await run("show-options", "-qv", "-t", "=manual-adoption:", "@rigged_node_id")).toBe(before);
    expect(await run("display-message", "-p", "-t", "=manual-adoption", "#{pane_pid}")).toBe(pid);
    expect(response.status).toBe(409);
    expect(setup.sessionRegistry.getBindingForNode(node.id)?.tmuxSession).toBe("manual-adoption");
  });

  it("ordinary unclaim clears only managed metadata and leaves the external process alive", async () => {
    const { node, discovered, first } = await claimSeat();
    expect((await run("show-options", "-qv", "-t", "=manual-adoption:", "@rigged_node_id")).trim()).toBe(node.id);
    const pid = await run("display-message", "-p", "-t", "=manual-adoption", "#{pane_pid}");
    const response = await setup.app.request(`/api/sessions/${first.sessionId}/unclaim`, { method: "POST" });
    expect(response.status).toBe(200);
    expect((await run("show-options", "-qv", "-t", "=manual-adoption:", "@rigged_node_id")).trim()).toBe("");
    expect(await run("display-message", "-p", "-t", "=manual-adoption", "#{pane_pid}")).toBe(pid);
    expect(setup.sessionRegistry.getBindingForNode(node.id)).toBeNull();
    expect(setup.discoveryRepo.getDiscoveredSession(discovered.id)?.status).toBe("active");
  });
});
