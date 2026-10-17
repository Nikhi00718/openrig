import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { createTestApp } from "./helpers/test-app.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";

describe("unclaim preserves a successor's custody", () => {
  let db: Database.Database;
  let setup: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    setup = createTestApp(db);
    setup.tmuxAdapter.deliveryGuard = new SeatDeliveryGuard(db, target => resolveGuardTarget(db, target));
  });
  afterEach(() => { db.close(); });

  async function claimedSeat() {
    const rig = setup.rigRepo.createRig("adoption-fixture");
    const node = setup.rigRepo.addNode(rig.id, "external.helper", { runtime: "terminal" });
    const discovered = setup.discoveryRepo.upsertDiscoveredSession({
      tmuxSession: "manual-adoption", tmuxPane: "%1", cwd: "/tmp",
      activeCommand: "bash", runtimeHint: "terminal", confidence: "high",
    });
    const claim = await setup.claimService.bind({ discoveredId: discovered.id, rigId: rig.id, logicalId: node.logicalId });
    expect(claim.ok).toBe(true);
    if (!claim.ok) throw new Error(claim.error);
    return { rig, node, discovered, claim };
  }

  function barrier() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
  }

  it.each([true, false])("does not let a replayed old session ID release a newly reclaimed seat (guard=%s)", async guarded => {
    const { rig, node, discovered, claim } = await claimedSeat();
    const first = await setup.app.request(`/api/sessions/${claim.sessionId}/unclaim`, { method: "POST" });
    expect(first.status).toBe(200);
    const successor = await setup.claimService.bind({ discoveredId: discovered.id, rigId: rig.id, logicalId: node.logicalId });
    expect(successor.ok).toBe(true);
    const binding = setup.sessionRegistry.getBindingForNode(node.id);
    const discovery = setup.discoveryRepo.getDiscoveredSession(discovered.id);
    if (!guarded) setup.tmuxAdapter.deliveryGuard = undefined;
    vi.mocked(setup.tmuxAdapter.setSessionOption).mockClear();

    const replay = await setup.app.request(`/api/sessions/${claim.sessionId}/unclaim`, { method: "POST" });

    expect(setup.sessionRegistry.getBindingForNode(node.id)).toEqual(binding);
    expect(setup.discoveryRepo.getDiscoveredSession(discovered.id)).toEqual(discovery);
    expect(setup.tmuxAdapter.setSessionOption).not.toHaveBeenCalled();
    expect(replay.status).toBe(409);
  });

  it("does not let an old claimed session ID detach a launched successor", async () => {
    const { rig, node, claim } = await claimedSeat();
    expect((await setup.rigLifecycleService.unclaimSession(claim.sessionId)).ok).toBe(true);
    const launched = await setup.nodeLauncher.launchNode(rig.id, node.logicalId);
    expect(launched.ok).toBe(true);
    const binding = setup.sessionRegistry.getBindingForNode(node.id);
    vi.mocked(setup.tmuxAdapter.setSessionOption).mockClear();

    const res = await setup.app.request(`/api/sessions/${claim.sessionId}/unclaim`, { method: "POST" });

    expect(setup.sessionRegistry.getBindingForNode(node.id)).toEqual(binding);
    expect(setup.tmuxAdapter.setSessionOption).not.toHaveBeenCalled();
    expect(res.status).toBe(409);
  });

  it.each(["unclaim", "release"] as const)("serializes %s metadata cleanup with a concurrent rebind", async operation => {
    const { rig, node, discovered, claim } = await claimedSeat();
    const entered = barrier();
    const finish = barrier();
    vi.mocked(setup.tmuxAdapter.setSessionOption).mockImplementationOnce(async () => {
      entered.resolve();
      await finish.promise;
      return { ok: true };
    });
    const request = setup.app.request(operation === "unclaim"
      ? `/api/sessions/${claim.sessionId}/unclaim`
      : `/api/rigs/${rig.id}/release`, { method: "POST" });
    await entered.promise;
    let rebindEntered = false;
    const guard = setup.tmuxAdapter.deliveryGuard!;
    const rebind = guard.lifecycle([node.id], async () => {
      rebindEntered = true;
      // This is the same binding replacement performed by a lifecycle operation.
      const next = setup.sessionRegistry.registerClaimedSession(node.id, "replacement-adoption");
      setup.sessionRegistry.updateBinding(node.id, { tmuxSession: next.sessionName, tmuxPane: "%2" });
      setup.discoveryRepo.markClaimed(discovered.id, node.id);
      guard.rebindLifecycle(node.id);
      return setup.sessionRegistry.getBindingForNode(node.id);
    }).then(binding => ({ binding, error: null }), error => ({ binding: null, error }));
    // An unguarded releaser allows this operation to enter before its cleanup ends.
    await new Promise<void>(resolve => setImmediate(resolve));
    const enteredDuringCleanup = rebindEntered;
    finish.resolve();
    await request;
    const rebound = await rebind;
    expect(enteredDuringCleanup).toBe(false);
    expect(rebound.error).toMatchObject({ code: "guard_target_changed" });
    expect(setup.sessionRegistry.getBindingForNode(node.id)).toBeNull();
    const successor = await setup.claimService.bind({ discoveredId: discovered.id, rigId: rig.id, logicalId: node.logicalId });
    expect(successor.ok).toBe(true);
    expect(setup.sessionRegistry.getBindingForNode(node.id)?.tmuxSession).toBe("manual-adoption");
    expect(setup.discoveryRepo.getDiscoveredSession(discovered.id)?.status).toBe("claimed");
  });

  it("rejects an unclaim whose target changes while it waits for a lifecycle lease", async () => {
    const { node, claim } = await claimedSeat();
    const entered = barrier();
    const finish = barrier();
    const guard = setup.tmuxAdapter.deliveryGuard!;
    const lifecycle = guard.lifecycle([node.id], async () => {
      entered.resolve();
      await finish.promise;
      setup.sessionRegistry.registerClaimedSession(node.id, "replacement-adoption");
      setup.sessionRegistry.updateBinding(node.id, { tmuxSession: "replacement-adoption", tmuxPane: "%2" });
      guard.rebindLifecycle(node.id);
    });
    await entered.promise;
    vi.mocked(setup.tmuxAdapter.setSessionOption).mockClear();
    const request = setup.app.request(`/api/sessions/${claim.sessionId}/unclaim`, { method: "POST" });
    await new Promise<void>(resolve => setImmediate(resolve));
    finish.resolve();
    await lifecycle;
    const binding = setup.sessionRegistry.getBindingForNode(node.id);
    const response = await request;
    expect(response.status).toBe(409);
    expect(setup.sessionRegistry.getBindingForNode(node.id)).toEqual(binding);
    expect(setup.tmuxAdapter.setSessionOption).not.toHaveBeenCalled();
  });

  it.each(["claim", "launch", "binding"] as const)("preserves a concurrent %s during unguarded metadata cleanup", async replacement => {
    const { rig, node, discovered, claim } = await claimedSeat();
    setup.tmuxAdapter.deliveryGuard = undefined;
    const entered = barrier();
    const finish = barrier();
    vi.mocked(setup.tmuxAdapter.setSessionOption).mockImplementationOnce(async () => {
      entered.resolve();
      await finish.promise;
      return { ok: true };
    });
    const request = setup.app.request(`/api/sessions/${claim.sessionId}/unclaim`, { method: "POST" });
    await entered.promise;
    if (replacement === "binding") {
      setup.sessionRegistry.updateBinding(node.id, { tmuxSession: "replacement-adoption", tmuxPane: "%2" });
    } else {
      expect((await setup.rigLifecycleService.unclaimSession(claim.sessionId)).ok).toBe(true);
      const successor = replacement === "claim"
        ? await setup.claimService.bind({ discoveredId: discovered.id, rigId: rig.id, logicalId: node.logicalId })
        : await setup.nodeLauncher.launchNode(rig.id, node.logicalId);
      expect(successor.ok).toBe(true);
    }
    const binding = setup.sessionRegistry.getBindingForNode(node.id);
    const discovery = setup.discoveryRepo.getDiscoveredSession(discovered.id);
    const sessions = db.prepare("SELECT * FROM sessions WHERE node_id = ? ORDER BY id").all(node.id);
    const events = db.prepare("SELECT * FROM events ORDER BY seq").all();
    finish.resolve();
    const response = await request;
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "session_not_current",
      error: expect.stringContaining("Database custody was not changed."),
    });
    expect(setup.sessionRegistry.getBindingForNode(node.id)).toEqual(binding);
    expect(setup.discoveryRepo.getDiscoveredSession(discovered.id)).toEqual(discovery);
    expect(db.prepare("SELECT * FROM sessions WHERE node_id = ? ORDER BY id").all(node.id)).toEqual(sessions);
    expect(db.prepare("SELECT * FROM events ORDER BY seq").all()).toEqual(events);
  });

  it("refuses cleanup under the existing typing guard before changing custody", async () => {
    const { node, claim } = await claimedSeat();
    await setup.tmuxAdapter.deliveryGuard!.set(node.id, true, "operator", "fixture pause");
    const binding = setup.sessionRegistry.getBindingForNode(node.id);
    vi.mocked(setup.tmuxAdapter.setSessionOption).mockClear();
    const response = await setup.app.request(`/api/sessions/${claim.sessionId}/unclaim`, { method: "POST" });
    expect(response.status).toBe(409);
    expect(setup.sessionRegistry.getBindingForNode(node.id)).toEqual(binding);
    expect(setup.tmuxAdapter.setSessionOption).not.toHaveBeenCalled();
  });

  it("keeps a repeat of an already released current ID harmless", async () => {
    const { node, claim } = await claimedSeat();
    expect((await setup.rigLifecycleService.unclaimSession(claim.sessionId)).ok).toBe(true);
    vi.mocked(setup.tmuxAdapter.setSessionOption).mockClear();
    const response = await setup.app.request(`/api/sessions/${claim.sessionId}/unclaim`, { method: "POST" });
    expect(response.status).toBe(200);
    expect(setup.sessionRegistry.getBindingForNode(node.id)).toBeNull();
    expect(setup.tmuxAdapter.setSessionOption).not.toHaveBeenCalled();
  });

  it("holds earlier seats through a whole-rig release and deletion", async () => {
    const { rig, node } = await claimedSeat();
    const secondNode = setup.rigRepo.addNode(rig.id, "external.second", { runtime: "terminal" });
    const discovered = setup.discoveryRepo.upsertDiscoveredSession({
      tmuxSession: "manual-second", tmuxPane: "%2", cwd: "/tmp",
      activeCommand: "bash", runtimeHint: "terminal", confidence: "high",
    });
    expect((await setup.claimService.bind({ discoveredId: discovered.id, rigId: rig.id, logicalId: secondNode.logicalId })).ok).toBe(true);
    const entered = barrier();
    const finish = barrier();
    vi.mocked(setup.tmuxAdapter.setSessionOption).mockImplementation(async (sessionName, key, value) => {
      if (sessionName === "manual-second" && key === "@rigged_node_id" && value === "") {
        entered.resolve();
        await finish.promise;
      }
      return { ok: true };
    });
    const release = setup.app.request(`/api/rigs/${rig.id}/release`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ delete: true }),
    });
    await entered.promise;
    let launchEntered = false;
    const launch = setup.tmuxAdapter.deliveryGuard!.lifecycle([node.id], async () => {
      launchEntered = true;
      return setup.nodeLauncher.launchNode(rig.id, node.logicalId);
    }).then(result => ({ result, error: null }), error => ({ result: null, error }));
    await new Promise<void>(resolve => setImmediate(resolve));
    const launchedDuringRelease = launchEntered;
    finish.resolve();
    const response = await release;
    const outcome = await launch;
    expect(launchedDuringRelease).toBe(false);
    expect(launchEntered).toBe(false);
    expect(outcome.error).toMatchObject({ code: "guard_target_unknown" });
    expect(response.status).toBe(200);
    expect(setup.rigRepo.getRig(rig.id)).toBeNull();
    expect(setup.tmuxAdapter.createSession).not.toHaveBeenCalled();
  });

  it("still releases the current claim without killing its tmux session", async () => {
    const { node, discovered, claim } = await claimedSeat();
    const res = await setup.app.request(`/api/sessions/${claim.sessionId}/unclaim`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(setup.sessionRegistry.getBindingForNode(node.id)).toBeNull();
    expect(setup.discoveryRepo.getDiscoveredSession(discovered.id)?.status).toBe("active");
    expect(setup.tmuxAdapter.killSession).not.toHaveBeenCalled();
  });
});
